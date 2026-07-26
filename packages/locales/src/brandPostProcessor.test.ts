import { DEFAULT_INBOX_TITLE } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import {
  applyBrandStrings,
  brandPostProcessor,
  isBrandPostProcessorEnabled,
} from './brandPostProcessor';

// These assertions hold under both default and custom branding: with default
// branding DEFAULT_INBOX_TITLE is 'Lobe AI', so every rewrite is the identity.
describe('applyBrandStrings', () => {
  it('rewrites the upstream assistant name to the deployment default', () => {
    expect(applyBrandStrings('Ask Lobe AI')).toBe(`Ask ${DEFAULT_INBOX_TITLE}`);
  });

  it('rewrites every occurrence in one string', () => {
    expect(applyBrandStrings('Lobe AI and Lobe AI')).toBe(
      `${DEFAULT_INBOX_TITLE} and ${DEFAULT_INBOX_TITLE}`,
    );
  });

  it('leaves unrelated copy untouched', () => {
    expect(applyBrandStrings('Start a new topic')).toBe('Start a new topic');
  });

  it('is only enabled when the deployment renamed the assistant', () => {
    // Cast away the literal type: under a given branding config tsc knows the
    // outcome of this comparison, but the assertion must hold for both.
    const renamed = (DEFAULT_INBOX_TITLE as string) !== 'Lobe AI';

    expect(isBrandPostProcessorEnabled).toBe(renamed);
  });
});

describe('brandPostProcessor', () => {
  it('passes non-string values through untouched', () => {
    const value = { count: 1 };
    expect(brandPostProcessor.process(value as never, 'key', {}, {} as never)).toBe(value);
  });
});
