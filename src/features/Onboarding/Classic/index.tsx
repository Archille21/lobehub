'use client';

import { ONBOARDING_AGENT_PICKER_ENABLED } from '@lobechat/business-const';
import { CLASSIC_ONBOARDING_MAX_STEP } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { memo, useCallback, useEffect, useRef } from 'react';
import { Navigate, useNavigate } from 'react-router';

import Loading from '@/components/Loading/BrandTextLoading';
import { useFinishOnboarding } from '@/features/Onboarding/useFinishOnboarding';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useOnboardingAgentTemplates } from '@/hooks/useOnboardingAgentTemplates';
import OnboardingContainer from '@/routes/onboarding/_layout';
import AgentPickerStep from '@/routes/onboarding/features/AgentPickerStep';
import FullNameStep from '@/routes/onboarding/features/FullNameStep';
import InterestsStep from '@/routes/onboarding/features/InterestsStep';
import ProSettingsStep from '@/routes/onboarding/features/ProSettingsStep';
import {
  trackOnboardingStepCompleted,
  trackOnboardingStepViewed,
} from '@/services/onboardingMetrics';
import { serverConfigSelectors, useServerConfigStore } from '@/store/serverConfig';
import { useUserStore } from '@/store/user';
import { onboardingSelectors } from '@/store/user/selectors';

import { isLegacyClassicStep, remapLegacyClassicStep } from './legacyStep';

const INTERESTS_STEP = 2;
const PRO_SETTINGS_STEP = 3;

const CLASSIC_STEP_TRACKING = {
  1: { flow: 'classic', step: 'fullname', stepIndex: 1 },
  [INTERESTS_STEP]: { flow: 'classic', step: 'interests', stepIndex: 2 },
  [PRO_SETTINGS_STEP]: { flow: 'classic', step: 'prosettings', stepIndex: 3 },
  [CLASSIC_ONBOARDING_MAX_STEP]: { flow: 'classic', step: 'agentpicker', stepIndex: 4 },
} as const;

const getClassicStepTrackingPayload = (step: number) =>
  CLASSIC_STEP_TRACKING[step as keyof typeof CLASSIC_STEP_TRACKING];

