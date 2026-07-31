/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findOrCreateGrants: vi.fn(),
  getInteractionDetails: vi.fn(),
  getInteractionResult: vi.fn(),
  getUserAuth: vi.fn(),
  initialize: vi.fn(),
}));

vi.mock('debug', () => ({
  default: () => vi.fn(),
}));

vi.mock('@lobechat/utils/server', () => ({
  getUserAuth: mocks.getUserAuth,
}));

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://example.com' },
}));

vi.mock('@/server/services/oidc', () => ({
  OIDCService: {
    initialize: mocks.initialize,
  },
}));

const createConsentRequest = () =>
  new Request('https://example.com/oidc/consent', {
    body: new URLSearchParams({ consent: 'accept', uid: 'interaction-1' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  }) as unknown as NextRequest;

describe('OIDC consent route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initialize.mockResolvedValue({
      findOrCreateGrants: mocks.findOrCreateGrants,
      getInteractionDetails: mocks.getInteractionDetails,
      getInteractionResult: mocks.getInteractionResult,
    });
    mocks.getUserAuth.mockResolvedValue({ userId: 'user-b' });
    mocks.getInteractionResult.mockResolvedValue(
      'https://oidc.example.com/oidc/auth/interaction-1',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates the provider session instead of creating a grant for another account', async () => {
    mocks.getInteractionDetails.mockResolvedValue({
      grantId: 'grant-a',
      params: { client_id: 'client-1' },
      prompt: { details: {}, name: 'consent' },
      session: { accountId: 'user-a' },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { POST } = await import('./route');
    const response = await POST(createConsentRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://example.com/oidc/auth/interaction-1');
    expect(mocks.findOrCreateGrants).not.toHaveBeenCalled();
    expect(mocks.getInteractionResult).toHaveBeenCalledWith('interaction-1', {
      login: { accountId: 'user-b', remember: true },
    });
  });

  it('creates the consent grant only when the provider session matches the active user', async () => {
    const grant = {
      addOIDCClaims: vi.fn(),
      addOIDCScope: vi.fn(),
      addResourceScope: vi.fn(),
      save: vi.fn().mockResolvedValue('grant-b'),
    };
    mocks.findOrCreateGrants.mockResolvedValue(grant);
    mocks.getInteractionDetails.mockResolvedValue({
      grantId: 'grant-b',
      params: { client_id: 'client-1' },
      prompt: {
        details: {
          missingOIDCClaims: ['email'],
          missingOIDCScope: ['openid'],
          missingResourceScopes: {},
        },
        name: 'consent',
      },
      session: { accountId: 'user-b' },
    });

    const { POST } = await import('./route');
    const response = await POST(createConsentRequest());

    expect(response.status).toBe(303);
    expect(mocks.findOrCreateGrants).toHaveBeenCalledWith('user-b', 'client-1', 'grant-b');
    expect(mocks.getInteractionResult).toHaveBeenCalledWith('interaction-1', {
      consent: { grantId: 'grant-b' },
    });
  });

  it('fails closed when the application session is missing', async () => {
    mocks.getInteractionDetails.mockResolvedValue({
      params: { client_id: 'client-1' },
      prompt: { details: {}, name: 'consent' },
      session: { accountId: 'user-a' },
    });
    mocks.getUserAuth.mockResolvedValue({ userId: undefined });

    const { POST } = await import('./route');
    const response = await POST(createConsentRequest());

    expect(response.status).toBe(401);
    expect(mocks.findOrCreateGrants).not.toHaveBeenCalled();
    expect(mocks.getInteractionResult).not.toHaveBeenCalled();
  });
});
