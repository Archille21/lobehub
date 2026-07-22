import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';

import { createLogger } from '@/utils/logger';

import { resolvePtySidecarBinaryPath } from './binaryPath';
import { encodePtyFrame, PtyFrameDecoder } from './frameCodec';
import type {
  PtyCreatedPayload,
  PtyCreatePayload,
  PtyErrorPayload,
  PtyFrame,
  PtyHelloPayload,
  PtySidecarClock,
  PtySidecarLogger,
} from './types';
import { PTY_PROTOCOL_VERSION, PtyFrameKind, PtySidecarError } from './types';

const HANDSHAKE_TIMEOUT_MS = 3000;
const SHUTDOWN_TIMEOUT_MS = 750;
const UINT32_MAX = 0xffff_ffff;

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const textEncoder = new TextEncoder();

const helloSchema = z
  .object({
    build: z.string(),
    maxVersion: z.number().int().nonnegative(),
    minVersion: z.number().int().nonnegative(),
    pid: z.number().int().positive(),
  })
  .strict();
const createdSchema = z
  .object({
    cwd: z.string(),
    pid: z.number().int().positive(),
    requestId: z.number().int().min(1).max(UINT32_MAX),
    shell: z.string(),
  })
  .strict();
const errorSchema = z
  .object({
    code: z.string(),
    fatal: z.boolean(),
    message: z.string(),
    requestId: z.number().int().min(1).max(UINT32_MAX).optional(),
  })
  .strict();
const exitSchema = z
  .object({
    exitCode: z.number().int(),
    signal: z.union([z.string(), z.number().int(), z.null()]),
  })
  .strict();

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let reject!: Deferred<T>['reject'];
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
};

interface SidecarProcessState {
  child: ChildProcessWithoutNullStreams;
  closed: Deferred<void>;
  decoder: PtyFrameDecoder;
  failed: boolean;
  generation: number;
  hello: Deferred<PtyHelloPayload>;
  helloTimer: NodeJS.Timeout;
  intentionalShutdown: boolean;
  ready: boolean;
  stderrDecoder: StringDecoder;
  stderrPending: string;
  writeTail: Promise<void>;
}

interface PendingCreate {
  externalId: string;
  generation: number;
  response: Deferred<PtySidecarCreatedSession>;
}

export interface PtySidecarCreatedSession {
  cwd: string;
  handle: number;
  pid: number;
  shell: string;
}

export interface PtySidecarCreateOptions {
  cols: number;
  cwd: string;
  externalId: string;
  rows: number;
  shell: string;
}

interface PtySidecarClientOptions {
  backpressureLogger?: PtySidecarLogger;
  binaryResolver?: () => Promise<string>;
  clock?: PtySidecarClock;
  logger?: PtySidecarLogger;
  spawnProcess?: typeof spawn;
}

type DataListener = (externalId: string, data: Uint8Array) => void;
type ExitListener = (externalId: string, exitCode: number) => void;

const defaultClock: PtySidecarClock = {
  clearTimeout: (timer) => clearTimeout(timer),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
};

const parseControlPayload = <T>(payload: Uint8Array, schema: z.ZodType<T>, label: string): T => {
  try {
    const parsedJson: unknown = JSON.parse(textDecoder.decode(payload));
    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    return parsed.data;
  } catch (cause) {
    throw new PtySidecarError('INVALID_FRAME', `Invalid ${label} payload`, { cause });
  }
};

const serializeControlPayload = (payload: PtyCreatePayload): Uint8Array =>
  textEncoder.encode(JSON.stringify(payload));

const validateDimensions = (cols: number, rows: number) => {
  if (
    !Number.isFinite(cols) ||
    !Number.isInteger(cols) ||
    !Number.isFinite(rows) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 1000 ||
    rows > 1000
  ) {
    throw new RangeError('Terminal dimensions must be between 1 and 1000');
  }
};

export class PtySidecarClient {
  private readonly backpressureLogger: PtySidecarLogger;
  private readonly binaryResolver: () => Promise<string>;
  private readonly clock: PtySidecarClock;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private readonly externalToHandle = new Map<string, number>();
  private generation = 0;
  private readonly handleToExternal = new Map<number, string>();
  private readonly logger: PtySidecarLogger;
  private nextRequestId = 1;
  private readonly pendingCreates = new Map<number, PendingCreate>();
  private processState: SidecarProcessState | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private readonly spawnProcess: typeof spawn;
  private startPromise: Promise<void> | null = null;

