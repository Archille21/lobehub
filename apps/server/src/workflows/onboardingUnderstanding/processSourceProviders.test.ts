// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  failRunningUnderstandingSourceProviders,
  processUnderstandingSourceProviders,
} from './processSourceProviders';

const errors = vi.hoisted(() => {
  class DomainError extends Error {}
  return { DomainError };
});

vi.mock('@lobechat/database', () => ({
  StaleUnderstandingSessionError: errors.DomainError,
  UnderstandingResourceNotFoundError: errors.DomainError,
  UnderstandingSessionNotFoundError: errors.DomainError,
}));
vi.mock('@/database/server', () => ({ getServerDB: vi.fn() }));
vi.mock('@/server/services/understanding/service', () => ({
  createUnderstandingService: vi.fn(),
}));

const payload = {
  responseLanguage: 'zh-CN',
  sourceProviders: [
    { revision: 1, sourceProviderId: 'gmail' },
    { revision: 1, sourceProviderId: 'github' },
  ],
  sessionId: 'session-1',
  topicId: 'topic-1',
  userId: 'user-1',
};
const workflow = { options: {}, routeFunction: vi.fn(), workflowId: 'process-collected' };

const createContext = (requestPayload: unknown) => {
  const steps: string[] = [];
  const invocations: Array<{ settings: any; stepName: string }> = [];
  return {
    context: {
      invoke: vi.fn(async (stepName: string, settings: any) => {
        invocations.push({ settings, stepName });
        return { body: {} };
      }),
      requestPayload,
      run: async <T>(stepName: string, action: () => Promise<T>) => {
        steps.push(stepName);
        return action();
      },
    },
    invocations,
    steps,
  };
};

const completed = (sourceProviderId: string, sourceFingerprint: string, revision = 1) => ({
  failedCount: 0,
  sourceProviderId,
  revision,
  sourceCount: 2,
  sourceFingerprint,
  status: 'completed' as const,
  succeededCount: 2,
});

