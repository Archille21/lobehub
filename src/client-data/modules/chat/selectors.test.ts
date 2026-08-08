import type { ClientDataCommit } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { applyClientDataCommit } from '../../core/reducer';
import { ingestChatTopicsPage } from './ingestors';
import {
  selectChatTopicDetailItem,
  selectChatTopicListItem,
  selectChatTopicsIndex,
} from './selectors';

const obs = { observedAt: 100, source: 'network' as const };

const seed = (commit: ClientDataCommit) => applyClientDataCommit(undefined, commit);

const page = (over: object = {}) =>
  ingestChatTopicsPage(
    {
      containerKey: 'agent-1',
      context: { agentId: 'agent-1' },
      items: [
        {
          completedAt: null,
          createdAt: new Date('2026-01-01'),
          favorite: true,
          historySummary: null,
          id: 't1',
          metadata: null,
          model: 'gpt-5',
          provider: 'openai',
          sortUpdatedAt: 100,
          status: 'active',
          title: 'T1',
          updatedAt: new Date('2026-01-02'),
          userId: 'user-1',
        } as never,
      ],
      page: 0,
      pageSize: 20,
      signature: {},
      surface: 'sidebar',
      total: 1,
      ...over,
    },
    obs,
  );

describe('chat topic selectors', () => {
  it('reads the index back by surface and container', () => {
    const scope = seed(page());
    expect(selectChatTopicsIndex(scope, 'sidebar', 'agent-1')?.total).toBe(1);
    expect(selectChatTopicsIndex(scope, 'agentView', 'agent-1')).toBeUndefined();
  });

  it('assembles a list item view when required fragments exist', () => {
    const scope = seed(page());
    expect(selectChatTopicListItem(scope, 't1')).toMatchObject({
      favorite: true,
      id: 't1',
      model: 'gpt-5',
      sortUpdatedAt: 100,
      title: 'T1',
    });
  });

  it('does not fabricate views when required fragments are missing', () => {
    const scope = seed(page());
    expect(selectChatTopicDetailItem(scope, 't1')).toBeUndefined();
    expect(selectChatTopicListItem(scope, 'missing')).toBeUndefined();
  });

  it('assembles a detail view for withDetails records', () => {
    const scope = seed(
      page({
        items: [
          {
            completedAt: null,
            createdAt: new Date('2026-01-01'),
            description: 'd',
            favorite: false,
            firstUserMessage: 'f',
            historySummary: null,
            id: 't1',
            messageCount: 2,
            metadata: null,
            model: null,
            provider: null,
            sortUpdatedAt: 100,
            status: 'active',
            title: 'T1',
            trigger: null,
            updatedAt: new Date('2026-01-02'),
            userId: 'user-1',
          } as never,
        ],
        signature: { withDetails: true },
        surface: 'agentView',
      }),
    );
    expect(selectChatTopicDetailItem(scope, 't1')).toMatchObject({
      description: 'd',
      messageCount: 2,
    });
  });
});
