export const PTY_PROTOCOL_VERSION = 1;

export const PtyFrameKind = {
  Hello: 0x01,
  Create: 0x02,
  Created: 0x03,
  CreateError: 0x04,
  Input: 0x05,
  Output: 0x06,
  Resize: 0x07,
  Kill: 0x08,
  Exit: 0x09,
  Error: 0x0a,
  Shutdown: 0x0b,
} as const;

export type PtyFrameKindValue = (typeof PtyFrameKind)[keyof typeof PtyFrameKind];

export interface PtyFrame {
  kind: PtyFrameKindValue;
  payload: Uint8Array;
  streamId: number;
}

export interface PtyHelloPayload {
  build: string;
  maxVersion: number;
  minVersion: number;
  pid: number;
}

export interface PtyCreatePayload {
  cols: number;
  cwd: string;
  envOverrides: {
    COLORTERM: 'truecolor';
    TERM: 'xterm-256color';
  };
  requestId: number;
  rows: number;
  shell: string;
}

export interface PtyCreatedPayload {
  cwd: string;
  pid: number;
  requestId: number;
  shell: string;
}

export interface PtyErrorPayload {
  code: string;
  fatal: boolean;
  message: string;
  requestId?: number;
}

export interface PtyExitPayload {
  exitCode: number;
  signal: null | number | string;
}

export type PtySidecarErrorCode =
  | 'INVALID_FRAME'
  | 'PROTOCOL_MISMATCH'
  | 'SIDECAR_CRASHED'
  | 'SIDECAR_HANDSHAKE_TIMEOUT'
  | 'SIDECAR_START_FAILED'
  | string;

export class PtySidecarError extends Error {
  constructor(
    readonly code: PtySidecarErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PtySidecarError';
  }
}

export interface PtySidecarClock {
  clearTimeout: (timer: NodeJS.Timeout) => void;
  setTimeout: (callback: () => void, delay: number) => NodeJS.Timeout;
}

export interface PtySidecarLogger {
  debug: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}
