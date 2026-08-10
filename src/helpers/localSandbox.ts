import { isDesktop } from '@lobechat/const';
import { resolveAgencyConfig } from '@lobechat/types';

import { isLocalSandboxEnabled, resolveExecutionTarget } from '@/helpers/executionTarget';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';
import { useUserStore } from '@/store/user';

/**
 * Whether an in-process desktop command must be sandboxed, read straight from
 * the stores.
 *
 * The gateway path resolves this on the server (`ToolExecutionContext.localSandbox`),
 * but a desktop run that executes in-process never reaches the server runtime —
 * without this the user would pick "Local Sandbox" and get an unfenced command
 * with no indication anything was skipped. Both paths converge on the same
 * `isLocalSandboxEnabled` rule so they cannot disagree about which runs are
 * fenced.
 *
 * Non-reactive by necessity (executors are plain callbacks, not components), so
 * it reads the same two stores `useEffectiveAgencyConfig` composes: the shared
 * `agents.agencyConfig` plus this member's `agentDeviceOverrides` entry. A
 * missing agentId means no config to consult — default to unsandboxed, matching
 * every pre-existing call site.
 */
export interface ClientLocalSandboxDecision {
  /** Confine this command (writes scoped to the working directory). */
  localSandbox: boolean;
  /** …and let it reach the package-registry allowlist. */
  localSandboxNetwork: boolean;
}

export const resolveClientLocalSandbox = (agentId?: string): ClientLocalSandboxDecision => {
  if (!isDesktop || !agentId) return { localSandbox: false, localSandboxNetwork: false };

  const sharedAgencyConfig = agentByIdSelectors.getAgencyConfigById(agentId)(
    useAgentStore.getState(),
  );
  const override = useUserStore.getState().workspaceUserPreference.agentDeviceOverrides?.[agentId];
  const agencyConfig = resolveAgencyConfig(sharedAgencyConfig, override);

  const target = resolveExecutionTarget(agencyConfig, {
    clientExecutionAvailable: true,
    isHetero: !!agencyConfig?.heterogeneousProvider?.type,
  });

  return {
    localSandbox: isLocalSandboxEnabled(agencyConfig, target),
    localSandboxNetwork: agencyConfig?.localSandboxNetwork === true,
  };
};
