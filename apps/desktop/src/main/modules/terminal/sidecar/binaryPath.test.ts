import { constants } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolvePtySidecarBinaryPath, verifyPtySidecarArchitecture } from './binaryPath';

const machHeader = (cpu: number) => {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeed_facf, true);
  view.setUint32(4, cpu, true);
  return bytes;
};

const elfX64Header = () => {
  const bytes = new Uint8Array(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  new DataView(bytes.buffer).setUint16(18, 62, true);
  return bytes;
};

const peX64Header = () => {
  const bytes = new Uint8Array(256);
  bytes.set([0x4d, 0x5a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(0x3c, 128, true);
  view.setUint32(128, 0x5045_0000, false);
  view.setUint16(132, 0x8664, true);
  return bytes;
};

describe('PTY sidecar binary resolver', () => {
  it('uses a development override and validates executable access and architecture', async () => {
    const accessBinary = vi.fn().mockResolvedValue(undefined);
    const verifyArchitecture = vi.fn().mockResolvedValue(undefined);

    const result = await resolvePtySidecarBinaryPath({
      accessBinary,
      appPath: '/app',
      arch: 'arm64',
      environment: { LOBE_PTY_SIDECAR_PATH: './custom-sidecar' },
      isPackaged: false,
      platform: 'darwin',
      verifyArchitecture,
    });

    expect(result).toBe(path.resolve('./custom-sidecar'));
    expect(accessBinary).toHaveBeenCalledWith(result, constants.X_OK);
    expect(verifyArchitecture).toHaveBeenCalledWith(result, 'darwin', 'arm64');
  });

  it('ignores the development override in packaged applications', async () => {
    const accessBinary = vi.fn().mockResolvedValue(undefined);
    const verifyArchitecture = vi.fn().mockResolvedValue(undefined);

    const result = await resolvePtySidecarBinaryPath({
      accessBinary,
      arch: 'x64',
      environment: { LOBE_PTY_SIDECAR_PATH: '/untrusted/override' },
      isPackaged: true,
      platform: 'win32',
      resourcesPath: 'C:\\Program Files\\LobeHub\\resources',
      verifyArchitecture,
    });

    expect(result).toBe(
      path.join('C:\\Program Files\\LobeHub\\resources', 'bin', 'lobe-pty-sidecar.exe'),
    );
    expect(accessBinary).toHaveBeenCalledWith(result, constants.F_OK);
  });

  it('recognizes the native executable formats and rejects the wrong machine', async () => {
    await expect(
      verifyPtySidecarArchitecture('/mac', 'darwin', 'arm64', async () => machHeader(0x0100_000c)),
    ).resolves.toBeUndefined();
    await expect(
      verifyPtySidecarArchitecture('/linux', 'linux', 'x64', async () => elfX64Header()),
    ).resolves.toBeUndefined();
    await expect(
      verifyPtySidecarArchitecture('/windows', 'win32', 'x64', async () => peX64Header()),
    ).resolves.toBeUndefined();
    await expect(
      verifyPtySidecarArchitecture('/mac', 'darwin', 'x64', async () => machHeader(0x0100_000c)),
    ).rejects.toMatchObject({ code: 'SIDECAR_START_FAILED' });
  });

  it('rejects unsupported runtime targets before touching the filesystem', async () => {
    const accessBinary = vi.fn();

    await expect(
      resolvePtySidecarBinaryPath({ accessBinary, arch: 'arm64', platform: 'linux' }),
    ).rejects.toMatchObject({ code: 'SIDECAR_START_FAILED' });
    expect(accessBinary).not.toHaveBeenCalled();
  });
});
