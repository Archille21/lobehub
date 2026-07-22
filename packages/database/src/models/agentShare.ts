import type { ShareVisibility } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';

import type { AgentShareConfig } from '../schemas';
import { agents, agentShares } from '../schemas';
import type { LobeChatDatabase } from '../type';
import { normalizeInboxAgentAvatar, normalizeInboxAgentTitle } from '../utils/inboxAgent';
import { buildWorkspaceWhere } from '../utils/workspace';

export type AgentShareData = NonNullable<
  Awaited<ReturnType<(typeof AgentShareModel)['findByShareId']>>
>;

export class AgentShareModel {
  private userId: string;
  private db: LobeChatDatabase;
  private workspaceId?: string;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.userId = userId;
    this.db = db;
    this.workspaceId = workspaceId;
  }

  /**
   * agent_shares has no userId/workspaceId columns — ownership is derived from
   * the agent row. Resolve the agent through the workspace-aware predicate so
   * every mutating method shares the same access rule.
   */
  private findOwnedAgent = async (agentId: string) => {
    return this.db.query.agents.findFirst({
      where: and(
        eq(agents.id, agentId),
        buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, agents),
      ),
    });
  };

  /**
   * Create or get existing share for an agent.
   * Each agent can only have one share record (enforced by unique constraint).
   * If record already exists, returns the existing one.
   */
  create = async (agentId: string, visibility: ShareVisibility = 'private') => {
    const agent = await this.findOwnedAgent(agentId);

    if (!agent) {
      throw new Error('Agent not found or not owned by user');
    }

    const [result] = await this.db
      .insert(agentShares)
      .values({ agentId, visibility })
      .onConflictDoNothing({ target: agentShares.agentId })
      .returning();

    // If conflict occurred, return existing record
    if (!result) {
      return this.getByAgentId(agentId);
    }

    return result;
  };

  /**
   * Get share info by agent ID (for the owner)
   */
  getByAgentId = async (agentId: string) => {
    const agent = await this.findOwnedAgent(agentId);
    if (!agent) return null;

    const result = await this.db
      .select({
        agentId: agentShares.agentId,
        id: agentShares.id,
        shareConfig: agentShares.shareConfig,
        userViewCount: agentShares.userViewCount,
        visibility: agentShares.visibility,
      })
      .from(agentShares)
      .where(eq(agentShares.agentId, agentId))
      .limit(1);

    return result[0] || null;
  };

  /**
   * Replace the share config of an agent share.
   */
  updateConfig = async (agentId: string, config: AgentShareConfig) => {
    const agent = await this.findOwnedAgent(agentId);
    if (!agent) return null;

    const [result] = await this.db
      .update(agentShares)
      .set({ shareConfig: config, updatedAt: new Date() })
      .where(eq(agentShares.agentId, agentId))
      .returning();

    return result || null;
  };

  /**
   * Update share visibility
   */
  updateVisibility = async (agentId: string, visibility: ShareVisibility) => {
    const agent = await this.findOwnedAgent(agentId);
    if (!agent) return null;

    const [result] = await this.db
      .update(agentShares)
      .set({ updatedAt: new Date(), visibility })
      .where(eq(agentShares.agentId, agentId))
      .returning();

    return result || null;
  };

  /**
   * Delete a share by agent ID
   */
  deleteByAgentId = async (agentId: string) => {
    const agent = await this.findOwnedAgent(agentId);
    if (!agent) return;

    return this.db.delete(agentShares).where(eq(agentShares.agentId, agentId));
  };

  /**
   * Find shared agent by share ID.
   * Returns share info including ownerId for permission checking by caller.
   */
  static findByShareId = async (db: LobeChatDatabase, shareId: string) => {
    const result = await db
      .select({
        agentAvatar: agents.avatar,
        agentBackgroundColor: agents.backgroundColor,
        agentDescription: agents.description,
        agentId: agentShares.agentId,
        agentMarketIdentifier: agents.marketIdentifier,
        agentSlug: agents.slug,
        agentTitle: agents.title,
        ownerId: agents.userId,
        shareConfig: agentShares.shareConfig,
        shareId: agentShares.id,
        userViewCount: agentShares.userViewCount,
        visibility: agentShares.visibility,
        workspaceId: agents.workspaceId,
      })
      .from(agentShares)
      .innerJoin(agents, eq(agentShares.agentId, agents.id))
      .where(eq(agentShares.id, shareId))
      .limit(1);

    if (!result[0]) return null;

    const share = result[0];

    return {
      ...share,
      agentAvatar: normalizeInboxAgentAvatar(share.agentAvatar, { slug: share.agentSlug }),
      agentTitle: normalizeInboxAgentTitle(share.agentTitle, { slug: share.agentSlug }),
    };
  };

  /**
   * Increment unique visitor count for a share.
   * Should be called by the application layer when a new visitor session starts.
   */
  static incrementUserViewCount = async (db: LobeChatDatabase, shareId: string) => {
    await db
      .update(agentShares)
      .set({ userViewCount: sql`${agentShares.userViewCount} + 1` })
      .where(eq(agentShares.id, shareId));
  };

  /**
   * Find shared agent by share ID with visibility check.
   * Throws TRPCError if access is denied.
   */
  static findByShareIdWithAccessCheck = async (
    db: LobeChatDatabase,
    shareId: string,
    accessUserId?: string,
  ): Promise<AgentShareData> => {
    const share = await AgentShareModel.findByShareId(db, shareId);

    if (!share) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Share not found' });
    }

    const isOwner = accessUserId && share.ownerId === accessUserId;

    // Only check visibility for non-owners
    // 'private' - only the agent creator can view
    // 'link' - anyone with the link can view
    if (!isOwner && share.visibility === 'private') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'This share is private' });
    }

    return share;
  };
}
