import type {
  ChatTopicMetadata,
  ChatTopicsIndex,
  ChatTopicStatus,
  TopicEntityRecord,
} from '@lobechat/types';
import { chatAgentViewTopicsIndexKey, chatSidebarTopicsIndexKey } from '@lobechat/types';

import type { ClientDataScopeState } from '../../core/initialState';

export interface ChatTopicListItemView {
  completedAt: Date | null;
  createdAt?: Date | number | string;
  favorite: boolean;
  historySummary: string | null;
  id: string;
  metadata: ChatTopicMetadata | null;
  model: string | null;
  provider: string | null;
  sortUpdatedAt: number;
  status?: ChatTopicStatus | null;
  title: string;
  updatedAt: Date | number | string;
  userId?: string;
}

export interface ChatTopicDetailView extends ChatTopicListItemView {
  description: string | null;
  firstUserMessage: string | null;
  messageCount: number | null;
  trigger?: string | null;
}

const activeRecord = (record: TopicEntityRecord | undefined): TopicEntityRecord | undefined =>
  record && !record.tombstoneAt ? record : undefined;

export const selectChatTopicsIndex = (
  scope: ClientDataScopeState | undefined,
  surface: 'agentView' | 'sidebar',
  containerKey: string,
): ChatTopicsIndex | undefined => {
  const key =
    surface === 'agentView'
      ? chatAgentViewTopicsIndexKey(containerKey)
      : chatSidebarTopicsIndexKey(containerKey);
  return scope?.indexes[key];
};

export const selectChatTopicListItem = (
  scope: ClientDataScopeState,
  id: string,
): ChatTopicListItemView | undefined => {
  const active = activeRecord(scope.entities.topic[id]);
  const fragments = active?.fragments;
  const display = fragments?.display?.data;
  const activity = fragments?.activity?.data;
  const ordering = fragments?.ordering?.data;
  const marking = fragments?.marking?.data;
  const status = fragments?.status?.data;
  const completion = fragments?.completion?.data;
  const generation = fragments?.generation?.data;
  const analytics = fragments?.analytics?.data;
  const summary = fragments?.summary?.data;
  const ownership = fragments?.ownership?.data;
  if (
    !active ||
    !display ||
    !activity ||
    !ordering ||
    !marking ||
    !status ||
    !completion ||
    !generation ||
    !analytics ||
    !summary ||
    !ownership
  )
    return undefined;

  return {
    ...display,
    ...activity,
    ...ordering,
    ...marking,
    ...status,
    ...completion,
    ...generation,
    ...analytics,
    ...summary,
    ...ownership,
    ...fragments?.creation?.data,
    id: active.id,
  };
};

export const selectChatTopicDetailItem = (
  scope: ClientDataScopeState,
  id: string,
): ChatTopicDetailView | undefined => {
  const base = selectChatTopicListItem(scope, id);
  const fragments = activeRecord(scope.entities.topic[id])?.fragments;
  const details = fragments?.details?.data;
  const triggerInfo = fragments?.triggerInfo?.data;
  if (!base || !details || !triggerInfo) return undefined;
  return { ...base, ...details, ...triggerInfo };
};
