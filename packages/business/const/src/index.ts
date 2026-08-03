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

/**
 * Whether the assistant is told it can connect third-party services.
 *
 * The credentials tool advertises two catalogues to the model: the built-in
 * OAuth providers (GitHub, Linear, Microsoft, Notion, X) and the Composio
 * integrations (Gmail, Google Calendar, Slack, …). Both are advertised
 * unconditionally — the Composio guidelines name services even when no
 * COMPOSIO_API_KEY is configured — so a deployment that ships none of them
 * still has an assistant claiming it can read the user's mail.
 *
 * Turning this off drops those sections from the system prompt *and* the
 * corresponding tool entries from the manifest. Local credential management
 * (saveCreds, sandbox injection) is unaffected.
 */
export const EXTERNAL_INTEGRATIONS_ENABLED = true;

/**
 * Whether this distribution ships a desktop build users can download.
 *
 * The web app offers the desktop app in several places — the execution-target
 * menu (both the header link and the empty-state card), the platform-agent
 * creation hint, and the device-connect wizard. They all point at
 * `DOWNLOAD_URL`, which serves the official build. A distribution that has no
 * desktop build of its own must not send users there, so turn this off and
 * every one of those entry points disappears.
 *
 * Local execution itself is untouched: a desktop client that already exists
 * still enrolls and runs normally. This only governs the *download* offer.
 */
export const DESKTOP_APP_ENABLED = true;

/**
 * Whether the home composer shows the "New" model shortcut row.
 *
 * The row is a hardcoded editorial list (`starterModels.ts`) — the freshest
 * chat/image/video models at release time. It is not derived from the models a
 * deployment actually serves, so on any deployment with its own model
 * catalogue the buttons are dead: clicking one writes a model id the provider
 * has never heard of. Turn it off where the catalogue is deployment-specific.
 */
export const HOME_MODEL_SHOWCASE_ENABLED = true;

export const OFFICIAL_PROVIDER_DISABLE_ERROR = 'The official provider cannot be disabled.';

export const isOfficialProvider = (id: string) =>
  ENABLE_BUSINESS_FEATURES && id === BRANDING_PROVIDER;
