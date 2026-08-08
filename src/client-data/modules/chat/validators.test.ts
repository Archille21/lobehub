import { describe, expect, it } from 'vitest';

import { isChatIndex } from './validators';

const valid = {
  key: 'chat.sidebarTopics:agent-1',
  observedAt: 100,
  persistRefLimit: 20,
  refs: [{ id: 't1', kind: 'topic' }],
  signature: { isInbox: true },
  source: 'network',
  total: 1,
};

describe('isChatIndex', () => {
  it('accepts a valid sidebar topics index', () => {
    expect(isChatIndex(valid)).toBe(true);
  });

  it('accepts a valid agent view topics index', () => {
    expect(isChatIndex({ ...valid, key: 'chat.agentViewTopics:agent-1' })).toBe(true);
  });

  it('rejects unknown key prefixes and empty container keys', () => {
    expect(isChatIndex({ ...valid, key: 'home.sidebar' })).toBe(false);
    expect(isChatIndex({ ...valid, key: 'chat.sidebarTopics:' })).toBe(false);
  });

  it('rejects refs of the wrong kind and invalid coverage numbers', () => {
    expect(isChatIndex({ ...valid, refs: [{ id: 'a', kind: 'agent' }] })).toBe(false);
    expect(isChatIndex({ ...valid, total: -1 })).toBe(false);
    expect(isChatIndex({ ...valid, persistRefLimit: 0 })).toBe(false);
  });

  it('rejects malformed signatures', () => {
    expect(isChatIndex({ ...valid, signature: { excludeStatuses: 'completed' } })).toBe(false);
  });
});
