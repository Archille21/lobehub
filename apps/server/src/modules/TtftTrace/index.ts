import { AsyncLocalStorage } from 'node:async_hooks';

import debug from 'debug';

import type { UpsertChatTtftMetricParams } from '@/database/models/chatTtftMetric';
import { ChatTtftMetricModel } from '@/database/models/chatTtftMetric';
import type { ChatTtftClock, ChatTtftSpan } from '@/database/schemas/chatTtftMetrics';
import type { LobeChatDatabase } from '@/database/type';

import { fetchQStashDispatchSpans } from './qstashEvents';

const log = debug('lobe-server:ttft-trace');

/** Kill switch — `TTFT_TRACE_ENABLED=0` turns every recorder into a no-op. */
export const ttftTraceEnabled = () => process.env.TTFT_TRACE_ENABLED !== '0';

/** `qstash_wait` above this triggers the async QStash logs enrichment. `-1` disables. */
const qstashLogsThresholdMs = () => Number(process.env.TTFT_QSTASH_LOGS_THRESHOLD_MS ?? 2000);

/** Coalesces the first-content flush and late spans (gateway_push, enrichment) into few upserts. */
const FLUSH_DEBOUNCE_MS = 1500;

/**
 * True until the first recorder is created in this lambda instance — a
 * cheap cold-start signal for the runStep invocation (module load happens
 * once per instance).
 */
let firstRecorderPending = true;

interface PendingSpan {
  clock: ChatTtftClock;
  endAtMs?: number;
  key: string;
  meta?: Record<string, unknown>;
  startAtMs: number;
}

interface SpanOptions {
  clock?: ChatTtftClock;
  meta?: Record<string, unknown>;
}

export interface CreateTtftTraceRecorderParams {
  /**
   * Epoch ms of this writer's clock-domain anchor; every span offset is
   * relative to it. Defaults to the recorder's creation time.
   *
   * Cross-lambda alignment convention (no state plumbing needed): the runStep
   * writer anchors on the QStash payload `timestamp`, which is the same
   * instant as the execAgent writer's `qstash_publish` span start — so the
   * reading side aligns the two timelines by shifting runStep offsets by
   * `qstash_publish.offsetMs`.
   */
  anchorMs?: number;
  db: LobeChatDatabase;
  operationId?: string;
  /** Test seam — replaces the ChatTtftMetricModel upsert. */
  persist?: (params: UpsertChatTtftMetricParams) => Promise<void>;
  userId: string;
}

/**
 * Per-request span collector for the "Enter → first token" (TTFT) mini-trace.
 *
 * Spans are buffered with absolute epoch timestamps and converted to
 * anchor-relative offsets at flush time, so call sites never deal with the
 * clock-domain bookkeeping. Everything here is fire-and-forget: persistence
 * failures are logged and swallowed, and the business path never awaits it.
 */
export class TtftTraceRecorder {
  readonly coldStart: boolean;

  private anchorMs: number;
  private captureNextGatewayPush = false;
  private fields: Omit<UpsertChatTtftMetricParams, 'operationId' | 'spans'> = {};
  private firstContentFlushSeen = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private operationId?: string;
  private pending: PendingSpan[] = [];
  private readonly persist: (params: UpsertChatTtftMetricParams) => Promise<void>;
  private providerFirstChunkAtMs?: number;
  private qstashEnriched = false;
  private qstashMessageId?: string;
  private qstashWaitMs?: number;

  constructor(params: CreateTtftTraceRecorderParams) {
    this.anchorMs = params.anchorMs ?? Date.now();
    this.operationId = params.operationId;
    this.coldStart = firstRecorderPending;
    firstRecorderPending = false;

    const model = new ChatTtftMetricModel(params.db, params.userId);
    this.persist = params.persist ?? model.upsert;
  }

  setAnchor(anchorMs: number) {
    this.anchorMs = anchorMs;
  }

  setOperationId(operationId: string) {
    this.operationId = operationId;
  }

  setQStashMessageId(messageId?: string) {
    this.qstashMessageId = messageId;
  }

