import type * as BusinessConst from '@lobechat/business-const';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Both branches are asserted from the same file: the single-provider variant is
 * only safe to ship if it does not also strip the multi-provider guidance
 * upstream, and that is exactly the kind of thing a one-sided test misses.
 */
const loadSystemPrompt = async (enableBusinessFeatures: boolean) => {
  vi.resetModules();
  // Partial mock: this module reads several branding constants beyond the flag
  // under test, and a full factory would have to be extended every time one is
  // added — which is exactly how this test broke once already.
  vi.doMock('@lobechat/business-const', async (importOriginal) => ({
    ...(await importOriginal<typeof BusinessConst>()),
    BRANDING_PROVIDER: 'lobehub',
    ENABLE_BUSINESS_FEATURES: enableBusinessFeatures,
  }));

  return (await import('./systemRole')).systemPrompt;
};

afterEach(() => {
  vi.doUnmock('@lobechat/business-const');
  vi.resetModules();
});

describe('agent management system prompt — multi-provider (upstream default)', () => {
  it('keeps the frontier-model priority ladder', async () => {
    const prompt = await loadSystemPrompt(false);

    expect(prompt).toContain('Second Priority');
    expect(prompt).toContain('Anthropic');
    expect(prompt).toContain('OpenAI');
    expect(prompt).toContain('Google');
  });

  it('still puts the branded provider first', async () => {
    expect(await loadSystemPrompt(false)).toContain('First Priority');
  });
});

describe('agent management system prompt — single provider', () => {
  it('names the branded provider as the only one', async () => {
    const prompt = await loadSystemPrompt(true);

    expect(prompt).toContain('exactly one provider');
    expect(prompt).toContain('`lobehub`');
  });

  // The ladder is what sent the model to a vendor that does not exist here: its
  // first rung is conditional, so an empty model list drops straight through to
  // "use Anthropic / OpenAI / Google".
  it('drops the vendor ladder entirely', async () => {
    const prompt = await loadSystemPrompt(true);

    expect(prompt).not.toContain('Second Priority');
    expect(prompt).not.toContain('Claude Sonnet');
    expect(prompt).not.toContain('Gemini 2.5 Pro');
    expect(prompt).not.toContain('GPT-5 or higher');
  });

  it('tells the model to omit both fields rather than guess', async () => {
    const prompt = await loadSystemPrompt(true);

    expect(prompt).toContain('omit BOTH');
    expect(prompt).toMatch(/inherits this deployment's configured default/);
  });

  // Naming a default model id here would make the prompt a second source of
  // truth for something `DEFAULT_MODEL` already owns and the startup check
  // already validates — it would rot silently when the admin edits the catalogue.
  it('does not hardcode a model id', async () => {
    const prompt = await loadSystemPrompt(true);

    expect(prompt).not.toMatch(/deepseek-v4/);
    expect(prompt).not.toContain('DEFAULT_MODEL');
  });

  it('rules out inferring a provider from the model vendor', async () => {
    const prompt = await loadSystemPrompt(true);

    expect(prompt).toContain('never infer one from a model');
    expect(prompt).toContain('bytedance');
  });
});
