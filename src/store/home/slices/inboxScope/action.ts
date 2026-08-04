import { type HomeStore } from '@/store/home/store';
import { type StoreSetter } from '@/store/types';
import { setNamespace } from '@/utils/storeDebug';

import { type HomeInboxScope } from './initialState';

const n = setNamespace('inboxScope');

type Setter = StoreSetter<HomeStore>;
export const createInboxScopeSlice = (set: Setter, get: () => HomeStore, _api?: unknown) =>
  new InboxScopeActionImpl(set, get, _api);

export class InboxScopeActionImpl {
  readonly #set: Setter;

  constructor(set: Setter, _get: () => HomeStore, _api?: unknown) {
    void _get;
    void _api;
    this.#set = set;
  }

  setHomeInboxScope = (scope: HomeInboxScope): void => {
    this.#set({ homeInboxScope: scope }, false, n('setHomeInboxScope'));
  };
}

export type InboxScopeAction = Pick<InboxScopeActionImpl, keyof InboxScopeActionImpl>;
