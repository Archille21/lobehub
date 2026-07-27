import { INBOX_SESSION_ID } from '@lobechat/const';
import type { AgentPluginEntry, SkillItem, SkillListItem } from '@lobechat/types';
import { getPluginMode, upsertPluginMode } from '@lobechat/types';
import { merge } from '@lobechat/utils';
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';

import type { NewAgentSkill } from '../schemas';
import { agents, agentSkills } from '../schemas';
import type { LobeChatDatabase } from '../type';
import { buildWorkspacePayload, buildWorkspaceWhere } from '../utils/workspace';

const skillItemColumns = {
  content: agentSkills.content,
  createdAt: agentSkills.createdAt,
  description: agentSkills.description,
  editorData: agentSkills.editorData,
  id: agentSkills.id,
  identifier: agentSkills.identifier,
  manifest: agentSkills.manifest,
  name: agentSkills.name,
  resources: agentSkills.resources,
  source: agentSkills.source,
  updatedAt: agentSkills.updatedAt,
  // Creator attribution — row-level ownership checks in workspace mode.
  userId: agentSkills.userId,
  zipFileHash: agentSkills.zipFileHash,
};

const skillListColumns = {
  createdAt: agentSkills.createdAt,
  description: agentSkills.description,
  id: agentSkills.id,
  identifier: agentSkills.identifier,
  manifest: agentSkills.manifest,
  name: agentSkills.name,
  source: agentSkills.source,
  updatedAt: agentSkills.updatedAt,
  // Creator attribution — row-level ownership checks in workspace mode.
  userId: agentSkills.userId,
  zipFileHash: agentSkills.zipFileHash,
};

export class AgentSkillModel {
  private userId: string;
  private workspaceId?: string;
  private db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string, workspaceId?: string) {
    this.db = db;
    this.userId = userId;
    this.workspaceId = workspaceId;
  }

  private scopeWhere = () =>
    buildWorkspaceWhere({ userId: this.userId, workspaceId: this.workspaceId }, agentSkills);

  // Workspace skills are shared, so initialize every agent in the workspace,
  // including private agents owned by other members.
  private agentScopeWhere = () =>
    buildWorkspaceWhere(
      { userId: this.userId, workspaceId: this.workspaceId },
      { userId: agents.userId, workspaceId: agents.workspaceId },
    );

  // ========== Create ==========

  create = async (data: Omit<NewAgentSkill, 'userId' | 'workspaceId'>): Promise<SkillItem> => {
    return this.db.transaction(async (trx) => {
      const [result] = await trx
        .insert(agentSkills)
        .values(buildWorkspacePayload({ userId: this.userId, workspaceId: this.workspaceId }, data))
        .returning(skillItemColumns);

      const scopedAgents = await trx
        .select({ id: agents.id, plugins: agents.plugins, slug: agents.slug })
        .from(agents)
        .where(this.agentScopeWhere());

      for (const agent of scopedAgents) {
        const plugins = agent.plugins as AgentPluginEntry[] | null;
        const defaultMode = agent.slug === INBOX_SESSION_ID ? 'auto' : 'disabled';
        if (getPluginMode(plugins ?? undefined, data.identifier) === defaultMode) continue;

        await trx
          .update(agents)
          .set({
            plugins: upsertPluginMode(
              plugins ?? undefined,
              data.identifier,
              defaultMode,
            ) as string[],
          })
          .where(and(eq(agents.id, agent.id), this.agentScopeWhere()));
      }

      return result;
    });
  };

  // ========== Read ==========

  findById = async (id: string): Promise<SkillItem | undefined> => {
    const [result] = await this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(eq(agentSkills.id, id), this.scopeWhere()))
      .limit(1);
    return result;
  };

  findByIdentifier = async (identifier: string): Promise<SkillItem | undefined> => {
    const [result] = await this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(eq(agentSkills.identifier, identifier), this.scopeWhere()))
      .limit(1);
    return result;
  };

  findByName = async (name: string): Promise<SkillItem | undefined> => {
    const [result] = await this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(sql`lower(${agentSkills.name}) = ${name.toLowerCase()}`, this.scopeWhere()))
      .limit(1);
    return result;
  };

  findAll = async (): Promise<{ data: SkillListItem[]; total: number }> => {
    const data = await this.db
      .select(skillListColumns)
      .from(agentSkills)
      .where(this.scopeWhere())
      .orderBy(desc(agentSkills.updatedAt));

    return { data, total: data.length };
  };

  findByIds = async (ids: string[]): Promise<SkillItem[]> => {
    if (ids.length === 0) return [];
    return this.db
      .select(skillItemColumns)
      .from(agentSkills)
      .where(and(inArray(agentSkills.id, ids), this.scopeWhere()));
  };

  listBySource = async (
    source: 'builtin' | 'market' | 'user',
  ): Promise<{ data: SkillListItem[]; total: number }> => {
    const data = await this.db
      .select(skillListColumns)
      .from(agentSkills)
      .where(and(eq(agentSkills.source, source), this.scopeWhere()))
      .orderBy(desc(agentSkills.updatedAt));

    return { data, total: data.length };
  };

  search = async (query: string): Promise<{ data: SkillListItem[]; total: number }> => {
    const data = await this.db
      .select(skillListColumns)
      .from(agentSkills)
      .where(
        and(
          this.scopeWhere(),
          or(ilike(agentSkills.name, `%${query}%`), ilike(agentSkills.description, `%${query}%`)),
        ),
      )
      .orderBy(desc(agentSkills.updatedAt));

    return { data, total: data.length };
  };

  // ========== Update ==========

  update = async (id: string, data: Partial<NewAgentSkill>): Promise<SkillItem> => {
    const existing = await this.findById(id);

    const updateData = merge(existing || {}, { ...data, updatedAt: new Date() });

    const [result] = await this.db
      .update(agentSkills)
      .set(updateData)
      .where(and(eq(agentSkills.id, id), this.scopeWhere()))
      .returning(skillItemColumns);
    return result;
  };

  // ========== Delete ==========

  delete = async (id: string): Promise<{ success: boolean }> => {
    const result = await this.db
      .delete(agentSkills)
      .where(and(eq(agentSkills.id, id), this.scopeWhere()));

    return { success: (result.rowCount ?? 0) > 0 };
  };
}
