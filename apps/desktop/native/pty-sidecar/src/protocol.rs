use std::fmt;
use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};

use serde::Serialize;

pub const HEADER_LEN: usize = 16;
pub const MAX_FRAME_PAYLOAD: usize = 4 * 1024 * 1024;
pub const MAX_CONTROL_PAYLOAD: usize = 64 * 1024;
pub const MAX_OUTPUT_PAYLOAD: usize = 64 * 1024;
pub const WRITER_QUEUE_CAPACITY: usize = 256;

const MAGIC: [u8; 4] = *b"LPTY";
const VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum FrameKind {
    Hello = 0x01,
    Create = 0x02,
    Created = 0x03,
    CreateError = 0x04,
    Input = 0x05,
    Output = 0x06,
    Resize = 0x07,
    Kill = 0x08,
    Exit = 0x09,
    Error = 0x0a,
    Shutdown = 0x0b,
}

impl TryFrom<u8> for FrameKind {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, ProtocolError> {
        match value {
            0x01 => Ok(Self::Hello),
            0x02 => Ok(Self::Create),
            0x03 => Ok(Self::Created),
            0x04 => Ok(Self::CreateError),
            0x05 => Ok(Self::Input),
            0x06 => Ok(Self::Output),
            0x07 => Ok(Self::Resize),
            0x08 => Ok(Self::Kill),
            0x09 => Ok(Self::Exit),
            0x0a => Ok(Self::Error),
            0x0b => Ok(Self::Shutdown),
            value => Err(ProtocolError::UnknownKind(value)),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    pub kind: FrameKind,
    pub stream_id: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: FrameKind, stream_id: u32, payload: Vec<u8>) -> Self {
        Self {
            kind,
            stream_id,
            payload,
        }
    }

    fn validate_outbound(&self) -> Result<(), ProtocolError> {
        validate_frame_shape(self.kind, self.stream_id, self.payload.len())
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    BadFlags(u16),
    BadMagic,
    BadVersion(u8),
    ControlPayloadTooLarge(usize),
    IncompleteFrame,
    InvalidPayloadLength { kind: FrameKind, length: usize },
    InvalidStreamId { kind: FrameKind, stream_id: u32 },
    OutputPayloadTooLarge(usize),
    PayloadTooLarge(usize),
    Serialize(serde_json::Error),
    UnknownKind(u8),
    WriterClosed,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadFlags(flags) => write!(formatter, "unsupported frame flags: {flags}"),
            Self::BadMagic => write!(formatter, "invalid frame magic"),
            Self::BadVersion(version) => {
                write!(formatter, "unsupported protocol version: {version}")
            }
            Self::ControlPayloadTooLarge(length) => {
                write!(formatter, "control payload exceeds 64 KiB: {length}")
            }
            Self::IncompleteFrame => write!(formatter, "input ended in the middle of a frame"),
            Self::InvalidPayloadLength { kind, length } => {
                write!(formatter, "invalid {kind:?} payload length: {length}")
            }
            Self::InvalidStreamId { kind, stream_id } => {
                write!(formatter, "invalid {kind:?} stream id: {stream_id}")
            }
            Self::OutputPayloadTooLarge(length) => {
                write!(formatter, "OUTPUT payload exceeds 64 KiB: {length}")
            }
            Self::PayloadTooLarge(length) => {
                write!(formatter, "frame payload exceeds 4 MiB: {length}")
            }
            Self::Serialize(error) => {
                write!(formatter, "failed to serialize control payload: {error}")
            }
            Self::UnknownKind(kind) => write!(formatter, "unknown frame kind: {kind:#04x}"),
            Self::WriterClosed => write!(formatter, "protocol writer is closed"),
        }
    }
}

impl std::error::Error for ProtocolError {}

pub struct FrameDecoder {
    buffer: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(HEADER_LEN),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Frame>, ProtocolError> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();

