import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertPtySidecarBinary, buildPtySidecar } from './buildPtySidecar.mjs';
import { createDevOrchestrator } from './devOrchestrator.mjs';

const desktopRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(desktopRoot, 'package.json'));

// vite's `exports` map blocks `require.resolve('vite/bin/vite.js')` directly.
const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');

let sidecarPath;
try {
  const configuredSidecarPath = process.env.LOBE_PTY_SIDECAR_PATH?.trim();
  if (configuredSidecarPath) {
    sidecarPath = path.resolve(desktopRoot, configuredSidecarPath);
    await assertPtySidecarBinary({
      binaryPath: sidecarPath,
      requireExecutable: process.platform !== 'win32',
    });
  } else {
    sidecarPath = await buildPtySidecar();
  }
  console.info(`PTY sidecar ready: ${sidecarPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

// Forward everything after `pnpm dev --` (e.g. --remote-debugging-port=9223) to electron.
const rawArgs = process.argv.slice(2);
const electronArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const cdpPort = Number(process.env.LOBE_DESKTOP_CDP_PORT);
if (
  Number.isInteger(cdpPort) &&
  cdpPort > 0 &&
  !electronArgs.some((arg) => arg.startsWith('--remote-debugging-port'))
) {
  electronArgs.push(`--remote-debugging-port=${cdpPort}`);
}

const orchestrator = createDevOrchestrator({
  desktopRoot,
  electronArgs,
  electronBin: require('electron'),
  sidecarPath,
  viteBin,
  vitePort: Number(process.env.LOBE_DESKTOP_VITE_PORT) || 5173,
});

process.on('SIGINT', () => orchestrator.shutdown(0));
process.on('SIGTERM', () => orchestrator.shutdown(0));

orchestrator.start();
