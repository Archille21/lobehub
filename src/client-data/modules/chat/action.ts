import type { ChatTopic } from '@lobechat/types';

import type { StoreSetter } from '@/store/types';

import type { ClientDataStore } from '../../store';
import type { EntityObservation } from '../home/ingestors';
import {
  type ChatTopicsPageInput,
  ingestChatTopicSearchResults,
  ingestChatTopicsPage,
} from './ingestors';
import { selectChatTopicsIndex } from './selectors';

type Setter = StoreSetter<ClientDataStore>;

export interface ChatClientDataAction {
  commitChatTopicSearchResults: (
    scope: string,
    items: ChatTopic[],
    observation: EntityObservation,
  ) => void;
  commitChatTopicsPage: (
    scope: string,
    input: Omit<ChatTopicsPageInput, 'existing'>,
    observation: EntityObservation,
  ) => void;
}

class ChatClientDataActionImpl implements ChatClientDataAction {
  readonly #get: () => ClientDataStore;

  constructor(_set: Setter, get: () => ClientDataStore, _api?: unknown) {
    void _set;
    void _api;
    this.#get = get;
  }

  commitChatTopicsPage = (
    scope: string,
    input: Omit<ChatTopicsPageInput, 'existing'>,
    observation: EntityObservation,
  ): void => {
    const existing = selectChatTopicsIndex(
      this.#get().scopes[scope],
      input.surface,
      input.containerKey,
    );
    this.#get().internal_commitClientData(
      scope,
      ingestChatTopicsPage({ ...input, existing }, observation),
    );
  };

  commitChatTopicSearchResults = (
    scope: string,
    items: ChatTopic[],
    observation: EntityObservation,
  ): void => {
    this.#get().internal_commitClientData(scope, ingestChatTopicSearchResults(items, observation));
  };
}

export const createChatClientDataAction = (
  set: Setter,
  get: () => ClientDataStore,
  api?: unknown,
) => new ChatClientDataActionImpl(set, get, api);
