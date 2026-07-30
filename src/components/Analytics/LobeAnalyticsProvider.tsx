'use client';

import type { LobeUser } from '@lobechat/types';
import {
  type GoogleAnalyticsProviderConfig,
  type PostHogProviderAnalyticsConfig,
  type XAdsProviderAnalyticsConfig,
} from '@lobehub/analytics';
import { createSingletonAnalytics } from '@lobehub/analytics';
import { AnalyticsProvider } from '@lobehub/analytics/react';
import { type ReactNode } from 'react';
import { memo, useEffect, useRef, useState } from 'react';

import { BUSINESS_LINE } from '@/const/analytics';
import { isDesktop } from '@/const/version';

type Props = {
  captureEnabled: boolean;
  children: ReactNode;
  ga4Config: GoogleAnalyticsProviderConfig;
  postHogConfig: PostHogProviderAnalyticsConfig;
  user?: LobeUser | null;
  xAdsConfig: XAdsProviderAnalyticsConfig;
};

let analyticsInstance: ReturnType<typeof createSingletonAnalytics> | null = null;

export const LobeAnalyticsProvider = memo(
  ({ captureEnabled, children, ga4Config, postHogConfig, user, xAdsConfig }: Props) => {
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

      analytics
        .getProvider('posthog')
        ?.getNativeInstance()
        ?.register({
          platform: isDesktop ? 'desktop' : 'web',
        });

      if (user?.id) {
        void analytics.identify(user.id, {
          email: user.email,
          firstName: user.firstName,
          lastName: user.latestName,
          username: user.username,
        });
      }
    }, [
      analytics,
      captureEnabled,
      isInitialized,
      user?.email,
      user?.firstName,
      user?.id,
      user?.latestName,
      user?.username,
    ]);

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
