// Portions adapted from crynta/terax-ai at
// fd99bf6e70e30a43b720d6e2e5f1fbb154208719.
// Copyright 2026 Crynta. Licensed under Apache-2.0.
// Modified by LobeHub.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::thread;
use std::time::Duration;

use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize, native_pty_system};
use serde::Serialize;

#[cfg(windows)]
use crate::platform::windows_job::ProcessJob;
use crate::protocol::{Frame, FrameKind, FrameSender, MAX_OUTPUT_PAYLOAD, TrySendResult};
use crate::server::Registry;

const READ_BUFFER_SIZE: usize = 16 * 1024;
const FLUSH_COALESCE: Duration = Duration::from_millis(8);
const FLUSH_QUEUE_RETRY_MIN: Duration = Duration::from_millis(1);
const FLUSH_QUEUE_RETRY_MAX: Duration = Duration::from_millis(16);
const MAX_PENDING_OUTPUT: usize = 4 * 1024 * 1024;
const OVERFLOW_NOTICE: &[u8] = b"\x1bc[LobeHub: terminal output dropped due to backpressure]\r\n";

#[cfg(windows)]
static CONPTY_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug)]
pub struct SessionError {
    stage: &'static str,
    source: String,
}

impl SessionError {
    fn new(stage: &'static str, source: impl fmt::Display) -> Self {
        Self {
            stage,
            source: source.to_string(),
        }
    }
}

impl fmt::Display for SessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.stage, self.source)
    }
}

impl std::error::Error for SessionError {}

#[derive(Clone, Debug)]
pub struct SpawnSpec {
    pub cols: u16,
    pub cwd: String,
    pub env_overrides: HashMap<String, String>,
    pub rows: u16,
    pub shell: String,
}

pub struct Session {
    // Field order is intentional. On Windows the Job Object closes before the
    // PTY pipes and master, terminating the process tree before ConPTY closes.
    #[cfg(windows)]
    _job: ProcessJob,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
}

impl Session {
    pub fn write(&self, bytes: &[u8]) -> io::Result<()> {
        self.writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .write_all(bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        self.master
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| SessionError::new("resize PTY", error))
    }

