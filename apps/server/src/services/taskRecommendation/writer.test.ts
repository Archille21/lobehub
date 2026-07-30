// @vitest-environment node
import { RequestTrigger } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { defaultTaskRecommendationConfig } from './config';
import { TaskRecommendationWriter } from './writer';

/** @example Connector evidence is converted into validated background-safe task drafts. */
describe('TaskRecommendationWriter', () => {
  /** @example The isolated writer owns prompt assembly, model selection, and schema validation. */
  it('generates structured recommendations with the configured agent', async () => {
    const generateObject = vi.fn(async () => ({
      recommendations: [
        {
          instruction: 'Inspect the pull request and return a private risk report.',
          reason: 'The lifecycle change needs focused analysis.',
          sourceUrls: ['https://github.com/lobehub/lobehub/pull/1'],
          title: 'Review LobeHub lifecycle changes',
        },
      ],
    }));
    const writer = new TaskRecommendationWriter({
      generator: { generateObject },
      writerAgent: vi.fn(async () => ({ id: 'agent-1', model: 'model-1', provider: 'provider-1' })),
    });

    const recommendations = await writer.generate({
      context: '{"pullRequest":1}',
      guide: defaultTaskRecommendationConfig.providers.github,
      limit: 3,
      providerId: 'github',
      responseLanguage: 'en-US',
      writingGuide: defaultTaskRecommendationConfig.writing,
    });

    expect(recommendations).toHaveLength(1);
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'model-1', provider: 'provider-1' }),
      { metadata: { trigger: RequestTrigger.Onboarding } },
    );
    expect(generateObject.mock.calls[0][0].messages[1].content).toContain(
      '<connector-evidence provider="github">',
    );
  });
});
