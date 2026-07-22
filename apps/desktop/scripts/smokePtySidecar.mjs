import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertPtySidecarBinary, getPtySidecarBinaryPath } from './buildPtySidecar.mjs';

const HEADER_SIZE = 16;
const MAGIC = Buffer.from('LPTY');
const MAX_FRAME_PAYLOAD = 4 * 1024 * 1024;
const PROTOCOL_VERSION = 1;
const UNICODE_TOKEN = 'LobeHub PTY 世界 🌐';
const ANSI_UNICODE_TOKEN = Buffer.from(`\u001B[36m${UNICODE_TOKEN}\u001B[0m`);

export const FrameKind = Object.freeze({
  CREATE: 0x02,
  CREATED: 0x03,
  CREATE_ERROR: 0x04,
  ERROR: 0x0a,
  EXIT: 0x09,
  HELLO: 0x01,
  INPUT: 0x05,
  KILL: 0x08,
  OUTPUT: 0x06,
  RESIZE: 0x07,
  SHUTDOWN: 0x0b,
});

const KNOWN_FRAME_KINDS = new Set(Object.values(FrameKind));

export const encodeFrame = ({ kind, payload = Buffer.alloc(0), streamId = 0 }) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (!KNOWN_FRAME_KINDS.has(kind)) throw new Error(`Unknown PTY frame kind: ${kind}`);
  if (body.length > MAX_FRAME_PAYLOAD) {
    throw new Error(`PTY frame payload exceeds ${MAX_FRAME_PAYLOAD} bytes`);
  }

  const frame = Buffer.allocUnsafe(HEADER_SIZE + body.length);
  MAGIC.copy(frame, 0);
  frame.writeUInt8(PROTOCOL_VERSION, 4);
  frame.writeUInt8(kind, 5);
  frame.writeUInt16BE(0, 6);
  frame.writeUInt32BE(streamId, 8);
  frame.writeUInt32BE(body.length, 12);
  body.copy(frame, HEADER_SIZE);
  return frame;
};

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames = [];

    while (this.#buffer.length >= HEADER_SIZE) {
      if (!this.#buffer.subarray(0, 4).equals(MAGIC)) {
        throw new Error('PTY sidecar emitted an invalid frame magic');
      }

      const version = this.#buffer.readUInt8(4);
      const kind = this.#buffer.readUInt8(5);
      const flags = this.#buffer.readUInt16BE(6);
      const streamId = this.#buffer.readUInt32BE(8);
      const payloadLength = this.#buffer.readUInt32BE(12);

      if (version !== PROTOCOL_VERSION) {
        throw new Error(`PTY sidecar emitted unsupported protocol version ${version}`);
      }
      if (!KNOWN_FRAME_KINDS.has(kind)) {
        throw new Error(`PTY sidecar emitted unknown frame kind ${kind}`);
      }
      if (flags !== 0) throw new Error(`PTY sidecar emitted non-zero v1 flags: ${flags}`);
      if (payloadLength > MAX_FRAME_PAYLOAD) {
        throw new Error(`PTY sidecar emitted an oversized frame: ${payloadLength}`);
      }
      if (this.#buffer.length < HEADER_SIZE + payloadLength) break;

      frames.push({
        kind,
        payload: Buffer.from(this.#buffer.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength)),
        streamId,
      });
      this.#buffer = this.#buffer.subarray(HEADER_SIZE + payloadLength);
    }

    return frames;
  }
}

const decodeJson = (frame, description) => {
  try {
    return JSON.parse(frame.payload.toString('utf8'));
  } catch (error) {
    throw new Error(`PTY sidecar emitted invalid ${description} JSON`, { cause: error });
  }
};

class FrameInbox {
  #failure;
  #frames = [];
  #waiters = new Set();

