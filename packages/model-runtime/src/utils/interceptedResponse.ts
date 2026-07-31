import { createCallbacksTransformer } from '../core/streams/protocol';
import type { ChatStreamCallbacks } from '../types';
import { StreamingResponse } from './response';

/**
 * Build the response an `interceptChat` hook returns when it answers the
 * request itself instead of letting it reach the model.
 *
 * Hand-rolling `event: text\ndata: "..."` is not enough. `interceptChat`
 * short-circuits ModelRuntime.chat before the provider runtime runs, and the
 * provider runtime is where `createCallbacksTransformer` gets attached — so a
 * hand-built stream never fires `options.callback.onText`.
 *
 * Browser clients parse the raw SSE themselves and look fine, which is why this
 * goes unnoticed. Server-side consumers do not: the agent gateway drains the
 * body with `consumeStreamUntilDone` and reads the answer out of the callbacks,
 * so it sees no content at all and reports the turn as `ModelEmptyCompletion`.
 * Piping through the same transformer makes an intercepted answer
 * indistinguishable from a real completion on both paths.
 */
export const createInterceptedTextResponse = (
  text: string,
  options?: {
    callbacks?: ChatStreamCallbacks;
    /**
     * Reported to consumers as the provider finish reason. Defaults to
     * `content_filter`, the conventional code for "withheld by moderation" —
     * the case this helper exists for.
     */
    finishReason?: string;
    id?: string;
  },
) => {
  const id = options?.id ?? 'intercepted';
  const finishReason = options?.finishReason ?? 'content_filter';

  const stream = new ReadableStream<string>({
    start(controller) {
      // One field per chunk, matching createSSEProtocolTransformer: the
      // callbacks transformer tracks the current event type across chunks and
      // only recognises a line when it *starts* with `event:` / `data:`.
      // Emitting a whole event as one string silently parses as nothing.
      controller.enqueue(`id: ${id}\n`);
      controller.enqueue(`event: text\n`);
      controller.enqueue(`data: ${JSON.stringify(text)}\n\n`);

      controller.enqueue(`id: ${id}\n`);
      controller.enqueue(`event: stop\n`);
      controller.enqueue(`data: ${JSON.stringify(finishReason)}\n\n`);

      controller.close();
    },
  });

  return StreamingResponse(stream.pipeThrough(createCallbacksTransformer(options?.callbacks)));
};
