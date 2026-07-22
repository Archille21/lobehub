import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';

import { createLogger } from '@/utils/logger';

import type { PtySidecarCreatedSession, PtySidecarCreateOptions } from './sidecar/PtySidecarClient';
import { PtySidecarClient } from './sidecar/PtySidecarClient';

export interface PtySessionCallbacks {
  onData: (id: string, data: Uint8Array) => void;
  onExit: (id: string, exitCode: number) => void;
  /** Called when the manager kills a session itself (LRU cap / idle timeout). */
  onReap?: (id: string, reason: 'idle' | 'limit') => void;
}

export interface CreatePtySessionOptions {
  cols: number;
  cwd?: string;
  rows: number;
}

export interface PtySessionInfo {
  cwd: string;
  id: string;
  pid: number;
  shell: string;
}

export interface PtySidecarTransport {
  createSession: (options: PtySidecarCreateOptions) => Promise<PtySidecarCreatedSession>;
  killSession: (externalId: string) => Promise<void>;
  onData: (listener: (externalId: string, data: Uint8Array) => void) => () => boolean | void;
  onExit: (listener: (externalId: string, exitCode: number) => void) => () => boolean | void;
  resizeSession: (externalId: string, cols: number, rows: number) => Promise<void>;
  shutdown: () => Promise<void>;
  writeSession: (externalId: string, data: string) => Promise<void>;
}

interface PtySessionManagerOptions {
  client?: PtySidecarTransport;
  isDirectory?: (path: string) => Promise<boolean>;
  now?: () => number;
}

/** Hard cap on concurrent PTY sessions; creating one more evicts the LRU session. */
const MAX_SESSIONS = 10;
/** Sessions with no input AND no output for this long get reaped. 5 min would be
 * too aggressive for a stateful shell (cwd/history/suspended jobs); anything
 * producing output — a running build, a tailing log — keeps itself alive. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PtySession {
  activationPending: boolean;
  handle?: number;
  lastActiveAt: number;
  pendingEvents: PtySessionEvent[];
  state: 'activating' | 'closing' | 'creating' | 'running';
}

type PtySessionEvent = { data: Uint8Array; type: 'data' } | { exitCode: number; type: 'exit' };

const logger = createLogger('terminal:session');

const getDefaultShell = () => {
  if (process.platform === 'win32') return process.env.ComSpec || 'powershell.exe';
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
};

const defaultIsDirectory = async (path: string) => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

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

/**
 * Owns product-level terminal session policy. The Rust sidecar owns PTY
 * processes; this manager preserves external ids, cwd/shell selection, LRU
 * eviction, idle reaping, and activity timestamps across renderer remounts.
 */
