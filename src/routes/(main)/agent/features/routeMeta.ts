import {
  ChartNoAxesColumn,
  Files,
  MessageSquare,
  MessagesSquareIcon,
  RadioTower,
  UserRoundCog,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { usePublishDynamicRouteMeta } from '@/features/RouteMeta/usePublishDynamicRouteMeta';
import { matchesRouteWorkspace, useRouteWorkspaceId } from '@/features/RouteMeta/workspaceScope';
import type { DynamicRouteMetaProps } from '@/spa/router/routeMeta';
import { routeMeta } from '@/spa/router/routeMeta';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { useChatStore } from '@/store/chat';
import { topicMapKey } from '@/store/chat/utils/topicMapKey';

const useTopicTitle = (
  agentId: string | undefined,
  topicId: string | undefined,
  routeWorkspaceId: string | null | undefined,
): string | undefined =>
  useChatStore((s) => {
    if (!agentId || !topicId || routeWorkspaceId === undefined) return undefined;

    const topic = s.topicDataMap[topicMapKey({ agentId })]?.items?.find(
      (item) => item.id === topicId,
    );
    return topic?.title || undefined;
  });

export const getAgentScopedPageTitle = (pageLabel: string, agentTitle?: string) =>
  [pageLabel, agentTitle].filter(Boolean).join(' - ');

const AgentDynamicMeta = ({ onResolve, params }: DynamicRouteMetaProps) => {
  const routeWorkspaceId = useRouteWorkspaceId(params);
  const meta = useAgentStore((s) => {
    const agentId = params.aid ?? '';
    const agent = s.agentMap[agentId];

    if (!matchesRouteWorkspace(agent?.workspaceId, routeWorkspaceId)) return {};

    return agentSelectors.getAgentMetaById(agentId)(s);
  });
  const topicTitle = useTopicTitle(params.aid, params.topicId ?? params.topic, routeWorkspaceId);
  const hasMeta = Object.keys(meta).length > 0;
  const agentTitle = hasMeta ? meta.title : undefined;

  usePublishDynamicRouteMeta(
    {
      avatar: meta.avatar,
      backgroundColor: meta.backgroundColor,
      title: [topicTitle, agentTitle].filter(Boolean).join(' · ') || undefined,
    },
    onResolve,
  );

  return null;
};

export const agentRouteMeta = routeMeta({
  DynamicMeta: AgentDynamicMeta,
  icon: MessageSquare,
  titleKey: 'navigation.chat',
});

type AgentScopedPageTitleKey =
  | 'navigation.agentChannels'
  | 'navigation.agentDocuments'
  | 'navigation.agentProfile'
  | 'navigation.agentStats';

const createAgentScopedDynamicMeta = (titleKey: AgentScopedPageTitleKey) => {
  const AgentScopedDynamicMeta = ({ onResolve, params }: DynamicRouteMetaProps) => {
    const { t } = useTranslation('electron');
    const routeWorkspaceId = useRouteWorkspaceId(params);
    const meta = useAgentStore((s) => {
      const agentId = params.aid ?? '';
      const agent = s.agentMap[agentId];

      if (!matchesRouteWorkspace(agent?.workspaceId, routeWorkspaceId)) return {};

      return agentSelectors.getAgentMetaById(agentId)(s);
    });
    const hasMeta = Object.keys(meta).length > 0;
    const agentTitle = hasMeta ? meta.title : undefined;

    usePublishDynamicRouteMeta(
      {
        avatar: meta.avatar,
        backgroundColor: meta.backgroundColor,
        title: getAgentScopedPageTitle(t(titleKey), agentTitle) || undefined,
      },
      onResolve,
    );

    return null;
  };

  return AgentScopedDynamicMeta;
};

export const agentProfileRouteMeta = routeMeta({
  DynamicMeta: createAgentScopedDynamicMeta('navigation.agentProfile'),
  icon: UserRoundCog,
  titleKey: 'navigation.agentProfile',
});

export const agentChannelRouteMeta = routeMeta({
  DynamicMeta: createAgentScopedDynamicMeta('navigation.agentChannels'),
  icon: RadioTower,
  titleKey: 'navigation.agentChannels',
});

export const agentDocumentsRouteMeta = routeMeta({
  DynamicMeta: createAgentScopedDynamicMeta('navigation.agentDocuments'),
  icon: Files,
  titleKey: 'navigation.agentDocuments',
});

export const agentStatsRouteMeta = routeMeta({
  DynamicMeta: createAgentScopedDynamicMeta('navigation.agentStats'),
  icon: ChartNoAxesColumn,
  titleKey: 'navigation.agentStats',
});

const TopicsDynamicMeta = ({ onResolve, params }: DynamicRouteMetaProps) => {
  const { t } = useTranslation('electron');
  const routeWorkspaceId = useRouteWorkspaceId(params);
  const meta = useAgentStore((s) => {
    const agentId = params.aid ?? '';
    const agent = s.agentMap[agentId];

    if (!matchesRouteWorkspace(agent?.workspaceId, routeWorkspaceId)) return {};

    return agentSelectors.getAgentMetaById(agentId)(s);
  });
  const hasMeta = Object.keys(meta).length > 0;
  const agentTitle = hasMeta ? meta.title : undefined;

  usePublishDynamicRouteMeta(
    {
      avatar: meta.avatar,
      backgroundColor: meta.backgroundColor,
      title: [t('navigation.topics'), agentTitle].filter(Boolean).join(' · ') || undefined,
    },
    onResolve,
  );

  return null;
};

export const topicsRouteMeta = routeMeta({
  DynamicMeta: TopicsDynamicMeta,
  icon: MessagesSquareIcon,
  titleKey: 'navigation.topics',
});
