import { describe, expect, it } from 'vitest';

import { resolveHomeRailVisible, resolveRailToggleVisible } from './homeRailVisibility';

describe('resolveHomeRailVisible', () => {
  it('collapses the rail column when it has no content', () => {
    expect(
      resolveHomeRailVisible({ isLogin: true, railHasContent: false, showHomeRail: true }),
    ).toBe(false);
  });

  it('shows the rail once content arrives', () => {
    expect(
      resolveHomeRailVisible({ isLogin: true, railHasContent: true, showHomeRail: true }),
    ).toBe(true);
  });

  it('keeps the rail collapsed when the user manually hid it, even with content', () => {
    expect(
      resolveHomeRailVisible({ isLogin: true, railHasContent: true, showHomeRail: false }),
    ).toBe(false);
  });

  it('never shows the rail to a signed-out visitor', () => {
    expect(
      resolveHomeRailVisible({ isLogin: false, railHasContent: true, showHomeRail: true }),
    ).toBe(false);
  });
});

describe('resolveRailToggleVisible', () => {
  it('hides the toggle when the rail has no content', () => {
    expect(
      resolveRailToggleVisible({ isLogin: true, isStatusInit: true, railHasContent: false }),
    ).toBe(false);
  });

  it('shows the toggle once content arrives', () => {
    expect(
      resolveRailToggleVisible({ isLogin: true, isStatusInit: true, railHasContent: true }),
    ).toBe(true);
  });

  it('hides the toggle before system status has loaded', () => {
    expect(
      resolveRailToggleVisible({ isLogin: true, isStatusInit: false, railHasContent: true }),
    ).toBe(false);
  });
});
