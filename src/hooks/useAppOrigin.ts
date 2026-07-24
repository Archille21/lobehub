'use client';

import { isDesktop } from '@lobechat/const';

import { useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';
import { normalizeAppOrigin } from '@/utils/normalizeAppOrigin';

/**
 * Returns the correct app origin URL for sharing/linking.
 * - Web: uses window.location.origin
 * - Desktop: uses remoteServerUrl from electron store
 */
export const useAppOrigin = () => {
  const remoteServerUrl = useElectronStore(electronSyncSelectors.remoteServerUrl);
  return normalizeAppOrigin(isDesktop ? remoteServerUrl : window.location.origin);
};
