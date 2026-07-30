'use client';

import { memo } from 'react';
import { useParams } from 'react-router';

import { useClearActiveTopicUnread } from '@/features/Conversation/hooks';
import { useTopicCommentDeepLink } from '@/features/TopicComment/useTopicCommentDeepLink';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';

import { useChatRouteSync } from './useChatRouteSync';

// sync outside state to useChatStore
const ChatHydration = memo(() => {
  const params = useParams<{ aid?: string; topicId?: string }>();
  const routeTopicId = params.topicId;
  const activeAgentId = useChatStore((s) => s.activeAgentId);
  const routeTopic = useChatStore((s) =>
    routeTopicId ? topicSelectors.getTopicById(routeTopicId)(s) : undefined,
  );
  const useFetchTopicDetail = useChatStore((s) => s.useFetchTopicDetail);
  const useFetchTopicLinkedPullRequest = useChatStore((s) => s.useFetchTopicLinkedPullRequest);

  useClearActiveTopicUnread();
  useFetchTopicDetail(activeAgentId && !routeTopic ? routeTopicId : undefined);
  useFetchTopicLinkedPullRequest(activeAgentId ? routeTopicId : undefined, routeTopic?.metadata);
  useTopicCommentDeepLink(routeTopicId);
  useChatRouteSync();

  return null;
});

export default ChatHydration;
