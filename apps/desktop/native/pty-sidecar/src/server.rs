// Portions adapted from crynta/terax-ai at
// fd99bf6e70e30a43b720d6e2e5f1fbb154208719.
// Copyright 2026 Crynta. Licensed under Apache-2.0.
// Modified by LobeHub.

use std::collections::HashMap;
use std::fmt;
use std::io::{self, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

use crate::protocol::{
    Frame, FrameDecoder, FrameKind, FrameSender, MAX_CONTROL_PAYLOAD, ProtocolError,
};
use crate::session::{self, Session, SpawnSpec};

const READ_BUFFER_SIZE: usize = 16 * 1024;
const DEFAULT_SESSION_LIMIT: usize = 64;
const MAX_DIMENSION: u16 = 1000;

#[derive(Debug)]
pub enum ServerError {
    InvalidFrame(&'static str),
    Io(io::Error),
    Protocol(ProtocolError),
}

impl fmt::Display for ServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFrame(message) => write!(formatter, "invalid frame: {message}"),
            Self::Io(error) => write!(formatter, "protocol input failed: {error}"),
            Self::Protocol(error) => write!(formatter, "protocol failure: {error}"),
        }
    }
}

impl std::error::Error for ServerError {}

impl From<io::Error> for ServerError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<ProtocolError> for ServerError {
    fn from(error: ProtocolError) -> Self {
        Self::Protocol(error)
    }
}

pub(crate) struct Registry {
    limit: usize,
    next_handle: AtomicU64,
    sessions: RwLock<HashMap<u32, Arc<Session>>>,
}

impl Registry {
    pub(crate) fn new(limit: usize) -> Self {
        Self {
            limit,
            next_handle: AtomicU64::new(1),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    fn allocate_handle(&self) -> Option<u32> {
        let next = self.next_handle.fetch_add(1, Ordering::Relaxed);
        u32::try_from(next).ok().filter(|handle| *handle != 0)
    }

    pub(crate) fn insert(&self, handle: u32, session: Arc<Session>) -> Result<(), ()> {
        let mut sessions = self
            .sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if sessions.len() >= self.limit || sessions.contains_key(&handle) {
            return Err(());
        }
        sessions.insert(handle, session);
        Ok(())
    }

    fn with_session<T>(&self, handle: u32, operation: impl FnOnce(&Session) -> T) -> Option<T> {
        let sessions = self
            .sessions
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions
            .get(&handle)
            .map(|session| operation(session.as_ref()))
    }

    pub(crate) fn len(&self) -> usize {
        self.sessions
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    pub(crate) fn remove(&self, handle: u32) {
        let session = self
            .sessions
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&handle);
        if let Some(session) = session {
            session::drop_session(session);
        }
    }

    fn shutdown(&self) {
        let sessions = {
            let mut sessions = self
                .sessions
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };
        for session in sessions {
            let _ = session.kill();
            session::drop_session(session);
        }
    }
}

impl Drop for Registry {
    fn drop(&mut self) {
        let sessions = self
            .sessions
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            let _ = session.kill();
            session::drop_session(session);
        }
    }
}

pub struct Server {
    frames: FrameSender,
    registry: Arc<Registry>,
}

impl Server {
    pub fn new(frames: FrameSender) -> Self {
        Self::with_session_limit(frames, DEFAULT_SESSION_LIMIT)
    }

    fn with_session_limit(frames: FrameSender, limit: usize) -> Self {
        Self {
            frames,
            registry: Arc::new(Registry::new(limit)),
        }
    }

    pub fn send_hello(&self) -> Result<(), ServerError> {
        self.frames.send_json(
            FrameKind::Hello,
            0,
            &HelloPayload {
                build: env!("CARGO_PKG_VERSION"),
                max_version: 1,
                min_version: 1,
                pid: std::process::id(),
            },
        )?;
        Ok(())
    }

