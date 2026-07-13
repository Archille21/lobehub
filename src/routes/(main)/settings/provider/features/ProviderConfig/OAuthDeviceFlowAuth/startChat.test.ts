import type { AiProviderModelListItem } from 'model-bank';
import { describe, expect, it, vi } from 'vitest';

import { prepareOAuthProviderChat, resolveOAuthChatModel } from './startChat';

const createModel = (
  id: string,
  overrides: Partial<AiProviderModelListItem> = {},
): AiProviderModelListItem => ({ enabled: true, id, type: 'chat', ...overrides });

describe('resolveOAuthChatModel', () => {
  it('falls back to the provider check model while its model list is unavailable', () => {
    expect(resolveOAuthChatModel({ checkModel: 'check-model' })).toBe('check-model');
  });

  it('prefers an enabled check model from the current provider list', () => {
    expect(
      resolveOAuthChatModel({
        checkModel: 'check-model',
        models: [createModel('first-model'), createModel('check-model')],
      }),
    ).toBe('check-model');
  });

  it('uses the first enabled chat model when the check model is unavailable', () => {
    expect(
      resolveOAuthChatModel({
        checkModel: 'disabled-check-model',
        models: [
          createModel('disabled-check-model', { enabled: false }),
          createModel('image-model', { type: 'image' }),
          createModel('chat-model'),
        ],
      }),
    ).toBe('chat-model');
  });
});

describe('prepareOAuthProviderChat', () => {
  it('blocks chat preparation when enabling the provider fails', async () => {
    const error = new Error('enable failed');
    const toggleProviderEnabled = vi.fn().mockRejectedValue(error);
    const updateInboxAgentConfig = vi.fn();

    const result = await prepareOAuthProviderChat({
      canManageProvider: true,
      checkModel: 'check-model',
      inboxAgentId: 'inbox',
      isProviderEnabled: false,
      providerId: 'supergrok',
      toggleProviderEnabled,
      updateInboxAgentConfig,
    });

    expect(result).toEqual({ error, status: 'enable-failed' });
    expect(updateInboxAgentConfig).not.toHaveBeenCalled();
  });

  it('blocks chat preparation when a disabled provider cannot be managed', async () => {
    const toggleProviderEnabled = vi.fn();
    const updateInboxAgentConfig = vi.fn();

    const result = await prepareOAuthProviderChat({
      canManageProvider: false,
      checkModel: 'check-model',
      inboxAgentId: 'inbox',
      isProviderEnabled: false,
      providerId: 'supergrok',
      toggleProviderEnabled,
      updateInboxAgentConfig,
    });

    expect(result).toEqual({ status: 'enable-required' });
    expect(toggleProviderEnabled).not.toHaveBeenCalled();
    expect(updateInboxAgentConfig).not.toHaveBeenCalled();
  });

  it('keeps chat preparation ready when presetting the model fails', async () => {
    const presetError = new Error('preset failed');

    const result = await prepareOAuthProviderChat({
      canManageProvider: true,
      checkModel: 'check-model',
      inboxAgentId: 'inbox',
      isProviderEnabled: true,
      providerId: 'supergrok',
      toggleProviderEnabled: vi.fn(),
      updateInboxAgentConfig: vi.fn().mockRejectedValue(presetError),
    });

    expect(result).toEqual({ presetError, status: 'ready' });
  });

  it('keeps chat preparation ready when there is no model to preset', async () => {
    const updateInboxAgentConfig = vi.fn();

    const result = await prepareOAuthProviderChat({
      canManageProvider: true,
      inboxAgentId: 'inbox',
      isProviderEnabled: true,
      providerId: 'supergrok',
      toggleProviderEnabled: vi.fn(),
      updateInboxAgentConfig,
    });

    expect(result).toEqual({ status: 'ready' });
    expect(updateInboxAgentConfig).not.toHaveBeenCalled();
  });

  it('presets the current provider model after enabling succeeds', async () => {
    const toggleProviderEnabled = vi.fn().mockResolvedValue(undefined);
    const updateInboxAgentConfig = vi.fn().mockResolvedValue(undefined);

    const result = await prepareOAuthProviderChat({
      canManageProvider: true,
      checkModel: 'check-model',
      inboxAgentId: 'inbox',
      isProviderEnabled: false,
      models: [createModel('current-provider-model')],
      providerId: 'supergrok',
      toggleProviderEnabled,
      updateInboxAgentConfig,
    });

    expect(result).toEqual({ status: 'ready' });
    expect(toggleProviderEnabled).toHaveBeenCalledWith('supergrok', true);
    expect(updateInboxAgentConfig).toHaveBeenCalledWith('inbox', {
      model: 'current-provider-model',
      provider: 'supergrok',
    });
  });
});