  fail(error) {
    if (this.#failure) return;
    this.#failure = error;
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  push(frame) {
    if (frame.kind === FrameKind.CREATE_ERROR || frame.kind === FrameKind.ERROR) {
      const payload = decodeJson(frame, 'error');
      this.fail(
        new Error(
          `PTY sidecar error ${payload.code ?? 'UNKNOWN'}: ${payload.message ?? 'no message'}`,
        ),
      );
      return;
    }

    for (const waiter of this.#waiters) {
      if (!waiter.predicate(frame)) continue;
      this.#waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      waiter.resolve(frame);
      return;
    }

    this.#frames.push(frame);
  }

  waitFor(predicate, description, timeoutMs = 3000) {
    if (this.#failure) return Promise.reject(this.#failure);

    const existingIndex = this.#frames.findIndex(predicate);
    if (existingIndex >= 0) {
      const [frame] = this.#frames.splice(existingIndex, 1);
      return Promise.resolve(frame);
    }

    return new Promise((resolve, reject) => {
      const waiter = { predicate, reject, resolve, timeout: undefined };
      waiter.timeout = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`Timed out waiting for PTY sidecar ${description}`));
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }
}

const writeFrame = async (child, frame) => {
  if (!child.stdin || child.stdin.destroyed) {
    throw new Error('PTY sidecar stdin closed before the smoke test completed');
  }

  await new Promise((resolve, reject) => {
    child.stdin.write(frame, (error) => (error ? reject(error) : resolve()));
  });
};

const createProbe = (binaryPath, timeoutMs) => {
  const child = spawn(binaryPath, [], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const decoder = new FrameDecoder();
  const inbox = new FrameInbox();
  const stderrChunks = [];
  let stderrBytes = 0;

  const exit = new Promise((resolve) => {
    child.once('error', (error) => {
      const wrapped = new Error(`Failed to start PTY sidecar: ${error.message}`, { cause: error });
      inbox.fail(wrapped);
      resolve({ code: null, error: wrapped, signal: null });
    });
    child.once('exit', (code, signal) => {
      const result = { code, signal };
      inbox.fail(
        new Error(
          `PTY sidecar exited before the smoke test completed (exit=${code ?? 'null'}, signal=${signal ?? 'none'})`,
        ),
      );
      resolve(result);
    });
  });

  child.stdout.on('data', (chunk) => {
    try {
      for (const frame of decoder.push(chunk)) inbox.push(frame);
    } catch (error) {
      inbox.fail(error);
      child.kill();
    }
  });

  child.stderr.on('data', (chunk) => {
    if (stderrBytes >= 64 * 1024) return;
    const remaining = 64 * 1024 - stderrBytes;
    const boundedChunk = Buffer.from(chunk).subarray(0, remaining);
    stderrChunks.push(boundedChunk);
    stderrBytes += boundedChunk.length;
  });

  return {
    child,
    exit,
    getStderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    inbox,
    timeoutMs,
  };
};

const waitForCleanExit = async (probe) => {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('Timed out waiting for PTY sidecar shutdown')),
      probe.timeoutMs,
    );
  });
  let result;
  try {
    result = await Promise.race([probe.exit, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(
      `PTY sidecar shutdown failed (exit=${result.code ?? 'null'}, signal=${result.signal ?? 'none'})`,
    );
  }
};

const readHello = async (probe) => {
  const frame = await probe.inbox.waitFor(
    (candidate) => candidate.kind === FrameKind.HELLO && candidate.streamId === 0,
    'HELLO',
    probe.timeoutMs,
  );
  const hello = decodeJson(frame, 'HELLO');
  if (
    !Number.isInteger(hello.minVersion) ||
    !Number.isInteger(hello.maxVersion) ||
    hello.minVersion > PROTOCOL_VERSION ||
    hello.maxVersion < PROTOCOL_VERSION
  ) {
    throw new Error(
      `PTY sidecar protocol mismatch: supported ${hello.minVersion ?? '?'}-${hello.maxVersion ?? '?'}`,
    );
  }
  if (!Number.isInteger(hello.pid) || hello.pid <= 0) {
    throw new Error('PTY sidecar HELLO did not contain a valid pid');
  }
  return hello;
};

const withProbe = async (binaryPath, options, operation) => {
  await assertPtySidecarBinary({
    binaryPath,
    expectedArchitecture: options.expectedArchitecture,
    requireExecutable: process.platform !== 'win32',
  });
  const probe = createProbe(binaryPath, options.timeoutMs);

  try {
    return await operation(probe);
  } catch (error) {
    const stderr = probe.getStderr().trim();
    if (stderr) console.error(`[pty-sidecar stderr]\n${stderr}`);
    throw error;
  } finally {
    if (probe.child.exitCode === null && probe.child.signalCode === null) {
      probe.child.kill();
    }
  }
};

export const verifyPtySidecarHello = async (
  binaryPath,
  { expectedArchitecture = process.arch, timeoutMs = 3000 } = {},
) =>
  withProbe(binaryPath, { expectedArchitecture, timeoutMs }, async (probe) => {
    const hello = await readHello(probe);
    await writeFrame(probe.child, encodeFrame({ kind: FrameKind.SHUTDOWN }));
    await waitForCleanExit(probe);
    return hello;
  });

export const getSmokeShell = ({ environment = process.env, platform = process.platform } = {}) => {
  if (platform === 'win32') {
    return environment.ComSpec || environment.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
  }
  if (platform === 'darwin') return '/bin/zsh';
  return environment.SHELL || '/bin/bash';
};

const getSmokeCommand = (marker) => {
  if (process.platform === 'win32') {
    return `powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $esc=[char]27; $unicode='LobeHub PTY '+[char]0x4e16+[char]0x754c+[char]::ConvertFromUtf32(0x1f310); [Console]::WriteLine($esc+'[31m'+'${marker}'+$esc+'[0m'); [Console]::WriteLine($esc+'[36m'+$unicode+$esc+'[0m'); $s=$Host.UI.RawUI.WindowSize; [Console]::WriteLine('LOBE_PTY_SIZE_'+$s.Height+'x'+$s.Width)"\r\n`;
  }

  return `printf '\\033[31m${marker}\\033[0m\\n'; printf '\\033[36m${UNICODE_TOKEN}\\033[0m\\n'; printf 'LOBE_PTY_SIZE_'; stty size\r`;
};

const hasExpectedOutput = (output, marker, columns, rows) => {
  const text = output.toString('utf8');
  if (!output.includes(Buffer.from(`\u001B[31m${marker}\u001B[0m`))) return false;
  if (!output.includes(ANSI_UNICODE_TOKEN)) return false;

  if (process.platform === 'win32') {
    return text.includes(`LOBE_PTY_SIZE_${rows}x${columns}`);
  }

  return new RegExp(`LOBE_PTY_SIZE_\\s*${rows}\\s+${columns}(?:\\D|$)`).test(text);
};

const assertSafeMarker = (marker) => {
  if (!/^[A-Z0-9_]+$/.test(marker)) {
    throw new Error('PTY smoke marker must contain only uppercase ASCII letters, digits, and _');
  }
};

export const getShutdownProbeCommand = (marker, { platform = process.platform } = {}) => {
  assertSafeMarker(marker);

  if (platform === 'win32') {
    return `powershell.exe -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::WriteLine('${marker}_'+$PID); Start-Sleep -Seconds 60"\r\n`;
  }

  // The foreground sleep is a real descendant of the managed shell. Closing
  // the PTY during SHUTDOWN must terminate both the session leader and this
  // foreground process; Windows exercises the equivalent path via Job Objects.
  return `sh -c 'printf "${marker}_%s\\n" "$$"; exec sleep 60'\r`;
};

export const parseMarkedProcessId = (output, marker) => {
  assertSafeMarker(marker);
  const match = output.toString('utf8').match(new RegExp(`${marker}_(\\d+)`));
  if (!match) return undefined;

  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

export const isProcessAlive = (pid, sendSignal = process.kill) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  try {
    sendSignal(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
};

export const waitForProcessesToExit = async (
  processIds,
  { isAlive = isProcessAlive, pollIntervalMs = 50, timeoutMs = 3000 } = {},
) => {
  const uniqueProcessIds = [...new Set(processIds)].filter(
    (pid) => Number.isSafeInteger(pid) && pid > 0,
  );
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const survivors = uniqueProcessIds.filter((pid) => isAlive(pid));
    if (survivors.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `PTY sidecar SHUTDOWN left managed processes running: ${survivors.join(', ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
};

export const smokePtySidecar = async (
  binaryPath,
  { expectedArchitecture = process.arch, timeoutMs = 10_000 } = {},
) =>
  withProbe(binaryPath, { expectedArchitecture, timeoutMs }, async (probe) => {
    const hello = await readHello(probe);
    const columns = 91;
    const rows = 37;
    const requestId = 1;
    const marker = `LOBE_PTY_SMOKE_${crypto.randomUUID().replaceAll('-', '')}`;
    const createPayload = Buffer.from(
      JSON.stringify({
        cols: 80,
        cwd: os.homedir(),
        envOverrides: { COLORTERM: 'truecolor', TERM: 'xterm-256color' },
        requestId,
        rows: 24,
        shell: getSmokeShell(),
      }),
    );

    await writeFrame(
      probe.child,
      encodeFrame({ kind: FrameKind.CREATE, payload: createPayload, streamId: 0 }),
    );
    const createdFrame = await probe.inbox.waitFor(
      (candidate) => candidate.kind === FrameKind.CREATED && candidate.streamId > 0,
      'CREATED',
      probe.timeoutMs,
    );
    const created = decodeJson(createdFrame, 'CREATED');
    if (created.requestId !== requestId || !Number.isInteger(created.pid) || created.pid <= 0) {
      throw new Error('PTY sidecar CREATED response did not correlate to the smoke request');
    }

    const resizePayload = Buffer.allocUnsafe(4);
    resizePayload.writeUInt16BE(columns, 0);
    resizePayload.writeUInt16BE(rows, 2);
    await writeFrame(
      probe.child,
      encodeFrame({
        kind: FrameKind.RESIZE,
        payload: resizePayload,
        streamId: createdFrame.streamId,
      }),
    );
    await writeFrame(
      probe.child,
      encodeFrame({
        kind: FrameKind.INPUT,
        payload: Buffer.from(getSmokeCommand(marker)),
        streamId: createdFrame.streamId,
      }),
    );

    let output = Buffer.alloc(0);
    while (!hasExpectedOutput(output, marker, columns, rows)) {
      const frame = await probe.inbox.waitFor(
        (candidate) =>
          candidate.streamId === createdFrame.streamId &&
          (candidate.kind === FrameKind.OUTPUT || candidate.kind === FrameKind.EXIT),
        'OUTPUT with marker and resized terminal dimensions',
        probe.timeoutMs,
      );
      if (frame.kind === FrameKind.EXIT) {
        throw new Error('PTY shell exited before producing the smoke output');
      }
      output = Buffer.concat([output, frame.payload]);
      if (output.length > 1024 * 1024) {
        throw new Error('PTY sidecar smoke output exceeded 1 MiB before the marker was observed');
      }
    }

    await writeFrame(
      probe.child,
      encodeFrame({ kind: FrameKind.KILL, streamId: createdFrame.streamId }),
    );
    const exitFrame = await probe.inbox.waitFor(
      (candidate) =>
        candidate.kind === FrameKind.EXIT && candidate.streamId === createdFrame.streamId,
      'EXIT after KILL',
      probe.timeoutMs,
    );
    decodeJson(exitFrame, 'EXIT');

    const shutdownRequestId = 2;
    const shutdownMarker = `LOBE_PTY_SHUTDOWN_${crypto.randomUUID().replaceAll('-', '').toUpperCase()}`;
    const shutdownCreatePayload = Buffer.from(
      JSON.stringify({
        cols: 80,
        cwd: os.homedir(),
        envOverrides: { COLORTERM: 'truecolor', TERM: 'xterm-256color' },
        requestId: shutdownRequestId,
        rows: 24,
        shell: getSmokeShell(),
      }),
    );
    await writeFrame(
      probe.child,
      encodeFrame({ kind: FrameKind.CREATE, payload: shutdownCreatePayload, streamId: 0 }),
    );
    const shutdownCreatedFrame = await probe.inbox.waitFor(
      (candidate) => candidate.kind === FrameKind.CREATED && candidate.streamId > 0,
      'CREATED for active SHUTDOWN session',
      probe.timeoutMs,
    );
    const shutdownCreated = decodeJson(shutdownCreatedFrame, 'CREATED');
    if (
      shutdownCreated.requestId !== shutdownRequestId ||
      !Number.isInteger(shutdownCreated.pid) ||
      shutdownCreated.pid <= 0
    ) {
      throw new Error('PTY sidecar CREATED response did not correlate to the SHUTDOWN request');
    }

    await writeFrame(
      probe.child,
      encodeFrame({
        kind: FrameKind.INPUT,
        payload: Buffer.from(getShutdownProbeCommand(shutdownMarker)),
        streamId: shutdownCreatedFrame.streamId,
      }),
    );

    let shutdownOutput = Buffer.alloc(0);
    let descendantPid;
    while (!descendantPid) {
      const frame = await probe.inbox.waitFor(
        (candidate) =>
          candidate.streamId === shutdownCreatedFrame.streamId &&
          (candidate.kind === FrameKind.OUTPUT || candidate.kind === FrameKind.EXIT),
        'active descendant PID before SHUTDOWN',
        probe.timeoutMs,
      );
      if (frame.kind === FrameKind.EXIT) {
        throw new Error('PTY shell exited before the SHUTDOWN descendant became active');
      }
      shutdownOutput = Buffer.concat([shutdownOutput, frame.payload]);
      descendantPid = parseMarkedProcessId(shutdownOutput, shutdownMarker);
      if (shutdownOutput.length > 1024 * 1024) {
        throw new Error('PTY sidecar SHUTDOWN probe output exceeded 1 MiB before its PID appeared');
      }
    }

    const managedProcessIds = [shutdownCreated.pid, descendantPid];
    const inactiveProcessIds = managedProcessIds.filter((pid) => !isProcessAlive(pid));
    if (inactiveProcessIds.length > 0) {
      throw new Error(
        `PTY SHUTDOWN probe processes exited before shutdown: ${inactiveProcessIds.join(', ')}`,
      );
    }

    await writeFrame(probe.child, encodeFrame({ kind: FrameKind.SHUTDOWN }));
    await waitForCleanExit(probe);
    await waitForProcessesToExit(managedProcessIds, { timeoutMs: probe.timeoutMs });

    return {
      hello,
      outputBytes: output.length,
      sessionPid: created.pid,
      shutdownDescendantPid: descendantPid,
      shutdownSessionPid: shutdownCreated.pid,
    };
  });

const isDirectExecution =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const args = process.argv.slice(2);
  const binaryArgumentIndex = args.indexOf('--binary');
  const binaryPath =
    binaryArgumentIndex >= 0
      ? args[binaryArgumentIndex + 1]
      : getPtySidecarBinaryPath({ release: args.includes('--release') });

  if (!binaryPath) {
    console.error('--binary requires an absolute or relative executable path');
    process.exitCode = 1;
  } else {
    try {
      if (args.includes('--release') && process.env.LOBE_PTY_SIDECAR_PREPARED === '1') {
        await assertPtySidecarBinary({
          binaryPath: path.resolve(binaryPath),
          requireExecutable: process.platform !== 'win32',
        });
        console.info(`PTY sidecar protocol smoke already passed: ${path.resolve(binaryPath)}`);
      } else if (args.includes('--hello-only')) {
        await verifyPtySidecarHello(path.resolve(binaryPath));
        console.info(`PTY sidecar HELLO smoke passed: ${path.resolve(binaryPath)}`);
      } else {
        await smokePtySidecar(path.resolve(binaryPath));
        console.info(`PTY sidecar protocol smoke passed: ${path.resolve(binaryPath)}`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
