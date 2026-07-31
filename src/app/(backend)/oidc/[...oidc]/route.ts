import { URL } from 'node:url';

import { serverDB } from '@lobechat/database';
import { getUserAuth } from '@lobechat/utils/server';
import debug from 'debug';
import { type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { authEnv } from '@/envs/auth';
import { createNodeRequest, createNodeResponse } from '@/libs/oidc-provider/http-adapter';
import { reconcileCurrentOIDCSession } from '@/libs/oidc-provider/session-cleanup';
import { OIDCService } from '@/server/services/oidc';
import { getOIDCProvider } from '@/server/services/oidc/oidcProvider';

const log = debug('lobe-oidc:route'); // Create a debug instance with a namespace

const AUTHORIZATION_PATH = /^\/oidc\/auth\/?$/;
const AUTHORIZATION_RESUME_PATH = /^\/oidc\/auth\/([^/]+)\/?$/;

type AuthorizationStage = { name: 'authorization' } | { name: 'resume'; uid: string };

const getAuthorizationStage = (pathname: string): AuthorizationStage | null => {
  if (AUTHORIZATION_PATH.test(pathname)) return { name: 'authorization' };

  const resumeMatch = AUTHORIZATION_RESUME_PATH.exec(pathname);
  return resumeMatch ? { name: 'resume', uid: resumeMatch[1] } : null;
};

const handler = async (req: NextRequest) => {
  const requestUrl = new URL(req.url);
  log(`Received ${req.method.toUpperCase()} request: %s %s`, req.method, req.url);
  log('Path: %s, Pathname: %s', requestUrl.pathname, requestUrl.pathname);

  // Declare the response collector
  let responseCollector;

  try {
    if (!authEnv.ENABLE_OIDC) {
      log('OIDC is not enabled');
      return new NextResponse('OIDC is not enabled', { status: 404 });
    }

    // Get the OIDC Provider instance
    const provider = await getOIDCProvider();

    const authorizationStage = getAuthorizationStage(requestUrl.pathname);
    if (authorizationStage) {
      try {
        const { userId } = await getUserAuth();
        if (userId) {
          const reconciliation =
            authorizationStage.name === 'authorization'
              ? await reconcileCurrentOIDCSession(serverDB, userId, {
                  getCookie: (name) => req.cookies.get(name)?.value ?? null,
                })
              : await new OIDCService(provider).reconcileInteractionAccount(
                  authorizationStage.uid,
                  userId,
                );

          if (reconciliation === 'recovered') {
            console.warn(
              `[OIDC Account Guard] recovered path=${authorizationStage.name} reason=account_mismatch`,
            );
          } else if (typeof reconciliation !== 'string' && reconciliation.status === 'recovered') {
            console.warn(
              `[OIDC Account Guard] recovered path=${authorizationStage.name} reason=${reconciliation.reason}`,
            );
          } else {
            const status =
              typeof reconciliation === 'string' ? reconciliation : reconciliation.status;
            log('[OIDC Account Guard] %s path=%s', status, authorizationStage.name);
          }
        } else {
          log('[OIDC Account Guard] missing_app_session path=%s', authorizationStage.name);
        }
      } catch (error) {
        /**
         * An unverified account binding must not reach oidc-provider because a stale session can
         * otherwise issue a code or token for the previous browser account without an interaction.
         */
        console.error(
          `[OIDC Account Guard] recovery_failed path=${authorizationStage.name}`,
          error,
        );
        return NextResponse.json(
          {
            error: 'temporarily_unavailable',
            error_description: 'OIDC authorization is temporarily unavailable',
          },
          { status: 503 },
        );
      }
    }

    log(`Calling provider.callback() for ${req.method}`); // Log the method
    await new Promise<void>((resolve, reject) => {
      // <-- Make promise callback async
      let middleware: any;
      try {
        log('Attempting to get middleware from provider.callback()');
        middleware = provider.callback();
        log('Successfully obtained middleware function.');
      } catch (syncError) {
        log('SYNC ERROR during provider.callback() call itself: %O', syncError);
        reject(syncError);
        return;
      }

      // Use helper method to create the response collector
      responseCollector = createNodeResponse(resolve);
      const nodeResponse = responseCollector.nodeResponse;

      // Use helper method to create the Node.js request object, now requires await
      createNodeRequest(req).then((nodeRequest) => {
        log('Calling the obtained middleware...');
        middleware(nodeRequest, nodeResponse, (error?: Error) => {
          log('Middleware callback function HAS BEEN EXECUTED.');
          if (error) {
            log('Middleware error reported via callback: %O', error);
            reject(error);
          } else {
            log(
              'Middleware completed successfully via callback (may be redundant if .end() was called).',
            );
            resolve();
          }
        });
        log('Middleware call initiated, waiting for its callback OR nodeResponse.end()...');
      }, reject);
    });

    log('Promise surrounding middleware call resolved.');

    // Access the final response status
    if (!responseCollector) {
      throw new Error('ResponseCollector was not initialized.');
    }

    const {
      responseStatus: finalStatus,
      responseBody: finalBody,
      responseHeaders: finalHeaders,
    } = responseCollector;

    log('Final Response Status: %d', finalStatus);
    log('Final Response Headers: %O', finalHeaders);

    return new NextResponse(finalBody, {
      headers: finalHeaders as HeadersInit,
      status: finalStatus,
    });
  } catch (error) {
    // Surface the real stack to production logs. A debug `log()` only writes to the
    // `lobe-oidc:route` namespace, which is disabled in production, so 500s otherwise
    // land with no application-layer error signature (monitoring blind spot).
    console.error(`[OIDC Route] Error handling ${req.method} ${requestUrl.pathname}:`, error);
    return new NextResponse(`Internal Server Error: ${(error as Error).message}`, { status: 500 });
  }
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const PATCH = handler;
