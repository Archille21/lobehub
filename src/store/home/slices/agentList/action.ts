import { type SWRResponse } from 'swr';

import { type SidebarAgentItem } from '@/database/repositories/home';
import { mutate, useClientDataSWR } from '@/libs/swr';
import { agentConfigKeys, clientDataKeys } from '@/libs/swr/keys';
import { getCacheScope } from '@/libs/swr/useCacheScope';
import { homeService } from '@/services/home';
import { getAgentStoreState } from '@/store/agent';
import { type HomeStore } from '@/store/home/store';
import { type StoreSetter } from '@/store/types';
import { setNamespace } from '@/utils/storeDebug';

const n = setNamespace('agentList');

type Setter = StoreSetter<HomeStore>;
export const createAgentListSlice = (set: Setter, get: () => HomeStore, _api?: unknown) =>
  new AgentListActionImpl(set, get, _api);

export class AgentListActionImpl {
  readonly #set: Setter;

  constructor(set: Setter, get: () => HomeStore, _api?: unknown) {
    void _api;
    void get;
    this.#set = set;
  }

  closeAllAgentsDrawer = (): void => {
    this.#set({ allAgentsDrawerOpen: false }, false, n('closeAllAgentsDrawer'));
  };

  openAllAgentsDrawer = (): void => {
    this.#set({ allAgentsDrawerOpen: true }, false, n('openAllAgentsDrawer'));
  };

  refreshAgentList = async (): Promise<void> => {
    getAgentStoreState().invalidateAvailableAgents();
    await mutate(clientDataKeys.sidebar(getCacheScope()));
  };

  useSearchAgents = (keyword?: string): SWRResponse<SidebarAgentItem[]> => {
    return useClientDataSWR<SidebarAgentItem[]>(agentConfigKeys.search(keyword), async () => {
      if (!keyword) return [];

      return homeService.searchAgents(keyword);
    });
  };
}

export type AgentListAction = Pick<AgentListActionImpl, keyof AgentListActionImpl>;
