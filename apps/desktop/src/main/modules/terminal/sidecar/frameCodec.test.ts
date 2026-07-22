import { describe, expect, it } from 'vitest';

import {
  encodePtyFrame,
  PTY_FRAME_HEADER_SIZE,
  PTY_MAX_OUTPUT_PAYLOAD_SIZE,
  PtyFrameDecoder,
} from './frameCodec';
import { PtyFrameKind } from './types';

const outputFrame = (payload: Uint8Array, streamId = 7) =>
  encodePtyFrame({ kind: PtyFrameKind.Output, payload, streamId });

describe('PTY frame codec', () => {
  it('decodes a frame split at every possible byte boundary without changing payload bytes', () => {
    const payload = new Uint8Array([0x1b, 0x5b, 0x31, 0x6d, 0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
    const encoded = outputFrame(payload);
    const decoder = new PtyFrameDecoder();
    const frames = [];

    for (const byte of encoded) frames.push(...decoder.push(Uint8Array.of(byte)));

    expect(frames).toEqual([{ kind: PtyFrameKind.Output, payload, streamId: 7 }]);
  });

  it('decodes multiple coalesced frames in order', () => {
    const first = outputFrame(Uint8Array.of(1, 2), 4);
    const second = encodePtyFrame({
      kind: PtyFrameKind.Exit,
      payload: new TextEncoder().encode('{"exitCode":0,"signal":null}'),
      streamId: 4,
    });
    const coalesced = new Uint8Array(first.byteLength + second.byteLength);
    coalesced.set(first);
    coalesced.set(second, first.byteLength);

    const frames = new PtyFrameDecoder().push(coalesced);

    expect(frames.map(({ kind }) => kind)).toEqual([PtyFrameKind.Output, PtyFrameKind.Exit]);
    expect(frames[0].payload).toEqual(Uint8Array.of(1, 2));
  });

  it.each([
    {
      corrupt: (frame: Uint8Array) => {
        frame[0] = 0;
      },
      errorCode: 'INVALID_FRAME',
      label: 'magic',
    },
    {
      corrupt: (frame: Uint8Array) => {
        frame[4] = 2;
      },
      errorCode: 'PROTOCOL_MISMATCH',
      label: 'version',
    },
    {
      corrupt: (frame: Uint8Array) => {
        frame[5] = 0xff;
      },
      errorCode: 'INVALID_FRAME',
      label: 'kind',
    },
    {
      corrupt: (frame: Uint8Array) => {
        new DataView(frame.buffer).setUint32(12, 4 * 1024 * 1024 + 1, false);
      },
      errorCode: 'INVALID_FRAME',
      label: 'payload length',
    },
  ])('rejects an invalid $label as soon as the header is complete', ({ corrupt, errorCode }) => {
    const frame = outputFrame(Uint8Array.of(1));
    corrupt(frame);

    expect(() => new PtyFrameDecoder().push(frame.subarray(0, PTY_FRAME_HEADER_SIZE))).toThrow(
      expect.objectContaining({ code: errorCode }),
    );
  });

  it('rejects invalid stream and fixed-size payload combinations before writing', () => {
    expect(() =>
      encodePtyFrame({ kind: PtyFrameKind.Output, payload: Uint8Array.of(1), streamId: 0 }),
    ).toThrow(/zero stream id/i);
    expect(() =>
      encodePtyFrame({ kind: PtyFrameKind.Resize, payload: Uint8Array.of(1), streamId: 2 }),
    ).toThrow(/four bytes/i);
    expect(() => outputFrame(new Uint8Array(PTY_MAX_OUTPUT_PAYLOAD_SIZE + 1))).toThrow(
      /output payload/i,
    );
  });
});
