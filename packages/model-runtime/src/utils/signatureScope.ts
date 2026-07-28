import type { ModelSignatureScope } from '@lobechat/types';

import { safeParseJSON } from './safeParseJSON';

export type ModelSignatureScopeBase = Omit<ModelSignatureScope, 'model'>;

const SCOPED_SIGNATURE_PREFIX = 'lobe-scoped-signature-v1:';

/**
 * Keep RouterRuntime provenance off constructor options so unrelated provider SDKs
 * never receive internal routing metadata through an options spread.
 */
const runtimeSignatureScopes = new WeakMap<object, ModelSignatureScopeBase>();

export const setRuntimeSignatureScope = (runtime: object, scope: ModelSignatureScopeBase) => {
  runtimeSignatureScopes.set(runtime, scope);
};

export const getRuntimeSignatureScope = (runtime: object) => runtimeSignatureScopes.get(runtime);

export const createModelSignatureScope = (
  provider: string,
  model: string,
  base?: ModelSignatureScopeBase,
): ModelSignatureScope => ({
  provider,
  ...base,
  model,
});

export const isSameModelSignatureScope = (
  source: ModelSignatureScope,
  target: ModelSignatureScope,
) => {
  /**
   * Router options without a stable channel id cannot safely prove provenance.
   * Refuse replay instead of treating all anonymous fallback channels as equal.
   */
  if ((source.routerId || target.routerId) && (!source.channelId || !target.channelId))
    return false;

  return (
    source.provider === target.provider &&
    source.model === target.model &&
    source.apiType === target.apiType &&
    source.routerId === target.routerId &&
    source.channelId === target.channelId
  );
};

/**
 * Keep Gemini thought signatures on the existing string-only persistence path while
 * carrying enough provenance to prevent replay to another model, API type, or channel.
 * The raw provider signature is restored only after an exact scope match.
 */
export const serializeScopedSignature = (signature: string, scope: ModelSignatureScope) =>
  `${SCOPED_SIGNATURE_PREFIX}${JSON.stringify({ scope, signature })}`;

export const resolveScopedSignature = (
  value: string | undefined,
  target: ModelSignatureScope | undefined,
) => {
  if (!value) return undefined;
  if (!target) return value.startsWith(SCOPED_SIGNATURE_PREFIX) ? undefined : value;
  if (!value.startsWith(SCOPED_SIGNATURE_PREFIX)) return undefined;

  const parsed = safeParseJSON<{ scope?: ModelSignatureScope; signature?: string }>(
    value.slice(SCOPED_SIGNATURE_PREFIX.length),
  );
  if (
    !parsed?.scope ||
    typeof parsed.signature !== 'string' ||
    !isSameModelSignatureScope(parsed.scope, target)
  ) {
    return undefined;
  }

  return parsed.signature;
};
