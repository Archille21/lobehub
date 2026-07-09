/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ContentLoading from './ContentLoading';

let runningOp: any;

vi.mock('@lobechat/heterogeneous-agents', () => ({
  HETEROGENEOUS_TYPE_LABELS: {
    'claude-code': 'Claude Code',
    'codex': 'Codex',
  },
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('antd-style', () => ({
  cssVar: {
    colorError: 'rgb(255, 0, 0)',
  },
}));

vi.mock('@/components/BubblesLoading', () => ({
  default: () => <div>bubbles</div>,
}));

vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => <div>neural loading</div>,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (selector: (s: unknown) => unknown) =>
    selector({
      agentMap: {
        'agent-1': {
          agencyConfig: {
            heterogeneousProvider: { type: 'claude-code' },
          },
        },
      },
    }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentSelectors: {
    getAgentConfigById: (agentId: string) => (s: any) => s.agentMap[agentId],
  },
}));

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ runningOp }),
}));

vi.mock('@/store/chat/selectors', () => ({
  operationSelectors: {
    getDeepestRunningOperationByMessage: () => (s: any) => s.runningOp,
  },
}));

vi.mock('@/styles/loading', () => ({
  elapsedTimeStyles: {
    elapsedTime: 'elapsed-time',
  },
  shinyTextStyles: {
    shinyText: 'shiny-text',
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      (
        ({
          'operation.autoRetryPending': `${options?.name} hit 529, retrying automatically`,
          'operation.execHeterogeneousAgent': `${options?.name} is running`,
          'operation.heterogeneousAgentFallback': 'External agent',
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

describe('ContentLoading', () => {
  beforeEach(() => {
    runningOp = {
      context: { agentId: 'agent-1' },
      metadata: { startTime: Date.now() },
      type: 'autoRetryPending',
    };
  });

  it('renders heterogeneous auto-retry with error color and without shiny text', () => {
    render(<ContentLoading id="assistant-1" />);

    const label = screen.getByText('Claude Code hit 529, retrying automatically...');

    expect(label).toHaveStyle({ color: 'rgb(255, 0, 0)' });
    expect(label).not.toHaveClass('shiny-text');
  });

  it('keeps normal heterogeneous running text shiny', () => {
    runningOp = {
      context: { agentId: 'agent-1' },
      metadata: { heterogeneousType: 'claude-code', startTime: Date.now() },
      type: 'execHeterogeneousAgent',
    };

    render(<ContentLoading id="assistant-1" />);

    expect(screen.getByText('Claude Code is running...')).toHaveClass('shiny-text');
  });
});
