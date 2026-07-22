import type { spawn as NodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { encodePtyFrame, PtyFrameDecoder } from './frameCodec';
import { PtySidecarClient } from './PtySidecarClient';
import type { PtyFrame, PtySidecarLogger } from './types';
import { PtyFrameKind } from './types';

interface FakeStdin extends EventEmitter {
  write: ReturnType<typeof vi.fn<(chunk: Uint8Array) => boolean>>;
}

interface FakeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  stderr: PassThrough;
  stdin: FakeStdin;
  stdout: PassThrough;
}

const textEncoder = new TextEncoder();

const jsonBytes = (value: unknown) => textEncoder.encode(JSON.stringify(value));

const frame = (kind: PtyFrame['kind'], streamId: number, payload: unknown): PtyFrame => ({
  kind,
  payload: payload instanceof Uint8Array ? payload : jsonBytes(payload),
  streamId,
});

const helloFrame = (versions = { maxVersion: 1, minVersion: 1 }) =>
  frame(PtyFrameKind.Hello, 0, { build: '0.1.0-test', pid: 9100, ...versions });

const createFakeChild = () => {
  const child = new EventEmitter() as FakeChild;
  const stdin = new EventEmitter() as FakeStdin;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: PtyFrame[] = [];
  const decoder = new PtyFrameDecoder();
  const writeResults: boolean[] = [];

  stdin.write = vi.fn((chunk: Uint8Array) => {
    writes.push(...decoder.push(new Uint8Array(chunk)));
    return writeResults.shift() ?? true;
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });

  const deliver = (...frames: PtyFrame[]) => {
    const encoded = frames.map(encodePtyFrame);
    const size = encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const item of encoded) {
      bytes.set(item, offset);
      offset += item.byteLength;
    }
    stdout.write(bytes);
  };

  return { child, deliver, writeResults, writes };
};

const asSpawn = (implementation: () => FakeChild) =>
  vi.fn(implementation) as unknown as typeof NodeSpawn;

const createLogger = (): PtySidecarLogger => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
});

const startClient = async (client: PtySidecarClient, fake: ReturnType<typeof createFakeChild>) => {
  const started = client.ensureStarted();
  await vi.waitFor(() => expect(fake.child.stdout.listenerCount('data')).toBe(1));
  fake.deliver(helloFrame());
  await started;
};

const createSession = async (
  client: PtySidecarClient,
  fake: ReturnType<typeof createFakeChild>,
  externalId: string,
  handle: number,
) => {
  const before = fake.writes.length;
  const pending = client.createSession({
    cols: 80,
    cwd: '/workspace',
    externalId,
    rows: 24,
    shell: '/bin/zsh',
  });
  await vi.waitFor(() => expect(fake.writes.length).toBeGreaterThan(before));
  const create = fake.writes.findLast(({ kind }) => kind === PtyFrameKind.Create);
  const payload = JSON.parse(new TextDecoder().decode(create?.payload)) as { requestId: number };
  fake.deliver(
    frame(PtyFrameKind.Created, handle, {
      cwd: '/workspace',
      pid: 9200 + handle,
      requestId: payload.requestId,
      shell: '/bin/zsh',
    }),
  );
  return pending;
};

