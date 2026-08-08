'use client';

import type { ChatTopicsIndex } from '@lobechat/types';
import isEqual from 'fast-deep-equal';

import { useCacheScope } from '@/libs/swr/useCacheScope';

import { useClientDataStore } from '../../store';
import {
  type ChatTopicListItemView,
  selectChatTopicListItem,
  selectChatTopicsIndex,
} from './selectors';

export const useChatTopicsIndex = (
  surface: 'agentView' | 'sidebar',
  containerKey: string | undefined,
): ChatTopicsIndex | undefined => {
  const scope = useCacheScope();
  return useClientDataStore((state) => {
    if (!containerKey) return undefined;
    return selectChatTopicsIndex(state.scopes[scope], surface, containerKey);
  }, isEqual);
};

export const useChatTopicListItem = (id: string | undefined): ChatTopicListItemView | undefined => {
  const scope = useCacheScope();
  return useClientDataStore((state) => {
    const entityScope = state.scopes[scope];
    if (!entityScope || !id) return undefined;
    return selectChatTopicListItem(entityScope, id);
  }, isEqual);
};