    pub fn run<R: Read>(&self, mut reader: R) -> Result<(), ServerError> {
        let mut decoder = FrameDecoder::new();
        let mut buffer = [0_u8; READ_BUFFER_SIZE];
        loop {
            let length = match reader.read(&mut buffer) {
                Ok(0) => {
                    decoder.finish()?;
                    return Ok(());
                }
                Ok(length) => length,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(ServerError::Io(error)),
            };

            for frame in decoder.push(&buffer[..length])? {
                validate_client_frame(&frame)?;
                if self.dispatch(frame)? == DispatchResult::Shutdown {
                    return Ok(());
                }
            }
        }
    }

    pub fn shutdown(&self) {
        self.registry.shutdown();
    }

    fn dispatch(&self, frame: Frame) -> Result<DispatchResult, ServerError> {
        match frame.kind {
            FrameKind::Create => self.create(frame.payload)?,
            FrameKind::Input => self.input(frame.stream_id, &frame.payload)?,
            FrameKind::Resize => self.resize(frame.stream_id, &frame.payload)?,
            FrameKind::Kill => self.kill(frame.stream_id)?,
            FrameKind::Shutdown => return Ok(DispatchResult::Shutdown),
            _ => {
                return Err(ServerError::InvalidFrame(
                    "frame direction is not client-to-sidecar",
                ));
            }
        }
        Ok(DispatchResult::Continue)
    }

    fn create(&self, payload: Vec<u8>) -> Result<(), ServerError> {
        let request_id = request_id_from_json(&payload);
        let request = match serde_json::from_slice::<CreateRequest>(&payload) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("[pty-sidecar] rejected malformed CREATE payload: {error}");
                return match request_id {
                    Some(request_id) => self.send_create_error(
                        request_id,
                        "SESSION_CREATE_FAILED",
                        "Invalid CREATE request",
                    ),
                    None => Err(ServerError::InvalidFrame(
                        "CREATE is missing a valid requestId",
                    )),
                };
            }
        };
        if request.request_id == 0 {
            return Err(ServerError::InvalidFrame(
                "CREATE requestId must be non-zero",
            ));
        }
        if let Err(message) = request.validate() {
            return self.send_create_error(request.request_id, "SESSION_CREATE_FAILED", message);
        }
        if self.registry.len() >= self.registry.limit {
            return self.send_create_error(
                request.request_id,
                "SESSION_LIMIT_REACHED",
                "The sidecar session limit has been reached",
            );
        }
        let Some(handle) = self.registry.allocate_handle() else {
            return self.send_create_error(
                request.request_id,
                "SESSION_LIMIT_REACHED",
                "No additional sidecar session handles are available",
            );
        };

        let spec = SpawnSpec {
            cols: request.cols,
            cwd: request.cwd.clone(),
            env_overrides: request.env_overrides,
            rows: request.rows,
            shell: request.shell.clone(),
        };
        let (prepared, pid) = match session::spawn(
            handle,
            &spec,
            self.frames.clone(),
            Arc::downgrade(&self.registry),
        ) {
            Ok(session) => session,
            Err(error) => {
                eprintln!("[pty-sidecar] failed to create session: {error}");
                return self.send_create_error(
                    request.request_id,
                    "SESSION_CREATE_FAILED",
                    "Failed to spawn the configured shell",
                );
            }
        };

        if self.registry.insert(handle, prepared.session()).is_err() {
            return self.send_create_error(
                request.request_id,
                "SESSION_LIMIT_REACHED",
                "The sidecar session limit has been reached",
            );
        }

        let created = self.frames.send_json(
            FrameKind::Created,
            handle,
            &CreatedPayload {
                cwd: &request.cwd,
                pid,
                request_id: request.request_id,
                shell: &request.shell,
            },
        );
        if let Err(error) = created {
            self.registry.remove(handle);
            return Err(ServerError::Protocol(error));
        }

