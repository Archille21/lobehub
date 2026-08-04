import { describe, expect, it } from 'vitest';

import { resolveHomeInboxHasContent } from './homeInboxHasContent';

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
