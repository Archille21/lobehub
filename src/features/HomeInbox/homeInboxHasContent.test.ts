import { describe, expect, it } from 'vitest';

import { resolveHomeInboxHasContent, resolveHomeInboxHasResolved } from './homeInboxHasContent';

describe('resolveHomeInboxHasContent', () => {
  it('shows the rail skeleton while briefs are loading', () => {
    expect(
      resolveHomeInboxHasContent({
        isMain: false,
        recommendationsVisible: false,
        sectionsCount: 0,
        status: 'loading',
      }),
    ).toBe(true);
  });

  it('shows the rail AsyncError on a first-load failure', () => {
    expect(
      resolveHomeInboxHasContent({
        isMain: false,
        recommendationsVisible: false,
        sectionsCount: 0,
        status: 'error',
      }),
    ).toBe(true);
  });

  it('has content whenever any section was assembled', () => {
    expect(
      resolveHomeInboxHasContent({
        isMain: false,
        recommendationsVisible: false,
        sectionsCount: 1,
        status: 'ready',
      }),
    ).toBe(true);
  });

  it('falls back to recommendations visibility once sections are empty', () => {
    expect(
      resolveHomeInboxHasContent({
        isMain: false,
        recommendationsVisible: true,
        sectionsCount: 0,
        status: 'ready',
      }),
    ).toBe(true);
    expect(
      resolveHomeInboxHasContent({
        isMain: false,
        recommendationsVisible: false,
        sectionsCount: 0,
        status: 'ready',
      }),
    ).toBe(false);
  });

  it('is false for an empty main inbox regardless of recommendations visibility', () => {
    expect(
      resolveHomeInboxHasContent({
        isMain: true,
        recommendationsVisible: true,
        sectionsCount: 0,
        status: 'ready',
      }),
    ).toBe(false);
  });
});

describe('resolveHomeInboxHasResolved', () => {
  it('is unresolved while briefs are still loading', () => {
    expect(
      resolveHomeInboxHasResolved({
        isRecommendationsSettled: true,
        isTopicsInit: true,
        status: 'loading',
      }),
    ).toBe(false);
  });

  it('is unresolved while topics have not finished their first fetch, even once briefs have', () => {
    expect(
      resolveHomeInboxHasResolved({
        isRecommendationsSettled: true,
        isTopicsInit: false,
        status: 'ready',
      }),
    ).toBe(false);
  });

  it('is unresolved while the recommendation flow is still showing its own skeleton', () => {
    expect(
      resolveHomeInboxHasResolved({
        isRecommendationsSettled: false,
        isTopicsInit: true,
        status: 'ready',
      }),
    ).toBe(false);
  });

  it('is resolved once briefs, topics, and recommendations have all settled', () => {
    expect(
      resolveHomeInboxHasResolved({
        isRecommendationsSettled: true,
        isTopicsInit: true,
        status: 'ready',
      }),
    ).toBe(true);
  });

  it('is resolved on a first-load brief failure — an error is itself a final answer', () => {
    expect(
      resolveHomeInboxHasResolved({
        isRecommendationsSettled: true,
        isTopicsInit: true,
        status: 'error',
      }),
    ).toBe(true);
  });
});
