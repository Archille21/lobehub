import type * as BusinessConst from '@lobechat/business-const';
import { cleanup, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The deny-list lives in a separate file from the rest of useCategory's tests
 * because it is read once at module scope, so each case has to re-import the
 * hook from cold.
 *
 * Everything the hook depends on is imported from that same fresh graph —
 * `vi.resetModules()` gives the dynamic import a new module registry, and a
 * statically-imported store Provider would be a different instance than the one
 * the hook reads from ("you have not used zustand provider as an ancestor").
 */

// The cold re-import pulls the whole settings module graph and does not fit in
// the 5s default. Generous, because the ceiling is reached only when this file
// runs alongside the rest of the suite — a timeout here would say nothing about
// the deny-list.
vi.setConfig({ testTimeout: 60_000 });

vi.hoisted(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    },
  });
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const renderCategories = async (hidden: readonly string[]) => {
  vi.resetModules();
  vi.doMock('@lobechat/business-const', async (importOriginal) => ({
    ...(await importOriginal<typeof BusinessConst>()),
    SETTINGS_HIDDEN_TABS: hidden,
  }));

  const [{ useCategory }, { initServerConfigStore, Provider }, { mapFeatureFlagsEnvToState }] =
    await Promise.all([
      import('./useCategory'),
      import('@/store/serverConfig/store'),
      import('@/config/featureFlags'),
    ]);

  const Wrapper = ({ children }: { children: ReactNode }) => (
    <Provider
      createStore={() =>
        initServerConfigStore({
          featureFlags: mapFeatureFlagsEnvToState({ provider_settings: true }),
          // The subscription group exists only under business features — which
          // is exactly the deployment shape that has no billing to show.
          serverConfig: { aiProvider: {}, enableBusinessFeatures: true, telemetry: {} },
        })
      }
    >
      {children}
    </Provider>
  );

  const { result } = renderHook(() => useCategory(), { wrapper: Wrapper });

  return result.current;
};

const keysOf = (groups: Awaited<ReturnType<typeof renderCategories>>) =>
  groups.flatMap((group) => group.items.map((item) => item.key as string));

afterEach(() => {
  cleanup();
  vi.doUnmock('@lobechat/business-const');
  vi.resetModules();
});

describe('settings hidden tabs', () => {
  it('shows everything when nothing is hidden, and removes exactly what is listed', async () => {
    const before = keysOf(await renderCategories([]));

    expect(before).toEqual(expect.arrayContaining(['devices', 'credential', 'messenger']));

    // Same render path with one entry listed — the result must differ by that
    // entry and nothing else.
    const after = keysOf(await renderCategories(['devices']));

    expect(after).toEqual(before.filter((key) => key !== 'devices'));
  });

  it('removes the listed tabs', async () => {
    const groups = await renderCategories(['devices', 'credential', 'messenger']);

    expect(keysOf(groups)).not.toContain('devices');
    expect(keysOf(groups)).not.toContain('credential');
    expect(keysOf(groups)).not.toContain('messenger');
    // Their groups still hold other tabs, so the groups themselves must survive.
    expect(groups.map((group) => group.key)).toEqual(expect.arrayContaining(['general', 'agent']));
  });

  // A heading with nothing under it reads as a section that failed to load.
  it('drops a group once all of its tabs are hidden', async () => {
    const groups = await renderCategories(['plans', 'usage', 'credits', 'billing', 'referral']);

    expect(groups.map((group) => group.key)).not.toContain('subscription');
    expect(groups.map((group) => group.key)).toContain('general');
  });
});
