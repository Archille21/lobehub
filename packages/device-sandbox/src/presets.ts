import os from 'node:os';

import type { SandboxPolicy } from './types';

/**
 * Policy for the desktop "Local Sandbox" execution environment — the option a
 * user picks in the execution-environment switcher to keep an agent's shell
 * commands inside the run's working directory.
 *
 * Deliberately narrow, because the picker promises exactly this and nothing
 * more:
 *
 * - **writes** are confined to the run's `cwd` plus the OS temp directory.
 *   Tooling that cannot write a temp file at all (compilers, package managers,
 *   `git`) fails in ways that read as product bugs, so temp is part of the
 *   contract rather than a leak the user has to discover.
 * - **reads** stay unrestricted. SRT's read denial is a separate axis
 *   (`deniedReadRoots`), and a blanket read jail would break every command that
 *   touches a toolchain outside the project (node_modules symlinks, rustup,
 *   Homebrew). "Can't modify anything outside the project" is the honest,
 *   enforceable promise; "can't see anything" is not.
 * - **network is denied**, with no allowlist. `normalizeSandboxPolicy` rejects
 *   `allowNetwork` without a non-empty domain allowlist, and there is no UI to
 *   author one yet — so the first version is offline, full stop.
 *
 * `onUnavailable: 'deny'` is the whole point of the option: if SRT can't be
 * initialized on this host (Windows, missing bubblewrap on Linux), the command
 * must fail loudly. Silently running unsandboxed would hand the user a security
 * guarantee the process never applied.
 */
export const createLocalSandboxPolicy = (cwd: string): SandboxPolicy => ({
  allowNetwork: false,
  onUnavailable: 'deny',
  writableRoots: [cwd, os.tmpdir()],
});
