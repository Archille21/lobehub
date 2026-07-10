import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, updatedAt } from './_helpers';

/**
 * Clock domain a span was measured on. Offsets/durations are only comparable
 * within one domain; `server-cross` marks the two ends living on different
 * server machines (NTP-synced, millisecond-level skew — e.g. QStash publish
 * on the exec lambda vs runStep start on the run lambda).
 */
export type ChatTtftClock = 'client' | 'server' | 'server-cross';

export interface ChatTtftSpan {
  clock: ChatTtftClock;
  /** Omitted for point marks (e.g. client receipt of `stream_start`). */
  durationMs?: number;
  /** Stage key, e.g. `qstash_wait` / `provider_ttft`. Free-form so stages can be added/removed without migrations. */
  key: string;
  meta?: Record<string, unknown>;
  /** Offset from the clock-domain anchor: client = Enter pressed, server = execAgent entry. */
  offsetMs: number;
}

/**
 * Mini-trace of one message send's first response (TTFT) path in gateway mode:
 * Enter pressed → first content delta reaches the client. One row per send,
 * upserted by three writers keyed on `operationId` (execAgent lambda, runStep
 * lambda at first content chunk, client report after first delta).
 *
 * Spans follow trace semantics — they may overlap, run in parallel, and leave
 * gaps; they do NOT partition the timeline, so per-stage sums never equal
 * `ttftMs`.
 */
export const chatTtftMetrics = pgTable(
  'chat_ttft_metrics',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),

    /** Agent runtime operation id — the correlation key all writers upsert on. */
    operationId: text('operation_id').notNull(),

    /**
     * Preserved across user/message deletion — metrics rows are analytic data.
     * Intentionally no foreign keys (also keeps the hot write path cheap).
     */
    userId: text('user_id').notNull(),
    topicId: text('topic_id'),
    userMessageId: text('user_message_id'),
    /** Backfilled by the runStep writer once the assistant message is known. */
    assistantMessageId: text('assistant_message_id'),

    /** What initiated the run (`sendMessage` today; other triggers only carry server spans). */
    trigger: text('trigger'),
    /** First message of a topic vs follow-ups (new-topic sends pay extra stages). */
    isTopicFirst: boolean('is_topic_first'),
    model: text('model'),
    provider: text('provider'),
    /** The runStep invocation was this lambda instance's first request (cold start). */
    coldStart: boolean('cold_start'),

    /**
     * End-to-end Enter → first content delta, measured entirely on the client
     * clock (never a cross-clock subtraction). NULL = first token never
     * observed (error/interrupt before streaming, or client report lost).
     */
    ttftMs: integer('ttft_ms'),

    spans: jsonb('spans').$type<ChatTtftSpan[]>().notNull().default([]),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('chat_ttft_metrics_operation_id_unique').on(t.operationId),
    index('chat_ttft_metrics_created_at_idx').on(t.createdAt),
    index('chat_ttft_metrics_user_id_created_at_idx').on(t.userId, t.createdAt),
  ],
);

export type NewChatTtftMetric = typeof chatTtftMetrics.$inferInsert;
export type ChatTtftMetricItem = typeof chatTtftMetrics.$inferSelect;
