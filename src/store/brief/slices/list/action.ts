import dayjs from 'dayjs';
import { type SWRResponse } from 'swr';

import { getClientDataStoreState } from '@/client-data';
import { useClientDataSWR } from '@/libs/swr';
import { briefKeys } from '@/libs/swr/keys';
import { getCacheScope } from '@/libs/swr/useCacheScope';
import { briefService } from '@/services/brief';
import { taskService } from '@/services/task';
import { type BriefStore } from '@/store/brief/store';
import { type BriefItem } from '@/store/brief/types';
import { type StoreSetter } from '@/store/types';

export interface NewsDay {
  /**
   * The local day (`YYYY-MM-DD`) this payload belongs to. Carried in the data so
   * consumers rendering with `keepPreviousData` can label/gate from the day
   * actually shown instead of the day being fetched — otherwise a slow page
   * flip shows the new day's title over the old day's briefs.
   */
  day: string;
  /** Any news brief older than this day exists — the day pager's "older" arrow. */
  hasEarlier: boolean;
  news: BriefItem[];
}

type Setter = StoreSetter<BriefStore>;

export const createBriefListSlice = (set: Setter, get: () => BriefStore, _api?: unknown) =>
  new BriefListActionImpl(set, get, _api);

export class BriefListActionImpl {
  constructor(_set: Setter, _get: () => BriefStore, _api?: unknown) {
    void _set;
    void _get;
    void _api;
  }

  deleteBrief = async (id: string) => {
    const scope = getCacheScope();
    const observedAt = Date.now();
    await briefService.delete(id);
    getClientDataStoreState().deleteBriefEntity(scope, id, observedAt);
  };

  markBriefRead = async (id: string) => {
    const scope = getCacheScope();
    const observedAt = Date.now();
    const result = await briefService.markRead(id);
    const readAt = result.data.readAt ?? new Date().toISOString();
    getClientDataStoreState().updateBriefReadState(scope, id, readAt, observedAt);
  };

  resolveBriefsAsRead = async (ids: string[]) => {
    if (ids.length === 0) return;

    // Capture the scope these ids belong to *before* awaiting — a workspace
    // switch mid-request must not land the resolution in the next partition.
    const scope = getCacheScope();
    const observedAt = Date.now();
    const result = await briefService.resolveManyAsRead(ids);
    const resolvedIds = new Set(result.data);
    if (resolvedIds.size === 0) return;

    getClientDataStoreState().resolveBriefEntitiesAsRead(
      scope,
      [...resolvedIds],
      new Date().toISOString(),
      observedAt,
    );
  };

  resolveBrief = async (id: string, action?: string, comment?: string) => {
    const scope = getCacheScope();
    const observedAt = Date.now();
    const result = await briefService.resolve(id, { action, comment });
    const resolvedAction = result.data.resolvedAction ?? action ?? null;
    const resolvedAt = result.data.resolvedAt ?? new Date().toISOString();
    const resolvedComment = result.data.resolvedComment ?? comment ?? null;
    getClientDataStoreState().updateBriefResolution(
      scope,
      id,
      {
        resolvedAction,
        resolvedAt,
        resolvedComment,
      },
      observedAt,
    );
  };

  // Free-form feedback from the brief card: resolve the brief with the
  // user's text (so the heartbeat re-arm gate in TaskLifecycle no longer
  // sees an unresolved urgent brief), then re-run the task so the agent
  // picks up `resolvedComment` in its next prompt. Without this, the brief
  // stays unresolved and the task is parked forever in `human-waiting`.
  submitFeedback = async (briefId: string, taskId: string, content: string) => {
    await this.resolveBrief(briefId, 'feedback', content);
    try {
      await taskService.run(taskId);
    } catch (error) {
      // CONFLICT means a run is already in flight (e.g. the user resolved
      // multiple briefs at once) — the in-flight run will read the freshly
      // resolved comment, so the resolve still does its job.
      console.warn('[BriefStore] submitFeedback: task.run failed', error);
    }
  };

  /**
   * Day-scoped news digest (`insight` + `result`, resolved included). Lives in
   * SWR only — no zustand bucket: the key already partitions by identity scope
   * and day, the list is read-mostly, and the one mutation that touches it
   * (mark-all-read) revalidates through the returned SWR handle. `day` is the
   * viewer's local `YYYY-MM-DD`; the [start, end) instants are computed here so
   * the server stays timezone-agnostic. `keepPreviousData` keeps the section
   * stable while the user pages between days.
   */
  useFetchNewsByDay = (enabled: boolean, scope: string, day: string): SWRResponse<NewsDay> =>
    useClientDataSWR<NewsDay>(
      enabled ? briefKeys.news(true, scope, day) : null,
      async () => {
        const startAt = dayjs(day).startOf('day');
        const result = await briefService.listNewsByDay({
          endAt: startAt.add(1, 'day').toDate(),
          startAt: startAt.toDate(),
        });
        return { day, hasEarlier: result.hasEarlier, news: result.data as BriefItem[] };
      },
      { keepPreviousData: true },
    );
}

export type BriefListAction = Pick<BriefListActionImpl, keyof BriefListActionImpl>;
