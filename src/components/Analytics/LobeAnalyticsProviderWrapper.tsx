import { type ReactNode } from 'react';
import { memo } from 'react';

import { LobeAnalyticsProvider } from '@/components/Analytics/LobeAnalyticsProvider';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors, userProfileSelectors } from '@/store/user/selectors';
import type { SPAServerConfig } from '@/types/spaServerConfig';
import { isDev } from '@/utils/env';

type Props = {
  children: ReactNode;
};

export const LobeAnalyticsProviderWrapper = memo<Props>(({ children }) => {
  const serverConfig: SPAServerConfig | undefined = window.__SERVER_CONFIG__;
  const analytics = serverConfig?.analyticsConfig;
  const isUserStateInit = useUserStore((s) => s.isUserStateInit);
  const telemetryEnabled = useUserStore(userGeneralSettingsSelectors.telemetry);
  const user = useUserStore(userProfileSelectors.userProfile);
  const captureEnabled = isUserStateInit && telemetryEnabled === true;

  return (
    <LobeAnalyticsProvider
      captureEnabled={captureEnabled}
      user={user}
      ga4Config={{
        debug: isDev,
        enabled: !!analytics?.google?.measurementId,
        gtagConfig: {
          debug_mode: isDev,
        },
        measurementId: analytics?.google?.measurementId ?? '',
      }}
      postHogConfig={{
        debug: analytics?.posthog?.debug ?? false,
        enabled: !!analytics?.posthog?.key,
        capture_pageview: 'history_change',
        host: analytics?.posthog?.host ?? '',
        key: analytics?.posthog?.key ?? '',
        opt_out_capturing_by_default: true,
        opt_out_persistence_by_default: true,
        person_profiles: 'identified_only',
      }}
      xAdsConfig={{
        debug: isDev,
        eventIds: analytics?.xAds?.eventIds,
        enabled: !!analytics?.xAds?.pixelId,
        pixelId: analytics?.xAds?.pixelId ?? '',
        purchaseEventId: analytics?.xAds?.purchaseEventId,
      }}
    >
      {children}
    </LobeAnalyticsProvider>
  );
});

LobeAnalyticsProviderWrapper.displayName = 'LobeAnalyticsProviderWrapper';
