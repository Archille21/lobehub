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
   * columns keep the first non-null value (`COALESCE(excluded, current)`).
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
          assistantMessageId: sql`COALESCE(${excluded('assistant_message_id')}, ${chatTtftMetrics.assistantMessageId})`,
          coldStart: sql`COALESCE(${excluded('cold_start')}, ${chatTtftMetrics.coldStart})`,
          isTopicFirst: sql`COALESCE(${excluded('is_topic_first')}, ${chatTtftMetrics.isTopicFirst})`,
          model: sql`COALESCE(${excluded('model')}, ${chatTtftMetrics.model})`,
          provider: sql`COALESCE(${excluded('provider')}, ${chatTtftMetrics.provider})`,
          spans: sql`${chatTtftMetrics.spans} || ${excluded('spans')}`,
          topicId: sql`COALESCE(${excluded('topic_id')}, ${chatTtftMetrics.topicId})`,
          trigger: sql`COALESCE(${excluded('trigger')}, ${chatTtftMetrics.trigger})`,
          ttftMs: sql`COALESCE(${excluded('ttft_ms')}, ${chatTtftMetrics.ttftMs})`,
          updatedAt: new Date(),
          userMessageId: sql`COALESCE(${excluded('user_message_id')}, ${chatTtftMetrics.userMessageId})`,
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
