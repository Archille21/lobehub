import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyWorktreeAddToTopic, parseWorktreeAddPath } from '../worktreeDetection';

const topicMocks = vi.hoisted(() => ({ getTopicById: vi.fn() }));

vi.mock('@/store/chat/selectors', () => ({
  topicSelectors: {
    getTopicById: (id: string) => (state: unknown) => topicMocks.getTopicById(id, state),
  },
}));

describe('parseWorktreeAddPath', () => {
  it('resolves a relative path against the source cwd', () => {
    expect(parseWorktreeAddPath('git worktree add ../wt', '/repo')).toBe('/wt');
    expect(parseWorktreeAddPath('git worktree add wt', '/repo')).toBe('/repo/wt');
  });

  it('keeps an absolute path as-is', () => {
    expect(parseWorktreeAddPath('git worktree add /tmp/wt', '/repo')).toBe('/tmp/wt');
  });

  it('skips flags and their values', () => {
    expect(parseWorktreeAddPath('git worktree add -b feature ../feat', '/repo')).toBe('/feat');
    expect(parseWorktreeAddPath('git worktree add --detach /tmp/wt', '/repo')).toBe('/tmp/wt');
    expect(parseWorktreeAddPath('git worktree add -f --lock /tmp/wt', '/repo')).toBe('/tmp/wt');
  });

  it('parses a JSON `arguments` blob (CC Bash tool shape)', () => {
    expect(parseWorktreeAddPath('{"command":"git worktree add ../wt"}', '/repo')).toBe('/wt');
  });

  it('handles a quoted path with spaces', () => {
    expect(parseWorktreeAddPath('git worktree add "../my wt"', '/repo')).toBe('/my wt');
  });

  it('stops at a shell separator (does not slurp the chained command)', () => {
    expect(parseWorktreeAddPath('cd /repo && git worktree add wt && cd wt', '/repo')).toBe(
      '/repo/wt',
    );
  });

  it('returns undefined for non-worktree-add commands', () => {
    expect(parseWorktreeAddPath('git status', '/repo')).toBeUndefined();
    expect(parseWorktreeAddPath('git worktree list', '/repo')).toBeUndefined();
    expect(parseWorktreeAddPath('{"command":"ls -la"}', '/repo')).toBeUndefined();
    expect(parseWorktreeAddPath(undefined, '/repo')).toBeUndefined();
  });
});

const makeGet = () => {
  const updateTopicMetadata = vi.fn().mockResolvedValue(undefined);
  const get = () => ({ updateTopicMetadata }) as any;
  return { get, updateTopicMetadata };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyWorktreeAddToTopic', () => {
  it('records the new worktree as the topic active one', async () => {
    topicMocks.getTopicById.mockReturnValue({
      metadata: { workingDirectoryConfig: { path: '/repo', repoType: 'github' } },
    });
    const { get, updateTopicMetadata } = makeGet();

    await applyWorktreeAddToTopic(get, { topicId: 't1', worktreePath: '/wt' });

    expect(updateTopicMetadata).toHaveBeenCalledWith('t1', {
      workingDirectoryConfig: {
        git: { activeWorktree: '/wt', isWorktree: true },
        path: '/repo',
        repoType: 'github',
      },
    });
  });

  it('falls back to the passed sourcePath when the topic has no config', async () => {
    topicMocks.getTopicById.mockReturnValue({ metadata: { workingDirectory: '/repo' } });
    const { get, updateTopicMetadata } = makeGet();

    await applyWorktreeAddToTopic(get, { sourcePath: '/repo', topicId: 't1', worktreePath: '/wt' });

    expect(updateTopicMetadata).toHaveBeenCalledWith('t1', {
      workingDirectoryConfig: {
        git: { activeWorktree: '/wt', isWorktree: true },
        path: '/repo',
      },
    });
  });

  it('does nothing when the worktree resolves to the source path', async () => {
    topicMocks.getTopicById.mockReturnValue({
      metadata: { workingDirectoryConfig: { path: '/repo' } },
    });
    const { get, updateTopicMetadata } = makeGet();

    await applyWorktreeAddToTopic(get, { topicId: 't1', worktreePath: '/repo' });

    expect(updateTopicMetadata).not.toHaveBeenCalled();
  });

  it('is idempotent when the active worktree is already set', async () => {
    topicMocks.getTopicById.mockReturnValue({
      metadata: {
        workingDirectoryConfig: {
          git: { activeWorktree: '/wt', isWorktree: true },
          path: '/repo',
        },
      },
    });
    const { get, updateTopicMetadata } = makeGet();

    await applyWorktreeAddToTopic(get, { topicId: 't1', worktreePath: '/wt' });

    expect(updateTopicMetadata).not.toHaveBeenCalled();
  });

  it('does nothing when the topic is gone', async () => {
    topicMocks.getTopicById.mockReturnValue(undefined);
    const { get, updateTopicMetadata } = makeGet();

    await applyWorktreeAddToTopic(get, { topicId: 't1', worktreePath: '/wt' });

    expect(updateTopicMetadata).not.toHaveBeenCalled();
  });
});
