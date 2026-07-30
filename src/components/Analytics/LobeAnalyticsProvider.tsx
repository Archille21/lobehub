'use client';

import type {
  GoogleAnalyticsProviderConfig,
  PostHogProviderAnalyticsConfig,
  XAdsProviderAnalyticsConfig,
} from '@lobehub/analytics';
import { createSingletonAnalytics } from '@lobehub/analytics';
import { AnalyticsProvider } from '@lobehub/analytics/react';
import type { ReactNode } from 'react';
import { memo, useEffect, useRef, useState } from 'react';

import { BUSINESS_LINE } from '@/const/analytics';
import { isDesktop } from '@/const/version';

type Props = {
  captureEnabled: boolean;
  children: ReactNode;
  ga4Config: GoogleAnalyticsProviderConfig;
  postHogConfig: PostHogProviderAnalyticsConfig;
  xAdsConfig: XAdsProviderAnalyticsConfig;
};

let analyticsInstance: ReturnType<typeof createSingletonAnalytics> | null = null;

export const LobeAnalyticsProvider = memo(
  ({ captureEnabled, children, ga4Config, postHogConfig, xAdsConfig }: Props) => {
    const analyticsRef = useRef<ReturnType<typeof createSingletonAnalytics> | null>(null);
    const [isInitialized, setIsInitialized] = useState(false);

    if (!analyticsRef.current) {
      analyticsRef.current =
        analyticsInstance ||
        createSingletonAnalytics({
          business: BUSINESS_LINE,
          captureEnabled,
          // Keep the manager-level logs (`[AnalyticsManager] ...`) quiet even in dev
          debug: false,
          providers: {
            ga4: ga4Config,
            posthog: postHogConfig,
            xAds: xAdsConfig,
          },
        });

      analyticsInstance = analyticsRef.current;
    }

    const analytics = analyticsRef.current;

    useEffect(() => {
      if (!analytics || !isInitialized || !captureEnabled) return;

      // Privacy boundary: telemetry consent covers anonymous product-usage metrics only.
      // Never call `identify` or attach account/profile fields here, even after consent.
      // The shared manager fans identification out to every configured provider, including GA4.
      analytics
        .getProvider('posthog')
        ?.getNativeInstance()
        ?.register({
          platform: isDesktop ? 'desktop' : 'web',
        });
    }, [analytics, captureEnabled, isInitialized]);

    if (!analytics) return children;

    return (
      <AnalyticsProvider
        captureEnabled={captureEnabled}
        client={analytics}
        onInitializeSuccess={() => {
          analyticsInstance?.setGlobalContext({
            platform: isDesktop ? 'desktop' : 'web',
          });
          setIsInitialized(true);
        }}
      >
        {children}
      </AnalyticsProvider>
    );
  },
);