export class PtySessionManager {
  private readonly client: PtySidecarTransport;
  private createTail = Promise.resolve();
  private readonly isDirectory: (path: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly removeDataListener: () => boolean | void;
  private readonly removeExitListener: () => boolean | void;
  private readonly sessions = new Map<string, PtySession>();
  private shutdownPromise: Promise<void> | null = null;
  private stopped = false;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly callbacks: PtySessionCallbacks,
    {
      client = new PtySidecarClient(),
      isDirectory = defaultIsDirectory,
      now = Date.now,
    }: PtySessionManagerOptions = {},
  ) {
    this.client = client;
    this.isDirectory = isDirectory;
    this.now = now;
    this.removeDataListener = client.onData((id, data) => this.handleData(id, data));
    this.removeExitListener = client.onExit((id, exitCode) => this.handleExit(id, exitCode));
    this.sweepTimer = setInterval(() => {
      void this.reapIdleSessions().catch((error) => {
        logger.error('failed to reap idle terminal sessions', error);
      });
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  create(options: CreatePtySessionOptions): Promise<PtySessionInfo> {
    const operation = this.createTail.then(() => this.createInternal(options));
    this.createTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async write(id: string, data: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state === 'closing' || session.state === 'creating') return;
    session.lastActiveAt = this.now();
    await this.client.writeSession(id, data);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    if (cols <= 0 || rows <= 0) return;
    validateDimensions(cols, rows);

    const session = this.sessions.get(id);
    if (!session || session.state === 'closing' || session.state === 'creating') return;
    session.lastActiveAt = this.now();
    await this.client.resizeSession(id, cols, rows);
  }

  async kill(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.state === 'closing') return;
    session.state = 'closing';
    await this.client.killSession(id);
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    clearInterval(this.sweepTimer);
    this.removeDataListener();
    this.removeExitListener();
    this.shutdownPromise = this.client.shutdown().finally(() => {
      this.sessions.clear();
    });
    return this.shutdownPromise;
  }

  private async createInternal(options: CreatePtySessionOptions): Promise<PtySessionInfo> {
    if (this.stopped) {
      throw new Error('Terminal session manager is shutting down');
    }
    validateDimensions(options.cols, options.rows);
    await this.evictLruIfFull();

    const id = `pty_${randomUUID()}`;
    const shell = getDefaultShell();
    const cwd = options.cwd && (await this.isDirectory(options.cwd)) ? options.cwd : os.homedir();
    const session: PtySession = {
      activationPending: true,
      lastActiveAt: this.now(),
      pendingEvents: [],
      state: 'creating',
    };
    this.sessions.set(id, session);

    let created: PtySidecarCreatedSession;
    try {
      created = await this.client.createSession({
        cols: options.cols,
        cwd,
        externalId: id,
        rows: options.rows,
        shell,
      });
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }

    const activeSession = this.sessions.get(id);
    if (activeSession) {
      activeSession.handle = created.handle;
      activeSession.state = 'activating';
      activeSession.lastActiveAt = this.now();
      setImmediate(() => this.activateSession(id, activeSession));
    }
    logger.info(`created terminal session ${id} (handle ${created.handle}, pid ${created.pid})`);
    return { cwd: created.cwd, id, pid: created.pid, shell: created.shell };
  }

  private handleData(id: string, data: Uint8Array) {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActiveAt = this.now();
      if (session.activationPending) {
        session.pendingEvents.push({ data, type: 'data' });
        return;
      }
    }
    this.callbacks.onData(id, data);
  }

  private handleExit(id: string, exitCode: number) {
    const session = this.sessions.get(id);
    if (session?.activationPending) {
      if (session.state === 'closing' && session.pendingEvents.length === 0) {
        this.finishSession(id, exitCode, session);
        return;
      }
      session.pendingEvents.push({ exitCode, type: 'exit' });
      return;
    }
    this.finishSession(id, exitCode, session);
  }

  private activateSession(id: string, session: PtySession) {
    if (this.sessions.get(id) !== session || !session.activationPending) return;
    session.activationPending = false;
    if (session.state === 'activating') session.state = 'running';
    const events = session.pendingEvents;
    session.pendingEvents = [];
    for (const event of events) {
      if (event.type === 'data') {
        this.callbacks.onData(id, event.data);
      } else {
        this.finishSession(id, event.exitCode, session);
        break;
      }
    }
  }

  private finishSession(id: string, exitCode: number, session?: PtySession) {
    this.sessions.delete(id);
    logger.info(
      `terminal session ${id} exited (handle ${session?.handle ?? 'pending'}, code ${exitCode})`,
    );
    this.callbacks.onExit(id, exitCode);
  }

  private countCapacitySessions() {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state !== 'closing') count++;
    }
    return count;
  }

  private async evictLruIfFull() {
    while (this.countCapacitySessions() >= MAX_SESSIONS) {
      let lruId: string | undefined;
      let lruAt = Infinity;
      for (const [id, session] of this.sessions) {
        if (
          (session.state === 'running' || session.state === 'activating') &&
          session.lastActiveAt < lruAt
        ) {
          lruAt = session.lastActiveAt;
          lruId = id;
        }
      }
      if (!lruId) return;
      this.callbacks.onReap?.(lruId, 'limit');
      logger.info(`reaping terminal session ${lruId} (limit)`);
      await this.kill(lruId);
    }
  }

  private async reapIdleSessions() {
    const now = this.now();
    const reaps: Promise<void>[] = [];
    for (const [id, session] of this.sessions) {
      if (
        (session.state === 'running' || session.state === 'activating') &&
        now - session.lastActiveAt > IDLE_TIMEOUT_MS
      ) {
        this.callbacks.onReap?.(id, 'idle');
        logger.info(`reaping terminal session ${id} (idle)`);
        reaps.push(this.kill(id));
      }
    }
    await Promise.all(reaps);
  }
}
