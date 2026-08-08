import type { EntityRef, EntitySource } from '../../entity';
import type { TopicQuerySortBy } from '../../topic';

export interface ChatTopicsQuerySignature {
  excludeStatuses?: string[];
  excludeTriggers?: string[];
  isInbox?: boolean;
  sortBy?: TopicQuerySortBy;
  withDetails?: boolean;
}

export type ChatSidebarTopicsIndexKey = `chat.sidebarTopics:${string}`;
export type ChatAgentViewTopicsIndexKey = `chat.agentViewTopics:${string}`;

interface ChatTopicsIndexBase<K extends string> {
  key: K;
  observedAt: number;
  /** Durable writes slice refs to this length; the in-memory index keeps all. */
  persistRefLimit: number;
  refs: EntityRef<'topic'>[];
  signature: ChatTopicsQuerySignature;
  source: EntitySource;
  total: number;
}

export interface ChatSidebarTopicsIndex extends ChatTopicsIndexBase<ChatSidebarTopicsIndexKey> {}
export interface ChatAgentViewTopicsIndex extends ChatTopicsIndexBase<ChatAgentViewTopicsIndexKey> {}

export type ChatTopicsIndex = ChatAgentViewTopicsIndex | ChatSidebarTopicsIndex;

export type ChatIndexMap = { [K in ChatAgentViewTopicsIndexKey]: ChatAgentViewTopicsIndex } & {
  [K in ChatSidebarTopicsIndexKey]: ChatSidebarTopicsIndex;
};

export const chatSidebarTopicsIndexKey = (containerKey: string): ChatSidebarTopicsIndexKey =>
  `chat.sidebarTopics:${containerKey}`;

export const chatAgentViewTopicsIndexKey = (containerKey: string): ChatAgentViewTopicsIndexKey =>
  `chat.agentViewTopics:${containerKey}`;
