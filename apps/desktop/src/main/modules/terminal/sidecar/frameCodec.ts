import type { PtyFrame, PtyFrameKindValue } from './types';
import { PTY_PROTOCOL_VERSION, PtyFrameKind, PtySidecarError } from './types';

export const PTY_FRAME_HEADER_SIZE = 16;
export const PTY_MAX_CONTROL_PAYLOAD_SIZE = 64 * 1024;
export const PTY_MAX_FRAME_PAYLOAD_SIZE = 4 * 1024 * 1024;
export const PTY_MAX_OUTPUT_PAYLOAD_SIZE = 64 * 1024;

const MAGIC = new Uint8Array([0x4c, 0x50, 0x54, 0x59]);
const VALID_FRAME_KINDS = new Set<number>(Object.values(PtyFrameKind));
const CONTROL_FRAME_KINDS = new Set<PtyFrameKindValue>([
  PtyFrameKind.Hello,
  PtyFrameKind.Create,
  PtyFrameKind.Created,
  PtyFrameKind.CreateError,
  PtyFrameKind.Exit,
  PtyFrameKind.Error,
]);

const assertUint32 = (value: number, field: string) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new PtySidecarError('INVALID_FRAME', `${field} must be an unsigned 32-bit integer`);
  }
};

const validateFrame = (kind: PtyFrameKindValue, streamId: number, payloadLength: number) => {
  assertUint32(streamId, 'streamId');
  assertUint32(payloadLength, 'payloadLength');

  if (payloadLength > PTY_MAX_FRAME_PAYLOAD_SIZE) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY frame payload exceeds the protocol limit');
  }
  if (CONTROL_FRAME_KINDS.has(kind) && payloadLength > PTY_MAX_CONTROL_PAYLOAD_SIZE) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY control payload exceeds the protocol limit');
  }
  if (kind === PtyFrameKind.Output && payloadLength > PTY_MAX_OUTPUT_PAYLOAD_SIZE) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY output payload exceeds the protocol limit');
  }

  const requiresGlobalStream =
    kind === PtyFrameKind.Hello ||
    kind === PtyFrameKind.Create ||
    kind === PtyFrameKind.CreateError ||
    kind === PtyFrameKind.Shutdown;
  const requiresSessionStream =
    kind === PtyFrameKind.Created ||
    kind === PtyFrameKind.Input ||
    kind === PtyFrameKind.Output ||
    kind === PtyFrameKind.Resize ||
    kind === PtyFrameKind.Kill ||
    kind === PtyFrameKind.Exit;

  if (requiresGlobalStream && streamId !== 0) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY global frame has a non-zero stream id');
  }
  if (requiresSessionStream && streamId === 0) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY session frame has a zero stream id');
  }
  if (kind === PtyFrameKind.Resize && payloadLength !== 4) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY resize payload must contain four bytes');
  }
  if ((kind === PtyFrameKind.Kill || kind === PtyFrameKind.Shutdown) && payloadLength !== 0) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY lifecycle frame must have an empty payload');
  }
};

const decodeHeader = (bytes: Uint8Array): Omit<PtyFrame, 'payload'> & { payloadLength: number } => {
  for (let index = 0; index < MAGIC.length; index++) {
    if (bytes[index] !== MAGIC[index]) {
      throw new PtySidecarError('INVALID_FRAME', 'Invalid PTY protocol magic');
    }
  }

  const version = bytes[4];
  if (version !== PTY_PROTOCOL_VERSION) {
    throw new PtySidecarError('PROTOCOL_MISMATCH', `Unsupported PTY protocol version ${version}`);
  }

  const kindValue = bytes[5];
  if (!VALID_FRAME_KINDS.has(kindValue)) {
    throw new PtySidecarError('INVALID_FRAME', `Unknown PTY frame kind ${kindValue}`);
  }
  const kind = kindValue as PtyFrameKindValue;

  const view = new DataView(bytes.buffer, bytes.byteOffset, PTY_FRAME_HEADER_SIZE);
  const flags = view.getUint16(6, false);
  if (flags !== 0) {
    throw new PtySidecarError('INVALID_FRAME', 'PTY protocol flags must be zero');
  }

  const streamId = view.getUint32(8, false);
  const payloadLength = view.getUint32(12, false);
  validateFrame(kind, streamId, payloadLength);

  return { kind, payloadLength, streamId };
};

export const encodePtyFrame = ({ kind, payload, streamId }: PtyFrame): Uint8Array => {
  validateFrame(kind, streamId, payload.byteLength);

  const frame = new Uint8Array(PTY_FRAME_HEADER_SIZE + payload.byteLength);
  frame.set(MAGIC, 0);
  frame[4] = PTY_PROTOCOL_VERSION;
  frame[5] = kind;

  const view = new DataView(frame.buffer);
  view.setUint16(6, 0, false);
  view.setUint32(8, streamId, false);
  view.setUint32(12, payload.byteLength, false);
  frame.set(payload, PTY_FRAME_HEADER_SIZE);
  return frame;
};

export class PtyFrameDecoder {
  private pending = new Uint8Array();

  push(chunk: Uint8Array): PtyFrame[] {
    if (chunk.byteLength === 0) return [];

    const bytes = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    bytes.set(this.pending);
    bytes.set(chunk, this.pending.byteLength);

    const frames: PtyFrame[] = [];
    let offset = 0;
    while (bytes.byteLength - offset >= PTY_FRAME_HEADER_SIZE) {
      const headerBytes = bytes.subarray(offset, offset + PTY_FRAME_HEADER_SIZE);
      const { kind, payloadLength, streamId } = decodeHeader(headerBytes);
      const frameLength = PTY_FRAME_HEADER_SIZE + payloadLength;
      if (bytes.byteLength - offset < frameLength) break;

      frames.push({
        kind,
        payload: bytes.slice(offset + PTY_FRAME_HEADER_SIZE, offset + frameLength),
        streamId,
      });
      offset += frameLength;
    }

    this.pending = bytes.slice(offset);
    return frames;
  }

  reset() {
    this.pending = new Uint8Array();
  }
}
