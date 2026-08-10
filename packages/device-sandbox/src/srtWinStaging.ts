import fs from 'node:fs';
import path from 'node:path';

/**
 * Where the relocated helper lives. Under `ProgramData` because its default ACL
 * grants `BUILTIN\Users` read+execute — which is the entire point.
 */
const stagingRoot = (): string =>
  path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'LobeHub', 'sandbox');

/**
 * Version the staged copy so an app update cannot leave a stale helper behind:
 * a newer runtime gets a new directory rather than silently reusing the old
 * binary. Read from the package that owns the binary, so it tracks the real
 * artifact instead of anything we'd have to remember to bump.
 */
const resolveVersion = (packagedExe: string): string => {
  // <pkgRoot>/vendor/srt-win/<arch>/srt-win.exe
  const pkgRoot = path.resolve(path.dirname(packagedExe), '../../..');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // fall through
  }
  // Size is a weak but honest fallback: it changes with the binary, and a
  // collision only costs us a re-check that the copy already matches.
  return `size-${fs.statSync(packagedExe).size}`;
};

/**
 * Copy the Windows sandbox helper somewhere the sandbox user can actually read,
 * and return that path.
 *
 * The sandbox runs the child as a *separate local account*, so every binary in
 * the launch chain must be readable by that account — not just by the person
 * running the app. The desktop app installs per-user by default, landing the
 * packaged helper under `C:\Users\<name>\AppData\Local\…`, a tree no other
 * local account may read. `CreateProcessWithLogonW` then logs the sandbox user
 * on successfully and fails at process creation with a bare ACCESS_DENIED,
 * which reads like a broken sandbox rather than a file-permission problem.
 * Confirmed on a real host: same binary, same machine, works from
 * `ProgramData` and fails from the user profile.
 *
 * Relocating is the supported fix — the backend takes a `windows.srtWin.path`
 * override precisely so embedders can place the helper themselves. Granting the
 * sandbox account an ACE on the install directory would work too, but a
 * per-user install directory is replaced wholesale on update, taking the ACE
 * with it and silently breaking the sandbox again.
 *
 * Returns `undefined` on anything other than Windows (nothing to relocate) and
 * whenever staging fails — callers then fall back to the packaged binary, which
 * is the current behaviour, not a regression.
 */
export const ensureStagedSrtWin = (packagedExe: string): string | undefined => {
  if (process.platform !== 'win32') return undefined;

  try {
    const target = path.join(
      stagingRoot(),
      `srt-win-${resolveVersion(packagedExe)}`,
      'srt-win.exe',
    );

    // Size match is enough to treat the copy as current: the directory is
    // already version-scoped, so this only guards a truncated or half-written
    // file from a previous interrupted copy.
    const source = fs.statSync(packagedExe);
    if (fs.existsSync(target) && fs.statSync(target).size === source.size) return target;

    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Copy via a temp name in the same directory so a concurrent launch never
    // observes a partially written executable.
    const pending = `${target}.${process.pid}.tmp`;
    fs.copyFileSync(packagedExe, pending);
    fs.renameSync(pending, target);
    return target;
  } catch {
    // Another user on this machine may own the staged copy, ProgramData may be
    // locked down, the disk may be full. None of that should take the whole
    // feature down — fall back and let the caller fail loudly at launch if the
    // packaged path really is unreachable.
    return undefined;
  }
};