  constructor({
    backpressureLogger = createLogger('terminal:backpressure'),
    binaryResolver = resolvePtySidecarBinaryPath,
    clock = defaultClock,
    logger = createLogger('terminal:sidecar'),
    spawnProcess = spawn,
  }: PtySidecarClientOptions = {}) {
    this.backpressureLogger = backpressureLogger;
    this.binaryResolver = binaryResolver;
    this.clock = clock;
    this.logger = logger;
    this.spawnProcess = spawnProcess;
  }

  onData(listener: DataListener) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: ExitListener) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async ensureStarted(): Promise<void> {
    if (this.shuttingDown) {
      throw new PtySidecarError('SIDECAR_START_FAILED', 'The terminal sidecar is shutting down');
    }
    if (this.processState?.ready && !this.processState.failed) return;
    if (this.startPromise) return this.startPromise;

    const startPromise = this.start();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  async createSession({
    cols,
    cwd,
    externalId,
    rows,
    shell,
  }: PtySidecarCreateOptions): Promise<PtySidecarCreatedSession> {
    validateDimensions(cols, rows);
    await this.ensureStarted();
    if (
      this.externalToHandle.has(externalId) ||
      [...this.pendingCreates.values()].some((pending) => pending.externalId === externalId)
    ) {
      throw new PtySidecarError('SESSION_CREATE_FAILED', 'The terminal session already exists');
    }
    const state = this.requireReadyState();
    const requestId = this.takeRequestId();
    const response = createDeferred<PtySidecarCreatedSession>();
    this.pendingCreates.set(requestId, { externalId, generation: state.generation, response });

    const payload: PtyCreatePayload = {
      cols,
      cwd,
      envOverrides: { COLORTERM: 'truecolor', TERM: 'xterm-256color' },
      requestId,
      rows,
      shell,
    };

    try {
      await this.sendFrame(state, {
        kind: PtyFrameKind.Create,
        payload: serializeControlPayload(payload),
        streamId: 0,
      });
    } catch (cause) {
      const pending = this.pendingCreates.get(requestId);
      if (pending) {
        this.pendingCreates.delete(requestId);
        pending.response.reject(cause);
      }
    }

    return response.promise;
  }

  async writeSession(externalId: string, data: string): Promise<void> {
    const handle = this.externalToHandle.get(externalId);
    if (handle === undefined || data.length === 0) return;
    const state = this.requireReadyState();
    await this.sendFrame(state, {
      kind: PtyFrameKind.Input,
      payload: textEncoder.encode(data),
      streamId: handle,
    });
  }

  async resizeSession(externalId: string, cols: number, rows: number): Promise<void> {
    validateDimensions(cols, rows);

    const handle = this.externalToHandle.get(externalId);
    if (handle === undefined) return;
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, cols, false);
    view.setUint16(2, rows, false);
    await this.sendFrame(this.requireReadyState(), {
      kind: PtyFrameKind.Resize,
      payload,
      streamId: handle,
    });
  }

  async killSession(externalId: string): Promise<void> {
    const handle = this.externalToHandle.get(externalId);
    if (handle === undefined) return;
    await this.sendFrame(this.requireReadyState(), {
      kind: PtyFrameKind.Kill,
      payload: new Uint8Array(),
      streamId: handle,
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownProcess();
    return this.shutdownPromise;
  }

  private async start() {
    let binaryPath: string;
    try {
      binaryPath = await this.binaryResolver();
    } catch (cause) {
      if (cause instanceof PtySidecarError) throw cause;
      throw new PtySidecarError(
        'SIDECAR_START_FAILED',
        'Failed to resolve the terminal sidecar binary',
        { cause },
      );
    }

    if (this.shuttingDown) {
      throw new PtySidecarError('SIDECAR_START_FAILED', 'The terminal sidecar is shutting down');
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawnProcess(binaryPath, [], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      throw new PtySidecarError('SIDECAR_START_FAILED', 'Failed to start the terminal sidecar', {
        cause,
      });
    }

    const generation = ++this.generation;
    const state = {
      child,
      closed: createDeferred<void>(),
      decoder: new PtyFrameDecoder(),
      failed: false,
      generation,
      hello: createDeferred<PtyHelloPayload>(),
      intentionalShutdown: false,
      ready: false,
      stderrDecoder: new StringDecoder('utf8'),
      stderrPending: '',
      writeTail: Promise.resolve(),
    } as SidecarProcessState;
    state.helloTimer = this.clock.setTimeout(() => {
      const error = new PtySidecarError(
        'SIDECAR_HANDSHAKE_TIMEOUT',
        'The terminal sidecar did not complete its handshake in time',
      );
      this.terminateProcess(state, error, true);
    }, HANDSHAKE_TIMEOUT_MS);

    this.processState = state;
    this.logger.info(`starting PTY sidecar generation ${generation}`);
    child.stdout.on('data', (chunk: Uint8Array) => this.handleStdout(state, chunk));
    child.stderr.on('data', (chunk: Uint8Array) => this.handleStderr(state, chunk));
    child.stdin.on('error', (cause) => {
      this.terminateProcess(
        state,
        new PtySidecarError('SIDECAR_CRASHED', 'The terminal sidecar input stream failed', {
          cause,
        }),
        true,
      );
    });
    child.once('error', (cause) => {
      const code = state.ready ? 'SIDECAR_CRASHED' : 'SIDECAR_START_FAILED';
      this.terminateProcess(
        state,
        new PtySidecarError(code, 'The terminal sidecar process failed', { cause }),
        false,
      );
    });
    child.once('close', (exitCode, signal) => {
      const suffix = signal ? ` (${signal})` : exitCode === null ? '' : ` (${exitCode})`;
      const error = new PtySidecarError(
        state.ready ? 'SIDECAR_CRASHED' : 'SIDECAR_START_FAILED',
        `The terminal sidecar exited unexpectedly${suffix}`,
      );
      this.terminateProcess(state, error, false);
    });

    const hello = await state.hello.promise;
    this.logger.info(
      `PTY sidecar ready (generation ${generation}, build ${hello.build}, pid ${hello.pid})`,
    );
  }

  private handleStdout(state: SidecarProcessState, chunk: Uint8Array) {
    if (state.failed) return;
    try {
      const frames = state.decoder.push(chunk);
      for (const frame of frames) {
        this.handleFrame(state, frame);
        if (state.failed) break;
      }
    } catch (cause) {
      const error =
        cause instanceof PtySidecarError
          ? cause
          : new PtySidecarError('INVALID_FRAME', 'Failed to decode a terminal sidecar frame', {
              cause,
            });
      this.terminateProcess(state, error, true);
    }
  }

  private handleFrame(state: SidecarProcessState, frame: PtyFrame) {
    if (!state.ready) {
      if (frame.kind !== PtyFrameKind.Hello) {
        throw new PtySidecarError('INVALID_FRAME', 'PTY sidecar sent data before HELLO');
      }
      this.handleHello(state, frame.payload);
      return;
    }

    switch (frame.kind) {
      case PtyFrameKind.Created: {
        this.handleCreated(state, frame.streamId, frame.payload);
        return;
      }
      case PtyFrameKind.CreateError: {
        this.handleCreateError(state, frame.payload);
        return;
      }
      case PtyFrameKind.Output: {
        const externalId = this.requireExternalId(frame.streamId);
        this.emitData(externalId, frame.payload);
        return;
      }
      case PtyFrameKind.Exit: {
        const payload = parseControlPayload(frame.payload, exitSchema, 'EXIT');
        const externalId = this.requireExternalId(frame.streamId);
        this.externalToHandle.delete(externalId);
        this.handleToExternal.delete(frame.streamId);
        this.emitExit(externalId, payload.exitCode);
        return;
      }
      case PtyFrameKind.Error: {
        this.handleErrorFrame(state, frame.streamId, frame.payload);
        return;
      }
      default: {
        throw new PtySidecarError(
          'INVALID_FRAME',
          `PTY sidecar sent an invalid frame kind ${frame.kind}`,
        );
      }
    }
  }

  private handleHello(state: SidecarProcessState, bytes: Uint8Array) {
    const payload = parseControlPayload<PtyHelloPayload>(bytes, helloSchema, 'HELLO');
    if (
      payload.minVersion > payload.maxVersion ||
      payload.minVersion > PTY_PROTOCOL_VERSION ||
      payload.maxVersion < PTY_PROTOCOL_VERSION
    ) {
      throw new PtySidecarError(
        'PROTOCOL_MISMATCH',
        'The terminal sidecar protocol version is incompatible',
      );
    }

    this.clock.clearTimeout(state.helloTimer);
    state.ready = true;
    state.hello.resolve(payload);
  }

  private handleCreated(state: SidecarProcessState, handle: number, bytes: Uint8Array) {
    const payload = parseControlPayload<PtyCreatedPayload>(bytes, createdSchema, 'CREATED');
    const pending = this.pendingCreates.get(payload.requestId);
    if (!pending || pending.generation !== state.generation) {
      throw new PtySidecarError('INVALID_FRAME', 'CREATED has no matching create request');
    }
    if (this.handleToExternal.has(handle) || this.externalToHandle.has(pending.externalId)) {
      throw new PtySidecarError('INVALID_FRAME', 'CREATED reuses an active terminal session');
    }

    this.pendingCreates.delete(payload.requestId);
    this.externalToHandle.set(pending.externalId, handle);
    this.handleToExternal.set(handle, pending.externalId);
    pending.response.resolve({
      cwd: payload.cwd,
      handle,
      pid: payload.pid,
      shell: payload.shell,
    });
  }

  private handleCreateError(state: SidecarProcessState, bytes: Uint8Array) {
    const payload = parseControlPayload<PtyErrorPayload>(bytes, errorSchema, 'CREATE_ERROR');
    if (payload.requestId === undefined) {
      throw new PtySidecarError('INVALID_FRAME', 'CREATE_ERROR is missing requestId');
    }

    const pending = this.pendingCreates.get(payload.requestId);
    if (!pending || pending.generation !== state.generation) {
      throw new PtySidecarError('INVALID_FRAME', 'CREATE_ERROR has no matching create request');
    }
    this.pendingCreates.delete(payload.requestId);
    pending.response.reject(new PtySidecarError(payload.code, payload.message));
  }

  private handleErrorFrame(state: SidecarProcessState, streamId: number, bytes: Uint8Array) {
    const payload = parseControlPayload<PtyErrorPayload>(bytes, errorSchema, 'ERROR');
    if (payload.fatal) {
      throw new PtySidecarError(payload.code, payload.message);
    }

    const externalId = streamId === 0 ? undefined : this.handleToExternal.get(streamId);
    this.logger.warn(
      `PTY sidecar reported ${payload.code}${externalId ? ` for ${externalId}` : ''}: ${payload.message}`,
    );
    if (payload.requestId !== undefined) {
      const pending = this.pendingCreates.get(payload.requestId);
      if (pending?.generation === state.generation) {
        this.pendingCreates.delete(payload.requestId);
        pending.response.reject(new PtySidecarError(payload.code, payload.message));
      }
    }
  }

  private handleStderr(state: SidecarProcessState, chunk: Uint8Array) {
    if (state.failed) return;
    state.stderrPending += state.stderrDecoder.write(chunk);
    const lines = state.stderrPending.split(/\r?\n/);
    state.stderrPending = lines.pop() ?? '';
    for (const line of lines) this.logStderrLine(line);
  }

  private logStderrLine(line: string) {
    const normalizedLine = line.trim().replace(/^\[pty-sidecar\]\s*/i, '');
    if (!normalizedLine) return;
    const backpressure = normalizedLine.match(
      /^session (\d+) dropped (\d+) output bytes due to backpressure$/i,
    );
    if (backpressure) {
      const [, handle, droppedBytes] = backpressure;
      const externalId = this.handleToExternal.get(Number(handle));
      const session = externalId ? `${externalId} (handle ${handle})` : `handle ${handle}`;
      this.backpressureLogger.warn(
        `session ${session} dropped ${droppedBytes} output bytes (writer queue state: saturated)`,
      );
    }
    const message = `[pty-sidecar] ${normalizedLine}`;
    if (/^(?:\[?error\]?|fatal|failed)\b/i.test(normalizedLine)) {
      this.logger.error(message);
    } else if (/^\[?warn(?:ing)?\]?\b/i.test(normalizedLine)) {
      this.logger.warn(message);
    } else {
      this.logger.debug(message);
    }
  }

  private requireExternalId(handle: number) {
    const externalId = this.handleToExternal.get(handle);
    if (!externalId) {
      throw new PtySidecarError('INVALID_FRAME', 'PTY frame references an unknown session');
    }
    return externalId;
  }

  private requireReadyState() {
    const state = this.processState;
    if (!state?.ready || state.failed) {
      throw new PtySidecarError('SIDECAR_CRASHED', 'The terminal sidecar is unavailable');
    }
    return state;
  }

  private takeRequestId() {
    for (let attempts = 0; attempts < UINT32_MAX; attempts++) {
      const requestId = this.nextRequestId;
      this.nextRequestId = requestId === UINT32_MAX ? 1 : requestId + 1;
      if (!this.pendingCreates.has(requestId)) return requestId;
    }
    throw new PtySidecarError('SESSION_CREATE_FAILED', 'No terminal create request ids remain');
  }

  private async sendFrame(state: SidecarProcessState, frame: PtyFrame) {
    const encoded = encodePtyFrame(frame);
    const write = state.writeTail.then(async () => {
      if (state.failed || this.processState !== state) {
        throw new PtySidecarError('SIDECAR_CRASHED', 'The terminal sidecar is unavailable');
      }
      if (state.child.stdin.write(encoded)) return;
      await this.waitForDrain(state);
    });

    state.writeTail = write.catch((cause) => {
      const error =
        cause instanceof PtySidecarError
          ? cause
          : new PtySidecarError('SIDECAR_CRASHED', 'Failed to write to the terminal sidecar', {
              cause,
            });
      this.terminateProcess(state, error, true);
    });
    return write;
  }

  private waitForDrain(state: SidecarProcessState) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        state.child.stdin.off('drain', handleDrain);
        state.child.stdin.off('error', handleError);
        state.child.off('close', handleClose);
      };
      const handleDrain = () => {
        cleanup();
        resolve();
      };
      const handleError = (cause: Error) => {
        cleanup();
        reject(cause);
      };
      const handleClose = () => {
        cleanup();
        reject(new PtySidecarError('SIDECAR_CRASHED', 'The terminal sidecar exited'));
      };

      state.child.stdin.once('drain', handleDrain);
      state.child.stdin.once('error', handleError);
      state.child.once('close', handleClose);
    });
  }

  private terminateProcess(state: SidecarProcessState, error: PtySidecarError, kill: boolean) {
    if (state.failed) return;
    state.failed = true;
    this.clock.clearTimeout(state.helloTimer);

    const stderrTail = state.stderrPending + state.stderrDecoder.end();
    state.stderrPending = '';
    this.logStderrLine(stderrTail);

    if (!state.ready) state.hello.reject(error);
    if (this.processState === state) this.processState = null;

    for (const [requestId, pending] of this.pendingCreates) {
      if (pending.generation !== state.generation) continue;
      this.pendingCreates.delete(requestId);
      pending.response.reject(error);
    }

    const affectedSessions = [...this.externalToHandle.keys()];
    this.externalToHandle.clear();
    this.handleToExternal.clear();

    if (!state.intentionalShutdown) {
      this.logger.error(
        `PTY sidecar generation ${state.generation} stopped (${error.code}): ${error.message}`,
      );
      for (const externalId of affectedSessions) this.emitExit(externalId, -1);
    }

    if (kill && !state.child.killed) {
      try {
        state.child.kill();
      } catch (cause) {
        this.logger.warn('failed to kill the terminal sidecar process', cause);
      }
    }
    state.closed.resolve();
  }

  private emitExit(externalId: string, exitCode: number) {
    for (const listener of this.exitListeners) {
      try {
        listener(externalId, exitCode);
      } catch (cause) {
        this.logger.error(`terminal exit listener failed for ${externalId}`, cause);
      }
    }
  }

  private emitData(externalId: string, data: Uint8Array) {
    for (const listener of this.dataListeners) {
      try {
        listener(externalId, data);
      } catch (cause) {
        this.logger.error(`terminal data listener failed for ${externalId}`, cause);
      }
    }
  }

  private async shutdownProcess() {
    const state = this.processState;
    if (!state || state.failed) return;
    state.intentionalShutdown = true;

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = this.clock.setTimeout(() => {
        timedOut = true;
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });

    const gracefulShutdown = (async () => {
      await this.sendFrame(state, {
        kind: PtyFrameKind.Shutdown,
        payload: new Uint8Array(),
        streamId: 0,
      });
      await state.closed.promise;
    })();

    try {
      await Promise.race([gracefulShutdown, timeout]);
    } catch (cause) {
      this.logger.warn('graceful terminal sidecar shutdown failed', cause);
    } finally {
      if (timer) this.clock.clearTimeout(timer);
    }

    if (timedOut || !state.failed) {
      if (timedOut) this.logger.warn('terminal sidecar did not exit within 750 ms; forcing exit');
      this.terminateProcess(
        state,
        new PtySidecarError('SIDECAR_CRASHED', 'The terminal sidecar was stopped during shutdown'),
        true,
      );
    }
  }
}
