import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PtySidecarTransport } from './index';
import { PtySessionManager } from './index';
import type { PtySidecarCreatedSession, PtySidecarCreateOptions } from './sidecar/PtySidecarClient';

class FakeSidecarClient implements PtySidecarTransport {
  private readonly dataListeners = new Set<(externalId: string, data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(externalId: string, exitCode: number) => void>();
  private nextHandle = 1;

  createSession = vi.fn(
    async (options: PtySidecarCreateOptions): Promise<PtySidecarCreatedSession> => ({
      cwd: options.cwd,
      handle: this.nextHandle++,
      pid: 1000 + this.nextHandle,
      shell: options.shell,
    }),
  );
  killSession = vi.fn(async () => undefined);
  resizeSession = vi.fn(async () => undefined);
  shutdown = vi.fn(async () => undefined);
  writeSession = vi.fn(async () => undefined);

  onData(listener: (externalId: string, data: Uint8Array) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (externalId: string, exitCode: number) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitData(externalId: string, data: Uint8Array) {
    for (const listener of this.dataListeners) listener(externalId, data);
  }

  emitExit(externalId: string, exitCode: number) {
    for (const listener of this.exitListeners) listener(externalId, exitCode);
  }
}

describe('PtySessionManager', () => {
  const managers: PtySessionManager[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createManager = (
    client: FakeSidecarClient,
    options: {
      callbacks?: Partial<ConstructorParameters<typeof PtySessionManager>[0]>;
      isDirectory?: (path: string) => Promise<boolean>;
      now?: () => number;
    } = {},
  ) => {
    const callbacks = {
      onData: vi.fn(),
      onExit: vi.fn(),
      onReap: vi.fn(),
      ...options.callbacks,
    };
    const manager = new PtySessionManager(callbacks, {
      client,
      isDirectory: options.isDirectory ?? (async () => true),
      now: options.now,
    });
    managers.push(manager);
    return { callbacks, manager };
  };

  it('preserves the public create result and falls back to home for a non-directory cwd', async () => {
    const client = new FakeSidecarClient();
    const { manager } = createManager(client, { isDirectory: async () => false });

    const result = await manager.create({ cols: 80, cwd: '/existing-file', rows: 24 });

    expect(result).toMatchObject({
      cwd: os.homedir(),
      id: expect.stringMatching(/^pty_/),
      pid: 1002,
    });
    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 80, cwd: os.homedir(), externalId: result.id, rows: 24 }),
    );
    expect(manager.has(result.id)).toBe(true);
  });

  it('delivers fast-shell final bytes before EXIT after the create result becomes observable', async () => {
    const client = new FakeSidecarClient();
    const orderedEvents: Array<'data' | 'exit'> = [];
    const bytes = Uint8Array.of(0xe4, 0xbd, 0xa0, 0x0d, 0x0a);
    client.createSession.mockImplementation((options: PtySidecarCreateOptions) => {
      const created = {
        cwd: options.cwd,
        handle: 77,
        pid: 7077,
        shell: options.shell,
      };
      return new Promise((resolve) => {
        resolve(created);
        client.emitData(options.externalId, bytes);
        client.emitExit(options.externalId, 0);
      });
    });
    const { manager } = createManager(client, {
      callbacks: {
        onData: () => orderedEvents.push('data'),
        onExit: () => orderedEvents.push('exit'),
      },
    });

    const result = await manager.create({ cols: 80, rows: 24 });
    expect(result).toMatchObject({ id: expect.stringMatching(/^pty_/), pid: 7077 });
    expect(orderedEvents).toEqual([]);

    await vi.advanceTimersToNextTimerAsync();
    expect(orderedEvents).toEqual(['data', 'exit']);
    expect(manager.has(result.id)).toBe(false);
  });

  it('drains buffered fast-shell events when killed before scheduled activation', async () => {
    const client = new FakeSidecarClient();
    const orderedEvents: Array<'data' | 'exit'> = [];
    const bytes = Uint8Array.of(0x66, 0x69, 0x6e, 0x61, 0x6c, 0x0d, 0x0a);
    client.createSession.mockImplementation((options: PtySidecarCreateOptions) => {
      const created = {
        cwd: options.cwd,
        handle: 78,
        pid: 7078,
        shell: options.shell,
      };
      return new Promise((resolve) => {
        resolve(created);
        client.emitData(options.externalId, bytes);
        client.emitExit(options.externalId, 0);
      });
    });
    const { manager } = createManager(client, {
      callbacks: {
        onData: () => orderedEvents.push('data'),
        onExit: () => orderedEvents.push('exit'),
      },
    });

    const result = await manager.create({ cols: 80, rows: 24 });
    await manager.kill(result.id);
    expect(client.killSession).toHaveBeenCalledWith(result.id);
    expect(orderedEvents).toEqual([]);

    await vi.advanceTimersToNextTimerAsync();
    expect(orderedEvents).toEqual(['data', 'exit']);
    expect(manager.has(result.id)).toBe(false);
  });

  it('evicts the least-recently-active session while retaining it until EXIT', async () => {
    const client = new FakeSidecarClient();
    let now = 0;
    const { callbacks, manager } = createManager(client, { now: () => now });
    const sessions = [];
    for (let index = 0; index < 10; index++) {
      now = index;
      sessions.push(await manager.create({ cols: 80, rows: 24 }));
    }

    now = 10;
    const eleventh = await manager.create({ cols: 80, rows: 24 });

    expect(client.killSession).toHaveBeenCalledWith(sessions[0].id);
    expect(callbacks.onReap).toHaveBeenCalledWith(sessions[0].id, 'limit');
    expect(manager.has(sessions[0].id)).toBe(true);
    expect(manager.has(eleventh.id)).toBe(true);

    client.emitExit(sessions[0].id, 0);
    expect(manager.has(sessions[0].id)).toBe(false);
    expect(callbacks.onExit).toHaveBeenCalledWith(sessions[0].id, 0);
  });

  it('refreshes idle activity from byte output and reaps only after 30 inactive minutes', async () => {
    const client = new FakeSidecarClient();
    let now = 0;
    const onData = vi.fn();
    const { callbacks, manager } = createManager(client, {
      callbacks: { onData },
      now: () => now,
    });
    const session = await manager.create({ cols: 80, rows: 24 });

    now = 20 * 60 * 1000;
    const bytes = Uint8Array.of(0xe4, 0xbd, 0xa0);
    client.emitData(session.id, bytes);
    now = 40 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(client.killSession).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledWith(session.id, bytes);

    now = 51 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(client.killSession).toHaveBeenCalledWith(session.id);
    expect(callbacks.onReap).toHaveBeenCalledWith(session.id, 'idle');
  });

  it('rejects malformed create dimensions before calling the sidecar', async () => {
    const client = new FakeSidecarClient();
    const { manager } = createManager(client);
    const invalidDimensions = [0, 1001, Number.NaN, Number.POSITIVE_INFINITY, 80.5];

    for (const dimension of invalidDimensions) {
      await expect(manager.create({ cols: dimension, rows: 24 })).rejects.toThrow(
        /between 1 and 1000/i,
      );
      await expect(manager.create({ cols: 80, rows: dimension })).rejects.toThrow(
        /between 1 and 1000/i,
      );
    }

    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('rejects malformed resize dimensions before calling the sidecar', async () => {
    const client = new FakeSidecarClient();
    const { manager } = createManager(client);
    const session = await manager.create({ cols: 80, rows: 24 });
    const invalidDimensions = [1001, Number.NaN, Number.POSITIVE_INFINITY, 80.5];

    for (const dimension of invalidDimensions) {
      await expect(manager.resize(session.id, dimension, 24)).rejects.toThrow(
        /between 1 and 1000/i,
      );
      await expect(manager.resize(session.id, 80, dimension)).rejects.toThrow(
        /between 1 and 1000/i,
      );
    }
    expect(client.resizeSession).not.toHaveBeenCalled();

    await manager.resize(session.id, 0, 24);
    await manager.resize(session.id, 80, -1);
    expect(client.resizeSession).not.toHaveBeenCalled();

    await manager.resize(session.id, 120, 40);
    expect(client.resizeSession).toHaveBeenCalledWith(session.id, 120, 40);
  });

  it('forwards a sidecar crash exit exactly once and clears the session', async () => {
    const client = new FakeSidecarClient();
    const { callbacks, manager } = createManager(client);
    const session = await manager.create({ cols: 80, rows: 24 });
    await vi.advanceTimersToNextTimerAsync();

    client.emitExit(session.id, -1);

    expect(callbacks.onExit).toHaveBeenCalledOnce();
    expect(callbacks.onExit).toHaveBeenCalledWith(session.id, -1);
    expect(manager.has(session.id)).toBe(false);
  });
});
