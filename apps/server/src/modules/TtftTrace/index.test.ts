// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpsertChatTtftMetricParams } from '@/database/models/chatTtftMetric';

import { createTtftTraceRecorder, ttftTrace, TtftTraceRecorder } from './index';

const fakeDb = {} as any;

const createRecorder = (overrides?: {
  anchorMs?: number;
  operationId?: string;
  persist?: (params: UpsertChatTtftMetricParams) => Promise<void>;
}) =>
  new TtftTraceRecorder({
    db: fakeDb,
    operationId: 'op_test',
    persist: overrides?.persist ?? (async () => {}),
    userId: 'user-1',
    ...overrides,
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('TtftTraceRecorder', () => {
  it('converts absolute timestamps to anchor-relative offsets on flush', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    const recorder = createRecorder({
      anchorMs: 1000,
      persist: async (params) => void persisted.push(params),
    });

    recorder.span('topic_create', 1200, 1350);
    recorder.mark('some_mark', 1500);
    recorder.requestFlush(true);
    await vi.runAllTimersAsync();

    expect(persisted).toHaveLength(1);
    expect(persisted[0].operationId).toBe('op_test');
    expect(persisted[0].spans).toEqual([
      { clock: 'server', durationMs: 150, key: 'topic_create', offsetMs: 200 },
      { clock: 'server', key: 'some_mark', offsetMs: 500 },
    ]);
  });

  it('time() wraps a call and records its duration without altering the result', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    const recorder = createRecorder({
      anchorMs: Date.now(),
      persist: async (params) => void persisted.push(params),
    });

    const pending = recorder.time('create_operation', async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return 'result';
    });
    await vi.advanceTimersByTimeAsync(120);

    await expect(pending).resolves.toBe('result');
    recorder.requestFlush(true);
    await vi.runAllTimersAsync();

    expect(persisted[0].spans).toEqual([
      expect.objectContaining({ durationMs: 120, key: 'create_operation' }),
    ]);
  });

  it('records spans even when the wrapped call throws', async () => {
    const recorder = createRecorder({ anchorMs: Date.now() });

    await expect(
      recorder.time('create_operation', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('does not flush without an operationId, then flushes once it is set', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    const recorder = new TtftTraceRecorder({
      db: fakeDb,
      persist: async (params) => void persisted.push(params),
      userId: 'user-1',
    });

    recorder.mark('early');
    recorder.requestFlush(true);
    await vi.runAllTimersAsync();
    expect(persisted).toHaveLength(0);

    recorder.setOperationId('op_late');
    recorder.requestFlush(true);
    await vi.runAllTimersAsync();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].operationId).toBe('op_late');
  });

  it('swallows persistence failures (fire-and-forget)', async () => {
    const recorder = createRecorder({
      persist: async () => {
        throw new Error('db down');
      },
    });

    recorder.mark('anything');
    recorder.requestFlush(true);
    await expect(vi.runAllTimersAsync()).resolves.not.toThrow();
  });

  it('onFirstContentFlush derives stream_flush_wait, is idempotent, and flushes immediately', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    const recorder = createRecorder({
      anchorMs: 0,
      persist: async (params) => void persisted.push(params),
    });

    recorder.recordProviderFirstChunk(100, 400);
    recorder.onFirstContentFlush(700);
    recorder.onFirstContentFlush(9999); // second call ignored
    await vi.runAllTimersAsync();

    expect(persisted).toHaveLength(1);
    expect(persisted[0].spans).toEqual([
      { clock: 'server', durationMs: 300, key: 'provider_ttft', offsetMs: 100 },
      { clock: 'server', durationMs: 300, key: 'stream_flush_wait', offsetMs: 400 },
    ]);
  });

  it('captures only the gateway push directly following the first content flush', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    const recorder = createRecorder({
      anchorMs: 0,
      persist: async (params) => void persisted.push(params),
    });

    // Pushes before the first content flush are ignored (step_start etc.)
    recorder.recordGatewayPush(10, '/events');
    recorder.onFirstContentFlush(500);
    recorder.recordGatewayPush(510, '/events');
    recorder.recordGatewayPush(600, '/events'); // disarmed again
    await vi.runAllTimersAsync();

    const spans = persisted.flatMap((p) => p.spans ?? []);
    const pushes = spans.filter((s) => s.key === 'gateway_push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0].offsetMs).toBe(510);
  });

  it('finish() records the umbrella span from the anchor', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    vi.setSystemTime(5000);
    const recorder = createRecorder({
      anchorMs: 4000,
      persist: async (params) => void persisted.push(params),
    });

    recorder.finish('server_exec_agent');
    await vi.runAllTimersAsync();

    expect(persisted[0].spans).toEqual([
      { clock: 'server', durationMs: 1000, key: 'server_exec_agent', offsetMs: 0 },
    ]);
  });

  it('recordQStashWait tags the span as server-cross', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    const recorder = createRecorder({
      anchorMs: 1000,
      persist: async (params) => void persisted.push(params),
    });

    recorder.recordQStashWait(1000, 2600);
    recorder.requestFlush(true);
    await vi.runAllTimersAsync();

    expect(persisted[0].spans).toEqual([
      { clock: 'server-cross', durationMs: 1600, key: 'qstash_wait', offsetMs: 0 },
    ]);
  });
});

describe('ttftTrace ambient context', () => {
  // NOTE: keep this test before any `begin()` call in this file — `begin()`
  // binds via AsyncLocalStorage.enterWith and there is no public unbind.
  it('helpers are no-ops without a bound recorder and time() passes through', async () => {
    expect(ttftTrace.current()).toBeUndefined();
    ttftTrace.mark('orphan');
    ttftTrace.span('orphan_span', 0, 10);
    await expect(ttftTrace.time('orphan_time', async () => 42)).resolves.toBe(42);
  });

  it('begin() returns undefined when the kill switch is off', () => {
    vi.stubEnv('TTFT_TRACE_ENABLED', '0');
    expect(createTtftTraceRecorder({ db: fakeDb, userId: 'user-1' })).toBeUndefined();
    expect(ttftTrace.begin({ db: fakeDb, userId: 'user-1' })).toBeUndefined();
  });

  it('begin() binds the recorder so nested helpers record onto it', async () => {
    const persisted: UpsertChatTtftMetricParams[] = [];
    const recorder = ttftTrace.begin({
      anchorMs: 0,
      db: fakeDb,
      fields: { trigger: 'sendMessage' },
      operationId: 'op_ctx',
      persist: async (params) => void persisted.push(params),
      userId: 'user-1',
    })!;

    expect(ttftTrace.current()).toBe(recorder);

    await ttftTrace.time('history_load', async () => 'x');
    ttftTrace.span('tool_discovery', 10, 30);

    recorder.requestFlush(true);
    await vi.runAllTimersAsync();

    expect(persisted[0].trigger).toBe('sendMessage');
    expect(persisted[0].spans?.map((s) => s.key)).toEqual(['history_load', 'tool_discovery']);
  });
});
