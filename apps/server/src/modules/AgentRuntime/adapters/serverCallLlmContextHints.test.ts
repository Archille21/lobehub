import type { CallLLMPayload } from '@lobechat/agent-runtime';
import type { UIChatMessage } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeExecutorContext } from '../context';
import { resolveServerCallLlmContextHints } from './serverCallLlmContextHints';

vi.mock('@/business/client/model-bank/loadModels', () => ({ loadModels: async () => [] }));
vi.mock('@/database/models/aiModel', () => ({
  AiModelModel: class {
    findById = async () => undefined;
  },
}));

const message = (id: string, role: string, content: string) =>
  ({ content, id, role }) as unknown as UIChatMessage;

const resolve = (payload: Partial<CallLLMPayload>) =>
  resolveServerCallLlmContextHints({
    ctx: { agentConfig: {} } as unknown as RuntimeExecutorContext,
    llmPayload: payload as CallLLMPayload,
    model: 'claude-sonnet-4-6',
    provider: 'lobehub',
  });

describe('resolveServerCallLlmContextHints', () => {
  // Regression: the client creates an assistant placeholder (content '...') for
  // the response being generated and sends it along. Keeping it made every
  // server-side payload end with an assistant message, which AIHubMix's Claude
  // route rejects: "This model does not support assistant message prefill."
  it('drops the in-flight assistant placeholder from the context', async () => {
    const { messagesForContext } = await resolve({
      assistantMessageId: 'msg_pending',
      messages: [message('msg_user', 'user', 'hi'), message('msg_pending', 'assistant', '...')],
    } as Partial<CallLLMPayload>);

    expect(messagesForContext.map((m) => m.id)).toEqual(['msg_user']);
    expect(messagesForContext.at(-1)?.role).toBe('user');
  });

  it('keeps completed assistant turns from earlier in the conversation', async () => {
    const { messagesForContext } = await resolve({
      assistantMessageId: 'msg_pending',
      messages: [
        message('msg_user_1', 'user', 'hi'),
        message('msg_assistant_1', 'assistant', 'hello'),
        message('msg_user_2', 'user', 'and again'),
        message('msg_pending', 'assistant', '...'),
      ],
    } as Partial<CallLLMPayload>);

    expect(messagesForContext.map((m) => m.id)).toEqual([
      'msg_user_1',
      'msg_assistant_1',
      'msg_user_2',
    ]);
  });

  it('leaves the messages untouched when no assistant message is in flight', async () => {
    const { messagesForContext } = await resolve({
      messages: [message('msg_user', 'user', 'hi')],
    } as Partial<CallLLMPayload>);

    expect(messagesForContext.map((m) => m.id)).toEqual(['msg_user']);
  });
});
