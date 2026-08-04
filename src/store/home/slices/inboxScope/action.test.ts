import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resolveHomeInboxHasContent } from '@/features/HomeInbox/homeInboxHasContent';
import { filterTopicsForInboxScope } from '@/features/HomeInbox/scopeTogglePlacement';
import { useHomeStore } from '@/store/home';

import { initialInboxScopeState } from './initialState';
import { homeInboxScopeSelectors } from './selectors';

beforeEach(() => {
  useHomeStore.setState({ ...initialInboxScopeState });
});

describe('InboxScopeActionImpl', () => {
  it('shares one scope value across independent subscribers', () => {
    const { result: subscriberA } = renderHook(() =>
      useHomeStore(homeInboxScopeSelectors.homeInboxScope),
    );
    const { result: subscriberB } = renderHook(() =>
      useHomeStore(homeInboxScopeSelectors.homeInboxScope),
    );

    expect(subscriberA.current).toBe('mine');
    expect(subscriberB.current).toBe('mine');

    act(() => {
      useHomeStore.getState().setHomeInboxScope('team');
    });

    expect(subscriberA.current).toBe('team');
    expect(subscriberB.current).toBe('team');
  });

  it('keeps the rail visible once the viewer switches to team view and their own running tasks empty out', () => {
    const myId = 'user-1';
    const teamRunning = [
      { id: 'task-1', userId: 'user-2' },
      { id: 'task-2', userId: 'user-3' },
    ];

    act(() => {
      useHomeStore.getState().setHomeInboxScope('team');
    });

    const scope = useHomeStore.getState().homeInboxScope;
    const teamView = scope === 'team';
    const runningTopics = filterTopicsForInboxScope(teamRunning, myId, teamView);

    expect(runningTopics).toHaveLength(2);
    expect(
      resolveHomeInboxHasContent({
        isMain: false,
        recommendationsVisible: false,
        sectionsCount: runningTopics.length > 0 ? 1 : 0,
        status: 'ready',
      }),
    ).toBe(true);
  });
});
