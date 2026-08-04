import { describe, expect, it } from 'vitest';

import { resolveSuppressRailTransition } from './suppressFirstRailTransition';

describe('resolveSuppressRailTransition', () => {
  it('suppresses the transition the first time loading settles to ready', () => {
    expect(resolveSuppressRailTransition({ hasSettledBefore: false, status: 'ready' })).toBe(true);
  });

  it('suppresses the transition the first time loading settles to error', () => {
    expect(resolveSuppressRailTransition({ hasSettledBefore: false, status: 'error' })).toBe(true);
  });

  it('does not suppress once it has already settled once', () => {
    expect(resolveSuppressRailTransition({ hasSettledBefore: true, status: 'ready' })).toBe(false);
    expect(resolveSuppressRailTransition({ hasSettledBefore: true, status: 'error' })).toBe(false);
  });

  it('does not suppress while still loading — it has not settled yet', () => {
    expect(resolveSuppressRailTransition({ hasSettledBefore: false, status: 'loading' })).toBe(
      false,
    );
    expect(resolveSuppressRailTransition({ hasSettledBefore: true, status: 'loading' })).toBe(
      false,
    );
  });
});
