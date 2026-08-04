import { describe, expect, it } from 'vitest';

import {
  resolveRailHasSettled,
  resolveSuppressRailTransition,
} from './suppressFirstRailTransition';

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

describe('resolveRailHasSettled', () => {
  it('settles once the inbox resolves, toggle or not', () => {
    expect(resolveRailHasSettled({ hasResolved: true, showHomeRailChanged: false })).toBe(true);
    expect(resolveRailHasSettled({ hasResolved: true, showHomeRailChanged: true })).toBe(true);
  });

  it('settles on a manual toggle even if the inbox never resolves — caps the window', () => {
    expect(resolveRailHasSettled({ hasResolved: false, showHomeRailChanged: true })).toBe(true);
  });

  it('does not settle while neither has happened', () => {
    expect(resolveRailHasSettled({ hasResolved: false, showHomeRailChanged: false })).toBe(false);
  });
});
