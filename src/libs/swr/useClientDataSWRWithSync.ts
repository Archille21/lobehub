/**
 * useClientDataSWR with automatic Zustand store sync
 *
 * Solves the problem of SWR cached data not being immediately synced to Zustand store.
 * When SWR returns data from the persisted cache, it will automatically sync to store via onData callback.
 *
 * Persistence (localStorage vs IndexedDB) is handled transparently by the
 * tier-aware SWR cache provider (see `localStorageProvider.ts`) based on the
 * SWR key — consumers never need to opt in per call.
 */

import { useEffect, useLayoutEffect, useRef } from 'react';
import { type SWRConfiguration, type SWRResponse } from 'swr';

import { useClientDataSWR } from './index';

type Key = string | readonly unknown[] | null | undefined;

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const serializeSyncKey = (key: Key): string => {
  if (key == null) return '';
  if (Array.isArray(key)) return JSON.stringify(key);
  return String(key);
};

interface UseClientDataSWRWithSyncOptions<T> extends SWRConfiguration<T> {
  /**
   * Data sync callback, called when data is available (both cached and fresh data)
   * Used to sync data to Zustand store
   */
  onData?: (data: T) => void;
  /**
   * Whether to skip sync (optional, for conditional skipping)
   */
  skipSync?: boolean;
}

/**
 * Enhanced version of useClientDataSWR with automatic cache data sync to Zustand store
 *
 * @example
 * ```ts
 * useClientDataSWRWithSync(
 *   isLogin ? ['fetchAgentList', isLogin] : null,
 *   () => homeService.getSidebarAgentList(),
 *   {
 *     onData: (data) => {
 *       // Auto sync to store, whether cached or fresh data
 *       set({ ...mapResponseToState(data), isInit: true });
 *     },
 *     skipSync: state.isInit, // Optional: skip after initialized
 *   }
 * );
 * ```
 */
export function useClientDataSWRWithSync<T>(
  key: Key,
  fetcher: (() => Promise<T>) | null,
  options?: UseClientDataSWRWithSyncOptions<T>,
): SWRResponse<T> {
  const { onData, skipSync, onSuccess, ...swrOptions } = options || {};
  const keySignature = serializeSyncKey(key);
  const lastSyncedRef = useRef<{ data: T; key: string } | null>(null);

  const response = useClientDataSWR<T>(key, fetcher, {
    ...swrOptions,
    onSuccess: (data, key, config) => {
      // Call original onSuccess
      onSuccess?.(data, key, config);
      // Also sync via onData
      if (onData && !skipSync) {
        onData(data);
        lastSyncedRef.current = { data, key: keySignature };
      }
    },
  });

  const { data } = response;

  // When cached data is available, sync to store before the browser paints.
  useBrowserLayoutEffect(() => {
    if (data === undefined || !onData || skipSync) return;

    const lastSynced = lastSyncedRef.current;
    if (lastSynced?.key === keySignature && lastSynced.data === data) {
      return;
    }

    onData(data);
    lastSyncedRef.current = { data, key: keySignature };
  }, [data, keySignature, onData, skipSync]);

  return response;
}
