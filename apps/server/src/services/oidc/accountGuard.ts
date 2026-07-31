import { getServerDB } from '@lobechat/database';
import { getUserAuth } from '@lobechat/utils/server';

import { OIDC_SESSION_COOKIE_NAME } from '@/libs/oidc-provider/cookies';
import type { OIDCProvider } from '@/libs/oidc-provider/provider';
import type { OIDCSessionReconciliationResult } from '@/libs/oidc-provider/session-cleanup';
import { reconcileCurrentOIDCSession } from '@/libs/oidc-provider/session-cleanup';

import { OIDCService } from '.';

const AUTHORIZATION_PATH = /^\/oidc\/auth\/?$/;
const AUTHORIZATION_RESUME_PATH = /^\/oidc\/auth\/([^/]+)\/?$/;

type OIDCAccountGuardPath = 'authorization' | 'resume';
type OIDCRecoveryReason = Extract<
  OIDCSessionReconciliationResult,
  { status: 'recovered' }
>['reason'];

type OIDCAccountGuardResult =
  | {
      path: OIDCAccountGuardPath;
      status: 'matched' | 'missing' | 'missing_app_session';
    }
  | {
      path: OIDCAccountGuardPath;
      reason: OIDCRecoveryReason;
      status: 'recovered';
    };

interface GuardOIDCAuthorizationAccountParams {
  getCookie: (name: string) => string | null;
  pathname: string;
  provider: OIDCProvider;
}

type AuthorizationStage = { name: 'authorization' } | { name: 'resume'; uid: string };

const getAuthorizationStage = (pathname: string): AuthorizationStage | null => {
  if (AUTHORIZATION_PATH.test(pathname)) return { name: 'authorization' };

  const resumeMatch = AUTHORIZATION_RESUME_PATH.exec(pathname);
  return resumeMatch ? { name: 'resume', uid: resumeMatch[1] } : null;
};

/**
 * Verifies that the active application account owns the OIDC authorization session.
 */
export const guardOIDCAuthorizationAccount = async ({
  getCookie,
  pathname,
  provider,
}: GuardOIDCAuthorizationAccountParams): Promise<OIDCAccountGuardResult | null> => {
  const stage = getAuthorizationStage(pathname);
  if (!stage) return null;

  if (stage.name === 'authorization' && !getCookie(OIDC_SESSION_COOKIE_NAME)) {
    return { path: stage.name, status: 'missing' };
  }

  const { userId } = await getUserAuth();
  if (!userId) return { path: stage.name, status: 'missing_app_session' };

  if (stage.name === 'resume') {
    const status = await new OIDCService(provider).reconcileInteractionAccount(stage.uid, userId);

    return status === 'recovered'
      ? { path: stage.name, reason: 'account_mismatch', status }
      : { path: stage.name, status };
  }

  const db = await getServerDB();
  const result = await reconcileCurrentOIDCSession(db, userId, { getCookie });

  return { path: stage.name, ...result };
};