  /** Merge dimension fields (model/provider/messageIds/…) into the row. */
  set(fields: Omit<UpsertChatTtftMetricParams, 'operationId' | 'spans'>) {
    Object.assign(this.fields, fields);
  }

  span(key: string, startAtMs: number, endAtMs?: number, options?: SpanOptions) {
    this.pending.push({
      clock: options?.clock ?? 'server',
      endAtMs,
      key,
      meta: options?.meta,
      startAtMs,
    });
  }

  /** Zero-duration point mark. */
  mark(key: string, atMs = Date.now(), options?: SpanOptions) {
    this.span(key, atMs, undefined, options);
  }

  /** Wrap an existing call so the call site stays a one-line change. */
  async time<T>(key: string, fn: () => Promise<T>, options?: SpanOptions): Promise<T> {
    const startAtMs = Date.now();
    try {
      return await fn();
    } finally {
      this.span(key, startAtMs, Date.now(), options);
    }
  }

  /**
   * `qstash_wait` = payload publish timestamp (exec lambda clock) → runStep
   * start (this lambda's clock). Cross-machine but NTP-synced, ms-level skew;
   * it also overlaps `qstash_publish` since the payload timestamp is taken
   * just before the publish HTTP call.
   */
  recordQStashWait(publishedAtMs: number, receivedAtMs: number) {
    this.qstashWaitMs = receivedAtMs - publishedAtMs;
    this.span('qstash_wait', publishedAtMs, receivedAtMs, { clock: 'server-cross' });
  }

  recordProviderFirstChunk(llmStartAtMs: number, firstChunkAtMs = Date.now()) {
    if (this.providerFirstChunkAtMs !== undefined) return;
    this.providerFirstChunkAtMs = firstChunkAtMs;
    this.span('provider_ttft', llmStartAtMs, firstChunkAtMs);
  }

  /**
   * Called by the stream sink when the first content delta is flushed toward
   * the gateway — the runStep writer's persistence trigger. Derives
   * `stream_flush_wait` (buffer latency the existing `firstChunkAt` metric
   * cannot see), arms the gateway-push capture, and kicks the QStash logs
   * enrichment for slow queue waits.
   */
  onFirstContentFlush(flushAtMs = Date.now()) {
    if (this.firstContentFlushSeen) return;
    this.firstContentFlushSeen = true;
    if (this.providerFirstChunkAtMs !== undefined) {
      this.span('stream_flush_wait', this.providerFirstChunkAtMs, flushAtMs);
    }
    this.captureNextGatewayPush = true;
    this.enrichFromQStashEvents();
    this.requestFlush(true);
  }

  /** Records the gateway HTTP push of the first content chunk only. */
  recordGatewayPush(startAtMs: number, path?: string) {
    if (!this.captureNextGatewayPush) return;
    this.captureNextGatewayPush = false;
    this.span('gateway_push', startAtMs, Date.now(), path ? { meta: { path } } : undefined);
    this.requestFlush();
  }

  /**
   * Close this writer's umbrella span (anchor → now) and persist immediately.
   * Called once at the end of the instrumented request.
   */
  finish(key: string) {
    this.span(key, this.anchorMs, Date.now());
    this.requestFlush(true);
  }

