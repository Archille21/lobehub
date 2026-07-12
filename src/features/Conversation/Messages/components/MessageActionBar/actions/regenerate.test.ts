/**
 * @vitest-environment happy-dom
 */
import type { UIChatMessage } from '@lobechat/types';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessageActionContext } from '../types';
import { regenerateAction } from './regenerate';

const regenerateUserMessage = vi.fn();
const regenerateAssistantMessage = vi.fn();
const deleteMessage = vi.fn();

vi.mock('../../../../store', () => ({
  messageStateSelectors: { isMessageRegenerating: () => () => false },
  useConversationStore: (selector: (s: any) => any) =>
    selector({ deleteMessage, regenerateAssistantMessage, regenerateUserMessage }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const build = (data: Partial<UIChatMessage>, role: MessageActionContext['role'], id = 'msg-1') =>
  renderHook(() => regenerateAction.useBuild({ data: data as UIChatMessage, id, role })).result
    .current!;

const error = { body: { message: 'boom' }, type: 'ProviderBizError' };

describe('regenerateAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never deletes an errored USER turn — the retry anchors the new assistant on it', () => {
    // The regenerate is fired without await and persists the new assistant with
    // `parent_id = <this user message>`. Deleting the anchor races that insert: the
    // assistant violates the FK, silently never lands, and the whole turn is lost.
    build({ error, id: 'user-1' } as unknown as UIChatMessage, 'user', 'user-1').handleClick!();

    expect(regenerateUserMessage).toHaveBeenCalledWith('user-1');
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('drops an errored ASSISTANT turn — the retry re-anchors on its parent, not on itself', () => {
    build({ error, id: 'asst-1' } as unknown as UIChatMessage, 'assistant', 'asst-1')
      .handleClick!();

    expect(regenerateAssistantMessage).toHaveBeenCalledWith('asst-1');
    expect(deleteMessage).toHaveBeenCalledWith('asst-1');
  });

  it('keeps a healthy assistant turn when regenerating', () => {
    build({ content: 'hi', id: 'asst-1' } as unknown as UIChatMessage, 'assistant', 'asst-1')
      .handleClick!();

    expect(regenerateAssistantMessage).toHaveBeenCalledWith('asst-1');
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
