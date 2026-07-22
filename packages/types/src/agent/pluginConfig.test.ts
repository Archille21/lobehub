import { describe, expect, it } from 'vitest';

import {
  getActivePluginIds,
  getDisabledPluginIds,
  getPinnedPluginIds,
  getPluginConnectorIds,
  getPluginMode,
  parsePluginEntry,
  upsertPluginMode,
} from './pluginConfig';

describe('parsePluginEntry', () => {
  it('resolves a legacy string entry as pinned', () => {
    expect(parsePluginEntry('web-search')).toEqual({ identifier: 'web-search', mode: 'pinned' });
  });

  it('resolves an object entry with no mode as pinned', () => {
    expect(parsePluginEntry({ identifier: 'web-search' })).toEqual({
      identifier: 'web-search',
      mode: 'pinned',
    });
  });

  it('resolves an object entry with an explicit mode', () => {
    expect(parsePluginEntry({ identifier: 'web-search', mode: 'auto' })).toEqual({
      identifier: 'web-search',
      mode: 'auto',
    });
    expect(parsePluginEntry({ identifier: 'web-search', mode: 'disabled' })).toEqual({
      identifier: 'web-search',
      mode: 'disabled',
    });
    expect(parsePluginEntry({ identifier: 'web-search', mode: 'pinned' })).toEqual({
      identifier: 'web-search',
      mode: 'pinned',
    });
  });
});

describe('parsePluginEntry — connectorIds', () => {
  it('is undefined for a legacy string entry', () => {
    expect(parsePluginEntry('gmail').connectorIds).toBeUndefined();
  });

  it('is undefined for an object entry without the field', () => {
    expect(parsePluginEntry({ identifier: 'gmail' }).connectorIds).toBeUndefined();
  });

  it('carries the restricted connector ids through', () => {
    expect(
      parsePluginEntry({ connectorIds: ['conn-1', 'conn-2'], identifier: 'gmail', mode: 'pinned' }),
    ).toEqual({ connectorIds: ['conn-1', 'conn-2'], identifier: 'gmail', mode: 'pinned' });
  });
});

describe('getPluginConnectorIds', () => {
  it('returns undefined (all connections) when plugins is undefined', () => {
    expect(getPluginConnectorIds(undefined, 'gmail')).toBeUndefined();
  });

  it('returns undefined when the identifier is absent — auto plugins use all connections', () => {
    expect(getPluginConnectorIds(['other'], 'gmail')).toBeUndefined();
  });

  it('returns undefined for a legacy string entry', () => {
    expect(getPluginConnectorIds(['gmail'], 'gmail')).toBeUndefined();
  });

  it('returns undefined for an object entry with no restriction', () => {
    expect(
      getPluginConnectorIds([{ identifier: 'gmail', mode: 'pinned' }], 'gmail'),
    ).toBeUndefined();
  });

  it('returns the restricted ids when present', () => {
    expect(
      getPluginConnectorIds([{ connectorIds: ['conn-1', 'conn-2'], identifier: 'gmail' }], 'gmail'),
    ).toEqual(['conn-1', 'conn-2']);
  });

  it('normalizes an empty restriction back to all-connections', () => {
    expect(
      getPluginConnectorIds([{ connectorIds: [], identifier: 'gmail' }], 'gmail'),
    ).toBeUndefined();
  });

  it('resolves within a mixed-shape array', () => {
    const plugins = [
      'legacy-a',
      { connectorIds: ['conn-x'], identifier: 'gmail', mode: 'pinned' as const },
      { identifier: 'notion', mode: 'disabled' as const },
    ];

    expect(getPluginConnectorIds(plugins, 'gmail')).toEqual(['conn-x']);
    expect(getPluginConnectorIds(plugins, 'legacy-a')).toBeUndefined();
    expect(getPluginConnectorIds(plugins, 'notion')).toBeUndefined();
  });
});

