import type * as BusinessConst from '@lobechat/business-const';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The portrait is the only thing on the dashboard fetched from a third-party
 * origin — its artwork lives in the hosted ops bucket (`OPS_ASSETS_BASE_URL`) —
 * so a distribution that turns it off is avoiding an off-origin request on every
 * home view, not just hiding a decoration. Losing the switch would restore that
 * request silently, with nothing on screen to say so.
 *
 * `HOME_PORTRAIT_ENABLED` is read at module scope, so each case re-imports the
 * hook from a cold registry — same reason as useCategory.hiddenTabs.test.tsx.
 */
const renderShowPortrait = async ({
  isLogin,
  portraitEnabled,
}: {
  isLogin: boolean;
  portraitEnabled: boolean;
}) => {
  vi.resetModules();

  // Partial mock: the hook's module graph reaches the rest of the branding
  // surface through @lobechat/const, and overriding only the one flag keeps
  // every other value real.
  vi.doMock('@lobechat/business-const', async (importOriginal) => ({
    ...(await importOriginal<typeof BusinessConst>()),
    HOME_PORTRAIT_ENABLED: portraitEnabled,
  }));
  vi.doMock('@/store/user', () => ({ useUserStore: (selector: () => boolean) => selector() }));
  vi.doMock('@/store/user/slices/auth/selectors', () => ({
    authSelectors: { isLogin: () => isLogin },
  }));

  const { useShowPortrait } = await import('../useShowPortrait');
  return renderHook(() => useShowPortrait()).result.current;
};

afterEach(() => {
  cleanup();
  vi.doUnmock('@lobechat/business-const');
});

describe('useShowPortrait', () => {
  it('shows the portrait for a signed-in user when enabled', async () => {
    await expect(renderShowPortrait({ isLogin: true, portraitEnabled: true })).resolves.toBe(true);
  });

  it('hides it when the distribution disables it', async () => {
    await expect(renderShowPortrait({ isLogin: true, portraitEnabled: false })).resolves.toBe(
      false,
    );
  });

  it('hides it for signed-out visitors even when enabled', async () => {
    await expect(renderShowPortrait({ isLogin: false, portraitEnabled: true })).resolves.toBe(
      false,
    );
  });
});
