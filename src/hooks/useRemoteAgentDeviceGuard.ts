import { isRemoteHeterogeneousType } from '@lobechat/heterogeneous-agents';
import { resolveAgencyConfig } from '@lobechat/types';
import { useCallback, useEffect, useState } from 'react';

import { deviceService } from '@/services/device';
import { useAgentStore } from '@/store/agent';
import { useUserStore } from '@/store/user';
import { workspaceUserSettingsSelectors } from '@/store/user/selectors';

export type RemoteAgentDeviceStatus =
  'checking' | 'device-offline' | 'no-device' | 'ok' | 'platform-unavailable';

interface UseRemoteAgentDeviceGuardOptions {
  /** The conversation's agent — validate this agent's bound device, not the global active one. */
  agentId: string;
  enabled?: boolean;
}

interface UseRemoteAgentDeviceGuardResult {
  refresh: () => void;
  status: RemoteAgentDeviceStatus;
}

/**
 * Checks whether the bound device is online and, for remote-only hetero
 * platforms, whether that platform is available on the device. Used in
 * HeterogeneousChatInput before device-dispatched hetero runs.
 */
export const useRemoteAgentDeviceGuard = ({
  agentId,
  enabled = true,
}: UseRemoteAgentDeviceGuardOptions): UseRemoteAgentDeviceGuardResult => {
  const sharedAgencyConfig = useAgentStore((s) =>
    agentId ? s.agentMap[agentId]?.agencyConfig : undefined,
  );
  const isWorkspaceAgent = useAgentStore((s) =>
    Boolean(agentId && s.agentMap[agentId]?.workspaceId),
  );

  // A workspace member's own device pick lives in
  // `workspace_user_settings.preference.agentDeviceOverrides[agentId]`
  // (LOBE-11689), NOT in the shared `agents.agencyConfig` — merge it exactly
  // like the device switcher and server dispatch do, otherwise this guard
  // validates a stale shared binding and reports "device offline" for a
  // device the member never selected (LOBE-11813).
  const { isLoading: isWorkspacePreferenceLoading } = useUserStore(
    (s) => s.useFetchWorkspaceUserPreference,
  )();
  const override = useUserStore(workspaceUserSettingsSelectors.agentDeviceOverrideById(agentId));
  const agencyConfig = resolveAgencyConfig(sharedAgencyConfig, override);

  const boundDeviceId = agencyConfig?.boundDeviceId;
  const providerType = agencyConfig?.heterogeneousProvider?.type;

  // Before the workspace preference resolves, the merged config may still be
  // the shared fallback — checking it would flash a false banner for the
  // very binding the override replaces.
  const pendingPreference = isWorkspaceAgent && isWorkspacePreferenceLoading;

  const [status, setStatus] = useState<RemoteAgentDeviceStatus>('checking');

  const check = useCallback(async () => {
    if (!enabled) return;
    if (pendingPreference) return;

    if (!boundDeviceId) {
      setStatus('no-device');
      return;
    }

    setStatus('checking');

    try {
      const devices = await deviceService.listDevices();
      const device = devices.find((d) => d.deviceId === boundDeviceId);

      if (!device || !device.online) {
        setStatus('device-offline');
        return;
      }

      if (providerType && isRemoteHeterogeneousType(providerType)) {
        const capability = await deviceService.checkCapability({
          deviceId: boundDeviceId,
          platform: providerType,
        });
        setStatus(capability.available ? 'ok' : 'platform-unavailable');
      } else {
        setStatus('ok');
      }
    } catch {
      // On error, allow sending — don't block user on network issues
      setStatus('ok');
    }
  }, [enabled, pendingPreference, boundDeviceId, providerType]);

  useEffect(() => {
    void check();
  }, [check]);

  // Re-check when window regains focus
  useEffect(() => {
    if (!enabled) return;
    const handler = () => void check();
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [enabled, check]);

  return { refresh: () => void check(), status };
};
