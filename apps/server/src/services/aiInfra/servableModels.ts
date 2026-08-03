import { BRANDING_PROVIDER } from '@lobechat/business-const';
import type { LobeChatDatabase } from '@lobechat/database';
import type { ProviderConfig } from '@lobechat/types';

import { AiInfraRepos } from '@/database/repositories/aiInfra';
import { getServerGlobalConfig } from '@/server/globalConfig';

/**
 * One answer to "which chat models can this deployment actually run", shared by
 * every server-side tool that shows models to a model or accepts a model id
 * back from one.
 *
 * Two things make this easy to get wrong, and both have been got wrong:
 *
 * 1. **`ai_models` is not the catalogue.** It is the table of per-user
 *    *overrides*. A provider whose catalogue is served from configuration —
 *    the branded provider — has no rows there at all; `getEnabledModels`
 *    deliberately drops any that appear and sources its list from the model
 *    bank instead. Scanning the table therefore misses exactly the models a
 *    single-provider deployment serves, while happily returning models of
 *    providers that are switched off.
 *
 * 2. **Provider enablement does not live in the database.** The branded
 *    provider is enabled by server config (`getServerGlobalConfig().aiProvider`),
 *    not by an `ai_providers` row — its row is typically absent or disabled.
 *    Constructing `AiInfraRepos` with an empty provider-config map silently
 *    drops it from the enabled list, which looks identical to "the user has no
 *    models".
 *
 * Both failures degrade to an *empty* list rather than an error, and an
 * ungrounded model does not report that it was shown nothing — it invents ids
 * that read plausibly next to the model name (`bytedance` for a Doubao model),
 * and those get written to the agent as if they were real.
 */

export interface ServableModelInfo {
  abilities?: {
    files?: boolean;
    functionCall?: boolean;
    reasoning?: boolean;
    vision?: boolean;
  };
  description?: string;
  id: string;
  name: string;
}

export interface ServableProviderInfo {
  id: string;
  models: ServableModelInfo[];
  name: string;
}

/**
 * Build `AiInfraRepos` with the server's real provider configuration, so
 * config-enabled providers are visible. Never construct it with `{}` for
 * anything that needs to know what is enabled.
 */
export const createAiInfraRepos = async (
  db: LobeChatDatabase,
  userId: string,
  workspaceId?: string,
): Promise<AiInfraRepos> => {
  const { aiProvider } = await getServerGlobalConfig();

  return new AiInfraRepos(db, userId, aiProvider as Record<string, ProviderConfig>, workspaceId);
};

/**
 * Enabled chat models grouped by enabled provider — the same set the chat model
 * picker offers, so a tool can never advertise a model the user cannot select.
 *
 * The branded provider sorts first: on a single-provider deployment it is the
 * only answer, and where there are several it is the managed default.
 */
export const listServableChatProviders = async (
  repos: AiInfraRepos,
  options?: { maxProviders?: number },
): Promise<ServableProviderInfo[]> => {
  const [enabledProviders, enabledModels] = await Promise.all([
    repos.getUserEnabledProviderList(),
    repos.getEnabledModels(),
  ]);

  const chatModelsByProvider = new Map<string, ServableModelInfo[]>();
  for (const model of enabledModels) {
    if (model.type !== 'chat') continue;

    const list = chatModelsByProvider.get(model.providerId) ?? [];
    // No description: `EnabledAiModel` does not carry one, and the value that
    // happens to survive the merge at runtime is dropped for any model the user
    // has customised — so it would be present for some models and missing for
    // others with no way to tell which. Id, display name and abilities are what
    // the choice actually turns on, and they are always there.
    list.push({
      abilities: model.abilities,
      id: model.id,
      name: model.displayName || model.id,
    });
    chatModelsByProvider.set(model.providerId, list);
  }

  const providers = enabledProviders
    .map((provider) => ({
      id: provider.id,
      models: chatModelsByProvider.get(provider.id) ?? [],
      name: provider.name || provider.id,
    }))
    // A provider with no chat models is noise in the prompt and a trap in
    // validation — it would read as a legal choice with nothing to choose.
    .filter((provider) => provider.models.length > 0)
    .sort((a, b) => {
      if (a.id === b.id) return 0;
      if (a.id === BRANDING_PROVIDER) return -1;
      if (b.id === BRANDING_PROVIDER) return 1;
      return 0;
    });

  return options?.maxProviders ? providers.slice(0, options.maxProviders) : providers;
};

/**
 * Render the servable set as the operator-facing half of a tool error. The
 * model reads this and retries with a real id, so it has to carry the ids
 * themselves — "that provider is invalid" alone just produces another guess.
 */
export const describeServableChoices = (providers: ServableProviderInfo[]): string => {
  if (providers.length === 0)
    return 'No chat models are currently available — do not set model/provider.';

  return providers
    .map((provider) => `${provider.id}: ${provider.models.map((m) => m.id).join(', ')}`)
    .join(' | ');
};

/**
 * Reject a model/provider pair the deployment cannot run, before it reaches the
 * database.
 *
 * A grounded model still guesses sometimes, and nothing downstream catches it:
 * the pair is written verbatim and the agent looks fine until someone opens it
 * and finds the composer refusing to send. Returning the valid ids here turns a
 * silently broken agent into a retry the model can act on.
 *
 * Returns `null` when the pair is acceptable — which includes an omitted pair,
 * since that legitimately means "inherit the deployment default".
 */
export const validateServableModelSelection = (
  providers: ServableProviderInfo[],
  selection: { model?: string; provider?: string },
): string | null => {
  const { model, provider } = selection;

  if (!model && !provider) return null;

  // Half a pair cannot be validated and cannot be resolved: `provider` alone
  // leaves no model, and `model` alone silently falls back to the default
  // provider, which is how a valid model ends up pointing at a dead one.
  if (!model || !provider)
    return `Both \`model\` and \`provider\` must be given together. Available — ${describeServableChoices(providers)}`;

  const match = providers.find((p) => p.id === provider);
  if (!match)
    return `Unknown provider "${provider}". Available — ${describeServableChoices(providers)}`;

  if (!match.models.some((m) => m.id === model))
    return `Provider "${provider}" does not serve model "${model}". Available — ${describeServableChoices(providers)}`;

  return null;
};
