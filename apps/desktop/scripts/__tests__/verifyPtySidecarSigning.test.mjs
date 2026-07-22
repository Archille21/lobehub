import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  hasWindowsSigningConfiguration,
  verifyPackagedSignatures,
} from '../verifyPtySidecarSigning.mjs';

const createContext = (electronPlatformName, platformSpecificBuildOptions = {}) => ({
  appOutDir: path.join(path.sep, 'build', `${electronPlatformName}-unpacked`),
  electronPlatformName,
  packager: {
    appInfo: { productFilename: 'LobeHub' },
    info: { config: {} },
    platformSpecificBuildOptions,
  },
});

describe('PTY sidecar post-sign verification', () => {
  it('recognizes supported Windows signing mechanisms and explicit opt-out', () => {
    const context = createContext('win32');

    expect(hasWindowsSigningConfiguration(context, {})).toBe(false);
    expect(hasWindowsSigningConfiguration(context, { WIN_CSC_LINK: 'configured' })).toBe(true);
    expect(
      hasWindowsSigningConfiguration(
        createContext('win32', {
          signtoolOptions: { certificateSubjectName: 'LobeHub' },
        }),
        {},
      ),
    ).toBe(true);
    expect(
      hasWindowsSigningConfiguration(
        createContext('win32', {
          azureSignOptions: { certificateProfileName: 'release' },
        }),
        {},
      ),
    ).toBe(true);
    expect(
      hasWindowsSigningConfiguration(createContext('win32', { signExecutable: false }), {
        WIN_CSC_LINK: 'configured',
      }),
    ).toBe(false);
  });

  it('verifies nested macOS helpers before the deep application check', async () => {
    const context = createContext('darwin');
    const resourcesPath = path.join(context.appOutDir, 'LobeHub.app', 'Contents', 'Resources');
    const execute = vi.fn();

    await expect(
      verifyPackagedSignatures(context, resourcesPath, {
        environment: { CSC_LINK: 'certificate-material' },
        execute,
        logger: { info: vi.fn() },
      }),
    ).resolves.toEqual({ verified: true });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toBe('codesign');
    expect(execute.mock.calls[0][1].at(-1)).toBe(
      path.join(resourcesPath, 'bin', 'lobe-pty-sidecar'),
    );
    expect(execute.mock.calls[0][2].env.CSC_LINK).toBeUndefined();
    expect(execute.mock.calls[1][1]).toContain('--deep');
    expect(execute.mock.calls[1][1].at(-1)).toBe(path.join(context.appOutDir, 'LobeHub.app'));
  });

  it('requires valid Authenticode on both Windows executables when signing is configured', async () => {
    const context = createContext('win32', { executableName: 'LobeHub' });
    const resourcesPath = path.join(context.appOutDir, 'resources');
    const execute = vi.fn();
    const signingSecret = 'certificate-material-that-must-not-be-forwarded';

    await expect(
      verifyPackagedSignatures(context, resourcesPath, {
        environment: {
          CSC_KEY_PASSWORD: 'password-that-must-not-be-forwarded',
          SystemRoot: 'C:\\Windows',
          WIN_CSC_LINK: signingSecret,
        },
        execute,
        logger: { info: vi.fn() },
      }),
    ).resolves.toEqual({ verified: true });

    expect(execute).toHaveBeenCalledTimes(1);
    const [executable, args, options] = execute.mock.calls[0];
    expect(executable).toBe(
      path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    );
    expect(args.join(' ')).not.toContain(signingSecret);
    expect(Buffer.from(args.at(-1), 'base64').toString('utf16le')).toContain(
      'Get-AuthenticodeSignature',
    );
    expect(options.env.WIN_CSC_LINK).toBeUndefined();
    expect(options.env.CSC_KEY_PASSWORD).toBeUndefined();
    expect(options.env.LOBE_DESKTOP_SIGNED_APP_PATH).toBe(
      path.join(context.appOutDir, 'LobeHub.exe'),
    );
    expect(options.env.LOBE_DESKTOP_SIGNED_SIDECAR_PATH).toBe(
      path.join(resourcesPath, 'bin', 'lobe-pty-sidecar.exe'),
    );
  });

  it('leaves intentionally unsigned local and PR builds unblocked', async () => {
    const execute = vi.fn();

    await expect(
      verifyPackagedSignatures(
        createContext('win32'),
        path.join(path.sep, 'build', 'win32-unpacked', 'resources'),
        { environment: {}, execute, logger: { info: vi.fn() } },
      ),
    ).resolves.toEqual({ verified: false });
    await expect(
      verifyPackagedSignatures(
        createContext('darwin'),
        path.join(path.sep, 'build', 'darwin-unpacked', 'LobeHub.app', 'Contents', 'Resources'),
        { environment: {}, execute, logger: { info: vi.fn() } },
      ),
    ).resolves.toEqual({ verified: false });

    expect(execute).not.toHaveBeenCalled();
  });
});