        loop {
            if self.buffer.len() < HEADER_LEN {
                break;
            }

            let magic: [u8; 4] = self.buffer[..4].try_into().expect("four-byte magic");
            if magic != MAGIC {
                return Err(ProtocolError::BadMagic);
            }
            if self.buffer[4] != VERSION {
                return Err(ProtocolError::BadVersion(self.buffer[4]));
            }
            let kind = FrameKind::try_from(self.buffer[5])?;
            let flags =
                u16::from_be_bytes(self.buffer[6..8].try_into().expect("two-byte frame flags"));
            if flags != 0 {
                return Err(ProtocolError::BadFlags(flags));
            }
            let stream_id =
                u32::from_be_bytes(self.buffer[8..12].try_into().expect("four-byte stream id"));
            let payload_len = u32::from_be_bytes(
                self.buffer[12..16]
                    .try_into()
                    .expect("four-byte payload length"),
            ) as usize;
            if payload_len > MAX_FRAME_PAYLOAD {
                return Err(ProtocolError::PayloadTooLarge(payload_len));
            }
            validate_frame_shape(kind, stream_id, payload_len)?;

            let frame_len = HEADER_LEN + payload_len;
            if self.buffer.len() < frame_len {
                break;
            }

            let payload = self.buffer[HEADER_LEN..frame_len].to_vec();
            self.buffer.drain(..frame_len);
            frames.push(Frame::new(kind, stream_id, payload));
        }

        Ok(frames)
    }

    pub fn finish(self) -> Result<(), ProtocolError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(ProtocolError::IncompleteFrame)
        }
    }
}

