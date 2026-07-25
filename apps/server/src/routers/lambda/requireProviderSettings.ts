import { TRPCError } from '@trpc/server';

import { trpc } from '@/libs/trpc/lambda/init';
import { getServerFeatureFlagsStateFromRuntimeConfig } from '@/server/featureFlags';

/**
 * Reject user-level provider/model config writes when the `provider_settings`
 * feature flag is off (`showProvider === false`).
 *
 * White-label / private deployments (e.g. `FEATURE_FLAGS=-provider_settings`)
 * hide the provider settings UI and block its routes on the client. This closes
 * the matching tRPC backdoor so a hand-crafted request can't create or mutate a
 * user's own providers/models/keys either.
 *
 * Reads stay open on purpose — the app still needs provider runtime state to
 * resolve the branded provider's models. Apply this only to write mutations.
 */
export const requireProviderSettings = trpc.middleware(async (opts) => {
  const { showProvider } = await getServerFeatureFlagsStateFromRuntimeConfig(
    opts.ctx.userId || undefined,
  );

  if (!showProvider) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Provider settings are disabled in this deployment.',
    });
  }

  return opts.next();
});