        prepared.activate();
        Ok(())
    }

    fn input(&self, handle: u32, payload: &[u8]) -> Result<(), ServerError> {
        let Some(result) = self
            .registry
            .with_session(handle, |session| session.write(payload))
        else {
            return self.send_missing_session(handle);
        };
        if let Err(error) = result {
            eprintln!("[pty-sidecar] failed to write session {handle}: {error}");
            self.send_error(
                handle,
                "SESSION_IO_FAILED",
                "Failed to write terminal input",
            )?;
        }
        Ok(())
    }

    fn resize(&self, handle: u32, payload: &[u8]) -> Result<(), ServerError> {
        let cols = u16::from_be_bytes(payload[..2].try_into().expect("validated resize columns"));
        let rows = u16::from_be_bytes(payload[2..].try_into().expect("validated resize rows"));
        if !valid_dimension(cols) || !valid_dimension(rows) {
            return Err(ServerError::InvalidFrame(
                "RESIZE dimensions must be between 1 and 1000",
            ));
        }
        let Some(result) = self
            .registry
            .with_session(handle, |session| session.resize(cols, rows))
        else {
            return self.send_missing_session(handle);
        };
        if let Err(error) = result {
            eprintln!("[pty-sidecar] failed to resize session {handle}: {error}");
            self.send_error(handle, "SESSION_IO_FAILED", "Failed to resize the terminal")?;
        }
        Ok(())
    }

    fn kill(&self, handle: u32) -> Result<(), ServerError> {
        let Some(result) = self.registry.with_session(handle, Session::kill) else {
            return self.send_missing_session(handle);
        };
        if let Err(error) = result {
            // The process may have exited while its final OUTPUT is still being
            // flushed. The mapping remains valid until EXIT is queued.
            eprintln!("[pty-sidecar] kill returned for session {handle}: {error}");
        }
        Ok(())
    }

    fn send_missing_session(&self, handle: u32) -> Result<(), ServerError> {
        self.send_error(
            handle,
            "SESSION_NOT_FOUND",
            "The terminal session does not exist",
        )
    }

    fn send_error(&self, handle: u32, code: &str, message: &str) -> Result<(), ServerError> {
        self.frames.send_json(
            FrameKind::Error,
            handle,
            &ErrorPayload {
                code,
                fatal: false,
                message,
            },
        )?;
        Ok(())
    }

    fn send_create_error(
        &self,
        request_id: u32,
        code: &str,
        message: &str,
    ) -> Result<(), ServerError> {
        self.frames.send_json(
            FrameKind::CreateError,
            0,
            &CreateErrorPayload {
                code,
                fatal: false,
                message,
                request_id,
            },
        )?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DispatchResult {
    Continue,
    Shutdown,
}

fn validate_client_frame(frame: &Frame) -> Result<(), ServerError> {
    let valid = match frame.kind {
        FrameKind::Create => frame.stream_id == 0 && frame.payload.len() <= MAX_CONTROL_PAYLOAD,
        FrameKind::Input => frame.stream_id != 0,
        FrameKind::Resize => frame.stream_id != 0 && frame.payload.len() == 4,
        FrameKind::Kill => frame.stream_id != 0 && frame.payload.is_empty(),
        FrameKind::Shutdown => frame.stream_id == 0 && frame.payload.is_empty(),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ServerError::InvalidFrame(
            "kind, stream id, or payload length violates protocol v1",
        ))
    }
}

fn valid_dimension(value: u16) -> bool {
    (1..=MAX_DIMENSION).contains(&value)
}

fn request_id_from_json(payload: &[u8]) -> Option<u32> {
    serde_json::from_slice::<serde_json::Value>(payload)
        .ok()
        .and_then(|value| value.get("requestId").and_then(serde_json::Value::as_u64))
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value != 0)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    cols: u16,
    cwd: String,
    env_overrides: HashMap<String, String>,
    request_id: u32,
    rows: u16,
    shell: String,
}

