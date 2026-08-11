import { mutate, useClientDataSWR } from '@/libs/swr';
import { taskKeys } from '@/libs/swr/keys';
import { getCacheScope } from '@/libs/swr/useCacheScope';
import { getProjectionStoreState, nextProjectionObservedAt } from '@/projection';
import { taskService } from '@/services/task';
import type { StoreSetter } from '@/store/types';

import type { GoalListFilter, GoalState, GoalViewMode } from './initialState';

const GOAL_STATUSES = [
  'backlog',
  'running',
  'scheduled',
  'paused',
  'completed',
  'failed',
  'canceled',
];

export type GoalStore = GoalState & GoalAction;
type Setter = StoreSetter<GoalStore>;

export class GoalActionImpl {
  readonly #set: Setter;

  constructor(set: Setter, get: () => GoalStore, _api?: unknown) {
    void _api;
    void get;
    this.#set = set;
  }

  deleteGoal = async (agentId: string, goalId: string): Promise<void> => {
    const scope = getCacheScope();
    const observedAt = nextProjectionObservedAt();
    await taskService.deleteGoal(goalId);
    getProjectionStoreState().deleteTaskProjection(scope, goalId, observedAt);
    await this.refreshGoals(agentId);
  };

  loadMoreGoals = (): void => {
    this.#set(
      ({ goalListVisibleLimit }) => ({ goalListVisibleLimit: goalListVisibleLimit + 10 }),
      false,
      'loadMoreGoals',
    );
  };

  refreshGoals = async (agentId: string): Promise<void> => {
    await mutate(taskKeys.sidebarGroups(`${agentId}:goals-page`));
  };

  setGoalListFilter = (filter: GoalListFilter): void => {
    this.#set({ goalListFilter: filter, goalListVisibleLimit: 10 }, false, 'setGoalListFilter');
  };

  setGoalViewMode = (mode: GoalViewMode): void => {
    this.#set({ goalViewMode: mode }, false, 'setGoalViewMode');
  };

  useFetchGoals = (agentId?: string) =>
    useClientDataSWR(
      agentId ? taskKeys.sidebarGroups(`${agentId}:goals-page`) : null,
      async () => {
        const scope = getCacheScope();
        const observedAt = nextProjectionObservedAt();
        const result = await taskService.groupList({
          assigneeAgentId: agentId,
          groups: [{ key: 'goals', limit: 100, statuses: GOAL_STATUSES }],
          hasGoal: true,
          parentTaskId: null,
        });
        getProjectionStoreState().commitTaskGroupList(
          scope,
          result.data,
          { agentKey: `${agentId}:goals-page`, visibility: 'all' },
          observedAt,
        );
        return result;
      },
      { revalidateOnFocus: true },
    );
}

export type GoalAction = Pick<GoalActionImpl, keyof GoalActionImpl>;
