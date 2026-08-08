import type { ChatTopic, ChatTopicsIndex } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { ingestChatTopicSearchResults, ingestChatTopicsPage } from './ingestors';

const topic = (id: string, over: Partial<ChatTopic> = {}): ChatTopic =>
  ({
    createdAt: new Date('2026-01-01'),
    favorite: false,
    historySummary: null,
    id,
    metadata: null,
    model: 'gpt-5',
    provider: 'openai',
    sortUpdatedAt: 100,
    status: 'active',
    title: `topic-${id}`,
    updatedAt: new Date('2026-01-02'),
    userId: 'user-1',
    ...over,
  }) as ChatTopic;

const obs = { observedAt: 100, source: 'network' as const };

const base = {
  containerKey: 'agent-1',
  context: { agentId: 'agent-1' },
  page: 0,
  pageSize: 2,
  signature: {},
  surface: 'sidebar' as const,
  total: 5,
};

describe('ingestChatTopicsPage', () => {
  it('builds base fragments and synthesizes routing from context', () => {
    const commit = ingestChatTopicsPage({ ...base, items: [topic('t1')] }, obs);
    const record = commit.entities?.[0];
    expect(record?.fragments).toMatchObject({
      display: { data: { title: 'topic-t1' } },
      generation: { data: { model: 'gpt-5', provider: 'openai' } },
      marking: { data: { favorite: false } },
      ordering: { data: { sortUpdatedAt: 100 } },
      ownership: { data: { userId: 'user-1' } },
      routing: { data: { agentId: 'agent-1' } },
    });
    expect(record?.fragments).not.toHaveProperty('details');
  });

  it('adds details and triggerInfo fragments only for withDetails pages', () => {
    const commit = ingestChatTopicsPage(
      {
        ...base,
        items: [
          topic('t1', { description: 'd', firstUserMessage: 'f', messageCount: 3, trigger: null }),
        ],
        signature: { withDetails: true },
        surface: 'agentView',
      },
      obs,
    );
    expect(commit.entities?.[0]?.fragments).toMatchObject({
      details: { data: { description: 'd', firstUserMessage: 'f', messageCount: 3 } },
      triggerInfo: { data: { trigger: null } },
    });
  });

  it('replaces refs when signature changes', () => {
    const existing = {
      key: 'chat.sidebarTopics:agent-1',
      observedAt: 50,
      persistRefLimit: 2,
      refs: [{ id: 'old', kind: 'topic' }],
      signature: { isInbox: true },
      source: 'network',
      total: 1,
    } as ChatTopicsIndex;
    const commit = ingestChatTopicsPage({ ...base, existing, items: [topic('t1')] }, obs);
    expect(commit.indexes?.[0]).toMatchObject({ refs: [{ id: 't1', kind: 'topic' }] });
  });

  it('merges a first-page refresh into an expanded list capped by total', () => {
    const existing = {
      key: 'chat.sidebarTopics:agent-1',
      observedAt: 50,
      persistRefLimit: 2,
      refs: ['t1', 't2', 't3', 't4'].map((id) => ({ id, kind: 'topic' as const })),
      signature: {},
      source: 'network' as const,
      total: 5,
    } as ChatTopicsIndex;
    const commit = ingestChatTopicsPage(
      { ...base, existing, items: [topic('t5'), topic('t1')], total: 4 },
      obs,
    );
    expect((commit.indexes?.[0] as ChatTopicsIndex).refs.map((ref) => ref.id)).toEqual([
      't5',
      't1',
      't2',
      't3',
    ]);
  });

  it('appends deduplicated refs for loadMore pages', () => {
    const existing = {
      key: 'chat.sidebarTopics:agent-1',
      observedAt: 50,
      persistRefLimit: 2,
      refs: [{ id: 't1', kind: 'topic' }],
      signature: {},
      source: 'network',
      total: 5,
    } as ChatTopicsIndex;
    const commit = ingestChatTopicsPage(
      { ...base, existing, items: [topic('t1'), topic('t2')], page: 1 },
      obs,
    );
    expect((commit.indexes?.[0] as ChatTopicsIndex).refs.map((ref) => ref.id)).toEqual([
      't1',
      't2',
    ]);
  });
});

describe('ingestChatTopicSearchResults', () => {
  it('produces entity records without indexes or routing', () => {
    const commit = ingestChatTopicSearchResults([topic('t1')], obs);
    expect(commit.indexes).toBeUndefined();
    expect(commit.entities?.[0]?.fragments).not.toHaveProperty('routing');
  });
});