fn validate_frame_shape(
    kind: FrameKind,
    stream_id: u32,
    payload_len: usize,
) -> Result<(), ProtocolError> {
    if payload_len > MAX_FRAME_PAYLOAD {
        return Err(ProtocolError::PayloadTooLarge(payload_len));
    }
    if matches!(
        kind,
        FrameKind::Hello
            | FrameKind::Create
            | FrameKind::Created
            | FrameKind::CreateError
            | FrameKind::Exit
            | FrameKind::Error
    ) && payload_len > MAX_CONTROL_PAYLOAD
    {
        return Err(ProtocolError::ControlPayloadTooLarge(payload_len));
    }
    if kind == FrameKind::Output && payload_len > MAX_OUTPUT_PAYLOAD {
        return Err(ProtocolError::OutputPayloadTooLarge(payload_len));
    }

    let requires_global_stream = matches!(
        kind,
        FrameKind::Hello | FrameKind::Create | FrameKind::CreateError | FrameKind::Shutdown
    );
    let requires_session_stream = matches!(
        kind,
        FrameKind::Created
            | FrameKind::Input
            | FrameKind::Output
            | FrameKind::Resize
            | FrameKind::Kill
            | FrameKind::Exit
    );
    if (requires_global_stream && stream_id != 0) || (requires_session_stream && stream_id == 0) {
        return Err(ProtocolError::InvalidStreamId { kind, stream_id });
    }
    if (kind == FrameKind::Resize && payload_len != 4)
        || (matches!(kind, FrameKind::Kill | FrameKind::Shutdown) && payload_len != 0)
    {
        return Err(ProtocolError::InvalidPayloadLength {
            kind,
            length: payload_len,
        });
    }
    Ok(())
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct FrameSender {
    sender: SyncSender<Frame>,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum TrySendResult {
    Sent,
    Full(Frame),
}

impl FrameSender {
    pub fn send(&self, frame: Frame) -> Result<(), ProtocolError> {
        frame.validate_outbound()?;
        self.sender
            .send(frame)
            .map_err(|_| ProtocolError::WriterClosed)
    }

    pub(crate) fn try_send(&self, frame: Frame) -> Result<TrySendResult, ProtocolError> {
        frame.validate_outbound()?;
        match self.sender.try_send(frame) {
            Ok(()) => Ok(TrySendResult::Sent),
            Err(TrySendError::Full(frame)) => Ok(TrySendResult::Full(frame)),
            Err(TrySendError::Disconnected(_)) => Err(ProtocolError::WriterClosed),
        }
    }

    pub fn send_json<T: Serialize>(
        &self,
        kind: FrameKind,
        stream_id: u32,
        payload: &T,
    ) -> Result<(), ProtocolError> {
        let payload = serde_json::to_vec(payload).map_err(ProtocolError::Serialize)?;
        self.send(Frame::new(kind, stream_id, payload))
    }
}

pub(crate) fn frame_channel(capacity: usize) -> (FrameSender, Receiver<Frame>) {
    let (sender, receiver) = mpsc::sync_channel(capacity);
    (FrameSender { sender }, receiver)
}

pub fn spawn_writer<W>(writer: W) -> (FrameSender, JoinHandle<io::Result<()>>)
where
    W: Write + Send + 'static,
{
    let (sender, receiver) = frame_channel(WRITER_QUEUE_CAPACITY);
    let handle = thread::Builder::new()
        .name("lobe-pty-protocol-writer".into())
        .spawn(move || run_writer(writer, receiver))
        .expect("spawn protocol writer thread");
    (sender, handle)
}

fn run_writer<W>(mut writer: W, receiver: Receiver<Frame>) -> io::Result<()>
where
    W: Write,
{
    for frame in receiver {
        frame
            .validate_outbound()
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

        let payload_len = u32::try_from(frame.payload.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "payload length overflow"))?;
        let mut header = [0_u8; HEADER_LEN];
        header[..4].copy_from_slice(&MAGIC);
        header[4] = VERSION;
        header[5] = frame.kind as u8;
        header[8..12].copy_from_slice(&frame.stream_id.to_be_bytes());
        header[12..16].copy_from_slice(&payload_len.to_be_bytes());

        writer.write_all(&header)?;
        writer.write_all(&frame.payload)?;
        writer.flush()?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn encode_for_test(frame: Frame) -> Vec<u8> {
    let (sender, receiver) = frame_channel(1);
    let mut bytes = Vec::new();
    sender.send(frame).expect("valid test frame");
    drop(sender);
    run_writer(&mut bytes, receiver).expect("encode test frame");
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_accepts_a_frame_split_at_every_byte_boundary() {
        let expected = Frame::new(FrameKind::Input, 7, b"split input".to_vec());
        let encoded = encode_for_test(expected.clone());
        let mut decoder = FrameDecoder::new();
        let mut decoded = Vec::new();

        for byte in encoded {
            decoded.extend(decoder.push(&[byte]).expect("fragment is valid"));
        }

        decoder.finish().expect("complete frame");
        assert_eq!(decoded, vec![expected]);
    }

    #[test]
    fn decoder_returns_multiple_coalesced_frames_in_order() {
        let first = Frame::new(FrameKind::Input, 3, b"first".to_vec());
        let second = Frame::new(FrameKind::Kill, 3, Vec::new());
        let mut bytes = encode_for_test(first.clone());
        bytes.extend(encode_for_test(second.clone()));

        let decoded = FrameDecoder::new().push(&bytes).expect("valid frames");

        assert_eq!(decoded, vec![first, second]);
    }

    #[test]
    fn decoder_rejects_corrupt_or_unsupported_headers_before_payload_allocation() {
        let valid = encode_for_test(Frame::new(FrameKind::Shutdown, 0, Vec::new()));

        let mut bad_magic = valid.clone();
        bad_magic[0] = b'X';
        assert!(matches!(
            FrameDecoder::new().push(&bad_magic),
            Err(ProtocolError::BadMagic)
        ));

        let mut bad_version = valid.clone();
        bad_version[4] = 2;
        assert!(matches!(
            FrameDecoder::new().push(&bad_version),
            Err(ProtocolError::BadVersion(2))
        ));

        let mut unknown_kind = valid.clone();
        unknown_kind[5] = 0xff;
        assert!(matches!(
            FrameDecoder::new().push(&unknown_kind),
            Err(ProtocolError::UnknownKind(0xff))
        ));

        let mut unsupported_flags = valid.clone();
        unsupported_flags[7] = 1;
        assert!(matches!(
            FrameDecoder::new().push(&unsupported_flags),
            Err(ProtocolError::BadFlags(1))
        ));

        let mut invalid_stream = valid.clone();
        invalid_stream[11] = 1;
        assert!(matches!(
            FrameDecoder::new().push(&invalid_stream),
            Err(ProtocolError::InvalidStreamId {
                kind: FrameKind::Shutdown,
                stream_id: 1
            })
        ));

        let mut oversized = valid;
        oversized[12..16]
            .copy_from_slice(&u32::try_from(MAX_FRAME_PAYLOAD + 1).unwrap().to_be_bytes());
        assert!(matches!(
            FrameDecoder::new().push(&oversized),
            Err(ProtocolError::PayloadTooLarge(_))
        ));
    }
}
