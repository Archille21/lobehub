// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { chatTtftMetrics, users } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { ChatTtftMetricModel } from '../chatTtftMetric';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'chat-ttft-test-user';
const otherUserId = 'chat-ttft-other-user';

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
});

afterEach(async () => {
  await serverDB.delete(chatTtftMetrics);
  await serverDB.delete(users);
});

const findByOperationId = async (operationId: string) =>
  serverDB.query.chatTtftMetrics.findFirst({
    where: eq(chatTtftMetrics.operationId, operationId),
  });

describe('ChatTtftMetricModel', () => {
  describe('upsert', () => {
    it('inserts a new row with spans and dimensions', async () => {
      const model = new ChatTtftMetricModel(serverDB, userId);

      await model.upsert({
        isTopicFirst: true,
        operationId: 'op_1',
        spans: [{ clock: 'server', durationMs: 120, key: 'server_exec_agent', offsetMs: 0 }],
        topicId: 'tpc_1',
        trigger: 'sendMessage',
        userMessageId: 'msg_user_1',
      });

      const row = await findByOperationId('op_1');
      expect(row).toMatchObject({
        isTopicFirst: true,
        operationId: 'op_1',
        topicId: 'tpc_1',
        trigger: 'sendMessage',
        ttftMs: null,
        userId,
        userMessageId: 'msg_user_1',
      });
      expect(row!.spans).toHaveLength(1);
    });

    it('merges concurrent writers: spans concatenate, scalars keep first non-null', async () => {
      const model = new ChatTtftMetricModel(serverDB, userId);

      // writer 1: execAgent lambda
      await model.upsert({
        isTopicFirst: false,
        operationId: 'op_2',
        spans: [{ clock: 'server', durationMs: 300, key: 'server_exec_agent', offsetMs: 0 }],
        trigger: 'sendMessage',
        userMessageId: 'msg_user_2',
      });

      // writer 2: runStep lambda — new fields + more spans, no trigger/userMessageId
      await model.upsert({
        assistantMessageId: 'msg_assistant_2',
        coldStart: true,
        model: 'gpt-5.6',
        operationId: 'op_2',
        provider: 'lobehub',
        spans: [
          { clock: 'server-cross', durationMs: 1200, key: 'qstash_wait', offsetMs: 350 },
          { clock: 'server', durationMs: 800, key: 'provider_ttft', offsetMs: 1900 },
        ],
      });

      // writer 3: client report
      await model.upsert({
        operationId: 'op_2',
        spans: [{ clock: 'client', durationMs: 260, key: 'exec_agent_rtt', offsetMs: 5 }],
        ttftMs: 3100,
      });

      const row = await findByOperationId('op_2');
      expect(row).toMatchObject({
        assistantMessageId: 'msg_assistant_2',
        coldStart: true,
        isTopicFirst: false,
        model: 'gpt-5.6',
        provider: 'lobehub',
        trigger: 'sendMessage',
        ttftMs: 3100,
        userMessageId: 'msg_user_2',
      });
      expect(row!.spans.map((s) => s.key)).toEqual([
        'server_exec_agent',
        'qstash_wait',
        'provider_ttft',
        'exec_agent_rtt',
      ]);
    });

    it('does not let one user overwrite another user’s row for the same operationId', async () => {
      await new ChatTtftMetricModel(serverDB, userId).upsert({
        operationId: 'op_3',
        spans: [{ clock: 'server', durationMs: 100, key: 'server_exec_agent', offsetMs: 0 }],
        ttftMs: 900,
      });

      await new ChatTtftMetricModel(serverDB, otherUserId).upsert({
        operationId: 'op_3',
        spans: [{ clock: 'client', durationMs: 1, key: 'exec_agent_rtt', offsetMs: 0 }],
        ttftMs: 1,
      });

      const row = await findByOperationId('op_3');
      expect(row!.userId).toBe(userId);
      expect(row!.ttftMs).toBe(900);
      expect(row!.spans).toHaveLength(1);
    });
  });

  describe('deleteBefore', () => {
    it('removes only rows older than the cutoff', async () => {
      const model = new ChatTtftMetricModel(serverDB, userId);
      await model.upsert({ operationId: 'op_old' });
      await model.upsert({ operationId: 'op_new' });

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await serverDB
        .update(chatTtftMetrics)
        .set({ createdAt: new Date(cutoff.getTime() - 1000) })
        .where(eq(chatTtftMetrics.operationId, 'op_old'));

      const deleted = await ChatTtftMetricModel.deleteBefore(serverDB, cutoff);

      expect(deleted).toBe(1);
      expect(await findByOperationId('op_old')).toBeUndefined();
      expect(await findByOperationId('op_new')).toBeDefined();
    });
  });
});
