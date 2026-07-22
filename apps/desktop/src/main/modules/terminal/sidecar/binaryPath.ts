import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import { PtySidecarError } from './types';

interface ResolvePtySidecarBinaryOptions {
  accessBinary?: (binaryPath: string, mode: number) => Promise<void>;
  appPath?: string;
  arch?: NodeJS.Architecture;
  environment?: NodeJS.ProcessEnv;
  isPackaged?: boolean;
  platform?: NodeJS.Platform;
  resourcesPath?: string;
  verifyArchitecture?: (
    binaryPath: string,
    platform: NodeJS.Platform,
    arch: NodeJS.Architecture,
  ) => Promise<void>;
}

const isSupportedTarget = (platform: NodeJS.Platform, arch: NodeJS.Architecture) =>
  (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) ||
  (platform === 'linux' && arch === 'x64') ||
  (platform === 'win32' && arch === 'x64');

const BINARY_HEADER_READ_SIZE = 64 * 1024;
const MACH_CPU_ARM64 = 0x0100_000c;
const MACH_CPU_X64 = 0x0100_0007;

type ReadBinaryHeader = (binaryPath: string) => Promise<Uint8Array>;

const readBinaryHeader: ReadBinaryHeader = async (binaryPath) => {
  const file = await open(binaryPath, 'r');
  try {
    const buffer = new Uint8Array(BINARY_HEADER_READ_SIZE);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
};

const architectureError = (platform: NodeJS.Platform, arch: NodeJS.Architecture) =>
  new PtySidecarError(
    'SIDECAR_START_FAILED',
    `The terminal sidecar binary does not match ${platform}/${arch}`,
  );

const verifyMachArchitecture = (bytes: Uint8Array, arch: NodeJS.Architecture) => {
  if (bytes.byteLength < 8) throw architectureError('darwin', arch);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expectedCpu = arch === 'arm64' ? MACH_CPU_ARM64 : MACH_CPU_X64;
  const littleEndianMagic = view.getUint32(0, true);
  if (littleEndianMagic === 0xfeed_facf) {
    if (view.getUint32(4, true) !== expectedCpu) throw architectureError('darwin', arch);
    return;
  }

  const bigEndianMagic = view.getUint32(0, false);
  const isFat32 = bigEndianMagic === 0xcafe_babe;
  const isFat64 = bigEndianMagic === 0xcafe_babf;
  if (!isFat32 && !isFat64) throw architectureError('darwin', arch);

  const architectureCount = view.getUint32(4, false);
  const entrySize = isFat64 ? 32 : 20;
  for (let index = 0; index < architectureCount; index++) {
    const offset = 8 + index * entrySize;
    if (offset + entrySize > bytes.byteLength) throw architectureError('darwin', arch);
    if (view.getUint32(offset, false) === expectedCpu) return;
  }
  throw architectureError('darwin', arch);
};

const verifyElfArchitecture = (bytes: Uint8Array, arch: NodeJS.Architecture) => {
  if (
    bytes.byteLength < 20 ||
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46 ||
    bytes[4] !== 2
  ) {
    throw architectureError('linux', arch);
  }
  const littleEndian = bytes[5] === 1;
  if (!littleEndian && bytes[5] !== 2) throw architectureError('linux', arch);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(18, littleEndian) !== 62) throw architectureError('linux', arch);
};

const verifyPeArchitecture = (bytes: Uint8Array, arch: NodeJS.Architecture) => {
  if (bytes.byteLength < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw architectureError('win32', arch);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  if (
    peOffset + 6 > bytes.byteLength ||
    view.getUint32(peOffset, false) !== 0x5045_0000 ||
    view.getUint16(peOffset + 4, true) !== 0x8664
  ) {
    throw architectureError('win32', arch);
  }
};

export const verifyPtySidecarArchitecture = async (
  binaryPath: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  readHeader: ReadBinaryHeader = readBinaryHeader,
) => {
  const bytes = await readHeader(binaryPath);
  if (platform === 'darwin') return verifyMachArchitecture(bytes, arch);
  if (platform === 'linux') return verifyElfArchitecture(bytes, arch);
  if (platform === 'win32') return verifyPeArchitecture(bytes, arch);
  throw architectureError(platform, arch);
};

export const resolvePtySidecarBinaryPath = async ({
  accessBinary = access,
  appPath = app.getAppPath(),
  arch = process.arch,
  environment = process.env,
  isPackaged = app.isPackaged,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  verifyArchitecture = verifyPtySidecarArchitecture,
}: ResolvePtySidecarBinaryOptions = {}): Promise<string> => {
  if (!isSupportedTarget(platform, arch)) {
    throw new PtySidecarError(
      'SIDECAR_START_FAILED',
      `The terminal sidecar does not support ${platform}/${arch}`,
    );
  }

  const binaryName = platform === 'win32' ? 'lobe-pty-sidecar.exe' : 'lobe-pty-sidecar';
  const developmentOverride = !isPackaged ? environment.LOBE_PTY_SIDECAR_PATH : undefined;
  const binaryPath = developmentOverride
    ? path.resolve(developmentOverride)
    : isPackaged
      ? path.join(resourcesPath, 'bin', binaryName)
      : path.join(appPath, 'native', 'pty-sidecar', 'target', 'debug', binaryName);

  try {
    await accessBinary(binaryPath, platform === 'win32' ? constants.F_OK : constants.X_OK);
    await verifyArchitecture(binaryPath, platform, arch);
  } catch (cause) {
    if (cause instanceof PtySidecarError) throw cause;
    throw new PtySidecarError(
      'SIDECAR_START_FAILED',
      'The terminal sidecar binary is unavailable',
      { cause },
    );
  }

  return binaryPath;
};
