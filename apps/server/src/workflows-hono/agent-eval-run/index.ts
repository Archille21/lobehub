import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import { serve } from '@upstash/workflow/hono';
import { Hono } from 'hono';

import { qstashClient } from '@/libs/qstash';

import { executeTestCaseWorkflow } from './workflows/executeTestCase';
import { finalizeRunWorkflow } from './workflows/finalizeRun';
import { paginateTestCasesWorkflow } from './workflows/paginateTestCases';
import { resumeAgentTrajectoryWorkflow } from './workflows/resumeAgentTrajectory';
import { resumeThreadTrajectoryWorkflow } from './workflows/resumeThreadTrajectory';
import { runAgentTrajectoryWorkflow } from './workflows/runAgentTrajectory';
import { runBenchmarkWorkflow } from './workflows/runBenchmark';
import { runThreadTrajectoryWorkflow } from './workflows/runThreadTrajectory';

const app = new Hono();

app.post(
  '/execute-test-case',
  serve(
    withOtelMetricsForUpstashWorkflows(executeTestCaseWorkflow, {
      url: '/api/workflows/agent-eval-run/execute-test-case',
    }),
    {
      flowControl: {
        key: 'agent-eval-run.execute-test-case',
        parallelism: 200,
        ratePerSecond: 5,
      },
      qstashClient,
    },
  ),
);

app.post(
  '/finalize-run',
  serve(
    withOtelMetricsForUpstashWorkflows(finalizeRunWorkflow, {
      url: '/api/workflows/agent-eval-run/finalize-run',
    }),
    {
      flowControl: { key: 'agent-eval-run.finalize-run', parallelism: 10, rate: 1 },
      qstashClient,
    },
  ),
);

app.post(
  '/paginate-test-cases',
  serve(
    withOtelMetricsForUpstashWorkflows(paginateTestCasesWorkflow, {
      url: '/api/workflows/agent-eval-run/paginate-test-cases',
    }),
    {
      flowControl: { key: 'agent-eval-run.paginate-test-cases', parallelism: 200, rate: 5 },
      qstashClient,
    },
  ),
);

app.post(
  '/resume-agent-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(resumeAgentTrajectoryWorkflow, {
      url: '/api/workflows/agent-eval-run/resume-agent-trajectory',
    }),
    {
      flowControl: {
        key: 'agent-eval-run.resume-agent-trajectory',
        parallelism: 500,
        ratePerSecond: 20,
      },
      qstashClient,
    },
  ),
);

app.post(
  '/resume-thread-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(resumeThreadTrajectoryWorkflow, {
      url: '/api/workflows/agent-eval-run/resume-thread-trajectory',
    }),
    {
      flowControl: {
        key: 'agent-eval-run.resume-thread-trajectory',
        parallelism: 500,
        ratePerSecond: 20,
      },
      qstashClient,
    },
  ),
);

app.post(
  '/run-agent-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(runAgentTrajectoryWorkflow, {
      url: '/api/workflows/agent-eval-run/run-agent-trajectory',
    }),
    {
      flowControl: {
        key: 'agent-eval-run.run-agent-trajectory',
        parallelism: 500,
        ratePerSecond: 20,
      },
      qstashClient,
    },
  ),
);

app.post(
  '/run-benchmark',
  serve(
    withOtelMetricsForUpstashWorkflows(runBenchmarkWorkflow, {
      url: '/api/workflows/agent-eval-run/run-benchmark',
    }),
    {
      flowControl: { key: 'agent-eval-run.process-run', parallelism: 100, rate: 1 },
      qstashClient,
    },
  ),
);

app.post(
  '/run-thread-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(runThreadTrajectoryWorkflow, {
      url: '/api/workflows/agent-eval-run/run-thread-trajectory',
    }),
    {
      flowControl: {
        key: 'agent-eval-run.run-thread-trajectory',
        parallelism: 500,
        ratePerSecond: 20,
      },
      qstashClient,
    },
  ),
);

export default app;
