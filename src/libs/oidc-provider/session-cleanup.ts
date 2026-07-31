import type { LobeChatDatabase } from '@lobechat/database';
import { oidcSessions } from '@lobechat/database/schemas';
import { eq } from 'drizzle-orm';

import {
  OIDC_SESSION_COOKIE_NAME,
  OIDC_SESSION_COOKIE_NAMES,
  verifyOIDCCookieSignature,
} from './cookies';

export interface OIDCSessionCookieReader {
  getCookie: (name: string) => string | null;
}

export interface OIDCSessionCookieContext extends OIDCSessionCookieReader {
  setCookie: (
    name: string,
    value: string,
    options: { expires: Date; httpOnly: boolean; path: string },
  ) => unknown;
}

type OIDCSessionCookieResult =
  { status: 'invalid' } | { status: 'missing' } | { sessionId: string; status: 'valid' };

export type OIDCSessionReconciliationResult =
  | { status: 'matched' }
  | { status: 'missing' }
  | { status: 'unverified' }
  | {
      reason: 'account_mismatch' | 'dangling_session' | 'invalid_cookie';
      status: 'recovered';
    };

const expireOIDCSessionCookies = (context: OIDCSessionCookieContext) => {
  for (const name of OIDC_SESSION_COOKIE_NAMES) {
    context.setCookie(name, '', {
      expires: new Date(0),
      httpOnly: true,
      path: '/',
    });
  }
};

const getOIDCSessionCookie = (context: OIDCSessionCookieReader): OIDCSessionCookieResult => {
  const sessionId = context.getCookie(OIDC_SESSION_COOKIE_NAME);
  if (!sessionId) return { status: 'missing' };

  const signature = context.getCookie(`${OIDC_SESSION_COOKIE_NAME}.sig`);
  if (!signature || !verifyOIDCCookieSignature(OIDC_SESSION_COOKIE_NAME, sessionId, signature)) {
    return { status: 'invalid' };
  }

  return { sessionId, status: 'valid' };
};

/**
 * Reconciles the OIDC session referenced by the current browser with the active application user.
 *
 * Deleting only the persisted session is intentional for authorization requests: oidc-provider
 * treats the still-signed cookie as a missing session, rotates it through its own middleware, and
 * restarts login without carrying the previous account binding into code or token issuance.
 * Without an active user, invalid or dangling sessions can still recover safely, while an existing
 * account-bound session remains untouched and is reported as unverified.
 */
export const reconcileCurrentOIDCSession = async (
  db: LobeChatDatabase,
  userId: string | undefined,
  context: OIDCSessionCookieReader,
  onRecovery?: () => void,
): Promise<OIDCSessionReconciliationResult> => {
  const cookie = getOIDCSessionCookie(context);
  if (cookie.status === 'missing') return { status: 'missing' };

  if (cookie.status === 'invalid') {
    onRecovery?.();
    return { reason: 'invalid_cookie', status: 'recovered' };
  }

  const [session] = await db
    .select({ userId: oidcSessions.userId })
    .from(oidcSessions)
    .where(eq(oidcSessions.id, cookie.sessionId))
    .limit(1);

  if (!session) {
    onRecovery?.();
    return { reason: 'dangling_session', status: 'recovered' };
  }

  if (!userId) return { status: 'unverified' };
  if (session.userId === userId) return { status: 'matched' };

  await db.delete(oidcSessions).where(eq(oidcSessions.id, cookie.sessionId));
  onRecovery?.();
  return { reason: 'account_mismatch', status: 'recovered' };
};

/**
 * Clears the signed OIDC session referenced by the current browser.
 */
export const clearCurrentOIDCSession = async (
  db: LobeChatDatabase,
  context: OIDCSessionCookieContext,
) => {
  const cookie = getOIDCSessionCookie(context);
  if (cookie.status === 'invalid') {
    expireOIDCSessionCookies(context);
    return false;
  }
  if (cookie.status === 'missing') return false;

  await db.delete(oidcSessions).where(eq(oidcSessions.id, cookie.sessionId));
  expireOIDCSessionCookies(context);

  return true;
};

/**
 * Clears a stale OIDC session before Better Auth establishes a different user session.
 *
 * Only the session referenced by the current browser is removed. Sessions on other devices and
 * persistent grants remain untouched.
 */
export const clearMismatchedOIDCSession = async (
  db: LobeChatDatabase,
  userId: string,
  context: OIDCSessionCookieContext | null,
) => {
  if (!context) return false;

  const result = await reconcileCurrentOIDCSession(db, userId, context, () =>
    expireOIDCSessionCookies(context),
  );
  return result.status === 'recovered';
};
