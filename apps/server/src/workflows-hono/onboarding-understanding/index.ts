import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import type { WorkflowContext } from '@upstash/workflow';
import { createWorkflow, serveMany } from '@upstash/workflow/hono';
import { Hono } from 'hono';

import {
  type ProcessCollectedUnderstandingPayload,
  type ProcessUnderstandingSourceProvidersPayload,
} from '@/server/workflows/onboardingUnderstanding';
import {
  processCollectedUnderstanding,
  processCollectedWorkflowOptions,
} from '@/server/workflows/onboardingUnderstanding/processCollected';
import {
  processSourceProvidersWorkflowOptions,
  processUnderstandingSourceProviders,
} from '@/server/workflows/onboardingUnderstanding/processSourceProviders';

import { createWorkflowQstashClient } from '../qstashClient';

const app = new Hono();

export const processCollectedWorkflow = createWorkflow<
  ProcessCollectedUnderstandingPayload,
  Awaited<ReturnType<typeof processCollectedUnderstanding>>
>(
  withOtelMetricsForUpstashWorkflows(processCollectedUnderstanding, {
    url: '/api/workflows/onboarding/understanding/process-collected',
  }),
  processCollectedWorkflowOptions,
);

export const processSourceProvidersWorkflow = createWorkflow<
  ProcessUnderstandingSourceProvidersPayload,
  Awaited<ReturnType<typeof processUnderstandingSourceProviders>>
>(
  withOtelMetricsForUpstashWorkflows(
    (context: WorkflowContext<ProcessUnderstandingSourceProvidersPayload>) =>
      processUnderstandingSourceProviders(context, {
        processCollectedWorkflow,
      }),
    { url: '/api/workflows/onboarding/understanding/process-source-providers' },
  ),
  processSourceProvidersWorkflowOptions,
);

app.post(
  '/:workflowId',
  serveMany(
    {
      'process-source-providers': processSourceProvidersWorkflow,
      'process-collected': processCollectedWorkflow,
    },
    { qstashClient: createWorkflowQstashClient() },
  ),
);

export default app;
