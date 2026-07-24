import { describe, expect, it } from 'vitest';

import { normalizeAppOrigin } from './normalizeAppOrigin';

describe('normalizeAppOrigin', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['https://example.com///', 'https://example.com'],
    ['http://localhost:3210/', 'http://localhost:3210'],
  ])('normalizes %s', (origin, expected) => {
    expect(normalizeAppOrigin(origin)).toBe(expected);
  });
});
