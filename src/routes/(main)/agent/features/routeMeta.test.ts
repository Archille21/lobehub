import { describe, expect, it } from 'vitest';

import { getAgentScopedPageTitle } from './routeMeta';

describe('getAgentScopedPageTitle', () => {
  it('uses the profile label and agent name for the desktop tab title', () => {
    expect(getAgentScopedPageTitle('Agent Profile', 'Researcher')).toBe(
      'Agent Profile - Researcher',
    );
  });

  it('uses the channel label and agent name for channel tabs', () => {
    expect(getAgentScopedPageTitle('Channels', 'Researcher')).toBe('Channels - Researcher');
  });

  it('falls back to the page label while agent metadata is loading', () => {
    expect(getAgentScopedPageTitle('Agent Profile')).toBe('Agent Profile');
  });
});
