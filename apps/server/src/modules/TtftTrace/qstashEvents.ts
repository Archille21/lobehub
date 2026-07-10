import type { ChatTtftClock } from '@/database/schemas/chatTtftMetrics';

/**
 * QStash delivery lifecycle event, from `GET /v2/events?messageId=…`.
 *
 * https://upstash.com/docs/qstash/api/events/list
 */
interface QStashEvent {
  messageId: string;
  state: string;
  /** Epoch ms on QStash's clock. */
  time: number;
}

export interface QStashDispatchSpan {
  endAtMs?: number;
  key: string;
  options: { clock: ChatTtftClock; meta?: Record<string, unknown> };
  startAtMs: number;
}

/**
 * Break a slow `qstash_wait` down using QStash's own event log:
 * `qstash_queue` = CREATED → ACTIVE (waiting inside QStash, e.g. the delay
 * parameter or queue backlog) and `qstash_deliver` = ACTIVE → next-step lambda
 * accepting the request (HTTP dispatch + lambda cold boot). Timestamps come
 * from QStash's clock, so spans are tagged `server-cross`.
 *
 * Best-effort: returns [] on missing token, HTTP failure, or unexpected shape.
 */
export const fetchQStashDispatchSpans = async (
  messageId: string,
): Promise<QStashDispatchSpan[]> => {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return [];

  const res = await fetch(
    `https://qstash.upstash.io/v2/events?messageId=${encodeURIComponent(messageId)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!res.ok) return [];

  const data = (await res.json()) as { events?: QStashEvent[] };
  if (!Array.isArray(data.events)) return [];

  const timeOf = (state: string) =>
    data.events!.find((e) => e.state?.toUpperCase() === state)?.time;

  const createdAt = timeOf('CREATED');
  const activeAt = timeOf('ACTIVE');
  const deliveredAt = timeOf('DELIVERED');

  const spans: QStashDispatchSpan[] = [];
  const clock: ChatTtftClock = 'server-cross';

  if (createdAt && activeAt) {
    spans.push({
      endAtMs: activeAt,
      key: 'qstash_queue',
      options: { clock },
      startAtMs: createdAt,
    });
  }
  if (activeAt && deliveredAt) {
    spans.push({
      endAtMs: deliveredAt,
      key: 'qstash_deliver',
      options: { clock, meta: { messageId } },
      startAtMs: activeAt,
    });
  }

  return spans;
};
