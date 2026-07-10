import { z } from 'zod';

import { ChatTtftMetricModel } from '@/database/models/chatTtftMetric';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { ttftTraceEnabled } from '@/server/modules/TtftTrace';

const ttftProcedure = authedProcedure.use(serverDatabase).use(({ ctx, next }) => {
  return next({
    ctx: { chatTtftMetricModel: new ChatTtftMetricModel(ctx.serverDB, ctx.userId) },
  });
});

/**
 * Client-side writer of the chat TTFT mini-trace (see `chat_ttft_metrics`).
 *
 * The client contributes only its own clock domain: spans measured from the
 * Enter keypress plus the end-to-end `ttftMs`. Dimensions (model / topic /
 * message ids) come from the two server writers; the row is merged on
 * `operationId` by ChatTtftMetricModel.upsert.
 */
export const chatTtftMetricRouter = router({
  report: ttftProcedure
    .input(
      z.object({
        operationId: z.string().min(1).max(128),
        spans: z
          .array(
            z.object({
              /** Client spans stay in the client clock domain by contract. */
              clock: z.literal('client'),
              durationMs: z.number().int().min(0).optional(),
              key: z.string().min(1).max(64),
              meta: z.record(z.string(), z.unknown()).optional(),
              offsetMs: z.number().int(),
            }),
          )
          .max(30)
          .default([]),
        /** Enter keypress → first rendered content delta, all on the client clock. */
        ttftMs: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ttftTraceEnabled()) return { ok: true as const };

      await ctx.chatTtftMetricModel.upsert({
        operationId: input.operationId,
        spans: input.spans,
        ttftMs: input.ttftMs,
      });

      return { ok: true as const };
    }),
});
