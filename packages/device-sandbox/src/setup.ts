import type { SandboxSetupResult } from './types';

/**
 * Whether this platform has a one-click setup the app can run for the user.
 *
 * Only Windows does: its backend needs a dedicated `srt-sandbox` account and a
 * WFP filter set, which `srt-win install` provisions in a single self-elevating
 * step. macOS needs nothing (Seatbelt ships with the OS), and Linux needs a
 * distro package (`bubblewrap`) that only the system's own package manager may
 * install — offering a button that can't deliver would be worse than telling
 * the user what to run.
 */
export const canInstallSandbox = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'win32';

/**
 * Provision whatever the sandbox backend needs on this machine.
 *
 * Users should not have to prepare anything before the desktop app can fence a
 * command — installing the app is supposed to be enough. This is the "enough"
 * part: a user-initiated setup the app runs on their behalf.
 *
 * On Windows this raises exactly one UAC prompt (the helper self-elevates) and
 * is idempotent, so re-running after a partial or failed attempt is safe.
 * Dismissing that prompt is a choice, not a failure: it comes back as
 * `cancelled` so the caller can leave the UI exactly as it was.
 *
 * Never called implicitly — creating a Windows account and installing network
 * filters is not something to do behind a user's back, so it hangs off an
 * explicit button.
 */
export const installDeviceSandbox = async (): Promise<SandboxSetupResult> => {
  if (!canInstallSandbox()) {
    const { windowsInstallInstructions } = await import('@anthropic-ai/sandbox-runtime');
    return {
      // Linux's dependency is a distro package; macOS should never get here at
      // all (an unavailable Seatbelt means something else is wrong, and the
      // probe's own reason says more than a generic instruction would).
      instructions:
        process.platform === 'linux'
          ? 'Install the sandbox dependency with your package manager, e.g. `sudo apt install bubblewrap`, then retry.'
          : windowsInstallInstructions(undefined),
      status: 'not-installable',
    };
  }

  const { installWindowsSandbox } = await import('@anthropic-ai/sandbox-runtime');
  const result = installWindowsSandbox();
  return result.cancelled ? { status: 'cancelled' } : { status: 'installed' };
};
