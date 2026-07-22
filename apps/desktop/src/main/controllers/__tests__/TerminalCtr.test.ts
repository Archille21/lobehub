import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { App } from '@/core/App';
import type { PtySessionCallbacks } from '@/modules/terminal';

import TerminalCtr from '../TerminalCtr';

const { appOn, appQuit, callbackBox, ipcHandle, manager } = vi.hoisted(() => ({
  appOn: vi.fn(),
  appQuit: vi.fn(),
  callbackBox: { current: undefined as PtySessionCallbacks | undefined },
  ipcHandle: vi.fn(),
  manager: {
    create: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(),
    write: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: { on: appOn, quit: appQuit },
  ipcMain: { handle: ipcHandle },
}));

vi.mock('@/modules/terminal', () => ({
  PtySessionManager: class {
    constructor(callbacks: PtySessionCallbacks) {
      callbackBox.current = callbacks;
      return manager;
    }
  },
}));

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

describe('TerminalCtr', () => {
  const broadcastToAllWindows = vi.fn();
  const app = { browserManager: { broadcastToAllWindows } } as unknown as App;

  beforeEach(() => {
    vi.clearAllMocks();
    callbackBox.current = undefined;
    manager.create.mockResolvedValue({
      cwd: '/workspace',
      id: 'pty_external',
      pid: 4242,
      shell: '/bin/zsh',
    });
    manager.kill.mockResolvedValue(undefined);
    manager.resize.mockResolvedValue(undefined);
    manager.shutdown.mockResolvedValue(undefined);
    manager.write.mockResolvedValue(undefined);
  });

  it('awaits the asynchronous manager while preserving the public create result', async () => {
    const controller = new TerminalCtr(app);

    await expect(
      controller.createSession({ cols: 80, cwd: '/workspace', rows: 24 }),
    ).resolves.toEqual({
      cwd: '/workspace',
      id: 'pty_external',
      pid: 4242,
      shell: '/bin/zsh',
    });
    expect(manager.create).toHaveBeenCalledWith({ cols: 80, cwd: '/workspace', rows: 24 });
  });

  it('broadcasts each sidecar OUTPUT immediately as Uint8Array without controller batching', () => {
    new TerminalCtr(app);
    const bytes = Uint8Array.of(0x1b, 0x5b, 0x31, 0x6d, 0xe4, 0xbd, 0xa0);

    callbackBox.current?.onData('pty_external', bytes);

    expect(broadcastToAllWindows).toHaveBeenCalledOnce();
    expect(broadcastToAllWindows).toHaveBeenCalledWith('terminalData', {
      data: bytes,
      id: 'pty_external',
    });
  });

  it('broadcasts sidecar EXIT and delegates write, resize, and kill operations', async () => {
    const controller = new TerminalCtr(app);

    await controller.writeSession({ data: 'echo test', id: 'pty_external' });
    await controller.resizeSession({ cols: 120, id: 'pty_external', rows: 40 });
    await controller.killSession({ id: 'pty_external' });
    callbackBox.current?.onExit('pty_external', -1);

    expect(manager.write).toHaveBeenCalledWith('pty_external', 'echo test');
    expect(manager.resize).toHaveBeenCalledWith('pty_external', 120, 40);
    expect(manager.kill).toHaveBeenCalledWith('pty_external');
    expect(broadcastToAllWindows).toHaveBeenCalledWith('terminalExit', {
      exitCode: -1,
      id: 'pty_external',
    });
  });

  it('prevents quit until one graceful shutdown completes, then allows the re-fired event', async () => {
    let finishShutdown!: () => void;
    manager.shutdown.mockReturnValue(
      new Promise<void>((resolve) => {
        finishShutdown = resolve;
      }),
    );
    const controller = new TerminalCtr(app);
    controller.afterAppReady();
    const beforeQuit = appOn.mock.calls.find(([event]) => event === 'before-quit')?.[1];
    expect(beforeQuit).toBeTypeOf('function');

    const firstEvent = { preventDefault: vi.fn() };
    const repeatedEvent = { preventDefault: vi.fn() };
    beforeQuit(firstEvent);
    beforeQuit(repeatedEvent);

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(repeatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(manager.shutdown).toHaveBeenCalledOnce();
    expect(appQuit).not.toHaveBeenCalled();

    finishShutdown();
    await vi.waitFor(() => expect(appQuit).toHaveBeenCalledOnce());

    const allowedEvent = { preventDefault: vi.fn() };
    beforeQuit(allowedEvent);
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
  });
});
