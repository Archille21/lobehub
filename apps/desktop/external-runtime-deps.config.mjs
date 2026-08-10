import {
  copyModulesToSource,
  getDependenciesForModules,
  getModuleFilesConfig,
} from './module-deps.config.mjs';

/**
 * Non-native modules intentionally externalized from the main-process bundle.
 *
 * These modules are not native dependencies. They stay external because their
 * process-level side effects must be owned by one Node runtime module instance.
 */
export const externalRuntimeModules = [
  // Ships the `srt-win` / seccomp helper binaries under `vendor/` and resolves
  // them relative to its own package directory. Bundling it into the main
  // process would leave those files out of the app entirely, so the Local
  // Sandbox could neither probe nor install itself — the one thing a user who
  // installed the desktop app should not have to arrange by hand.
  '@anthropic-ai/sandbox-runtime',
  'electron-log',
  'font-list',
];

/**
 * Get all dependencies for runtime external modules.
 * @returns {string[]}
 */
export function getAllExternalRuntimeDependencies() {
  return getDependenciesForModules(externalRuntimeModules);
}

/**
 * Generate files config objects for non-native runtime external modules.
 * @returns {Array<{from: string, to: string, filter: string[]}>}
 */
export function getExternalRuntimeModulesFilesConfig() {
  return getModuleFilesConfig(externalRuntimeModules);
}

export async function copyExternalRuntimeModulesToSource() {
  await copyModulesToSource(externalRuntimeModules, 'runtime external module');
}
