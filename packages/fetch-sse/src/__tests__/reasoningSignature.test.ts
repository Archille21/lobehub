import type { FetchEventSourceInit } from '@lobechat/utils/client/fetchEventSource/index';
import { fetchEventSource } from '@lobechat/utils/client/fetchEventSource/index';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchSSE } from '../fetchSSE';

vi.mock('@lobechat/model-runtime', () => ({
  parseToolCalls: vi.fn(),
}));

vi.mock('@lobechat/utils/client/fetchEventSource/index', () => ({
  fetchEventSource: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchSSE reasoning signatures', () => {
  it('should discard a reasoning signature without visible reasoning text', async () => {
    const mockOnFinish = vi.fn();

    (fetchEventSource as any).mockImplementationOnce(
      (url: string, options: FetchEventSourceInit) => {
        options.onopen!({ clone: () => ({ ok: true, headers: new Headers() }) } as any);
        options.onmessage!({
          data: JSON.stringify('encrypted-reasoning-content'),
          event: 'reasoning_signature',
        } as any);
        options.onmessage!({ data: JSON.stringify('Done'), event: 'text' } as any);
      },
    );

    await fetchSSE('/', {
      onFinish: mockOnFinish,
      responseAnimation: 'fadeIn',
    });

    expect(mockOnFinish).toHaveBeenCalledWith('Done', {
      observationId: null,
      reasoning: undefined,
      toolCalls: undefined,
      traceId: null,
      type: 'done',
    });
  });

  it('should preserve non-streaming response items with visible summary text', async () => {
    const mockOnFinish = vi.fn();
    const responseItem = {
      item: {
        encrypted_content: 'encrypted-reasoning-content',
        id: 'reasoning-1',
        summary: [{ text: 'Visible summary', type: 'summary_text' }],
        type: 'reasoning',
      },
      signatureScope: {
        model: 'gpt-5.6-sol',
        provider: 'chatgpt',
      },
    };

    (fetchEventSource as any).mockImplementationOnce(
      (url: string, options: FetchEventSourceInit) => {
        options.onopen!({ clone: () => ({ ok: true, headers: new Headers() }) } as any);
        options.onmessage!({
          data: JSON.stringify(responseItem),
          event: 'reasoning_signature',
        } as any);
        options.onmessage!({ data: JSON.stringify('Done'), event: 'text' } as any);
      },
    );

    await fetchSSE('/', {
      onFinish: mockOnFinish,
      responseAnimation: 'fadeIn',
    });

    expect(mockOnFinish).toHaveBeenCalledWith('Done', {
      observationId: null,
      reasoning: {
        content: 'Visible summary',
        responseItems: [responseItem],
        signature: undefined,
      },
      toolCalls: undefined,
      traceId: null,
      type: 'done',
    });
  });

  it('should preserve non-streaming response items without visible summary text', async () => {
    const mockOnFinish = vi.fn();
    const responseItem = {
      item: {
        encrypted_content: 'encrypted-reasoning-content',
        id: 'reasoning-1',
        summary: [],
        type: 'reasoning',
      },
      signatureScope: {
        model: 'gpt-5.6-sol',
        provider: 'chatgpt',
      },
    };

    (fetchEventSource as any).mockImplementationOnce(
      (url: string, options: FetchEventSourceInit) => {
        options.onopen!({ clone: () => ({ ok: true, headers: new Headers() }) } as any);
        options.onmessage!({
          data: JSON.stringify(responseItem),
          event: 'reasoning_signature',
        } as any);
        options.onmessage!({ data: JSON.stringify('Done'), event: 'text' } as any);
      },
    );

    await fetchSSE('/', {
      onFinish: mockOnFinish,
      responseAnimation: 'fadeIn',
    });

    expect(mockOnFinish).toHaveBeenCalledWith('Done', {
      observationId: null,
      reasoning: {
        content: undefined,
        responseItems: [responseItem],
        signature: undefined,
      },
      toolCalls: undefined,
      traceId: null,
      type: 'done',
    });
  });
});