  /** Fire-and-forget, debounced persistence. Never throws. */
  requestFlush(immediate = false) {
    if (immediate) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
      void this.flush();
      return;
    }

    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DEBOUNCE_MS);
    // Don't hold the process open for a metrics flush.
    this.flushTimer.unref?.();
  }

  private toSpans(pending: PendingSpan[]): ChatTtftSpan[] {
    return pending.map((s) => ({
      clock: s.clock,
      ...(s.endAtMs === undefined ? {} : { durationMs: s.endAtMs - s.startAtMs }),
      key: s.key,
      ...(s.meta ? { meta: s.meta } : {}),
      offsetMs: s.startAtMs - this.anchorMs,
    }));
  }

  private async flush() {
    if (!this.operationId) return;
    if (this.pending.length === 0 && Object.keys(this.fields).length === 0) return;

    const spans = this.toSpans(this.pending);
    const fields = this.fields;
    this.pending = [];
    this.fields = {};

    try {
      await this.persist({ ...fields, operationId: this.operationId, spans });
    } catch (error) {
      log('failed to persist ttft trace for %s: %O', this.operationId, error);
    }
  }

  private enrichFromQStashEvents() {
    const threshold = qstashLogsThresholdMs();
    if (this.qstashEnriched || threshold < 0) return;
    if (!this.qstashMessageId || this.qstashWaitMs === undefined) return;
    if (this.qstashWaitMs < threshold) return;

    this.qstashEnriched = true;
    const messageId = this.qstashMessageId;

    void fetchQStashDispatchSpans(messageId)
      .then((spans) => {
        if (spans.length === 0) return;
        for (const span of spans) this.span(span.key, span.startAtMs, span.endAtMs, span.options);
        this.requestFlush();
      })
      .catch((error) => log('qstash events enrichment failed for %s: %O', messageId, error));
  }
}

const storage = new AsyncLocalStorage<TtftTraceRecorder>();

/**
 * Ambient accessor so instrumentation points stay one-line and no business
 * function signature changes (same idea as the OTel context). All helpers are
 * no-ops when no recorder is bound or the feature is disabled.
 */
export const ttftTrace = {
  /**
   * Create a recorder and bind it to the current async execution context and
   * everything it spawns (`enterWith` — intentionally request-scoped; each
   * serverless invocation starts a fresh async chain). Returns undefined when
   * the feature is disabled.
   */
  begin(
    params: CreateTtftTraceRecorderParams & {
      fields?: Omit<UpsertChatTtftMetricParams, 'operationId' | 'spans'>;
    },
  ): TtftTraceRecorder | undefined {
    const { fields, ...rest } = params;
    const recorder = createTtftTraceRecorder(rest);
    if (!recorder) return undefined;
    if (fields) recorder.set(fields);
    storage.enterWith(recorder);
    return recorder;
  },

  /**
   * runStep-lambda entry: anchor on the QStash payload timestamp (see
   * CreateTtftTraceRecorderParams.anchorMs for the alignment convention),
   * record `qstash_wait` and the cold-start flag in one shot. Only meaningful
   * for step 0 — the caller gates on it.
   */
  beginRunStep(params: {
    db: LobeChatDatabase;
    operationId: string;
    publishedAtMs: number;
    qstashMessageId?: string;
    receivedAtMs: number;
    userId: string;
  }): TtftTraceRecorder | undefined {
    const recorder = ttftTrace.begin({
      anchorMs: params.publishedAtMs,
      db: params.db,
      operationId: params.operationId,
      userId: params.userId,
    });
    if (!recorder) return undefined;
    recorder.set({ coldStart: recorder.coldStart });
    recorder.recordQStashWait(params.publishedAtMs, params.receivedAtMs);
    recorder.setQStashMessageId(params.qstashMessageId);
    return recorder;
  },

  current: () => storage.getStore(),

  mark(key: string, atMs?: number, options?: SpanOptions) {
    storage.getStore()?.mark(key, atMs, options);
  },

  set(fields: Omit<UpsertChatTtftMetricParams, 'operationId' | 'spans'>) {
    storage.getStore()?.set(fields);
  },

  span(key: string, startAtMs: number, endAtMs?: number, options?: SpanOptions) {
    storage.getStore()?.span(key, startAtMs, endAtMs, options);
  },

  /** Wrap an awaited call; passes through untouched when no recorder is bound. */
  time<T>(key: string, fn: () => Promise<T>, options?: SpanOptions): Promise<T> {
    const recorder = storage.getStore();
    return recorder ? recorder.time(key, fn, options) : fn();
  },
};

export const createTtftTraceRecorder = (
  params: CreateTtftTraceRecorderParams,
): TtftTraceRecorder | undefined => {
  if (!ttftTraceEnabled()) return undefined;
  try {
    return new TtftTraceRecorder(params);
  } catch (error) {
    log('failed to create ttft trace recorder: %O', error);
    return undefined;
  }
};
