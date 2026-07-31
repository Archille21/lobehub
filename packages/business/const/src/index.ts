import { BRANDING_PROVIDER } from './branding';

export * from './branding';
export * from './llm';
export * from './url';

export const ENABLE_BUSINESS_FEATURES = false;

/**
 * Master switch for the conversational agent-onboarding flow.
 *
 * Soft-disabled: kept in the codebase but permanently off, so onboarding always
 * falls back to the classic form flow (`deriveOnboardingBranchPath`) and the
 * agent-mode switch stays hidden (`ModeSwitch`). Flip back to `isDev` (or a real
 * flag) to revive it.
 */
export const AGENT_ONBOARDING_ENABLED = false;

/**
 * Whether the classic onboarding flow ends with the agent-marketplace picker.
 *
 * The picker lists templates fetched from the hosted marketplace
 * (`market.agent.getOnboardingFull`). A self-hosted deployment with no route to
 * that service can only ever render an empty grid, so the step is dead weight
 * there — turn this off and the flow finishes on the last form step instead.
 */
export const ONBOARDING_AGENT_PICKER_ENABLED = true;

export const OFFICIAL_PROVIDER_DISABLE_ERROR = 'The official provider cannot be disabled.';

export const isOfficialProvider = (id: string) =>
  ENABLE_BUSINESS_FEATURES && id === BRANDING_PROVIDER;
