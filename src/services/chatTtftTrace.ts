import { lambdaClient } from '@/libs/trpc/client';

interface ClientTtftSpan {
  clock: 'client';
  durationMs?: number;
  key: string;
  meta?: Record<string, unknown>;
  offsetMs: number;
}

/**
 * Client-side collector of the chat TTFT mini-trace (see the server module
 * `apps/server/src/modules/TtftTrace` and the `chat_ttft_metrics` table).
 *
 * Everything here is on the client clock, anchored at the Enter keypress
 * (`beginSend`). `ttftMs` — the user-perceived Enter → first content delta —
 * is therefore measured on a single clock with no cross-machine skew.
 *
 * One trace at a time: a new `beginSend` discards the previous unreported
 * trace (concurrent sends across topics are rare and the loser is dropped,
 * not corrupted). Reporting is fire-and-forget; failures only log.
 */
class ChatTtftTraceCollector {
  private anchorMs?: number;
  private operationId?: string;
  private reported = false;
  private seenKeys = new Set<string>();
  private spans: ClientTtftSpan[] = [];

  /** Anchor a new send at the Enter keypress. */
  beginSend() {
    this.anchorMs = Date.now();
    this.operationId = undefined;
    this.reported = false;
    this.seenKeys.clear();
    this.spans = [];
  }

  /**
   * Bind the server operation id once execAgent returns. A trace without an
   * operation (client-runtime or hetero run, failed send) is never reported.
   */
  attachOperation(operationId: string) {
    if (this.anchorMs === undefined || this.operationId) return;
    this.operationId = operationId;
  }

  /** Record a span; per-key, first occurrence wins (later steps are ignored). */
  span(key: string, startAtMs: number, endAtMs = Date.now(), meta?: Record<string, unknown>) {
    if (this.anchorMs === undefined || this.reported || this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    this.spans.push({
      clock: 'client',
      durationMs: Math.max(0, Math.round(endAtMs - startAtMs)),
      key,
      ...(meta ? { meta } : {}),
      offsetMs: Math.round(startAtMs - this.anchorMs),
    });
  }

  /** Zero-duration point mark. */
  mark(key: string, atMs = Date.now()) {
    if (this.anchorMs === undefined || this.reported || this.seenKeys.has(key)) return;
    this.seenKeys.add(key);
    this.spans.push({ clock: 'client', key, offsetMs: Math.round(atMs - this.anchorMs) });
  }

  /** Wrap an awaited call as a span; passes through when no trace is active. */
  async time<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const startAtMs = Date.now();
    try {
      return await fn();
    } finally {
      this.span(key, startAtMs);
    }
  }

  /** Span gated on the trace belonging to `operationId` (for shared code paths). */
  spanFor(operationId: string, key: string, startAtMs: number, endAtMs?: number) {
    if (this.operationId !== operationId) return;
    this.span(key, startAtMs, endAtMs);
  }

  /** Mark gated on the trace belonging to `operationId`. */
  markFor(operationId: string, key: string) {
    if (this.operationId !== operationId) return;
    this.mark(key);
  }

  /**
   * First rendered content delta (text/reasoning) — the end of the TTFT path.
   * Computes `ttftMs` and reports the trace.
   */
  onFirstContent(operationId: string) {
    if (this.operationId !== operationId || this.reported || this.anchorMs === undefined) return;
    const ttftMs = Date.now() - this.anchorMs;
    this.mark('first_content');
    this.report(ttftMs);
  }

  private report(ttftMs: number) {
    if (this.reported || !this.operationId) return;
    this.reported = true;

    lambdaClient.chatTtftMetric.report
      .mutate({ operationId: this.operationId, spans: this.spans, ttftMs })
      .catch((error: unknown) => console.warn('[ChatTtftTrace] report failed:', error));
  }
}

export const chatTtftTrace = new ChatTtftTraceCollector();
