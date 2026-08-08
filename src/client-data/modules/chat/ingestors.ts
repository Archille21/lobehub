import type {
  ChatTopic,
  ChatTopicsIndex,
  ChatTopicsQuerySignature,
  ClientDataCommit,
  EntityFragment,
  EntityRef,
  TopicEntityRecord,
} from '@lobechat/types';
import { chatAgentViewTopicsIndexKey, chatSidebarTopicsIndexKey } from '@lobechat/types';
import isEqual from 'fast-deep-equal';

import type { EntityObservation } from '../home/ingestors';

const fragment = <T>(data: T, observation: EntityObservation): EntityFragment<T> => ({
  data,
  ...observation,
});

export const normalizeChatTopicsSignature = (
  signature: ChatTopicsQuerySignature,
): ChatTopicsQuerySignature => ({
  ...(signature.excludeStatuses?.length
    ? { excludeStatuses: [...signature.excludeStatuses].sort() }
    : {}),
  ...(signature.excludeTriggers?.length
    ? { excludeTriggers: [...signature.excludeTriggers].sort() }
    : {}),
  ...(signature.isInbox ? { isInbox: true } : {}),
  ...(signature.sortBy ? { sortBy: signature.sortBy } : {}),
  ...(signature.withDetails ? { withDetails: true } : {}),
});

const timestampOf = (value: Date | number | string): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

const chatTopicRecord = (
  item: ChatTopic,
  observation: EntityObservation,
  options: { agentId?: string | null; withDetails?: boolean } = {},
): TopicEntityRecord => ({
  fragments: {
    activity: fragment({ updatedAt: item.updatedAt }, observation),
    analytics: fragment({ metadata: item.metadata ?? null }, observation),
    completion: fragment({ completedAt: item.completedAt ?? null }, observation),
    creation: fragment({ createdAt: item.createdAt }, observation),
    display: fragment({ title: item.title }, observation),
    generation: fragment(
      { model: item.model ?? null, provider: item.provider ?? null },
      observation,
    ),
    marking: fragment({ favorite: item.favorite ?? false }, observation),
    ordering: fragment(
      { sortUpdatedAt: item.sortUpdatedAt ?? timestampOf(item.updatedAt) },
      observation,
    ),
    ownership: fragment({ userId: item.userId }, observation),
    status: fragment({ status: item.status ?? null }, observation),
    summary: fragment({ historySummary: item.historySummary ?? null }, observation),
    ...(options.agentId !== undefined
      ? { routing: fragment({ agentId: options.agentId }, observation) }
      : {}),
    ...(options.withDetails
      ? {
          details: fragment(
            {
              description: item.description ?? null,
              firstUserMessage: item.firstUserMessage ?? null,
              messageCount: item.messageCount ?? null,
            },
            observation,
          ),
          triggerInfo: fragment({ trigger: item.trigger ?? null }, observation),
        }
      : {}),
  },
  id: item.id,
  kind: 'topic',
});

export interface ChatTopicsPageInput {
  containerKey: string;
  context: { agentId?: string | null };
  existing?: ChatTopicsIndex;
  items: ChatTopic[];
  page: number;
  pageSize: number;
  signature: ChatTopicsQuerySignature;
  surface: 'agentView' | 'sidebar';
  total: number;
}

export const ingestChatTopicsPage = (
  input: ChatTopicsPageInput,
  observation: EntityObservation,
): ClientDataCommit => {
  const signature = normalizeChatTopicsSignature(input.signature);
  const withDetails = Boolean(signature.withDetails);
  const pageRefs: EntityRef<'topic'>[] = input.items.map(({ id }) => ({ id, kind: 'topic' }));

  const existing =
    input.existing && isEqual(normalizeChatTopicsSignature(input.existing.signature), signature)
      ? input.existing
      : undefined;

  let refs = pageRefs;
  if (existing && input.page > 0) {
    const seen = new Set(existing.refs.map(({ id }) => id));
    refs = [...existing.refs, ...pageRefs.filter(({ id }) => !seen.has(id))];
  } else if (existing && existing.refs.length > pageRefs.length) {
    const pageIds = new Set(pageRefs.map(({ id }) => id));
    const cap = Math.min(Math.max(pageRefs.length, existing.refs.length), input.total);
    refs = [...pageRefs, ...existing.refs.filter(({ id }) => !pageIds.has(id))].slice(0, cap);
  }

  const key =
    input.surface === 'agentView'
      ? chatAgentViewTopicsIndexKey(input.containerKey)
      : chatSidebarTopicsIndexKey(input.containerKey);

  return {
    entities: input.items.map((item) =>
      chatTopicRecord(item, observation, { agentId: input.context.agentId ?? null, withDetails }),
    ),
    indexes: [
      {
        key,
        ...observation,
        persistRefLimit: input.pageSize,
        refs,
        signature,
        total: input.total,
      } as ChatTopicsIndex,
    ],
  };
};

export const ingestChatTopicSearchResults = (
  items: ChatTopic[],
  observation: EntityObservation,
): ClientDataCommit => ({
  entities: items.map((item) => chatTopicRecord(item, observation)),
});
