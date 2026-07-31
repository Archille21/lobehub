import { oidcSessions } from '@lobechat/database/schemas';
import Keygrip from 'keygrip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OIDC_SESSION_COOKIE_NAMES } from './cookies';
import {
  clearCurrentOIDCSession,
  clearMismatchedOIDCSession,
  reconcileCurrentOIDCSession,
} from './session-cleanup';

const TEST_COOKIE_KEY = 'test-cookie-key';

vi.mock('@/config/db', () => ({
  serverDBEnv: { KEY_VAULTS_SECRET: 'test-cookie-key' },
}));

const signSessionCookie = (sessionId: string) =>
  new Keygrip([TEST_COOKIE_KEY]).sign(`_session=${sessionId}`);

const createDb = (sessions: Array<{ userId: string }>) => {
  const limit = vi.fn().mockResolvedValue(sessions);
  const selectWhere = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: selectWhere }));
  const deleteWhere = vi.fn().mockResolvedValue({ rowCount: 1 });
  const delete_ = vi.fn(() => ({ where: deleteWhere }));

  return {
    db: {
      delete: delete_,
      select: vi.fn(() => ({ from })),
    },
    delete_,
    deleteWhere,
  };
};

const createCookieContext = (
  sessionId: string | null,
  signature = sessionId ? signSessionCookie(sessionId) : null,
) => ({
  getCookie: vi.fn((name: string) => {
    if (name === '_session') return sessionId;
    if (name === '_session.sig') return signature;
    return null;
  }),
  setCookie: vi.fn(),
});

describe('reconcileCurrentOIDCSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes the current browser session when it belongs to another user', async () => {
    const { db, delete_, deleteWhere } = createDb([{ userId: 'user-a' }]);
    const context = createCookieContext('oidc-session-a');

    const result = await reconcileCurrentOIDCSession(
      db as unknown as Parameters<typeof reconcileCurrentOIDCSession>[0],
      'user-b',
      context,
    );

    expect(result).toEqual({ reason: 'account_mismatch', status: 'recovered' });
    expect(delete_).toHaveBeenCalledWith(oidcSessions);
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(context.setCookie).not.toHaveBeenCalled();
  });

  it('preserves a session that already belongs to the active user', async () => {
    const { db, delete_ } = createDb([{ userId: 'user-a' }]);
    const context = createCookieContext('oidc-session-a');

    const result = await reconcileCurrentOIDCSession(
      db as unknown as Parameters<typeof reconcileCurrentOIDCSession>[0],
      'user-a',
      context,
    );

    expect(result).toEqual({ status: 'matched' });
    expect(delete_).not.toHaveBeenCalled();
  });

  it('recovers an invalid signed cookie without an active user', async () => {
    const { db, delete_ } = createDb([{ userId: 'user-a' }]);
    const context = createCookieContext('oidc-session-a', 'invalid-signature');

    const result = await reconcileCurrentOIDCSession(
      db as unknown as Parameters<typeof reconcileCurrentOIDCSession>[0],
      undefined,
      context,
    );

    expect(result).toEqual({ reason: 'invalid_cookie', status: 'recovered' });
    expect(db.select).not.toHaveBeenCalled();
    expect(delete_).not.toHaveBeenCalled();
  });

  it('recovers a dangling session without an active user', async () => {
    const { db, delete_ } = createDb([]);
    const context = createCookieContext('missing-session');

    const result = await reconcileCurrentOIDCSession(
      db as unknown as Parameters<typeof reconcileCurrentOIDCSession>[0],
      undefined,
      context,
    );

    expect(result).toEqual({ reason: 'dangling_session', status: 'recovered' });
    expect(delete_).not.toHaveBeenCalled();
  });

  it('leaves an existing session unverified when there is no active user', async () => {
    const { db, delete_ } = createDb([{ userId: 'user-a' }]);
    const context = createCookieContext('oidc-session-a');

    const result = await reconcileCurrentOIDCSession(
      db as unknown as Parameters<typeof reconcileCurrentOIDCSession>[0],
      undefined,
      context,
    );

    expect(result).toEqual({ status: 'unverified' });
    expect(delete_).not.toHaveBeenCalled();
  });
});