const ClassicOnboardingPage = memo(() => {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [
    isUserStateInit,
    commonStepsCompleted,
    currentStep,
    goToNextStep,
    goToPreviousStep,
    setOnboardingStep,
  ] = useUserStore((s) => [
    s.isUserStateInit,
    onboardingSelectors.commonStepsCompleted(s),
    onboardingSelectors.currentStep(s),
    s.goToNextStep,
    s.goToPreviousStep,
    s.setOnboardingStep,
  ]);
  const enableComposio = useServerConfigStore(serverConfigSelectors.enableComposio);
  const serverConfigInit = useServerConfigStore((s) => s.serverConfigInit);
  const shouldSkipProSettingsStep = serverConfigInit && !enableComposio;
  const autoSkippedStepKeysRef = useRef<Set<string>>(new Set());
  const viewedStepKeysRef = useRef<Set<string>>(new Set());
  const legacyRemappedRef = useRef(false);

  // Which step the user actually lands on last, and therefore which "next"
  // finishes onboarding rather than advancing. Without the agent picker the
  // flow ends on pro-settings — or on interests, since pro-settings is itself
  // auto-skipped when Composio is off.
  const lastStep = ONBOARDING_AGENT_PICKER_ENABLED
    ? CLASSIC_ONBOARDING_MAX_STEP
    : shouldSkipProSettingsStep
      ? INTERESTS_STEP
      : PRO_SETTINGS_STEP;

  const finishOnboarding = useFinishOnboarding('classic');

  // Prefetching the marketplace is only worth a request when the picker can
  // actually render it; otherwise it is a guaranteed-failing call on a network
  // that cannot reach the hosted service.
  useOnboardingAgentTemplates(
    ONBOARDING_AGENT_PICKER_ENABLED && isUserStateInit && commonStepsCompleted,
  );

  useEffect(() => {
    if (!isUserStateInit || legacyRemappedRef.current) return;
    legacyRemappedRef.current = true;
    if (isLegacyClassicStep(currentStep)) {
      void setOnboardingStep(remapLegacyClassicStep(currentStep));
    }
  }, [currentStep, isUserStateInit, setOnboardingStep]);

  const renderableStep = isLegacyClassicStep(currentStep)
    ? remapLegacyClassicStep(currentStep)
    : currentStep;

  // FullNameStep is the branch's first step, so its back button leaves the
  // branch and re-enters the shared prefix's ResponseLanguageStep (step 2).
  const backToResponseLanguageStep = useCallback(() => {
    navigate('/onboarding?step=2', { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (
      !isUserStateInit ||
      !commonStepsCompleted ||
      currentStep !== PRO_SETTINGS_STEP ||
      !shouldSkipProSettingsStep ||
      // Nothing follows pro-settings, so there is no step to skip *to* — the
      // stale-step effect below finishes the flow instead of advancing into a
      // step that no longer renders.
      lastStep <= PRO_SETTINGS_STEP
    ) {
      return;
    }

    const payload = CLASSIC_STEP_TRACKING[PRO_SETTINGS_STEP];
    if (autoSkippedStepKeysRef.current.has(payload.step)) return;

    autoSkippedStepKeysRef.current.add(payload.step);
    trackOnboardingStepCompleted({
      ...payload,
      action: 'auto_skip',
      skipped: true,
    });
    goToNextStep();
  }, [
    commonStepsCompleted,
    currentStep,
    goToNextStep,
    isUserStateInit,
    lastStep,
    shouldSkipProSettingsStep,
  ]);

  // A persisted `currentStep` can point past the last step that still exists —
  // a user who was mid-flow when the agent picker was turned off, the legacy
  // remap in the shared prefix, or an `?entry=skip` link that jumps to the end.
  // Finish rather than render nothing; otherwise onboarding is a dead screen
  // the user can never leave.
  const staleStepHandledRef = useRef(false);
  useEffect(() => {
    if (!isUserStateInit || !commonStepsCompleted || !serverConfigInit) return;
    if (currentStep <= lastStep || staleStepHandledRef.current) return;

    staleStepHandledRef.current = true;
    void finishOnboarding();
  }, [
    commonStepsCompleted,
    currentStep,
    finishOnboarding,
    isUserStateInit,
    lastStep,
    serverConfigInit,
  ]);

  useEffect(() => {
    if (!isUserStateInit || !commonStepsCompleted) return;
    if (currentStep === PRO_SETTINGS_STEP && (!serverConfigInit || shouldSkipProSettingsStep)) {
      return;
    }

    const payload = getClassicStepTrackingPayload(currentStep);
    if (!payload || viewedStepKeysRef.current.has(payload.step)) return;

    viewedStepKeysRef.current.add(payload.step);
    trackOnboardingStepViewed(payload);
  }, [
    commonStepsCompleted,
    currentStep,
    isUserStateInit,
    serverConfigInit,
    shouldSkipProSettingsStep,
  ]);

  const goToNextStepFromFullName = useCallback(() => {
    trackOnboardingStepCompleted(CLASSIC_STEP_TRACKING[1]);
    goToNextStep();
  }, [goToNextStep]);

  const goToNextStepFromInterests = useCallback(() => {
    const payload = shouldSkipProSettingsStep
      ? { ...CLASSIC_STEP_TRACKING[INTERESTS_STEP], skippedNextStep: 'prosettings' }
      : CLASSIC_STEP_TRACKING[INTERESTS_STEP];

    // Last step: finishOnboarding emits the step event itself, so the store
    // write lands before it — same ordering the agent picker always had.
    if (lastStep === INTERESTS_STEP) {
      void finishOnboarding(payload);
      return;
    }

    trackOnboardingStepCompleted(payload);

    if (shouldSkipProSettingsStep) {
      goToNextStep();
      goToNextStep();
      return;
    }

    goToNextStep();
  }, [finishOnboarding, goToNextStep, lastStep, shouldSkipProSettingsStep]);

  const goToNextStepFromProSettings = useCallback(() => {
    if (lastStep === PRO_SETTINGS_STEP) {
      void finishOnboarding(CLASSIC_STEP_TRACKING[PRO_SETTINGS_STEP]);
      return;
    }

    trackOnboardingStepCompleted(CLASSIC_STEP_TRACKING[PRO_SETTINGS_STEP]);
    goToNextStep();
  }, [finishOnboarding, goToNextStep, lastStep]);

  const goToPreviousStepFromAgentPicker = useCallback(() => {
    if (shouldSkipProSettingsStep) {
      goToPreviousStep();
      goToPreviousStep();
      return;
    }

    goToPreviousStep();
  }, [goToPreviousStep, shouldSkipProSettingsStep]);

  if (!isUserStateInit) {
    return <Loading debugId="ClassicOnboarding" />;
  }

  if (!commonStepsCompleted) {
    return <Navigate replace to="/onboarding" />;
  }

  const renderStep = () => {
    switch (renderableStep) {
      case 1: {
        return (
          <FullNameStep onBack={backToResponseLanguageStep} onNext={goToNextStepFromFullName} />
        );
      }
      case INTERESTS_STEP: {
        return <InterestsStep onBack={goToPreviousStep} onNext={goToNextStepFromInterests} />;
      }
      case PRO_SETTINGS_STEP: {
        if (!serverConfigInit) return <Loading debugId="ClassicOnboarding/serverConfig" />;
        if (shouldSkipProSettingsStep) {
          // Transient either way — the auto-skip effect advances, or, when this
          // is already past the last step, the stale-step effect finishes.
          return lastStep <= PRO_SETTINGS_STEP ? (
            <Loading debugId="ClassicOnboarding/finishing" />
          ) : null;
        }

        return <ProSettingsStep onBack={goToPreviousStep} onNext={goToNextStepFromProSettings} />;
      }
      case CLASSIC_ONBOARDING_MAX_STEP: {
        // Only reachable with the picker off via a stale persisted step; the
        // stale-step effect is already finishing the flow.
        if (!ONBOARDING_AGENT_PICKER_ENABLED) {
          return <Loading debugId="ClassicOnboarding/finishing" />;
        }

        return <AgentPickerStep onBack={goToPreviousStepFromAgentPicker} />;
      }
      default: {
        return null;
      }
    }
  };

  const contentMaxWidth = renderableStep === CLASSIC_ONBOARDING_MAX_STEP ? 780 : 600;

  return (
    <OnboardingContainer>
      <Flexbox
        gap={24}
        paddingInline={isMobile ? 16 : 0}
        style={{ maxWidth: contentMaxWidth, width: '100%' }}
      >
        {renderStep()}
      </Flexbox>
    </OnboardingContainer>
  );
});

ClassicOnboardingPage.displayName = 'ClassicOnboardingPage';

export default ClassicOnboardingPage;