describe('PtySidecarClient', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('correlates concurrent creates and routes raw bytes through bidirectional session mappings', async () => {
    const fake = createFakeChild();
    const spawnProcess = asSpawn(() => fake.child);
    const client = new PtySidecarClient({
      binaryResolver: async () => '/fake/lobe-pty-sidecar',
      logger: createLogger(),
      spawnProcess,
    });
    const events: Array<{ data?: Uint8Array; exitCode?: number; id: string }> = [];
    client.onData((id, data) => events.push({ data, id }));
    client.onExit((id, exitCode) => events.push({ exitCode, id }));
    await startClient(client, fake);

    const first = client.createSession({
      cols: 80,
      cwd: '/one',
      externalId: 'external-one',
      rows: 24,
      shell: '/bin/zsh',
    });
    const second = client.createSession({
      cols: 100,
      cwd: '/two',
      externalId: 'external-two',
      rows: 30,
      shell: '/bin/zsh',
    });
    await vi.waitFor(() =>
      expect(fake.writes.filter(({ kind }) => kind === PtyFrameKind.Create)).toHaveLength(2),
    );
    const creates = fake.writes
      .filter(({ kind }) => kind === PtyFrameKind.Create)
      .map(({ payload }) => JSON.parse(new TextDecoder().decode(payload)) as { requestId: number });

    fake.deliver(
      frame(PtyFrameKind.Created, 22, {
        cwd: '/two',
        pid: 222,
        requestId: creates[1].requestId,
        shell: '/bin/zsh',
      }),
      frame(PtyFrameKind.Created, 11, {
        cwd: '/one',
        pid: 111,
        requestId: creates[0].requestId,
        shell: '/bin/zsh',
      }),
    );

    await expect(first).resolves.toMatchObject({ cwd: '/one', handle: 11, pid: 111 });
    await expect(second).resolves.toMatchObject({ cwd: '/two', handle: 22, pid: 222 });

    await client.killSession('external-one');
    expect(fake.writes.at(-1)).toMatchObject({ kind: PtyFrameKind.Kill, streamId: 11 });

    const raw = Uint8Array.of(0x1b, 0x5b, 0x31, 0x6d, 0xe4, 0xbd, 0xa0);
    fake.deliver(
      frame(PtyFrameKind.Output, 11, raw),
      frame(PtyFrameKind.Exit, 11, { exitCode: 0, signal: null }),
    );
    expect(events).toEqual([
      { data: raw, id: 'external-one' },
      { exitCode: 0, id: 'external-one' },
    ]);

    const writesBeforeMissingSession = fake.writes.length;
    await client.writeSession('external-one', 'ignored');
    expect(fake.writes).toHaveLength(writesBeforeMissingSession);
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it('rejects a HELLO timeout and an incompatible protocol without falling back', async () => {
    vi.useFakeTimers();
    const timedOutFake = createFakeChild();
    const timedOutClient = new PtySidecarClient({
      binaryResolver: async () => '/fake/sidecar',
      logger: createLogger(),
      spawnProcess: asSpawn(() => timedOutFake.child),
    });
    const timedOut = timedOutClient.ensureStarted();
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({
      code: 'SIDECAR_HANDSHAKE_TIMEOUT',
    });
    await vi.waitFor(() => expect(timedOutFake.child.stdout.listenerCount('data')).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);
    await timeoutAssertion;
    expect(timedOutFake.child.kill).toHaveBeenCalledOnce();

    vi.useRealTimers();
    const mismatchFake = createFakeChild();
    const mismatchClient = new PtySidecarClient({
      binaryResolver: async () => '/fake/sidecar',
      logger: createLogger(),
      spawnProcess: asSpawn(() => mismatchFake.child),
    });
    const mismatched = mismatchClient.ensureStarted();
    await vi.waitFor(() => expect(mismatchFake.child.stdout.listenerCount('data')).toBe(1));
    mismatchFake.deliver(helloFrame({ maxVersion: 2, minVersion: 2 }));
    await expect(mismatched).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });
    expect(mismatchFake.child.kill).toHaveBeenCalledOnce();
  });

  it('serializes stdin writes behind drain backpressure', async () => {
    const fake = createFakeChild();
    const client = new PtySidecarClient({
      binaryResolver: async () => '/fake/sidecar',
      logger: createLogger(),
      spawnProcess: asSpawn(() => fake.child),
    });
    await startClient(client, fake);
    await createSession(client, fake, 'external', 5);

    fake.writeResults.push(false);
    const first = client.writeSession('external', 'first');
    await vi.waitFor(() =>
      expect(fake.writes.filter(({ kind }) => kind === PtyFrameKind.Input)).toHaveLength(1),
    );
    const second = client.writeSession('external', 'second');
    await Promise.resolve();
    expect(fake.writes.filter(({ kind }) => kind === PtyFrameKind.Input)).toHaveLength(1);

    fake.child.stdin.emit('drain');
    await Promise.all([first, second]);
    const inputs = fake.writes
      .filter(({ kind }) => kind === PtyFrameKind.Input)
      .map(({ payload }) => new TextDecoder().decode(payload));
    expect(inputs).toEqual(['first', 'second']);
  });

  it('rejects malformed dimensions before starting or writing to the sidecar', async () => {
    const fake = createFakeChild();
    const spawnProcess = asSpawn(() => fake.child);
    const client = new PtySidecarClient({
      binaryResolver: async () => '/fake/sidecar',
      logger: createLogger(),
      spawnProcess,
    });
    const invalidDimensions = [0, 1001, Number.NaN, Number.POSITIVE_INFINITY, 80.5];

    for (const dimension of invalidDimensions) {
      await expect(
        client.createSession({
          cols: dimension,
          cwd: '/workspace',
          externalId: `invalid-cols-${dimension}`,
          rows: 24,
          shell: '/bin/zsh',
        }),
      ).rejects.toThrow(/between 1 and 1000/i);
      await expect(
        client.createSession({
          cols: 80,
          cwd: '/workspace',
          externalId: `invalid-rows-${dimension}`,
          rows: dimension,
          shell: '/bin/zsh',
        }),
      ).rejects.toThrow(/between 1 and 1000/i);
    }
    expect(spawnProcess).not.toHaveBeenCalled();

    await startClient(client, fake);
    await createSession(client, fake, 'external', 5);
    const writesBeforeResize = fake.writes.length;
    for (const dimension of invalidDimensions) {
      await expect(client.resizeSession('external', dimension, 24)).rejects.toThrow(
        /between 1 and 1000/i,
      );
      await expect(client.resizeSession('external', 80, dimension)).rejects.toThrow(
        /between 1 and 1000/i,
      );
    }
    expect(fake.writes).toHaveLength(writesBeforeResize);

    await client.resizeSession('external', 1000, 1);
    const resize = fake.writes.at(-1);
    expect(resize).toMatchObject({ kind: PtyFrameKind.Resize, streamId: 5 });
    expect(resize?.payload).toEqual(Uint8Array.of(0x03, 0xe8, 0x00, 0x01));
  });

  it('fans a crash out once per session and lazily starts a fresh process on the next create', async () => {
    const firstFake = createFakeChild();
    const secondFake = createFakeChild();
    const processes = [firstFake, secondFake];
    const spawnProcess = asSpawn(() => {
      const next = processes.shift();
      if (!next) throw new Error('unexpected spawn');
      return next.child;
    });
    const client = new PtySidecarClient({
      binaryResolver: async () => '/fake/sidecar',
      logger: createLogger(),
      spawnProcess,
    });
    const exits = vi.fn();
    client.onExit(exits);
    await startClient(client, firstFake);
    await createSession(client, firstFake, 'one', 1);
    await createSession(client, firstFake, 'two', 2);

    firstFake.child.emit('close', 9, null);
    firstFake.child.emit('error', new Error('late error'));
    expect(exits.mock.calls).toEqual([
      ['one', -1],
      ['two', -1],
    ]);

    const restarted = client.ensureStarted();
    await vi.waitFor(() => expect(secondFake.child.stdout.listenerCount('data')).toBe(1));
    secondFake.deliver(helloFrame());
    await restarted;
    await createSession(client, secondFake, 'three', 3);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('logs sidecar stderr separately and force-kills after the 750 ms shutdown deadline', async () => {
    vi.useFakeTimers();
    const fake = createFakeChild();
    const backpressureLogger = createLogger();
    const logger = createLogger();
    const data = vi.fn();
    const client = new PtySidecarClient({
      backpressureLogger,
      binaryResolver: async () => '/fake/sidecar',
      logger,
      spawnProcess: asSpawn(() => fake.child),
    });
    client.onData(data);
    const started = client.ensureStarted();
    await vi.waitFor(() => expect(fake.child.stdout.listenerCount('data')).toBe(1));
    fake.deliver(helloFrame());
    await started;

    fake.child.stderr.write(
      '[pty-sidecar] fatal error: protocol input failed\n' +
        '[pty-sidecar] error: invalid control frame\n' +
        '[pty-sidecar] failed to create session: spawn shell\n' +
        '[pty-sidecar] session 7 dropped 128 output bytes due to backpressure\n',
    );
    expect(logger.error).toHaveBeenCalledWith('[pty-sidecar] fatal error: protocol input failed');
    expect(logger.error).toHaveBeenCalledWith('[pty-sidecar] error: invalid control frame');
    expect(logger.error).toHaveBeenCalledWith(
      '[pty-sidecar] failed to create session: spawn shell',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      '[pty-sidecar] session 7 dropped 128 output bytes due to backpressure',
    );
    expect(backpressureLogger.warn).toHaveBeenCalledWith(
      'session handle 7 dropped 128 output bytes (writer queue state: saturated)',
    );
    expect(data).not.toHaveBeenCalled();

    const shutdown = client.shutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.writes.some(({ kind }) => kind === PtyFrameKind.Shutdown)).toBe(true);
    await vi.advanceTimersByTimeAsync(749);
    expect(fake.child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(fake.child.kill).toHaveBeenCalledOnce();
  });
});
