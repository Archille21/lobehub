/**
 * @vitest-environment happy-dom
 */
import type { UIChatMessage } from '@lobechat/types';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageActionContext } from '../types';
import { branchingAction } from './branching';

const openThreadCreator = vi.fn();
const warning = vi.fn();

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (state: any) => any) =>
    selector({ activeTopicId: 'topic-1', openThreadCreator }),
}));

vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { warning } }) },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const build = (data: Partial<UIChatMessage>) =>
  renderHook(() =>
    branchingAction.useBuild({
      data: data as UIChatMessage,
      id: 'message-1',
      role: 'assistant' as MessageActionContext['role'],
    }),
  ).result.current;

describe('branchingAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the thread creator for a main-topic message', () => {
    build({})!.handleClick!();

    expect(openThreadCreator).toHaveBeenCalledWith('message-1');
  });

  it('is unavailable for a message that already belongs to a thread', () => {
    expect(build({ threadId: 'thread-1' })).toBeNull();
    expect(openThreadCreator).not.toHaveBeenCalled();
  });
});