describe('processUnderstandingSourceProviders', () => {
  it('runs one durable operation per provider concurrently and invokes each completed fingerprint immediately', async () => {
    let releaseGmail!: () => void;
    const gmailGate = new Promise<void>((resolve) => (releaseGmail = resolve));
    const service = {
      processSourceProvider: vi.fn(async ({ sourceProviderId }: { sourceProviderId: string }) => {
        if (sourceProviderId === 'gmail') await gmailGate;
        return completed(
          sourceProviderId,
          sourceProviderId === 'github' ? 'github@1' : 'github@1,gmail@1',
        );
      }),
    };
    const { context, invocations, steps } = createContext(payload);
    const running = processUnderstandingSourceProviders(context as never, {
      createService: async () => service as never,
      processCollectedWorkflow: workflow as never,
    });

    await vi.waitFor(() => expect(invocations).toHaveLength(1));
    expect(invocations[0].settings.body).toEqual({
      responseLanguage: 'zh-CN',
      sessionId: 'session-1',
      sourceFingerprint: 'github@1',
      topicId: 'topic-1',
      userId: 'user-1',
    });
    releaseGmail();
    await running;

    expect(steps).toEqual(['source-provider:github:1:process', 'source-provider:gmail:1:process']);
    expect(service.processSourceProvider).toHaveBeenCalledWith({
      sourceProviderId: 'github',
      revision: 1,
      sessionId: 'session-1',
      topicId: 'topic-1',
    });
    expect(invocations).toHaveLength(2);
    expect(invocations[0].settings.flowControl).toEqual({
      key: 'onboarding-understanding.writing.session-1',
      parallelism: 1,
    });
    expect(JSON.stringify({ invocations, payload })).not.toMatch(/token|accountId|markdown|xml/i);
  });

  it('replays a commit-before-ack delivery with the same fingerprint child identity', async () => {
    const service = {
      processSourceProvider: vi.fn(async () => completed('github', 'github@2', 2)),
    };
    const attempt = { revision: 2, sourceProviderId: 'github' };
    const first = createContext({ ...payload, sourceProviders: [attempt] });
    const replay = createContext({ ...payload, sourceProviders: [attempt] });
    const dependencies = {
      createService: async () => service as never,
      processCollectedWorkflow: workflow as never,
    };

    await processUnderstandingSourceProviders(first.context as never, dependencies);
    await processUnderstandingSourceProviders(replay.context as never, dependencies);

    expect(service.processSourceProvider).toHaveBeenCalledTimes(2);
    expect(first.invocations[0].settings.workflowRunId).toBe(
      replay.invocations[0].settings.workflowRunId,
    );
    expect(first.invocations[0].settings.workflowRunId).toMatch(
      /^onboarding-understanding-collected-[a-f0-9]{32}$/,
    );
  });

  it('does not invoke writing for terminal failure and lets transient errors retry', async () => {
    const terminal = createContext({
      ...payload,
      sourceProviders: [{ revision: 1, sourceProviderId: 'github' }],
    });
    await processUnderstandingSourceProviders(terminal.context as never, {
      createService: async () =>
        ({
          processSourceProvider: vi.fn(async () => ({
            ...completed('github', ''),
            status: 'failed',
          })),
        }) as never,
      processCollectedWorkflow: workflow as never,
    });
    expect(terminal.invocations).toHaveLength(0);

    const transient = new Error('connector temporarily unavailable');
    await expect(
      processUnderstandingSourceProviders(terminal.context as never, {
        createService: async () =>
          ({
            processSourceProvider: vi.fn(async () => {
              throw transient;
            }),
          }) as never,
        processCollectedWorkflow: workflow as never,
      }),
    ).rejects.toBe(transient);
  });

  it('does not invoke writing for a stale provider attempt', async () => {
    const stale = createContext({
      ...payload,
      sourceProviders: [{ revision: 4, sourceProviderId: 'github' }],
    });
    await processUnderstandingSourceProviders(stale.context as never, {
      createService: async () =>
        ({
          processSourceProvider: vi.fn(async () => ({
            ...completed('github', 'github@5', 4),
            status: 'stale',
          })),
        }) as never,
      processCollectedWorkflow: workflow as never,
    });

    expect(stale.invocations).toHaveLength(0);
  });

  it('rejects duplicate attempts and unsafe external payload fields', async () => {
    const service = { processSourceProvider: vi.fn(async () => completed('github', 'github@1')) };
    const duplicate = createContext({
      ...payload,
      sourceProviders: [
        { revision: 1, sourceProviderId: 'github' },
        { revision: 2, sourceProviderId: 'github' },
      ],
    });
    await expect(
      processUnderstandingSourceProviders(duplicate.context as never, {
        createService: async () => service as never,
        processCollectedWorkflow: workflow as never,
      }),
    ).rejects.toThrow();

    const unsafe = createContext({
      ...payload,
      accessToken: 'secret',
      sourceProviders: [{ revision: 1, sourceProviderId: 'github:1' }],
    });
    await expect(
      processUnderstandingSourceProviders(unsafe.context as never, {
        createService: vi.fn(),
        processCollectedWorkflow: workflow as never,
      }),
    ).rejects.toThrow();
  });
});

describe('failRunningUnderstandingSourceProviders', () => {
  it('terminalizes only the selected target revision and ignores an older attempt', async () => {
    const service = {
      failSourceProvider: vi.fn(async ({ revision }: { revision: number }) =>
        revision === 8 ? {} : undefined,
      ),
    };
    const current = {
      ...payload,
      sourceProviders: [{ revision: 8, sourceProviderId: 'github' }],
    };
    await expect(
      failRunningUnderstandingSourceProviders(current, {
        createService: async () => service as never,
      }),
    ).resolves.toEqual({ failedSourceProviderIds: ['github'] });
    expect(service.failSourceProvider).toHaveBeenCalledWith({
      sourceProviderId: 'github',
      revision: 8,
      sessionId: 'session-1',
      topicId: 'topic-1',
    });

    const oldAttempt = {
      ...payload,
      sourceProviders: [{ revision: 4, sourceProviderId: 'github' }],
    };
    await expect(
      failRunningUnderstandingSourceProviders(oldAttempt, {
        createService: async () => service as never,
      }),
    ).resolves.toEqual({ failedSourceProviderIds: [] });
    expect(service.failSourceProvider).toHaveBeenLastCalledWith({
      sourceProviderId: 'github',
      revision: 4,
      sessionId: 'session-1',
      topicId: 'topic-1',
    });
  });
});