describe('clearMismatchedOIDCSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears another user session from the current browser before sign-in', async () => {
    const { db, delete_, deleteWhere } = createDb([{ userId: 'user-a' }]);
    const context = createCookieContext('oidc-session-a');

    const cleared = await clearMismatchedOIDCSession(
      db as unknown as Parameters<typeof clearMismatchedOIDCSession>[0],
      'user-b',
      context,
    );

    expect(cleared).toBe(true);
    expect(delete_).toHaveBeenCalledWith(oidcSessions);
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(context.setCookie).toHaveBeenCalledTimes(OIDC_SESSION_COOKIE_NAMES.length);
    for (const name of OIDC_SESSION_COOKIE_NAMES) {
      expect(context.setCookie).toHaveBeenCalledWith(name, '', {
        expires: new Date(0),
        httpOnly: true,
        path: '/',
      });
    }
  });

  it('preserves the current browser session when the user is unchanged', async () => {
    const { db, delete_ } = createDb([{ userId: 'user-a' }]);
    const context = createCookieContext('oidc-session-a');

    const cleared = await clearMismatchedOIDCSession(
      db as unknown as Parameters<typeof clearMismatchedOIDCSession>[0],
      'user-a',
      context,
    );

    expect(cleared).toBe(false);
    expect(delete_).not.toHaveBeenCalled();
    expect(context.setCookie).not.toHaveBeenCalled();
  });

  it('expires a dangling session cookie when its database row no longer exists', async () => {
    const { db, delete_ } = createDb([]);
    const context = createCookieContext('missing-session');

    const cleared = await clearMismatchedOIDCSession(
      db as unknown as Parameters<typeof clearMismatchedOIDCSession>[0],
      'user-b',
      context,
    );

    expect(cleared).toBe(true);
    expect(delete_).not.toHaveBeenCalled();
    expect(context.setCookie).toHaveBeenCalledTimes(OIDC_SESSION_COOKIE_NAMES.length);
  });

  it('does not delete a database row when the session cookie signature is invalid', async () => {
    const { db, delete_ } = createDb([{ userId: 'user-a' }]);
    const context = createCookieContext('oidc-session-a', 'invalid-signature');

    const cleared = await clearMismatchedOIDCSession(
      db as unknown as Parameters<typeof clearMismatchedOIDCSession>[0],
      'user-b',
      context,
    );

    expect(cleared).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
    expect(delete_).not.toHaveBeenCalled();
    expect(context.setCookie).toHaveBeenCalledTimes(OIDC_SESSION_COOKIE_NAMES.length);
  });
});

describe('clearCurrentOIDCSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the signed OIDC session referenced by the current browser', async () => {
    const { db, delete_, deleteWhere } = createDb([]);
    const context = createCookieContext('oidc-session-a');

    const cleared = await clearCurrentOIDCSession(
      db as unknown as Parameters<typeof clearCurrentOIDCSession>[0],
      context,
    );

    expect(cleared).toBe(true);
    expect(delete_).toHaveBeenCalledWith(oidcSessions);
    expect(deleteWhere).toHaveBeenCalledOnce();
    expect(context.setCookie).toHaveBeenCalledTimes(OIDC_SESSION_COOKIE_NAMES.length);
  });

  it('expires an invalid cookie without deleting an untrusted session identifier', async () => {
    const { db, delete_ } = createDb([]);
    const context = createCookieContext('oidc-session-a', 'invalid-signature');

    const cleared = await clearCurrentOIDCSession(
      db as unknown as Parameters<typeof clearCurrentOIDCSession>[0],
      context,
    );

    expect(cleared).toBe(false);
    expect(delete_).not.toHaveBeenCalled();
    expect(context.setCookie).toHaveBeenCalledTimes(OIDC_SESSION_COOKIE_NAMES.length);
  });
});
