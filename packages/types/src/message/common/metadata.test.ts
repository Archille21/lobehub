import { describe, expect, it } from 'vitest';

import { RequestTrigger } from '../../agentRuntime';
import { MessageMetadataSchema } from './metadata';

describe('MessageMetadataSchema', () => {
  it('preserves request trigger metadata during runtime parsing', () => {
    const parsed = MessageMetadataSchema.parse({
      trigger: RequestTrigger.Onboarding,
      unknown: 'stripped',
    });

    expect(parsed).toEqual({ trigger: RequestTrigger.Onboarding });
  });

  it('preserves hetero-agent session provenance so it is not stripped on writes', () => {
    const parsed = MessageMetadataSchema.parse({
      heteroMessageId: 'cc-1',
      heteroSessionId: 'sess-A',
      unknown: 'stripped',
    });

    expect(parsed).toEqual({ heteroMessageId: 'cc-1', heteroSessionId: 'sess-A' });
  });

  // The renderer executor flushes the main-chain verdict through
  // UpdateMessageParamsSchema. Strip it here and the desktop path persists no
  // verdict at all — silently, and only on that path — leaving every reader to
  // guess from message content forever.
  it('preserves the signal main-chain verdict so it is not stripped on writes', () => {
    const parsed = MessageMetadataSchema.parse({
      signal: { sourceToolCallId: 'tc', sourceToolName: 'Bash', type: 'tool-stdout' },
      signalPromoted: true,
      unknown: 'stripped',
    });

    expect(parsed).toEqual({
      signal: { sourceToolCallId: 'tc', sourceToolName: 'Bash', type: 'tool-stdout' },
      signalPromoted: true,
    });
  });
});