describe('getPluginMode', () => {
  it('returns auto when plugins is undefined', () => {
    expect(getPluginMode(undefined, 'web-search')).toBe('auto');
  });

  it('returns auto when the identifier is not present', () => {
    expect(getPluginMode(['a', 'b'], 'web-search')).toBe('auto');
  });

  it('returns pinned for a legacy string entry', () => {
    expect(getPluginMode(['web-search'], 'web-search')).toBe('pinned');
  });

  it('returns the explicit mode for an object entry', () => {
    expect(getPluginMode([{ identifier: 'web-search', mode: 'disabled' }], 'web-search')).toBe(
      'disabled',
    );
  });

  it('resolves correctly within a mixed-shape array', () => {
    const plugins = [
      'legacy-a',
      { identifier: 'disabled-b', mode: 'disabled' as const },
      { identifier: 'pinned-c', mode: 'pinned' as const },
    ];

    expect(getPluginMode(plugins, 'legacy-a')).toBe('pinned');
    expect(getPluginMode(plugins, 'disabled-b')).toBe('disabled');
    expect(getPluginMode(plugins, 'pinned-c')).toBe('pinned');
    expect(getPluginMode(plugins, 'not-there')).toBe('auto');
  });
});

describe('getPinnedPluginIds / getDisabledPluginIds / getActivePluginIds', () => {
  const plugins = [
    'legacy-a',
    { identifier: 'disabled-b', mode: 'disabled' as const },
    { identifier: 'pinned-c', mode: 'pinned' as const },
    { identifier: 'auto-d', mode: 'auto' as const },
  ];

  it('collects pinned identifiers, including legacy strings and mode-less objects', () => {
    expect(getPinnedPluginIds(plugins)).toEqual(['legacy-a', 'pinned-c']);
  });

  it('collects disabled identifiers', () => {
    expect(getDisabledPluginIds(plugins)).toEqual(['disabled-b']);
  });

  it('getActivePluginIds mirrors getPinnedPluginIds', () => {
    expect(getActivePluginIds(plugins)).toEqual(getPinnedPluginIds(plugins));
  });

  it('returns an empty array for undefined input', () => {
    expect(getPinnedPluginIds(undefined)).toEqual([]);
    expect(getDisabledPluginIds(undefined)).toEqual([]);
    expect(getActivePluginIds(undefined)).toEqual([]);
  });
});

describe('upsertPluginMode', () => {
  it('appends a new object entry when the identifier is absent', () => {
    expect(upsertPluginMode(['a'], 'b', 'disabled')).toEqual([
      'a',
      { identifier: 'b', mode: 'disabled' },
    ]);
  });

  it('updates an existing object entry in place, preserving other fields', () => {
    const plugins = [{ identifier: 'a', mode: 'pinned' as const, extra: 'keep-me' } as any];

    expect(upsertPluginMode(plugins, 'a', 'disabled')).toEqual([
      { identifier: 'a', mode: 'disabled', extra: 'keep-me' },
    ]);
  });

  it('preserves connectorIds when only the mode changes', () => {
    const plugins = [{ connectorIds: ['conn-1'], identifier: 'gmail', mode: 'pinned' as const }];

    expect(upsertPluginMode(plugins, 'gmail', 'disabled')).toEqual([
      { connectorIds: ['conn-1'], identifier: 'gmail', mode: 'disabled' },
    ]);
  });

  it('upgrades a touched legacy string entry to an object, leaving others as strings', () => {
    const plugins = ['a', 'b', 'c'];

    expect(upsertPluginMode(plugins, 'b', 'disabled')).toEqual([
      'a',
      { identifier: 'b', mode: 'disabled' },
      'c',
    ]);
  });

  it('never mutates the input array', () => {
    const plugins = ['a', 'b'];
    const result = upsertPluginMode(plugins, 'a', 'disabled');

    expect(plugins).toEqual(['a', 'b']);
    expect(result).not.toBe(plugins);
  });

  it('handles undefined input by creating a new array', () => {
    expect(upsertPluginMode(undefined, 'a', 'pinned')).toEqual([
      { identifier: 'a', mode: 'pinned' },
    ]);
  });

  it('removes the entry (legacy string or object) when set to auto, instead of persisting it', () => {
    expect(upsertPluginMode(['a', 'b'], 'a', 'auto')).toEqual(['b']);
    expect(
      upsertPluginMode([{ identifier: 'a', mode: 'disabled' as const }, 'b'], 'a', 'auto'),
    ).toEqual(['b']);
  });

  it('is a no-op when setting auto on an identifier that is already absent', () => {
    expect(upsertPluginMode(['a'], 'not-there', 'auto')).toEqual(['a']);
  });
});
