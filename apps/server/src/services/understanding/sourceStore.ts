import { createHash } from 'node:crypto';

import {
  type CollectionDiagnostics,
  CollectionDiagnosticsSchema,
  MAX_COLLECTION_COUNT,
  MAX_SOURCE_PROVIDER_ID_LENGTH,
} from '@lobechat/types';
import type Redis from 'ioredis';
import { z } from 'zod';

import { getAgentRuntimeRedisClient } from '@/server/modules/AgentRuntime/redis';

import { MAX_SOURCE_BRIEF_LENGTH } from './sanitizer';

const SOURCE_STORE_PREFIX = 'onboarding_understanding:context';
const SOURCE_STORE_TTL_SECONDS = 3 * 24 * 60 * 60;

interface SessionReference {
  sessionId: string;
  userId: string;
}

interface SourceProviderReference extends SessionReference {
  revision: number;
  sourceProviderId: string;
}

export interface StoredUnderstandingSourceProviderContext {
  context: string;
  diagnostics: CollectionDiagnostics;
  revision: number;
  sourceCount: number;
  sourceProviderId: string;
}

const StoredUnderstandingSourceProviderContextSchema = z
  .object({
    context: z.string().max(MAX_SOURCE_BRIEF_LENGTH),
    diagnostics: CollectionDiagnosticsSchema,
    sourceProviderId: z.string().trim().min(1).max(MAX_SOURCE_PROVIDER_ID_LENGTH),
    revision: z.number().int().nonnegative().max(MAX_COLLECTION_COUNT),
    sourceCount: z.number().int().nonnegative().max(MAX_COLLECTION_COUNT),
  })
  .strict() satisfies z.ZodType<StoredUnderstandingSourceProviderContext>;

const digestIdentifier = (value: string): string => {
  if (!value || value.length > 512) throw new TypeError('Invalid Understanding source identifier');
  return createHash('sha256').update(value).digest('hex');
};

const sessionKey = ({ sessionId, userId }: SessionReference): string =>
  `${SOURCE_STORE_PREFIX}:{${digestIdentifier(userId)}}:session:${digestIdentifier(sessionId)}`;

const sourceProviderField = (sourceProviderId: string, revision: number): string =>
  `${z.string().trim().min(1).max(MAX_SOURCE_PROVIDER_ID_LENGTH).parse(sourceProviderId)}:${z.number().int().nonnegative().max(MAX_COLLECTION_COUNT).parse(revision)}`;

export class UnderstandingSourceStore {
  private readonly redis: Redis;

  constructor(redis: Redis | null = getAgentRuntimeRedisClient()) {
    if (!redis) throw new Error('Redis is not available for onboarding Understanding sources');
    this.redis = redis;
  }

  async deleteSession(reference: SessionReference): Promise<void> {
    try {
      await this.redis.del(sessionKey(reference));
    } catch {
      throw new Error('Failed to reset onboarding Understanding source provider contexts');
    }
  }

  async get(
    reference: SourceProviderReference,
  ): Promise<StoredUnderstandingSourceProviderContext | null> {
    try {
      const field = sourceProviderField(reference.sourceProviderId, reference.revision);
      const serialized = await this.redis.hget(sessionKey(reference), field);
      if (!serialized) return null;
      const stored = StoredUnderstandingSourceProviderContextSchema.parse(JSON.parse(serialized));
      if (
        stored.sourceProviderId !== reference.sourceProviderId ||
        stored.revision !== reference.revision ||
        sourceProviderField(stored.sourceProviderId, stored.revision) !== field
      ) {
        throw new Error('Stored source provider context does not match its reference');
      }
      return stored;
    } catch {
      throw new Error('Failed to read onboarding Understanding source provider context');
    }
  }

  async put(input: SessionReference & StoredUnderstandingSourceProviderContext): Promise<void> {
    try {
      const stored = StoredUnderstandingSourceProviderContextSchema.parse({
        context: input.context,
        diagnostics: input.diagnostics,
        sourceProviderId: input.sourceProviderId,
        revision: input.revision,
        sourceCount: input.sourceCount,
      });
      const key = sessionKey(input);
      await this.redis
        .multi()
        .hset(
          key,
          sourceProviderField(stored.sourceProviderId, stored.revision),
          JSON.stringify(stored),
        )
        .expire(key, SOURCE_STORE_TTL_SECONDS)
        .exec();
    } catch {
      throw new Error('Failed to persist onboarding Understanding source provider context');
    }
  }
}
