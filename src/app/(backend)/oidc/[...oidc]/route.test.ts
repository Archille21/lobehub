/**
 * @vitest-environment node
 */
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createNodeRequest: vi.fn(),
  createNodeResponse: vi.fn(),
  getUserAuth: vi.fn(),
  middleware: vi.fn(),
  providerCallback: vi.fn(),
  reconcileInteractionAccount: vi.fn(),
  reconcileCurrentOIDCSession: vi.fn(),
}));

vi.mock('debug', () => ({
  default: () => vi.fn(),
}));

vi.mock('@/envs/auth', () => ({
  authEnv: {
    ENABLE_OIDC: true,
  },
}));

vi.mock('@lobechat/database', () => ({
  serverDB: { id: 'server-db' },
}));

vi.mock('@lobechat/utils/server', () => ({
  getUserAuth: mocks.getUserAuth,
}));

vi.mock('@/libs/oidc-provider/http-adapter', () => ({
  createNodeRequest: mocks.createNodeRequest,
  createNodeResponse: mocks.createNodeResponse,
}));

vi.mock('@/libs/oidc-provider/session-cleanup', () => ({
  reconcileCurrentOIDCSession: mocks.reconcileCurrentOIDCSession,
}));

vi.mock('@/server/services/oidc', () => ({
  OIDCService: class {
    reconcileInteractionAccount = mocks.reconcileInteractionAccount;
  },
}));

vi.mock('@/server/services/oidc/oidcProvider', () => ({
  getOIDCProvider: vi.fn(async () => ({
    callback: mocks.providerCallback,
  })),
}));

describe('OIDC route', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.providerCallback.mockReturnValue(mocks.middleware);
    mocks.middleware.mockImplementation(
      (_request: unknown, _response: unknown, next: (error?: Error) => void) => next(),
    );
    mocks.createNodeRequest.mockResolvedValue({});
    mocks.createNodeResponse.mockReturnValue({
      nodeResponse: {},
      responseBody: '',
      responseHeaders: {},
      responseStatus: 200,
    });
    mocks.getUserAuth.mockResolvedValue({ userId: undefined });
    mocks.reconcileInteractionAccount.mockResolvedValue('matched');
    mocks.reconcileCurrentOIDCSession.mockResolvedValue({ status: 'missing' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reconciles the current browser session before an authorization request', async () => {
    mocks.getUserAuth.mockResolvedValueOnce({ userId: 'user-b' });
    mocks.reconcileCurrentOIDCSession.mockResolvedValueOnce({
      reason: 'account_mismatch',
      status: 'recovered',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { GET } = await import('./route');
    const getCookie = vi.fn((name: string) =>
      name === '_session' ? { value: 'oidc-session-a' } : undefined,
    );
    const request = {
      cookies: { get: getCookie },
      method: 'GET',
      url: 'https://example.com/oidc/auth?client_id=client-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.reconcileCurrentOIDCSession).toHaveBeenCalledWith(
      { id: 'server-db' },
      'user-b',
      expect.objectContaining({ getCookie: expect.any(Function) }),
    );
    const cookieReader = mocks.reconcileCurrentOIDCSession.mock.calls[0][2];
    expect(cookieReader.getCookie('_session')).toBe('oidc-session-a');
    expect(mocks.middleware).toHaveBeenCalledTimes(1);
  });

  it('replaces a stale interaction result before resuming authorization', async () => {
    mocks.getUserAuth.mockResolvedValueOnce({ userId: 'user-b' });
    mocks.reconcileInteractionAccount.mockResolvedValueOnce('recovered');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { GET } = await import('./route');
    const request = {
      cookies: { get: vi.fn() },
      method: 'GET',
      url: 'https://example.com/oidc/auth/interaction-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.reconcileInteractionAccount).toHaveBeenCalledWith('interaction-1', 'user-b');
    expect(mocks.reconcileCurrentOIDCSession).not.toHaveBeenCalled();
    expect(mocks.middleware).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the authorization account check fails', async () => {
    mocks.getUserAuth.mockRejectedValueOnce(new Error('auth unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { GET } = await import('./route');
    const request = {
      cookies: { get: vi.fn() },
      method: 'GET',
      url: 'https://example.com/oidc/auth?client_id=client-1',
    } as unknown as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'temporarily_unavailable',
      error_description: 'OIDC authorization is temporarily unavailable',
    });
    expect(mocks.providerCallback).not.toHaveBeenCalled();
  });

  it('returns a 500 response when creating the Node request fails', async () => {
    mocks.createNodeRequest.mockRejectedValueOnce(new Error('body stream aborted'));

    const { POST } = await import('./route');
    const request = new Request('https://example.com/oidc/token', {
      body: 'grant_type=refresh_token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      method: 'POST',
    }) as unknown as NextRequest;

    const response = await Promise.race([
      POST(request),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('OIDC route timed out')), 50),
      ),
    ]);

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain('body stream aborted');
    expect(mocks.middleware).not.toHaveBeenCalled();
  });
});