impl CreateRequest {
    fn validate(&self) -> Result<(), &'static str> {
        if !valid_dimension(self.cols) || !valid_dimension(self.rows) {
            return Err("Terminal dimensions must be between 1 and 1000");
        }
        if self.cwd.is_empty() || self.shell.is_empty() {
            return Err("cwd and shell must not be empty");
        }
        if self.cwd.contains('\0') || self.shell.contains('\0') {
            return Err("cwd and shell contain an invalid character");
        }
        if self.env_overrides.iter().any(|(key, value)| {
            !matches!(key.as_str(), "TERM" | "COLORTERM") || value.contains('\0')
        }) {
            return Err("envOverrides may contain only TERM and COLORTERM");
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloPayload<'a> {
    build: &'a str,
    max_version: u8,
    min_version: u8,
    pid: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedPayload<'a> {
    cwd: &'a str,
    pid: u32,
    request_id: u32,
    shell: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateErrorPayload<'a> {
    code: &'a str,
    fatal: bool,
    message: &'a str,
    request_id: u32,
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    code: &'a str,
    fatal: bool,
    message: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::frame_channel;

    fn create_payload(cols: u16, rows: u16) -> Vec<u8> {
        serde_json::json!({
            "cols": cols,
            "cwd": "/tmp",
            "envOverrides": {
                "COLORTERM": "truecolor",
                "TERM": "xterm-256color"
            },
            "requestId": 1,
            "rows": rows,
            "shell": "/bin/sh"
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn create_dimensions_accept_only_the_documented_boundary() {
        let minimum: CreateRequest =
            serde_json::from_slice(&create_payload(1, 1)).expect("minimum request");
        let maximum: CreateRequest =
            serde_json::from_slice(&create_payload(1000, 1000)).expect("maximum request");
        let zero: CreateRequest =
            serde_json::from_slice(&create_payload(0, 24)).expect("zero request shape");
        let excessive: CreateRequest =
            serde_json::from_slice(&create_payload(80, 1001)).expect("large request shape");

        assert!(minimum.validate().is_ok());
        assert!(maximum.validate().is_ok());
        assert!(zero.validate().is_err());
        assert!(excessive.validate().is_err());
    }

    #[test]
    fn invalid_session_operations_are_non_fatal_and_report_the_handle() {
        let (frames, receiver) = frame_channel(8);
        let server = Server::new(frames);
        let operations = [
            Frame::new(FrameKind::Input, 77, b"input".to_vec()),
            Frame::new(FrameKind::Resize, 77, [0, 80, 0, 24].to_vec()),
            Frame::new(FrameKind::Kill, 77, Vec::new()),
        ];

        for operation in operations {
            validate_client_frame(&operation).expect("valid client operation");
            assert_eq!(
                server.dispatch(operation).expect("non-fatal dispatch"),
                DispatchResult::Continue
            );
            let error = receiver.recv().expect("ERROR frame");
            assert_eq!(error.kind, FrameKind::Error);
            assert_eq!(error.stream_id, 77);
            let payload: serde_json::Value =
                serde_json::from_slice(&error.payload).expect("ERROR JSON");
            assert_eq!(payload["code"], "SESSION_NOT_FOUND");
            assert_eq!(payload["fatal"], false);
        }
    }

    #[test]
    fn defensive_session_cap_rejects_create_without_spawning() {
        let (frames, receiver) = frame_channel(2);
        let server = Server::with_session_limit(frames, 0);
        let frame = Frame::new(FrameKind::Create, 0, create_payload(80, 24));

        server.dispatch(frame).expect("non-fatal create rejection");

        let error = receiver.recv().expect("CREATE_ERROR frame");
        assert_eq!(error.kind, FrameKind::CreateError);
        let payload: serde_json::Value =
            serde_json::from_slice(&error.payload).expect("CREATE_ERROR JSON");
        assert_eq!(payload["code"], "SESSION_LIMIT_REACHED");
        assert_eq!(payload["requestId"], 1);
    }
}
