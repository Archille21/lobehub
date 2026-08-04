import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOME_RAIL_INBOX_OPTIONS,
  useHomeInboxSections,
} from '@/features/HomeInbox/useHomeInboxSections';
import { briefService } from '@/services/brief';
import { topicService } from '@/services/topic';
import { useBriefStore } from '@/store/brief';
import { initialBriefListState } from '@/store/brief/slices/list/initialState';
import { useHomeStore } from '@/store/home';
import { useUserStore } from '@/store/user';
import { withSWR } from '~test-utils';

import { initialInboxScopeState } from './initialState';
import { homeInboxScopeSelectors } from './selectors';

vi.mock('@/business/client/hooks/useWorkspaceMemberProfiles', () => ({
  useWorkspaceMemberProfiles: () =>
    new Map([
      ['user-1', {}],
      ['user-2', {}],
    ]),
}));

vi.mock('@/features/Recommendations', () => ({
  useRecommendationsSettled: () => true,
  useRecommendationsVisible: () => false,
}));

beforeEach(() => {
  useHomeStore.setState({ ...initialInboxScopeState });
  useBriefStore.setState({ ...initialBriefListState });
  useUserStore.setState({ isSignedIn: true, user: { id: 'user-1' } } as never);

  vi.spyOn(briefService, 'listUnresolved').mockResolvedValue({ data: [] } as never);
  vi.spyOn(topicService, 'queryTopics').mockResolvedValue([
    { id: 'task-1', status: 'running', userId: 'user-2' },
    { id: 'task-2', status: 'running', userId: 'user-3' },
  ] as never);
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

  it('keeps two independent useHomeInboxSections instances in agreement once the shared scope switches to team', async () => {
    const { result } = renderHook(
      () => ({
        railPredicate: useHomeInboxSections(HOME_RAIL_INBOX_OPTIONS),
        railRender: useHomeInboxSections(HOME_RAIL_INBOX_OPTIONS),
      }),
      { wrapper: withSWR },
    );

    await waitFor(() => expect(result.current.railPredicate.status).toBe('ready'));

    // A team member's own running task is what would normally have kept the
    // rail visible; with none of the mocked running tasks owned by them, the
    // 'mine' scope both instances start on already has nothing to show.
    expect(result.current.railPredicate.hasContent).toBe(false);
    expect(result.current.railRender.hasContent).toBe(false);

    act(() => {
      useHomeStore.getState().setHomeInboxScope('team');
    });

    await waitFor(() => {
      expect(result.current.railPredicate.hasContent).toBe(true);
      expect(result.current.railRender.hasContent).toBe(true);
    });
  });
});
