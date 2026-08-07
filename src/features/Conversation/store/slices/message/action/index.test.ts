import type { AssistantContentBlock, UIChatMessage } from '@lobechat/types';
import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationContext } from '../../../../types';
import { createStore } from '../../../index';

// Mock conversation-flow parse so createStore initialization never reaches a real parser.
vi.mock('@lobechat/conversation-flow', () => ({
  parse: (messages: UIChatMessage[]) => {
    const messageMap: Record<string, UIChatMessage> = {};
    for (const msg of messages) messageMap[msg.id] = msg;
    return { flatList: [...messages].sort((a, b) => a.createdAt - b.createdAt), messageMap };
  },
}));

const createTestStore = (context?: Partial<ConversationContext>) =>
  createStore({
    context: {
      agentId: 'agent-1',
      topicId: 'topic-1',
      threadId: null,
      ...context,
    },
  });

describe('message convenience actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addAIMessage', () => {
    it('creates an assistant message with its conversation context and the submitted text', async () => {
      const store = createTestStore();
      const createMessage = vi.fn().mockResolvedValue('message-1');
      store.setState({ createMessage });

      await act(async () => {
        await store.getState().addAIMessage('assistant content');
      });

      expect(createMessage).toHaveBeenCalledWith({
        agentId: 'agent-1',
        content: 'assistant content',
        parentId: undefined,
        role: 'assistant',
        threadId: undefined,
        topicId: 'topic-1',
      });
    });

    it('does not forward groupId to createMessage (canary-aligned context)', async () => {
      const store = createTestStore({ groupId: 'group-1', scope: 'group' });
      const createMessage = vi.fn().mockResolvedValue('message-1');
      store.setState({ createMessage });

      await act(async () => {
        await store.getState().addAIMessage('assistant content');
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ groupId: expect.anything() }),
      );
    });

    it('still allows an empty assistant placeholder', async () => {
      const store = createTestStore();
      const createMessage = vi.fn().mockResolvedValue('message-1');
      store.setState({ createMessage });

      await act(async () => {
        await store.getState().addAIMessage('');
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: '', role: 'assistant' }),
      );
    });

    it('uses the last display message as the parent id', async () => {
      const store = createTestStore();
      const createMessage = vi.fn().mockResolvedValue('message-1');
      store.setState({
        createMessage,
        displayMessages: [
          { id: 'prev-1', content: 'previous', role: 'user', createdAt: 1, updatedAt: 1 },
        ],
      });

      await act(async () => {
        await store.getState().addAIMessage('assistant content');
      });

      expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({ parentId: 'prev-1' }));
    });

    it('fires the onMessageCreated hook for the created assistant message', async () => {
      const onMessageCreated = vi.fn();
      const store = createTestStore();
      const created: UIChatMessage = {
        id: 'message-1',
        content: 'assistant content',
        role: 'assistant',
        createdAt: 1,
        updatedAt: 1,
      };
      store.setState({
        createMessage: vi.fn().mockResolvedValue('message-1'),
        displayMessages: [created],
        hooks: { onMessageCreated },
      });

      await act(async () => {
        await store.getState().addAIMessage('assistant content');
      });

      expect(onMessageCreated).toHaveBeenCalledWith(created);
    });

    it('clears the input after successful creation', async () => {
      const store = createTestStore();
      store.setState({
        createMessage: vi.fn().mockResolvedValue('message-1'),
        inputMessage: 'submitted draft',
      });

      await act(async () => {
        await store.getState().addAIMessage('submitted draft');
      });

      expect(store.getState().inputMessage).toBe('');
    });

    it('does not clear the input when creation fails', async () => {
      const store = createTestStore();
      store.setState({
        createMessage: vi.fn().mockResolvedValue(undefined),
        inputMessage: 'submitted draft',
      });

      await act(async () => {
        await store.getState().addAIMessage('submitted draft');
      });

      expect(store.getState().inputMessage).toBe('submitted draft');
    });
  });

  describe('addUserMessage', () => {
    it('creates a user message with its conversation context, files and the submitted text', async () => {
      const store = createTestStore();
      const createMessage = vi.fn().mockResolvedValue('message-1');
      store.setState({ createMessage });

      await act(async () => {
        await store.getState().addUserMessage({ message: 'user content', fileList: ['file-1'] });
      });

      expect(createMessage).toHaveBeenCalledWith({
        agentId: 'agent-1',
        content: 'user content',
        files: ['file-1'],
        parentId: undefined,
        role: 'user',
        threadId: undefined,
        topicId: 'topic-1',
      });
    });

    /**
     * @example A user presses Alt+Enter after an agent completes a multi-step tool run.
     */
    it('continues from the final assistant block instead of the assistant group display id', async () => {
      const store = createTestStore();
      const createMessage = vi.fn().mockResolvedValue('message-1');
      const assistantGroup: UIChatMessage = {
        children: [
          { content: 'I will inspect the project.', id: 'assistant-step-1' },
          { content: 'Here is the final answer.', id: 'assistant-step-2' },
        ],
        content: '',
        createdAt: 1,
        id: 'assistant-group-root',
        role: 'assistantGroup',
        updatedAt: 1,
      };
      store.setState({ createMessage, displayMessages: [assistantGroup] });

      await act(async () => {
        await store.getState().addUserMessage({ message: 'Follow-up without generation' });
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'assistant-step-2' }),
      );
    });

    /**
     * @example A user presses Alt+Enter after a supervisor broadcasts work to an agent council.
     */
    it('continues from the last persisted supervisor block after an in-bubble council', async () => {
      // ROOT CAUSE:
      //
      // FlatListBuilder appends a `council-*` display-only block after the
      // supervisor's persisted assistant block when a broadcast has no later
      // supervisor reply. The virtual ID cannot be a database parent ID.
      //
      // Before this fix, addUserMessage persisted `council-supervisor-tool-use`
      // as parentId and the new message could become orphaned from the active
      // conversation branch.
      //
      // We skip the virtual council block and use the preceding persisted
      // supervisor assistant block as the parent.
      const store = createTestStore();
      const createMessage = vi.fn().mockResolvedValue('message-1');
      const councilBlock: AssistantContentBlock = {
        content: '',
        council: [
          {
            content: 'Council member response',
            createdAt: 1,
            id: 'council-member-1',
            role: 'assistant',
            updatedAt: 1,
          },
        ],
        id: 'council-supervisor-tool-use',
      };
      const assistantGroup: UIChatMessage = {
        children: [{ content: 'I will ask the council.', id: 'supervisor-tool-use' }, councilBlock],
        content: '',
        createdAt: 1,
        id: 'assistant-group-root',
        role: 'assistantGroup',
        updatedAt: 1,
      };
      store.setState({ createMessage, displayMessages: [assistantGroup] });

      await act(async () => {
        await store.getState().addUserMessage({ message: 'Follow up after broadcast' });
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'supervisor-tool-use' }),
      );
    });

    it('does not forward groupId to createMessage (canary-aligned context)', async () => {
      const store = createTestStore({ groupId: 'group-1', scope: 'group' });
      const createMessage = vi.fn().mockResolvedValue('message-1');
      store.setState({ createMessage });

      await act(async () => {
        await store.getState().addUserMessage({ message: 'user content' });
      });

      expect(createMessage).toHaveBeenCalledWith(
        expect.not.objectContaining({ groupId: expect.anything() }),
      );
    });

    it('clears the input after successful creation', async () => {
      const store = createTestStore();
      store.setState({
        createMessage: vi.fn().mockResolvedValue('message-1'),
        inputMessage: 'submitted draft',
      });

      await act(async () => {
        await store.getState().addUserMessage({ message: 'submitted draft' });
      });

      expect(store.getState().inputMessage).toBe('');
    });

    it('does not clear the input when creation fails', async () => {
      const store = createTestStore();
      store.setState({
        createMessage: vi.fn().mockResolvedValue(undefined),
        inputMessage: 'submitted draft',
      });

      await act(async () => {
        await store.getState().addUserMessage({ message: 'submitted draft' });
      });

      expect(store.getState().inputMessage).toBe('submitted draft');
    });
  });
});
