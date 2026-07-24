import { createHash } from 'node:crypto';

import {
  StaleUnderstandingSessionError,
  UnderstandingResourceNotFoundError,
  UnderstandingSessionNotFoundError,
} from '@lobechat/database';
import type { InvokableWorkflow, PublicServeOptions, WorkflowContext } from '@upstash/workflow';

import { getServerDB } from '@/database/server';
import {
  createUnderstandingService,
  type UnderstandingService,
} from '@/server/services/understanding/service';

import {
  getUnderstandingWritingFlowControlKey,
  type ProcessCollectedUnderstandingPayload,
  type ProcessUnderstandingSourceProvidersPayload,
  ProcessUnderstandingSourceProvidersPayloadSchema,
} from './types';

type SourceProviderService = Pick<
  UnderstandingService,
  'failSourceProvider' | 'processSourceProvider'
>;

type SourceProviderWorkflowContext = Pick<
  WorkflowContext<ProcessUnderstandingSourceProvidersPayload>,
  'invoke' | 'requestPayload' | 'run'
>;

interface SourceProviderWorkflowDependencies {
  createService?: (userId: string) => Promise<SourceProviderService>;
  processCollectedWorkflow: InvokableWorkflow<ProcessCollectedUnderstandingPayload, unknown>;
}

interface SourceProviderFailureDependencies {
  createService?: (userId: string) => Promise<SourceProviderService>;
}

const createService = async (userId: string) =>
  createUnderstandingService({ db: await getServerDB(), userId });

const isTerminalizedSession = (error: unknown) =>
  error instanceof StaleUnderstandingSessionError ||
  error instanceof UnderstandingResourceNotFoundError ||
  error instanceof UnderstandingSessionNotFoundError;

const collectedWorkflowRunId = (sessionId: string, sourceFingerprint: string) =>
  `onboarding-understanding-collected-${createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(sourceFingerprint)
    .digest('hex')
    .slice(0, 32)}`;

export const processUnderstandingSourceProviders = async (
  context: SourceProviderWorkflowContext,
  dependencies: SourceProviderWorkflowDependencies,
) => {
  const parsed = ProcessUnderstandingSourceProvidersPayloadSchema.parse(context.requestPayload);
  const payload = {
    ...parsed,
    sourceProviders: parsed.sourceProviders.toSorted((left, right) =>
      left.sourceProviderId.localeCompare(right.sourceProviderId),
    ),
  };
  const service = await (dependencies.createService ?? createService)(payload.userId);

  const sourceProviders = await Promise.all(
    payload.sourceProviders.map(async ({ revision, sourceProviderId }) => {
      const result = await context.run(
        `source-provider:${sourceProviderId}:${revision}:process`,
        () =>
          service.processSourceProvider({
            revision,
            sessionId: payload.sessionId,
            sourceProviderId,
            topicId: payload.topicId,
          }),
      );
      if (result.status === 'completed' && result.revision === revision) {
        await context.invoke(`source-provider:${sourceProviderId}:write:${result.revision}`, {
          body: {
            responseLanguage: payload.responseLanguage,
            sessionId: payload.sessionId,
            sourceFingerprint: result.sourceFingerprint,
            topicId: payload.topicId,
            userId: payload.userId,
          },
          // Serialize writers for this session. The repository's fingerprint CAS then prevents a
          // delayed failure callback for an older invocation from terminalizing newer writing.
          flowControl: {
            key: getUnderstandingWritingFlowControlKey(payload.sessionId),
            parallelism: 1,
          },
          workflow: dependencies.processCollectedWorkflow,
          workflowRunId: collectedWorkflowRunId(payload.sessionId, result.sourceFingerprint),
        });
      }

      return {
        failedCount: result.failedCount,
        sourceProviderId,
        revision: result.revision,
        sourceCount: result.sourceCount,
        status: result.status,
        succeededCount: result.succeededCount,
      };
    }),
  );

  return { sourceProviders };
};

export const failRunningUnderstandingSourceProviders = async (
  input: unknown,
  dependencies: SourceProviderFailureDependencies = {},
) => {
  const payload = ProcessUnderstandingSourceProvidersPayloadSchema.parse(input);
  const service = await (dependencies.createService ?? createService)(payload.userId);
  const failedSourceProviderIds: string[] = [];

  await Promise.all(
    payload.sourceProviders.map(async ({ revision, sourceProviderId }) => {
      try {
        const failed = await service.failSourceProvider({
          sourceProviderId,
          revision,
          sessionId: payload.sessionId,
          topicId: payload.topicId,
        });
        if (failed) failedSourceProviderIds.push(sourceProviderId);
      } catch (error) {
        if (!isTerminalizedSession(error)) throw error;
      }
    }),
  );

  return { failedSourceProviderIds: failedSourceProviderIds.sort() };
};

export const processSourceProvidersWorkflowOptions = {
  failureFunction: async ({
    context: { requestPayload },
  }: {
    context: { requestPayload?: unknown };
  }) => {
    const parsed = ProcessUnderstandingSourceProvidersPayloadSchema.safeParse(requestPayload);
    if (!parsed.success) return 'invalid-payload';
    const result = await failRunningUnderstandingSourceProviders(parsed.data);
    return `failed-source-providers:${result.failedSourceProviderIds.length}`;
  },
  initialPayloadParser: (input: string) =>
    ProcessUnderstandingSourceProvidersPayloadSchema.parse(JSON.parse(input)),
} satisfies PublicServeOptions<ProcessUnderstandingSourceProvidersPayload>;
