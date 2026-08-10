import { isDesktop } from '@lobechat/const';
import type { DeviceSandboxCapabilityResult } from '@lobechat/electron-client-ipc';
import type { SWRResponse } from 'swr';

import { useClientDataSWR } from '@/libs/swr';
import { localFileService } from '@/services/electron/localFileService';

const LOCAL_SANDBOX_CAPABILITY_SWR_KEY = 'local-sandbox-capability';

/**
 * Whether this machine can actually run sandboxed commands.
 *
 * Asked instead of guessed: the sandbox backend supports macOS and Linux only,
 * and Linux additionally needs host binaries that may be missing — a
 * `process.platform` check in the renderer would offer the option on hosts that
 * cannot honour it. The probe result is fixed for the life of the app process,
 * so it is fetched once and never revalidated.
 *
 * Web has no local machine to fence, so it never asks.
 */
export const useLocalSandboxCapability = (): SWRResponse<DeviceSandboxCapabilityResult> =>
  useClientDataSWR<DeviceSandboxCapabilityResult>(
    isDesktop ? [LOCAL_SANDBOX_CAPABILITY_SWR_KEY] : null,
    () => localFileService.getSandboxCapability(),
    { revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false },
  );
