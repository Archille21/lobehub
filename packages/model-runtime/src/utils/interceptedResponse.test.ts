import { describe, expect, it, vi } from 'vitest';

import { consumeStreamUntilDone } from './consumeStream';
import { createInterceptedTextResponse } from './interceptedResponse';

const readBody = async (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
};

describe('createInterceptedTextResponse', () => {
  it('drives onText so server-side consumers see the content', async () => {
    // The regression: draining the body is how the agent gateway consumes a
    // chat response, and it recovers the text purely through the callbacks.
    // A hand-rolled SSE stream leaves onText uncalled and the turn is reported
    // as ModelEmptyCompletion.
    const onText = vi.fn();
    const onFinal = vi.fn();

    const response = createInterceptedTextResponse('⚠️ 已被拦截', {
      callbacks: { onFinal, onText },
    });
    await consumeStreamUntilDone(response);

    expect(onText).toHaveBeenCalledWith('⚠️ 已被拦截');
    expect(onFinal).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: 'content_filter', text: '⚠️ 已被拦截' }),
    );
  });

  it('still emits SSE a browser client can parse', async () => {
    const body = await readBody(createInterceptedTextResponse('blocked'));

    expect(body).toContain('event: text\ndata: "blocked"\n\n');
    expect(body).toContain('event: stop\ndata: "content_filter"\n\n');
  });

  it('works without callbacks', async () => {
    const response = createInterceptedTextResponse('blocked');

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    await expect(consumeStreamUntilDone(response)).resolves.toBeUndefined();
  });

  it('lets the caller override the finish reason', async () => {
    const onFinal = vi.fn();
    await consumeStreamUntilDone(
      createInterceptedTextResponse('done', { callbacks: { onFinal }, finishReason: 'stop' }),
    );

    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ finishReason: 'stop' }));
  });
});
