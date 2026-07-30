import type { PostHogProviderAnalyticsConfig } from '@lobehub/analytics';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useUserStore } from '@/store/user';
import type { SPAServerConfig } from '@/types/spaServerConfig';

import { LobeAnalyticsProviderWrapper } from './LobeAnalyticsProviderWrapper';

const providerMock = vi.hoisted(() => ({
  props: undefined as
    | {
        captureEnabled: boolean;
        children: ReactNode;
        postHogConfig: PostHogProviderAnalyticsConfig;
      }
    | undefined,
}));

vi.mock('@/components/Analytics/LobeAnalyticsProvider', () => ({
  LobeAnalyticsProvider: (props: {
    captureEnabled: boolean;
    children: ReactNode;
    postHogConfig: PostHogProviderAnalyticsConfig;
  }) => {
    providerMock.props = props;
    return props.children;
  },
}));

const serverConfig = {
  analyticsConfig: {
    posthog: {
      debug: true,
      host: 'https://posthog.example.com',
      key: 'ph-key',
    },
  },
} as SPAServerConfig;

beforeEach(() => {
  providerMock.props = undefined;
  window.__SERVER_CONFIG__ = serverConfig;
  useUserStore.setState({
    isUserStateInit: true,
    settings: { general: { telemetry: true } },
    user: {
      email: 'user@example.com',
      id: 'user-id',
    },
  });
});

afterEach(() => {
  cleanup();
  window.__SERVER_CONFIG__ = undefined;
  useUserStore.setState({
    isUserStateInit: false,
    settings: {},
    user: undefined,
  });
});

describe('LobeAnalyticsProviderWrapper', () => {
  it('starts PostHog opted out and enables capture only after explicit consent is loaded', () => {
    render(
      <LobeAnalyticsProviderWrapper>
        <div>Analytics child</div>
      </LobeAnalyticsProviderWrapper>,
    );

    expect(screen.getByText('Analytics child')).toBeInTheDocument();
    expect(providerMock.props?.captureEnabled).toBe(true);
    expect(providerMock.props).not.toHaveProperty('user');
    expect(providerMock.props?.postHogConfig).toMatchObject({
      autocapture: false,
      capture_pageleave: false,
      capture_pageview: false,
      debug: true,
      disable_session_recording: true,
      enabled: true,
      host: 'https://posthog.example.com',
      key: 'ph-key',
      mask_all_element_attributes: true,
      mask_all_text: true,
      mask_personal_data_properties: true,
      opt_out_capturing_by_default: true,
      opt_out_persistence_by_default: true,
      person_profiles: 'never',
      property_denylist: expect.arrayContaining([
        '$current_url',
        '$initial_current_url',
        '$initial_ph_keyword',
        '$pathname',
        '$referrer',
        'ph_keyword',
        'title',
      ]),
      save_campaign_params: false,
      save_referrer: false,
    });
  });

  it('keeps capture disabled until user state initialization completes', () => {
    useUserStore.setState({ isUserStateInit: false });

    render(
      <LobeAnalyticsProviderWrapper>
        <div>Analytics child</div>
      </LobeAnalyticsProviderWrapper>,
    );

    expect(providerMock.props?.captureEnabled).toBe(false);
  });
});
