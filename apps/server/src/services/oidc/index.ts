import { getServerDB } from '@lobechat/database';
import { oidcClients, users } from '@lobechat/database/schemas';
import debug from 'debug';
import { eq } from 'drizzle-orm';

import { defaultClients } from '@/libs/oidc-provider/config';
import { createContextForInteractionDetails } from '@/libs/oidc-provider/http-adapter';
import { type OIDCProvider } from '@/libs/oidc-provider/provider';

import { getOIDCProvider } from './oidcProvider';

const log = debug('lobe-oidc:service');

const firstPartyClientIds = new Set(defaultClients.map((client) => client.client_id));

export interface ConsentClientMetadata {
  clientName?: string;
  developerName?: string;
  isFirstParty: boolean;
  logo?: string;
  policyUri?: string;
}

export class OIDCService {
  private provider: OIDCProvider;

  constructor(provider: OIDCProvider) {
    this.provider = provider;
  }
  static async initialize() {
    const provider = await getOIDCProvider();

    return new OIDCService(provider);
  }

  async getInteractionDetails(uid: string) {
    const { req, res } = await createContextForInteractionDetails(uid);
    return this.provider.interactionDetails(req, res);
  }

  async getInteractionResult(uid: string, result: any) {
    const { req, res } = await createContextForInteractionDetails(uid);
    return this.provider.interactionResult(req, res, result);
  }

  async finishInteraction(uid: string, result: any) {
    const { req, res } = await createContextForInteractionDetails(uid);
    return this.provider.interactionFinished(req, res, result, { mergeWithLastSubmission: true });
  }

  async reconcileInteractionAccount(uid: string, accountId: string) {
    const details = await this.getInteractionDetails(uid);
    const interactionAccountId = details.session?.accountId;

    if (!interactionAccountId) return 'missing';
    if (interactionAccountId === accountId) return 'matched';

    /**
     * Replacing a stale consent result with a login result delegates account switching to
     * oidc-provider's resume and end-session flow before it loads an account-bound grant.
     */
    await this.getInteractionResult(uid, {
      login: { accountId, remember: true },
    });
    return 'recovered';
  }

  async findOrCreateGrants(accountId: string, clientId: string, existingGrantId?: string) {
    // 2. Find or create Grant object
    let grant;
    if (existingGrantId) {
      // If a previous interaction step already associated a Grant
      grant = await this.provider.Grant.find(existingGrantId);
      log('Found existing grantId: %s', existingGrantId);
      if (grant) {
        /**
         * An interaction grant is already bound to its account and client. Replacing a mismatched
         * grant would hide a stale session binding and could destroy another account's grant.
         * Account recovery must rotate the OIDC session before consent reaches this method.
         */
        if (grant.accountId !== accountId) {
          throw new Error('OIDC grant account does not match the authorization session');
        }
        if (grant.clientId !== clientId) {
          throw new Error('OIDC grant client does not match the authorization request');
        }
      } else {
        log('Existing grantId %s not found in storage, will create a new grant', existingGrantId);
      }
    }

    if (!grant) {
      // If not found or no existingGrantId, create a new one
      grant = new this.provider.Grant({
        accountId,
        clientId,
      });
      log('Created new Grant for account %s and client %s', accountId, clientId);
    }

    return grant;
  }

  async getClientMetadata(clientId: string) {
    const client = await this.provider.Client.find(clientId);
    return client?.metadata();
  }

  async getConsentClientMetadata(clientId: string): Promise<ConsentClientMetadata> {
    const clientDetail = await this.getClientMetadata(clientId);
    const isFirstParty = firstPartyClientIds.has(clientId);

    const base: ConsentClientMetadata = {
      clientName: clientDetail?.client_name as string | undefined,
      isFirstParty,
      logo: clientDetail?.logo_uri as string | undefined,
      policyUri: clientDetail?.policy_uri as string | undefined,
    };

    if (isFirstParty) return base;

    const db = await getServerDB();
    const [record] = await db
      .select({
        name: oidcClients.name,
        policyUri: oidcClients.policyUri,
        userId: oidcClients.userId,
      })
      .from(oidcClients)
      .where(eq(oidcClients.id, clientId))
      .limit(1);

    if (!record) return base;

    let developerName: string | undefined;
    if (record.userId) {
      const [owner] = await db
        .select({ fullName: users.fullName, username: users.username })
        .from(users)
        .where(eq(users.id, record.userId))
        .limit(1);
      developerName = owner?.fullName || owner?.username || undefined;
    }

    return {
      clientName: base.clientName ?? record.name,
      developerName,
      isFirstParty: false,
      logo: base.logo,
      policyUri: base.policyUri ?? record.policyUri ?? undefined,
    };
  }
}

export { getOIDCProvider } from './oidcProvider';
