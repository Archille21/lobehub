import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getPtySidecarBinaryPath } from './buildPtySidecar.mjs';

const desktopRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(desktopRoot, 'package.json'));

export const launchDesktopElectron = ({
  electronArgs = [],
  electronBin = require('electron'),
  environment = process.env,
  spawn = nodeSpawn,
} = {}) => {
  const configuredSidecarPath = environment.LOBE_PTY_SIDECAR_PATH?.trim();
  const sidecarPath = configuredSidecarPath
    ? path.resolve(desktopRoot, configuredSidecarPath)
    : getPtySidecarBinaryPath({
        targetDirectory: environment.CARGO_TARGET_DIR,
        targetTriple: environment.CARGO_BUILD_TARGET,
      });

  return spawn(electronBin, ['.', ...electronArgs], {
    cwd: desktopRoot,
    env: {
      ...environment,
      LOBE_PTY_SIDECAR_PATH: sidecarPath,
    },
    stdio: 'inherit',
  });
};

const isDirectExecution =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const rawArgs = process.argv.slice(2);
  const electronArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  const electron = launchDesktopElectron({ electronArgs });

  electron.once('error', (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
  electron.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
