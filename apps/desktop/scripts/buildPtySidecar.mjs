import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const crateRoot = fileURLToPath(new URL('../native/pty-sidecar/', import.meta.url));

const ARCHITECTURE_ALIASES = new Map([
  ['aarch64', 'arm64'],
  ['amd64', 'x64'],
  ['arm64', 'arm64'],
  ['x64', 'x64'],
  ['x86_64', 'x64'],
]);

const CPU_ARCHITECTURES = new Map([
  [0x01_00_00_07, 'x64'],
  [0x01_00_00_0c, 'arm64'],
]);

const ELF_ARCHITECTURES = new Map([
  [62, 'x64'],
  [183, 'arm64'],
]);

const PE_ARCHITECTURES = new Map([
  [0x8664, 'x64'],
  [0xaa64, 'arm64'],
]);

export const getPtySidecarBinaryName = (platform = process.platform) =>
  platform === 'win32' ? 'lobe-pty-sidecar.exe' : 'lobe-pty-sidecar';

export const normalizeArchitecture = (architecture) =>
  ARCHITECTURE_ALIASES.get(architecture?.toLowerCase()) ?? architecture;

export const getPtySidecarBinaryPath = ({
  platform = process.platform,
  release = false,
  targetDirectory = process.env.CARGO_TARGET_DIR,
  targetTriple = process.env.CARGO_BUILD_TARGET,
} = {}) => {
  const cargoTargetDirectory = targetDirectory
    ? path.resolve(crateRoot, targetDirectory)
    : path.join(crateRoot, 'target');
  const profileDirectory = release ? 'release' : 'debug';

  return path.join(
    cargoTargetDirectory,
    ...(targetTriple ? [targetTriple] : []),
    profileDirectory,
    getPtySidecarBinaryName(platform),
  );
};

/**
 * Read the native architecture from a Mach-O, ELF, or PE executable header.
 * Rust release artifacts are deliberately native-only, so fat Mach-O binaries
 * are rejected instead of selecting one slice implicitly.
 */
export const detectBinaryArchitecture = (binary) => {
  if (!Buffer.isBuffer(binary) || binary.length < 20) return undefined;

  const littleEndianMagic = binary.readUInt32LE(0);
  const bigEndianMagic = binary.readUInt32BE(0);

  if (littleEndianMagic === 0xfeedfacf || littleEndianMagic === 0xfeedface) {
    return CPU_ARCHITECTURES.get(binary.readUInt32LE(4));
  }

  if (bigEndianMagic === 0xfeedfacf || bigEndianMagic === 0xfeedface) {
    return CPU_ARCHITECTURES.get(binary.readUInt32BE(4));
  }

  if (bigEndianMagic === 0xcafebabe || littleEndianMagic === 0xcafebabe) {
    return 'universal';
  }

  if (binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const isLittleEndian = binary[5] === 1;
    const machine = isLittleEndian ? binary.readUInt16LE(18) : binary.readUInt16BE(18);
    return ELF_ARCHITECTURES.get(machine);
  }

  if (binary[0] === 0x4d && binary[1] === 0x5a && binary.length >= 64) {
    const peHeaderOffset = binary.readUInt32LE(0x3c);
    if (
      peHeaderOffset + 6 <= binary.length &&
      binary.subarray(peHeaderOffset, peHeaderOffset + 4).equals(Buffer.from('PE\0\0'))
    ) {
      return PE_ARCHITECTURES.get(binary.readUInt16LE(peHeaderOffset + 4));
    }
  }

  return undefined;
};

export const assertPtySidecarBinary = async ({
  binaryPath,
  expectedArchitecture = process.env.npm_config_arch || process.arch,
  requireExecutable = false,
} = {}) => {
  const normalizedExpectedArchitecture = normalizeArchitecture(expectedArchitecture);

  if (!['arm64', 'x64'].includes(normalizedExpectedArchitecture)) {
    throw new Error(`Unsupported PTY sidecar architecture: ${expectedArchitecture}`);
  }

  let binary;
  let stat;
  try {
    [binary, stat] = await Promise.all([fs.readFile(binaryPath), fs.stat(binaryPath)]);
  } catch (error) {
    throw new Error(`PTY sidecar binary is missing at ${binaryPath}`, { cause: error });
  }

  if (!stat.isFile()) {
    throw new Error(`PTY sidecar path is not a file: ${binaryPath}`);
  }

  if (requireExecutable && (stat.mode & 0o111) === 0) {
    throw new Error(`PTY sidecar is not executable: ${binaryPath}`);
  }

  const actualArchitecture = detectBinaryArchitecture(binary);
  if (!actualArchitecture) {
    throw new Error(`Unable to determine PTY sidecar architecture: ${binaryPath}`);
  }

  if (actualArchitecture !== normalizedExpectedArchitecture) {
    throw new Error(
      `PTY sidecar architecture mismatch: expected ${normalizedExpectedArchitecture}, found ${actualArchitecture}`,
    );
  }

  return { actualArchitecture, binaryPath };
};

const runCargoBuild = ({ release }) =>
  new Promise((resolve, reject) => {
    const args = ['build', ...(release ? ['--release'] : []), '--locked'];
    const child = spawn('cargo', args, {
      cwd: crateRoot,
      env: process.env,
      shell: false,
      // Keep stdout reserved for the final machine-readable binary path.
      stdio: ['inherit', process.stderr, process.stderr],
    });

    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            'Cargo is required to build the desktop PTY sidecar. Install the Rust toolchain declared in native/pty-sidecar/rust-toolchain.toml and retry.',
            { cause: error },
          ),
        );
        return;
      }

      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Cargo failed to build the PTY sidecar (exit=${code ?? 'null'}, signal=${signal ?? 'none'}). Verify the pinned Rust toolchain and Cargo.lock.`,
        ),
      );
    });
  });

export const buildPtySidecar = async ({
  expectedArchitecture = process.env.npm_config_arch || process.arch,
  release = false,
} = {}) => {
  await runCargoBuild({ release });

  const binaryPath = getPtySidecarBinaryPath({ release });
  await assertPtySidecarBinary({
    binaryPath,
    expectedArchitecture,
    requireExecutable: process.platform !== 'win32',
  });

  return binaryPath;
};

const isDirectExecution =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const release = process.argv.slice(2).includes('--release');

  try {
    const binaryPath = getPtySidecarBinaryPath({ release });
    if (release && process.env.LOBE_PTY_SIDECAR_PREPARED === '1') {
      await assertPtySidecarBinary({
        binaryPath,
        requireExecutable: process.platform !== 'win32',
      });
    } else {
      await buildPtySidecar({ release });
    }
    // This is the script's only stdout output. Callers can consume it directly.
    process.stdout.write(`${binaryPath}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
