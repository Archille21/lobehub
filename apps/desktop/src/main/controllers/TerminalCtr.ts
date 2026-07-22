import type {
  TerminalCreateSessionParams,
  TerminalCreateSessionResult,
  TerminalKillParams,
  TerminalResizeParams,
  TerminalWriteParams,
} from '@lobechat/electron-client-ipc';
import { app as electronApp } from 'electron';

import type { App } from '@/core/App';
import { PtySessionManager } from '@/modules/terminal';
import { createLogger } from '@/utils/logger';

import { ControllerModule, IpcMethod } from './index';

const logger = createLogger('controllers:TerminalCtr');

export default class TerminalCtr extends ControllerModule {
  static override readonly groupName = 'terminal';

  private allowQuit = false;
  private readonly manager: PtySessionManager;
  private shutdownStarted = false;

  constructor(app: App, manager?: PtySessionManager) {
    super(app);
    this.manager =
      manager ??
      new PtySessionManager({
        onData: (id, data) => {
          this.app.browserManager.broadcastToAllWindows('terminalData', { data, id });
        },
        onExit: (id, exitCode) => {
          logger.debug(`session ${id} exited with code ${exitCode}`);
          this.app.browserManager.broadcastToAllWindows('terminalExit', { exitCode, id });
        },
        onReap: (id, reason) => {
          logger.info(`reaping session ${id} (${reason})`);
        },
      });
  }

  @IpcMethod()
  async createSession(params: TerminalCreateSessionParams): Promise<TerminalCreateSessionResult> {
    try {
      const info = await this.manager.create(params);
      logger.debug(`created session ${info.id} (pid ${info.pid})`);
      return info;
    } catch (error) {
      logger.error('failed to create terminal session:', error);
      throw error;
    }
  }

  @IpcMethod()
  async writeSession(params: TerminalWriteParams): Promise<void> {
    await this.manager.write(params.id, params.data);
  }

  @IpcMethod()
  async resizeSession(params: TerminalResizeParams): Promise<void> {
    await this.manager.resize(params.id, params.cols, params.rows);
  }

  @IpcMethod()
  async killSession(params: TerminalKillParams): Promise<void> {
    logger.debug(`killing session ${params.id}`);
    try {
      await this.manager.kill(params.id);
    } catch (error) {
      logger.error(`failed to kill session ${params.id}:`, error);
      throw error;
    }
  }

  afterAppReady() {
    electronApp.on('before-quit', (event) => {
      if (this.allowQuit) return;
      event.preventDefault();
      if (this.shutdownStarted) return;

      this.shutdownStarted = true;
      void this.manager
        .shutdown()
        .catch((error) => {
          logger.error('failed to shut down terminal sidecar gracefully:', error);
        })
        .finally(() => {
          this.allowQuit = true;
          electronApp.quit();
        });
    });
  }
}
