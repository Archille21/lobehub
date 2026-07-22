import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { timestamps } from './_helpers';
import { agents } from './agent';

export interface AgentShareConfig {
  allowReadMemory?: boolean;
  /** Tool whitelist — only the listed MCP/plugin/skill ids are exposed to visitors. */
  enabledToolIds?: string[];
  filePermissionConfig?: {
    agentFiles?: 'none' | 'read';
    knowledgeBase?: 'none' | 'read';
    uploadAllowed?: boolean;
  };
  guestEnabled?: boolean;
  maxGuestTopics?: number;
  /** Per-visitor cap: max share topics a single senderId can create. */
  maxTopicsPerVisitor?: number;
  /** Per-topic cap: max message turns within a single share topic. */
  maxTurnsPerTopic?: number;
  // tipSplitRatio is platform-controlled, not configurable by the creator
}

export const agentShares = pgTable(
  'agent_shares',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    visibility: text('visibility').default('private').notNull(), // 'private' | 'link'

    shareConfig: jsonb('share_config').$type<AgentShareConfig>(),

    /** Unique visitor count — incremented by the application layer on each new visitor session. */
    userViewCount: integer('user_view_count').default(0).notNull(),

    ...timestamps,
  },
  (t) => [
    uniqueIndex('agent_shares_agent_id_unique').on(t.agentId),
    index('agent_shares_visibility_idx').on(t.visibility),
  ],
);

export type NewAgentShare = typeof agentShares.$inferInsert;
export type AgentShareItem = typeof agentShares.$inferSelect;
