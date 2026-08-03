import { describe, expect, it } from 'vitest';

import {
  describeServableChoices,
  type ServableProviderInfo,
  validateServableModelSelection,
} from '../servableModels';

/**
 * What a single-branded-provider deployment looks like: one provider serving a
 * catalogue drawn from several upstream vendors. The vendor names are the point
 * — they are what a model infers a (wrong) provider id from.
 */
const branded: ServableProviderInfo[] = [
  {
    id: 'lobehub',
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'doubao-seed-2-0-pro-260215', name: 'Doubao Seed 2.0 Pro' },
    ],
    name: 'LobeHub',
  },
];

describe('validateServableModelSelection', () => {
  it('accepts a pair that is actually served', () => {
    expect(
      validateServableModelSelection(branded, {
        model: 'deepseek-v4-pro',
        provider: 'lobehub',
      }),
    ).toBeNull();
  });

  // Omitting both is how a caller says "use the deployment default" — it must
  // not be mistaken for an invalid selection.
  it('accepts an omitted pair', () => {
    expect(validateServableModelSelection(branded, {})).toBeNull();
  });

  // The reported bug: a Doubao model with a vendor name inferred from it.
  it('rejects a provider id inferred from the model vendor', () => {
    const problem = validateServableModelSelection(branded, {
      model: 'doubao-seed-2-0-pro-260215',
      provider: 'bytedance',
    });

    expect(problem).toContain('bytedance');
    // The message has to carry the real ids, or the retry is another guess.
    expect(problem).toContain('lobehub');
    expect(problem).toContain('deepseek-v4-pro');
  });

  it('rejects a real upstream provider that this deployment does not serve', () => {
    expect(
      validateServableModelSelection(branded, { model: 'gpt-5.4', provider: 'openai' }),
    ).toContain('Unknown provider "openai"');
  });

  // Right provider, wrong model — the pair is what has to be valid, not either half.
  it('rejects a model the named provider does not serve', () => {
    expect(
      validateServableModelSelection(branded, { model: 'gpt-5.4', provider: 'lobehub' }),
    ).toContain('does not serve model "gpt-5.4"');
  });

  // A lone `model` falls back to the default provider downstream, which is
  // precisely how a valid model ends up pointing at a disabled provider.
  it('rejects half a pair', () => {
    expect(validateServableModelSelection(branded, { model: 'deepseek-v4-pro' })).toContain(
      'must be given together',
    );
    expect(validateServableModelSelection(branded, { provider: 'lobehub' })).toContain(
      'must be given together',
    );
  });

  // Empty means the deployment could not resolve anything — telling the model to
  // pick from an empty list is what produced invented ids in the first place.
  it('tells the model not to set a model at all when nothing is servable', () => {
    const problem = validateServableModelSelection([], {
      model: 'deepseek-v4-pro',
      provider: 'lobehub',
    });

    expect(problem).toContain('No chat models are currently available');
  });
});

describe('describeServableChoices', () => {
  it('lists every id the model may copy', () => {
    expect(describeServableChoices(branded)).toBe(
      'lobehub: deepseek-v4-pro, deepseek-v4-flash, doubao-seed-2-0-pro-260215',
    );
  });

  it('separates providers so ids are never read as belonging to the wrong one', () => {
    const described = describeServableChoices([
      ...branded,
      { id: 'ollama', models: [{ id: 'llama3', name: 'Llama 3' }], name: 'Ollama' },
    ]);

    expect(described).toContain('lobehub: deepseek-v4-pro');
    expect(described).toContain('ollama: llama3');
    expect(described).toContain(' | ');
  });
});
