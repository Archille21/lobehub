import { lt, sql } from 'drizzle-orm';

import type { ChatTtftSpan, NewChatTtftMetric } from '../schemas/chatTtftMetrics';
import { chatTtftMetrics } from '../schemas/chatTtftMetrics';
import type { LobeChatDatabase } from '../type';

export interface UpsertChatTtftMetricParams {
  assistantMessageId?: string | null;
  coldStart?: boolean | null;
  isTopicFirst?: boolean | null;
  model?: string | null;
  operationId: string;
  provider?: string | null;
  spans?: ChatTtftSpan[];
  topicId?: string | null;
  trigger?: string | null;
  ttftMs?: number | null;
  userMessageId?: string | null;
}

export class ChatTtftMetricModel {
  private readonly db: LobeChatDatabase;
  private readonly userId: string;

  constructor(db: LobeChatDatabase, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  /**
   * Insert-or-merge one writer's contribution, keyed on `operationId`. The
   * three writers (execAgent lambda, runStep lambda, client report) race in
   * arbitrary order, so on conflict `spans` are concatenated and scalar
   * columns keep the first non-null value (`COALESCE(current, excluded)`) —
   * a retry (QStash redelivery, duplicate client report) must not overwrite
   * what the first attempt recorded, e.g. `cold_start` flipping true→false.
   *
   * The conflict-update is additionally guarded by `user_id` so a client
   * report can never mutate another user's row.
   */
  upsert = async (params: UpsertChatTtftMetricParams) => {
    const { operationId, spans = [], ...fields } = params;

    const values: NewChatTtftMetric = {
      ...fields,
      operationId,
      spans,
      userId: this.userId,
    };

    const excluded = (column: string) => sql.raw(`excluded."${column}"`);

    await this.db
      .insert(chatTtftMetrics)
      .values(values)
      .onConflictDoUpdate({
        set: {
          assistantMessageId: sql`COALESCE(${chatTtftMetrics.assistantMessageId}, ${excluded('assistant_message_id')})`,
          coldStart: sql`COALESCE(${chatTtftMetrics.coldStart}, ${excluded('cold_start')})`,
          isTopicFirst: sql`COALESCE(${chatTtftMetrics.isTopicFirst}, ${excluded('is_topic_first')})`,
          model: sql`COALESCE(${chatTtftMetrics.model}, ${excluded('model')})`,
          provider: sql`COALESCE(${chatTtftMetrics.provider}, ${excluded('provider')})`,
          spans: sql`${chatTtftMetrics.spans} || ${excluded('spans')}`,
          topicId: sql`COALESCE(${chatTtftMetrics.topicId}, ${excluded('topic_id')})`,
          trigger: sql`COALESCE(${chatTtftMetrics.trigger}, ${excluded('trigger')})`,
          ttftMs: sql`COALESCE(${chatTtftMetrics.ttftMs}, ${excluded('ttft_ms')})`,
          updatedAt: new Date(),
          userMessageId: sql`COALESCE(${chatTtftMetrics.userMessageId}, ${excluded('user_message_id')})`,
        },
        setWhere: sql`${chatTtftMetrics.userId} = ${this.userId}`,
        target: chatTtftMetrics.operationId,
      });
  };

  /**
   * TTL cleanup for the retention cron — rows older than `cutoff` are dropped
   * wholesale, so this is deliberately not user-scoped.
   */
  static deleteBefore = async (db: LobeChatDatabase, cutoff: Date): Promise<number> => {
    const deleted = await db
      .delete(chatTtftMetrics)
      .where(lt(chatTtftMetrics.createdAt, cutoff))
      .returning({ id: chatTtftMetrics.id });

    return deleted.length;
  };
}
