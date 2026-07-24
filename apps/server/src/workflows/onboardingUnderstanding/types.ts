import { z } from 'zod';

const identifierSchema = z.string().trim().min(1).max(512);
const sourceProviderIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);

/** Payload for collecting all selected Understanding source providers. */
export interface ProcessUnderstandingSourceProvidersPayload {
  /** Language required for the eventual user-visible proposal. */
  responseLanguage: string;
  sessionId: string;
  sourceProviders: UnderstandingSourceProviderAttempt[];
  topicId: string;
  userId: string;
}

/** One source provider collection attempt in an Understanding workflow. */
export interface UnderstandingSourceProviderAttempt {
  revision: number;
  sourceProviderId: string;
}

/** Payload for generating an Understanding proposal from collected sources. */
export interface ProcessCollectedUnderstandingPayload {
  /** Language required for every user-visible proposal field. */
  responseLanguage: string;
  sessionId: string;
  sourceFingerprint: string;
  topicId: string;
  userId: string;
}

export const ProcessUnderstandingSourceProvidersPayloadSchema = z
  .object({
    responseLanguage: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Z]{2,3}(?:-[A-Z0-9]{2,8})*$/i),
    sourceProviders: z
      .array(
        z
          .object({
            revision: z.number().int().positive().max(1_000_000),
            sourceProviderId: sourceProviderIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16)
      .refine(
        (sourceProviders) =>
          new Set(sourceProviders.map(({ sourceProviderId }) => sourceProviderId)).size ===
          sourceProviders.length,
        'Source provider attempts must be unique',
      ),
    sessionId: identifierSchema,
    topicId: identifierSchema,
    userId: identifierSchema,
  })
  .strict() satisfies z.ZodType<ProcessUnderstandingSourceProvidersPayload>;

export const ProcessCollectedUnderstandingPayloadSchema = z
  .object({
    responseLanguage: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Z]{2,3}(?:-[A-Z0-9]{2,8})*$/i),
    sessionId: identifierSchema,
    sourceFingerprint: z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[\w-]+@\d+(,[\w-]+@\d+)*$/),
    topicId: identifierSchema,
    userId: identifierSchema,
  })
  .strict() satisfies z.ZodType<ProcessCollectedUnderstandingPayload>;

const flowKeyPart = (value: string) => value.replaceAll(/[^\w.-]/g, '_');

export const getUnderstandingWritingFlowControlKey = (sessionId: string) =>
  `onboarding-understanding.writing.${flowKeyPart(sessionId)}`;
