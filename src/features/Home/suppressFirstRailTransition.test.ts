import { describe, expect, it } from 'vitest';

import { resolveSuppressRailTransition } from './suppressFirstRailTransition';

describe('resolveSuppressRailTransition', () => {
  it('suppresses the transition the first time the inbox resolves', () => {
    expect(resolveSuppressRailTransition({ hasResolved: true, hasSettledBefore: false })).toBe(
      true,
    );
  });

  it('does not suppress once it has already settled once', () => {
    expect(resolveSuppressRailTransition({ hasResolved: true, hasSettledBefore: true })).toBe(
      false,
    );
  });

  it('does not suppress while still unresolved — it has not settled yet', () => {
    expect(resolveSuppressRailTransition({ hasResolved: false, hasSettledBefore: false })).toBe(
      false,
    );
    expect(resolveSuppressRailTransition({ hasResolved: false, hasSettledBefore: true })).toBe(
      false,
    );
  });
});
