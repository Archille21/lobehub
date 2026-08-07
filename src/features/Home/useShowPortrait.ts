import { HOME_PORTRAIT_ENABLED } from '@lobechat/business-const';

import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/slices/auth/selectors';

/**
 * Whether the dashboard mounts the Chief Agent portrait and the speech bubble
 * beside it. The two are one decision: the bubble's tail points at the portrait
 * and its copy is written as the agent speaking, so shipping either alone is a
 * bug rather than a variant.
 *
 * Signed-out visitors never had a portrait — there is no agent to speak the
 * line — and `HOME_PORTRAIT_ENABLED` lets a distribution drop it entirely. That
 * matters to self-hosted installs in particular: the artwork is served from the
 * hosted ops bucket, so it is the one thing on this page that cannot come from
 * the deployment's own origin.
 */
export const useShowPortrait = (): boolean => {
  const isLogin = useUserStore(authSelectors.isLogin);

  return Boolean(isLogin && HOME_PORTRAIT_ENABLED);
};
