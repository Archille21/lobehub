import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { detectBinaryArchitecture, getPtySidecarBinaryPath } from '../buildPtySidecar.mjs';
import { launchDesktopElectron } from '../launchElectron.mjs';
import {
  encodeFrame,
  FrameDecoder,
  FrameKind,
  getShutdownProbeCommand,
  getSmokeShell,
  isProcessAlive,
  parseMarkedProcessId,
  waitForProcessesToExit,
} from '../smokePtySidecar.mjs';

const buildScript = fileURLToPath(new URL('../buildPtySidecar.mjs', import.meta.url));
const smokeScript = fileURLToPath(new URL('../smokePtySidecar.mjs', import.meta.url));

const writeElfFixture = (binaryPath, architecture) => {
  const binary = Buffer.alloc(32);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(binary);
  binary[5] = 1;
  binary.writeUInt16LE(architecture === 'arm64' ? 183 : 62, 18);
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, binary, { mode: 0o755 });
};

describe('PTY sidecar build helpers', () => {
  it('resolves debug and release binaries relative to the desktop crate', () => {
    expect(getPtySidecarBinaryPath({ platform: 'linux' })).toMatch(
      path.join('native', 'pty-sidecar', 'target', 'debug', 'lobe-pty-sidecar'),
    );
    expect(getPtySidecarBinaryPath({ platform: 'win32', release: true })).toMatch(
      path.join('native', 'pty-sidecar', 'target', 'release', 'lobe-pty-sidecar.exe'),
    );
  });

  it('detects architectures from native executable headers', () => {
    const macho = Buffer.alloc(32);
    macho.writeUInt32LE(0xfeedfacf, 0);
    macho.writeUInt32LE(0x01_00_00_0c, 4);

    const elf = Buffer.alloc(32);
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(elf);
    elf[5] = 1;
    elf.writeUInt16LE(62, 18);

    const pe = Buffer.alloc(128);
    pe.write('MZ', 0);
    pe.writeUInt32LE(64, 0x3c);
    pe.write('PE\0\0', 64);
    pe.writeUInt16LE(0xaa64, 68);

    expect(detectBinaryArchitecture(macho)).toBe('arm64');
    expect(detectBinaryArchitecture(elf)).toBe('x64');
    expect(detectBinaryArchitecture(pe)).toBe('arm64');
  });

  it('revalidates a CI-prepared binary without rebuilding or re-running the smoke', () => {
    const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobe-pty-prepared-'));
    const binaryPath = getPtySidecarBinaryPath({ release: true, targetDirectory });
    writeElfFixture(binaryPath, process.arch);
    const env = {
      ...process.env,
      CARGO_TARGET_DIR: targetDirectory,
      LOBE_PTY_SIDECAR_PREPARED: '1',
      npm_config_arch: process.arch,
    };

    try {
      const build = spawnSync(process.execPath, [buildScript, '--release'], {
        encoding: 'utf8',
        env,
      });
      const smoke = spawnSync(process.execPath, [smokeScript, '--release'], {
        encoding: 'utf8',
        env,
      });

      expect(build.status, build.stderr).toBe(0);
      expect(build.stdout.trim()).toBe(binaryPath);
      expect(smoke.status, smoke.stderr).toBe(0);
      expect(smoke.stdout).toContain('protocol smoke already passed');
    } finally {
      fs.rmSync(targetDirectory, { force: true, recursive: true });
    }
  });

  it('rejects a prepared binary with the wrong architecture', () => {
    const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobe-pty-wrong-arch-'));
    const binaryPath = getPtySidecarBinaryPath({ release: true, targetDirectory });
    writeElfFixture(binaryPath, process.arch === 'arm64' ? 'x64' : 'arm64');

    try {
      const result = spawnSync(process.execPath, [buildScript, '--release'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDirectory,
          LOBE_PTY_SIDECAR_PREPARED: '1',
          npm_config_arch: process.arch,
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('architecture mismatch');
    } finally {
      fs.rmSync(targetDirectory, { force: true, recursive: true });
    }
  });
});

describe('desktop Electron launcher', () => {
  it('preserves an explicit development sidecar override', () => {
    const environment = { LOBE_PTY_SIDECAR_PATH: './custom/lobe-pty-sidecar' };
    const spawn = vi.fn(() => ({ once: vi.fn() }));

    launchDesktopElectron({ electronBin: '/electron', environment, spawn });

    const options = spawn.mock.calls[0][2];
    expect(options.env.LOBE_PTY_SIDECAR_PATH).toBe(
      path.resolve(
        fileURLToPath(new URL('../../', import.meta.url)),
        environment.LOBE_PTY_SIDECAR_PATH,
      ),
    );
  });

  it('passes the exact custom Cargo target binary to the development runtime', () => {
    const environment = {
      CARGO_BUILD_TARGET: 'aarch64-unknown-linux-gnu',
      CARGO_TARGET_DIR: '../../../custom-cargo-target',
    };
    const spawn = vi.fn(() => ({ once: vi.fn() }));

    launchDesktopElectron({
      electronArgs: ['--inspect=9229'],
      electronBin: '/repo/node_modules/electron/dist/electron',
      environment,
      spawn,
    });

    expect(spawn).toHaveBeenCalledOnce();
    const [binary, args, options] = spawn.mock.calls[0];
    expect(binary).toBe('/repo/node_modules/electron/dist/electron');
    expect(args).toEqual(['.', '--inspect=9229']);
    expect(options.env.LOBE_PTY_SIDECAR_PATH).toBe(
      getPtySidecarBinaryPath({
        targetDirectory: environment.CARGO_TARGET_DIR,
        targetTriple: environment.CARGO_BUILD_TARGET,
      }),
    );
  });
});

describe('PTY sidecar smoke frame codec', () => {
  it('uses the required platform shell for packaged smoke', () => {
    expect(getSmokeShell({ environment: { SHELL: '/bin/fish' }, platform: 'darwin' })).toBe(
      '/bin/zsh',
    );
    expect(getSmokeShell({ environment: { SHELL: '/bin/fish' }, platform: 'linux' })).toBe(
      '/bin/fish',
    );
    expect(
      getSmokeShell({ environment: { ComSpec: 'C:\\Windows\\cmd.exe' }, platform: 'win32' }),
    ).toBe('C:\\Windows\\cmd.exe');
  });

  it('decodes fragmented and coalesced binary frames without changing payload bytes', () => {
    const firstPayload = Buffer.from([0xf0, 0x9f, 0x8c, 0x8f, 0x1b, 0x5b, 0x31, 0x6d]);
    const first = encodeFrame({
      kind: FrameKind.OUTPUT,
      payload: firstPayload,
      streamId: 7,
    });
    const second = encodeFrame({
      kind: FrameKind.EXIT,
      payload: Buffer.from('{"exitCode":0,"signal":null}'),
      streamId: 7,
    });
    const decoder = new FrameDecoder();

    expect(decoder.push(first.subarray(0, 5))).toEqual([]);
    expect(decoder.push(first.subarray(5, 17))).toEqual([]);
    const frames = decoder.push(Buffer.concat([first.subarray(17), second]));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ kind: FrameKind.OUTPUT, payload: firstPayload, streamId: 7 });
    expect(frames[1].kind).toBe(FrameKind.EXIT);
  });

  it('rejects a corrupted stream before accepting later bytes', () => {
    const frame = encodeFrame({ kind: FrameKind.HELLO, payload: Buffer.from('{}') });
    frame[0] = 0;
    const decoder = new FrameDecoder();

    expect(() => decoder.push(frame)).toThrow('invalid frame magic');
  });

  it('builds bounded descendant probes for each supported shell family', () => {
    const marker = 'LOBE_PTY_SHUTDOWN_ABC123';
    const windows = getShutdownProbeCommand(marker, { platform: 'win32' });
    const unix = getShutdownProbeCommand(marker, { platform: 'linux' });

    expect(windows).toContain(`[Console]::WriteLine('${marker}_'+$PID)`);
    expect(windows).toContain('Start-Sleep -Seconds 60');
    expect(unix).toContain(`printf "${marker}_%s\\n" "$$"`);
    expect(unix).toContain('exec sleep 60');
    expect(() => getShutdownProbeCommand('unsafe; marker')).toThrow('uppercase ASCII');
  });

  it('extracts only a valid marked process id from terminal output', () => {
    const marker = 'LOBE_PTY_SHUTDOWN_ABC123';

    expect(parseMarkedProcessId(Buffer.from(`prompt\r\n${marker}_4242\r\n`), marker)).toBe(4242);
    expect(parseMarkedProcessId(Buffer.from(`${marker}_0`), marker)).toBeUndefined();
    expect(parseMarkedProcessId(Buffer.from(`${marker}_not-a-pid`), marker)).toBeUndefined();
  });

  it('treats permission denial as alive and missing processes as exited', () => {
    expect(isProcessAlive(42, () => undefined)).toBe(true);
    expect(
      isProcessAlive(42, () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
    ).toBe(true);
    expect(
      isProcessAlive(42, () => {
        throw Object.assign(new Error('missing'), { code: 'ESRCH' });
      }),
    ).toBe(false);
  });

  it('waits until every managed process has exited', async () => {
    const checks = new Map([
      [11, 0],
      [12, 0],
    ]);

    await waitForProcessesToExit([11, 12, 12], {
      isAlive: (pid) => {
        const count = checks.get(pid) ?? 0;
        checks.set(pid, count + 1);
        return count === 0;
      },
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    expect(checks.get(11)).toBeGreaterThanOrEqual(2);
    expect(checks.get(12)).toBeGreaterThanOrEqual(2);
  });

  it('fails when a managed process survives the shutdown deadline', async () => {
    await expect(
      waitForProcessesToExit([71], {
        isAlive: () => true,
        timeoutMs: 0,
      }),
    ).rejects.toThrow('SHUTDOWN left managed processes running: 71');
  });
});
