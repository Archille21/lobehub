import { useCallback } from 'react';
import { useNavigate } from 'react-router';

import type { OnboardingFlow, OnboardingStepPayload } from '@/services/onboardingMetrics';
import {
  trackOnboardingCompleted,
  trackOnboardingStepCompleted,
} from '@/services/onboardingMetrics';
import { useUserStore } from '@/store/user';
import { consumeOnboardingCallbackUrl } from '@/utils/onboardingRedirect';

/**
 * Mark onboarding finished and leave for wherever the user was originally
 * headed.
 *
 * Extracted from AgentPickerStep, which used to be the only caller of
 * `finishOnboarding`. That made the picker load-bearing: with it disabled
 * (ONBOARDING_AGENT_PICKER_ENABLED) nothing would ever set `finishedAt`, so
 * every sign-in would drop the user back into onboarding. Whichever step ends
 * up last has to be able to finish the flow.
 *
 * `stepPayload` is emitted between the store write and the completion event so
 * the metrics ordering stays step-completed → onboarding-completed → navigate.
 */
export const useFinishOnboarding = (flow: Exclude<OnboardingFlow, 'common'>) => {
  const navigate = useNavigate();
  const finishOnboarding = useUserStore((s) => s.finishOnboarding);

  return useCallback(
    async (stepPayload?: OnboardingStepPayload) => {
      await finishOnboarding();

      if (stepPayload) trackOnboardingStepCompleted(stepPayload);

      // Restore the original signup target (threaded through onboarding), if any.
      const targetUrl = consumeOnboardingCallbackUrl() || '/';
      trackOnboardingCompleted({ flow, targetUrl });
      navigate(targetUrl);
    },
    [finishOnboarding, flow, navigate],
  );
};
