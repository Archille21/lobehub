import type { AiProviderModelListItem } from 'model-bank';

interface ResolveOAuthChatModelParams {
  checkModel?: string;
  models?: AiProviderModelListItem[];
}

export const resolveOAuthChatModel = ({
  checkModel,
  models,
}: ResolveOAuthChatModelParams): string | undefined => {
  const enabledChatModels = models?.filter((model) => model.enabled && model.type === 'chat') ?? [];

  if (checkModel && enabledChatModels.some((model) => model.id === checkModel)) return checkModel;

  return enabledChatModels[0]?.id ?? checkModel;
};

interface UpdateInboxAgentConfig {
  model: string;
  provider: string;
}

interface PrepareOAuthProviderChatParams extends ResolveOAuthChatModelParams {
  canManageProvider: boolean;
  inboxAgentId?: string;
  isProviderEnabled: boolean;
  providerId: string;
  toggleProviderEnabled: (providerId: string, enabled: boolean) => Promise<void>;
  updateInboxAgentConfig: (agentId: string, config: UpdateInboxAgentConfig) => Promise<void>;
}

export type PrepareOAuthProviderChatResult =
  | { error: unknown; status: 'enable-failed' }
  | { status: 'enable-required' }
  | { presetError?: unknown; status: 'ready' };

export const prepareOAuthProviderChat = async ({
  canManageProvider,
  checkModel,
  inboxAgentId,
  isProviderEnabled,
  models,
  providerId,
  toggleProviderEnabled,
  updateInboxAgentConfig,
}: PrepareOAuthProviderChatParams): Promise<PrepareOAuthProviderChatResult> => {
  if (!isProviderEnabled) {
    if (!canManageProvider) return { status: 'enable-required' };

    try {
      await toggleProviderEnabled(providerId, true);
    } catch (error) {
      return { error, status: 'enable-failed' };
    }
  }

  const targetModel = resolveOAuthChatModel({ checkModel, models });
  if (!inboxAgentId || !targetModel) return { status: 'ready' };

  try {
    await updateInboxAgentConfig(inboxAgentId, { model: targetModel, provider: providerId });
    return { status: 'ready' };
  } catch (presetError) {
    return { presetError, status: 'ready' };
  }
};