    pub fn kill(&self) -> io::Result<()> {
        #[cfg(windows)]
        {
            if let Err(job_error) = self._job.terminate(1) {
                // Best-effort fallback for diagnostics and partial cleanup;
                // the Job Object error remains authoritative because killing
                // only the shell cannot guarantee ConPTY descendant cleanup.
                let _ = self
                    .killer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .kill();
                return Err(job_error);
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            self.killer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .kill()
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Covers stdin EOF, protocol failure, aborted CREATE, and any registry
        // cleanup path that did not first receive an explicit KILL frame.
        let killer = self
            .killer
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _ = killer.kill();
    }
}

pub fn drop_session(session: Arc<Session>) {
    #[cfg(windows)]
    let _lifecycle = CONPTY_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    drop(session);
}

#[cfg(windows)]
fn lock_conpty_lifecycle() -> std::sync::MutexGuard<'static, ()> {
    CONPTY_LIFECYCLE_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct ChildKillGuard {
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}

impl ChildKillGuard {
    fn new(killer: Box<dyn ChildKiller + Send + Sync>) -> Self {
        Self {
            killer: Some(killer),
        }
    }

    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildKillGuard {
    fn drop(&mut self) {
        if let Some(mut killer) = self.killer.take() {
            let _ = killer.kill();
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartState {
    Pending,
    Running,
    Aborted,
}

struct StartGate {
    state: Mutex<StartState>,
    changed: Condvar,
}

impl StartGate {
    fn new() -> Self {
        Self {
            state: Mutex::new(StartState::Pending),
            changed: Condvar::new(),
        }
    }

    fn wait_until_released(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *state == StartState::Pending {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *state == StartState::Running
    }

    fn release(&self) {
        *self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = StartState::Running;
        self.changed.notify_all();
    }

    fn abort(&self) {
        *self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = StartState::Aborted;
        self.changed.notify_all();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitPayload {
    exit_code: i32,
    signal: Option<String>,
}

struct OutputInner {
    exit: Option<ExitPayload>,
    overflow_generation: u64,
    overflow_dropped: u64,
    pending: VecDeque<u8>,
    reader_done: bool,
}

struct OutputState {
    inner: Mutex<OutputInner>,
    changed: Condvar,
}

impl OutputState {
    fn new() -> Self {
        Self {
            inner: Mutex::new(OutputInner {
                exit: None,
                overflow_generation: 0,
                overflow_dropped: 0,
                pending: VecDeque::with_capacity(READ_BUFFER_SIZE),
                reader_done: false,
            }),
            changed: Condvar::new(),
        }
    }

    fn append(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }

        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if inner.pending.len().saturating_add(bytes.len()) > MAX_PENDING_OUTPUT {
            let mut dropped = inner.pending.len() as u64;
            inner.pending.clear();
            inner.pending.extend(OVERFLOW_NOTICE);
            inner.overflow_generation = inner.overflow_generation.wrapping_add(1);

            if bytes.len() <= MAX_PENDING_OUTPUT - OVERFLOW_NOTICE.len() {
                inner.pending.extend(bytes);
            } else {
                dropped = dropped.saturating_add(bytes.len() as u64);
            }
            inner.overflow_dropped = inner.overflow_dropped.saturating_add(dropped);
        } else {
            inner.pending.extend(bytes);
        }
        self.changed.notify_one();
    }

    fn mark_reader_done(&self) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .reader_done = true;
        self.changed.notify_all();
    }

    fn finish_after_reader(&self, exit: ExitPayload) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !inner.reader_done {
            inner = self
                .changed
                .wait(inner)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        inner.exit = Some(exit);
        self.changed.notify_all();
    }
}

struct ReaderCompletion {
    output: Arc<OutputState>,
}

impl Drop for ReaderCompletion {
    fn drop(&mut self) {
        self.output.mark_reader_done();
    }
}

pub struct PreparedSession {
    gate: Arc<StartGate>,
    session: Option<Arc<Session>>,
}

impl PreparedSession {
    pub fn session(&self) -> Arc<Session> {
        Arc::clone(self.session.as_ref().expect("prepared session is present"))
    }

    /// Releases reader, flusher, and waiter threads. The caller must enqueue
    /// CREATED and register the session before invoking this method.
    pub fn activate(mut self) {
        self.gate.release();
        if let Some(session) = self.session.take() {
            drop_session(session);
        }
    }
}

impl Drop for PreparedSession {
    fn drop(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = session.kill();
            self.gate.abort();
            drop_session(session);
        }
    }
}

pub fn spawn(
    handle: u32,
    spec: &SpawnSpec,
    frames: FrameSender,
    registry: Weak<Registry>,
) -> Result<(PreparedSession, u32), SessionError> {
    #[cfg(windows)]
    let _lifecycle = lock_conpty_lifecycle();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| SessionError::new("open PTY", error))?;
    let PtyPair { slave, master } = pair;

    let mut command = CommandBuilder::new(&spec.shell);
    command.cwd(&spec.cwd);
    for (key, value) in &spec.env_overrides {
        command.env(key, value);
    }

    let mut child = slave
        .spawn_command(command)
        .map_err(|error| SessionError::new("spawn shell", error))?;
    drop(slave);

    let mut child_guard = ChildKillGuard::new(child.clone_killer());
    let killer = child.clone_killer();
    let reader = master
        .try_clone_reader()
        .map_err(|error| SessionError::new("clone PTY reader", error))?;
    let writer = master
        .take_writer()
        .map_err(|error| SessionError::new("take PTY writer", error))?;
    let pid = child
        .process_id()
        .ok_or_else(|| SessionError::new("read shell pid", "process id is unavailable"))?;

    #[cfg(windows)]
    let job = ProcessJob::create_for(pid)
        .map_err(|error| SessionError::new("assign shell to Job Object", error))?;

    let session = Arc::new(Session {
        #[cfg(windows)]
        _job: job,
        killer: Mutex::new(killer),
        writer: Mutex::new(writer),
        master: Mutex::new(master),
    });
    let gate = Arc::new(StartGate::new());
    let output = Arc::new(OutputState::new());

    let gate_waiter = Arc::clone(&gate);
    let output_waiter = Arc::clone(&output);
    let waiter = thread::Builder::new()
        .name(format!("lobe-pty-waiter-{handle}"))
        .spawn(move || {
            if !gate_waiter.wait_until_released() {
                let _ = child.wait();
                return;
            }

            let exit = match child.wait() {
                Ok(status) => ExitPayload {
                    exit_code: i32::try_from(status.exit_code()).unwrap_or(i32::MAX),
                    signal: status.signal().map(str::to_owned),
                },
                Err(error) => {
                    eprintln!("[pty-sidecar] failed to wait for session {handle}: {error}");
                    ExitPayload {
                        exit_code: -1,
                        signal: None,
                    }
                }
            };
            output_waiter.finish_after_reader(exit);
        })
        .map_err(|error| SessionError::new("spawn PTY waiter thread", error))?;

    let gate_reader = Arc::clone(&gate);
    let output_reader = Arc::clone(&output);
    let reader_thread = match thread::Builder::new()
        .name(format!("lobe-pty-reader-{handle}"))
        .spawn(move || run_reader(reader, gate_reader, output_reader, handle))
    {
        Ok(thread) => thread,
        Err(error) => {
            let _ = session.kill();
            gate.abort();
            let _ = waiter.join();
            drop(session);
            return Err(SessionError::new("spawn PTY reader thread", error));
        }
    };

    let gate_flusher = Arc::clone(&gate);
    let output_flusher = Arc::clone(&output);
    let flusher = thread::Builder::new()
        .name(format!("lobe-pty-flusher-{handle}"))
        .spawn(move || {
            if gate_flusher.wait_until_released() {
                run_flusher(handle, output_flusher, frames, registry);
            }
        });
    if let Err(error) = flusher {
        let _ = session.kill();
        gate.abort();
        let _ = reader_thread.join();
        let _ = waiter.join();
        drop(session);
        return Err(SessionError::new("spawn PTY flusher thread", error));
    }

    child_guard.disarm();
    Ok((
        PreparedSession {
            gate,
            session: Some(session),
        },
        pid,
    ))
}

fn run_reader(
    mut reader: Box<dyn Read + Send>,
    gate: Arc<StartGate>,
    output: Arc<OutputState>,
    handle: u32,
) {
    let _completion = ReaderCompletion {
        output: Arc::clone(&output),
    };
    if !gate.wait_until_released() {
        return;
    }

    let mut buffer = [0_u8; READ_BUFFER_SIZE];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => output.append(&buffer[..length]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => {
                eprintln!("[pty-sidecar] PTY reader ended for session {handle}: {error}");
                break;
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackpressureError<'a> {
    code: &'a str,
    fatal: bool,
    message: &'a str,
}

fn run_flusher(
    handle: u32,
    output: Arc<OutputState>,
    frames: FrameSender,
    registry: Weak<Registry>,
) {
    let result = flush_until_exit(handle, &output, &frames);
    if let Err(error) = result {
        eprintln!("[pty-sidecar] output pipeline ended for session {handle}: {error}");
    }
    if let Some(registry) = registry.upgrade() {
        registry.remove(handle);
    }
}

fn flush_until_exit(
    handle: u32,
    output: &OutputState,
    frames: &FrameSender,
) -> Result<(), crate::protocol::ProtocolError> {
    loop {
        let mut inner = output
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while inner.pending.is_empty() && inner.overflow_dropped == 0 && inner.exit.is_none() {
            inner = output
                .changed
                .wait(inner)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }

        if !inner.pending.is_empty() {
            drop(inner);
            thread::sleep(FLUSH_COALESCE);
            flush_pending_burst(handle, output, frames)?;
            continue;
        }

        if inner.overflow_dropped > 0 {
            let dropped = std::mem::take(&mut inner.overflow_dropped);
            drop(inner);
            eprintln!(
                "[pty-sidecar] session {handle} dropped {dropped} output bytes due to backpressure"
            );
            frames.send_json(
                FrameKind::Error,
                handle,
                &BackpressureError {
                    code: "OUTPUT_BACKPRESSURE",
                    fatal: false,
                    message: "Terminal output was reset after exceeding the pending-output limit",
                },
            )?;
            continue;
        }

        if let Some(exit) = inner.exit.take() {
            drop(inner);
            return frames.send_json(FrameKind::Exit, handle, &exit);
        }
    }
}

fn flush_pending_burst(
    handle: u32,
    output: &OutputState,
    frames: &FrameSender,
) -> Result<(), crate::protocol::ProtocolError> {
    let mut cached = None;
    let mut retry_delay = FLUSH_QUEUE_RETRY_MIN;
    loop {
        match try_flush_pending_frame(handle, output, frames, &mut cached)? {
            FlushProgress::Empty => return Ok(()),
            FlushProgress::QueueFull => {
                thread::sleep(retry_delay);
                retry_delay = (retry_delay * 2).min(FLUSH_QUEUE_RETRY_MAX);
            }
            FlushProgress::Sent => retry_delay = FLUSH_QUEUE_RETRY_MIN,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FlushProgress {
    Empty,
    QueueFull,
    Sent,
}

struct PendingFrame {
    frame: Frame,
    length: usize,
    overflow_generation: u64,
}

fn try_flush_pending_frame(
    handle: u32,
    output: &OutputState,
    frames: &FrameSender,
    cached: &mut Option<PendingFrame>,
) -> Result<FlushProgress, crate::protocol::ProtocolError> {
    let mut inner = output
        .inner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if cached
        .as_ref()
        .is_some_and(|frame| frame.overflow_generation != inner.overflow_generation)
    {
        *cached = None;
    }
    if cached.is_none() {
        let length = inner.pending.len().min(MAX_OUTPUT_PAYLOAD);
        if length == 0 {
            return Ok(FlushProgress::Empty);
        }
        *cached = Some(PendingFrame {
            frame: Frame::new(
                FrameKind::Output,
                handle,
                inner.pending.iter().take(length).copied().collect(),
            ),
            length,
            overflow_generation: inner.overflow_generation,
        });
    }

    let PendingFrame {
        frame,
        length,
        overflow_generation,
    } = cached.take().expect("pending frame is cached");
    match frames.try_send(frame)? {
        TrySendResult::Full(frame) => {
            *cached = Some(PendingFrame {
                frame,
                length,
                overflow_generation,
            });
            Ok(FlushProgress::QueueFull)
        }
        TrySendResult::Sent => {
            inner.pending.drain(..length);
            Ok(FlushProgress::Sent)
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;
    #[cfg(unix)]
    use std::time::Instant;

    use super::*;
    use crate::protocol::frame_channel;

    #[test]
    fn final_output_is_enqueued_before_exit() {
        let output = OutputState::new();
        let (frames, receiver) = frame_channel(8);
        output.append(b"last terminal bytes");
        output.mark_reader_done();
        output.finish_after_reader(ExitPayload {
            exit_code: 0,
            signal: None,
        });

        flush_until_exit(41, &output, &frames).expect("flush output and exit");

        let first = receiver.recv().expect("OUTPUT frame");
        let second = receiver.recv().expect("EXIT frame");
        assert_eq!(first.kind, FrameKind::Output);
        assert_eq!(first.stream_id, 41);
        assert_eq!(first.payload, b"last terminal bytes");
        assert_eq!(second.kind, FrameKind::Exit);
        assert_eq!(second.stream_id, 41);
    }

    #[test]
    fn large_pending_output_is_split_without_losing_bytes() {
        let output = OutputState::new();
        let expected = vec![b'z'; MAX_OUTPUT_PAYLOAD * 2 + 17];
        let (frames, receiver) = frame_channel(8);
        output.append(&expected);
        output.mark_reader_done();
        output.finish_after_reader(ExitPayload {
            exit_code: 0,
            signal: None,
        });

        flush_until_exit(42, &output, &frames).expect("flush output and exit");

        let mut actual = Vec::new();
        let mut output_frames = 0;
        loop {
            let frame = receiver.recv().expect("pipeline frame");
            match frame.kind {
                FrameKind::Output => {
                    assert!(frame.payload.len() <= MAX_OUTPUT_PAYLOAD);
                    actual.extend(frame.payload);
                    output_frames += 1;
                }
                FrameKind::Exit => break,
                kind => panic!("unexpected frame: {kind:?}"),
            }
        }
        assert_eq!(output_frames, 3);
        assert_eq!(actual, expected);
    }

    #[test]
    fn overflow_discards_the_whole_pending_prefix_and_emits_a_reset_notice() {
        let output = Arc::new(OutputState::new());
        output.append(&vec![b'x'; MAX_PENDING_OUTPUT - 1]);
        output.append(b"new bytes");
        let (frames, receiver) = frame_channel(128);
        let flusher_output = Arc::clone(&output);
        let flusher = thread::spawn(move || flush_until_exit(9, &flusher_output, &frames));

        let mut output_bytes = Vec::new();
        let mut saw_backpressure_error = false;
        while !saw_backpressure_error {
            let frame = receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("prompt backpressure pipeline frame");
            match frame.kind {
                FrameKind::Output => output_bytes.extend(frame.payload),
                FrameKind::Error => saw_backpressure_error = true,
                FrameKind::Exit => panic!("EXIT preceded the backpressure notification"),
                kind => panic!("unexpected frame: {kind:?}"),
            }
        }
        assert!(output_bytes.starts_with(b"\x1bc[LobeHub:"));
        assert!(output_bytes.ends_with(b"new bytes"));
        assert!(!output_bytes.starts_with(b"x"));
        assert!(saw_backpressure_error);

        output.mark_reader_done();
        output.finish_after_reader(ExitPayload {
            exit_code: 0,
            signal: None,
        });
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("EXIT frame")
                .kind,
            FrameKind::Exit
        );
        flusher
            .join()
            .expect("flusher thread")
            .expect("flush reset and exit");
    }

    #[test]
    fn queue_saturation_cannot_commit_output_that_a_later_overflow_discards() {
        let output = OutputState::new();
        output.append(&vec![b'x'; MAX_PENDING_OUTPUT - 1]);
        let (frames, receiver) = frame_channel(1);
        frames
            .send(Frame::new(FrameKind::Hello, 0, b"{}".to_vec()))
            .expect("fill writer queue");
        let mut cached = None;

        assert_eq!(
            try_flush_pending_frame(9, &output, &frames, &mut cached).expect("probe full queue"),
            FlushProgress::QueueFull
        );

        output.append(b"new bytes");
        assert_eq!(
            receiver.recv().expect("queue filler").kind,
            FrameKind::Hello
        );
        assert_eq!(
            try_flush_pending_frame(9, &output, &frames, &mut cached).expect("flush reset output"),
            FlushProgress::Sent
        );

        let frame = receiver.recv().expect("reset OUTPUT frame");
        assert_eq!(frame.kind, FrameKind::Output);
        assert!(frame.payload.starts_with(OVERFLOW_NOTICE));
        assert!(frame.payload.ends_with(b"new bytes"));
        assert!(!frame.payload.contains(&b'x'));
    }

    #[cfg(unix)]
    #[test]
    fn dropping_a_session_kills_its_child() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open PTY");
        let PtyPair { slave, master } = pair;
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "sleep 30"]);
        let mut child = slave.spawn_command(command).expect("spawn child");
        drop(slave);

        let session = Arc::new(Session {
            killer: Mutex::new(child.clone_killer()),
            writer: Mutex::new(master.take_writer().expect("take writer")),
            master: Mutex::new(master),
        });
        assert!(child.try_wait().expect("poll child").is_none());

        drop_session(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        while child.try_wait().expect("poll killed child").is_none() {
            assert!(Instant::now() < deadline, "child survived Session drop");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_immediately_exiting_child_flushes_output_and_leaves_the_registry() {
        let registry = Arc::new(Registry::new(64));
        let (frames, receiver) = frame_channel(16);
        let cwd = std::env::current_dir()
            .expect("current directory")
            .to_string_lossy()
            .into_owned();
        let spec = SpawnSpec {
            cols: 80,
            cwd,
            env_overrides: HashMap::new(),
            rows: 24,
            shell: "/bin/pwd".into(),
        };
        let (prepared, _) = spawn(1, &spec, frames.clone(), Arc::downgrade(&registry))
            .expect("spawn quick command");
        registry
            .insert(1, prepared.session())
            .expect("register session");
        frames
            .send(Frame::new(FrameKind::Created, 1, b"{}".to_vec()))
            .expect("queue CREATED");
        prepared.activate();

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut kinds = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining) {
                Ok(frame) => {
                    kinds.push(frame.kind);
                    if frame.kind == FrameKind::Exit {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => panic!("quick child did not exit"),
                Err(RecvTimeoutError::Disconnected) => panic!("frame channel disconnected"),
            }
        }

        assert_eq!(kinds.first(), Some(&FrameKind::Created));
        let output_index = kinds
            .iter()
            .position(|kind| *kind == FrameKind::Output)
            .expect("pwd output");
        let exit_index = kinds
            .iter()
            .position(|kind| *kind == FrameKind::Exit)
            .expect("exit frame");
        assert!(output_index < exit_index);

        while registry.len() != 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(registry.len(), 0);
    }

    #[cfg(windows)]
    #[test]
    fn conpty_lifecycle_operations_do_not_overlap() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            threads.push(thread::spawn(move || {
                let _guard = lock_conpty_lifecycle();
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                thread::sleep(Duration::from_millis(25));
                active.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for thread in threads {
            thread.join().expect("lifecycle worker");
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}
