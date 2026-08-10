import os from 'node:os';

import { describe, expect, it } from 'vitest';

import { normalizeSandboxPolicy } from '../policy';
import { createLocalSandboxPolicy } from '../presets';

describe('createLocalSandboxPolicy', () => {
  it('confines writes to the working directory and the temp dir', () => {
    const policy = createLocalSandboxPolicy(process.cwd());

    expect(policy.writableRoots).toEqual([process.cwd(), os.tmpdir()]);
  });

  it('denies network with no allowlist', () => {
    // `normalizeSandboxPolicy` throws when `allowNetwork` is set without a
    // non-empty domain allowlist, so a policy that accidentally opened the
    // network would fail here rather than at the user's machine.
    const policy = createLocalSandboxPolicy(process.cwd());

    expect(policy.allowNetwork).toBe(false);
    expect(policy.allowedNetworkDomains).toBeUndefined();
    expect(() => normalizeSandboxPolicy(policy)).not.toThrow();
  });

  it('fails closed when no sandbox backend is available', () => {
    // The whole point of the option: an unavailable backend must abort the
    // command, never downgrade it to an unsandboxed spawn.
    expect(createLocalSandboxPolicy(process.cwd()).onUnavailable).toBe('deny');
  });

  it('leaves reads unrestricted', () => {
    // Commands legitimately read toolchains outside the project (node, rustup,
    // Homebrew). The promise is "can't modify anything outside the working
    // directory", not "can't see anything".
    const policy = createLocalSandboxPolicy(process.cwd());

    expect(policy.deniedReadRoots).toBeUndefined();
    expect(policy.readableRoots).toBeUndefined();
  });
});
