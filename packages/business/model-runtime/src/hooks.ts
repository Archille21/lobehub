import type { ModelRuntimeHooks } from '@lobechat/model-runtime';

/**
 * Business slot for ModelRuntime lifecycle hooks.
 *
 * The OSS default is a no-op. Commercial/enterprise distributions override this
 * package via pnpm overrides (`@lobechat/business-model-runtime` →
 * `@cloud/...` / `@enterprise/...`) to inject billing, tracing, or content
 * moderation hooks (`interceptChat` / `transformChatResponse`) without
 * touching the app source.
 */
export function getBusinessModelRuntimeHooks(
  _userId: string,
  _provider: string,
  _workspaceId?: string,
): ModelRuntimeHooks | undefined {
  return undefined;
}
