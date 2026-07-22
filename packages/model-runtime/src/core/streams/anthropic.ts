import type Anthropic from '@anthropic-ai/sdk';
import type { Stream } from '@anthropic-ai/sdk/streaming';
import type { ChatCitationItem } from '@lobechat/types';

import type { ChatStreamCallbacks } from '../../types';
import { isDeepSeekThinkingEligibleModel } from '../../utils/modelParse';
import { convertAnthropicUsage } from '../usageConverters';
import type {
  ChatPayloadForTransformStream,
  StreamContext,
  StreamProtocolChunk,
  StreamProtocolToolCallChunk,
  StreamToolCallChunkData,
} from './protocol';
import {
  convertIterableToStream,
  createCallbacksTransformer,
  createSSEProtocolTransformer,
  createTokenSpeedCalculator,
} from './protocol';

export const transformAnthropicStream = (
  chunk: Anthropic.MessageStreamEvent,
  context: StreamContext,
  payload?: ChatPayloadForTransformStream,
): StreamProtocolChunk | StreamProtocolChunk[] => {
  // maybe need another structure to add support for multiple choices
  switch (chunk.type) {
    case 'message_start': {
      context.id = chunk.message.id;
      context.returnedCitationArray = [];
      const usage = convertAnthropicUsage(chunk, undefined, payload);

      if (usage) {
        context.usage = usage;
      } else {
        delete context.usage;
      }

      return { data: chunk.message, id: chunk.message.id, type: 'data' };
    }
    case 'content_block_start': {
      switch (chunk.content_block.type) {
        case 'redacted_thinking': {
          return {
            data: chunk.content_block.data,
            id: context.id,
            type: 'flagged_reasoning_signature',
          };
        }

        case 'text': {
          return { data: chunk.content_block.text, id: context.id, type: 'data' };
        }

        case 'server_tool_use':
        case 'tool_use': {
          const toolChunk = chunk.content_block;

          // if toolIndex is not defined, set it to 0
          if (typeof context.toolIndex === 'undefined') {
            context.toolIndex = 0;
          }
          // if toolIndex is defined, increment it
          else {
            context.toolIndex += 1;
          }

          const toolCall: StreamToolCallChunkData = {
            function: {
              arguments: '',
              name: toolChunk.name,
            },
            id: toolChunk.id,
            index: context.toolIndex,
            type: 'function',
          };

          context.tool = { id: toolChunk.id, index: context.toolIndex, name: toolChunk.name };

          return { data: [toolCall], id: context.id, type: 'tool_calls' };
        }

        /*
        case 'web_search_tool_result': {
          const citations = chunk.content_block.content;

          return [
            {
              data: {
                citations: (citations as any[]).map(
                  (item) =>
                    ({
                      title: item.title,
                      url: item.url,
                    }) as CitationItem,
                ),
              },
              id: context.id,
              type: 'grounding',
            },
          ];
        }
        */

        case 'thinking': {
          const thinkingChunk = chunk.content_block;

          if (typeof thinkingChunk.thinking === 'string' && thinkingChunk.thinking.trim()) {
            context.receivedNonEmptyReasoning = true;
          }

          // if there is signature in the thinking block, return both thinking and signature
          if (!!thinkingChunk.signature) {
            return [
              { data: thinkingChunk.thinking, id: context.id, type: 'reasoning' },
              { data: thinkingChunk.signature, id: context.id, type: 'reasoning_signature' },
            ];
          }

          if (typeof thinkingChunk.thinking === 'string')
            return { data: thinkingChunk.thinking, id: context.id, type: 'reasoning' };

          return { data: thinkingChunk, id: context.id, type: 'data' };
        }

        default: {
          break;
        }
      }

      return { data: chunk, id: context.id, type: 'data' };
    }

    case 'content_block_delta': {
      switch (chunk.delta.type) {
        case 'text_delta': {
          const text = chunk.delta.text;

          // DeepSeek's anthropic-compatible endpoint prefills `<think>` server-side; when its
          // parser fails to capture the reasoning into a thinking block, the raw tokens leak
          // into the text channel as `reasoning…</think>answer` — closing tag only, thinking
          // block empty. Split such deltas so the literal tag never reaches user-visible
          // content. Gated to DeepSeek thinking models with no real reasoning received and no
          // literal `<think>` seen, so ordinary content that merely mentions the closing tag
          // (after a real thinking block, or alongside the opening tag) is left untouched.
          if (
            typeof text === 'string' &&
            isDeepSeekThinkingEligibleModel(payload?.model) &&
            !context.receivedNonEmptyReasoning &&
            !context.sawLiteralThinkOpenTag
          ) {
            if (text.includes('<think>')) {
              context.sawLiteralThinkOpenTag = true;
            } else if (text.includes('</think>')) {
              const [leakedReasoning, ...rest] = text.split('</think>');
              const afterThink = rest.join('</think>');

              // reasoning was emitted for this message now — disarm the guard so later
              // occurrences of the tag are treated as ordinary content again
              context.receivedNonEmptyReasoning = true;

              const results: StreamProtocolChunk[] = [];
              if (leakedReasoning)
                results.push({ data: leakedReasoning, id: context.id, type: 'reasoning' });
              if (afterThink) results.push({ data: afterThink, id: context.id, type: 'text' });

              return results.length > 0 ? results : { data: '', id: context.id, type: 'text' };
            }
          }

          return { data: text, id: context.id, type: 'text' };
        }

        case 'input_json_delta': {
          const delta = chunk.delta.partial_json;

          const toolCall: StreamToolCallChunkData = {
            function: { arguments: delta },
            index: context.toolIndex || 0,
            type: 'function',
          };

          return {
            data: [toolCall],
            id: context.id,
            type: 'tool_calls',
          } as StreamProtocolToolCallChunk;
        }

        case 'signature_delta': {
          return {
            data: chunk.delta.signature,
            id: context.id,
            type: 'reasoning_signature',
          };
        }

        case 'thinking_delta': {
          if (typeof chunk.delta.thinking === 'string' && chunk.delta.thinking.trim()) {
            context.receivedNonEmptyReasoning = true;
          }

          return {
            data: chunk.delta.thinking,
            id: context.id,
            type: 'reasoning',
          };
        }

        case 'citations_delta': {
          const citations = (chunk as any).delta.citation;

          if (context.returnedCitationArray) {
            context.returnedCitationArray.push({
              title: citations.title,
              url: citations.url,
            } as ChatCitationItem);
          }

          return { data: null, id: context.id, type: 'text' };
        }

        default: {
          break;
        }
      }
      return { data: chunk, id: context.id, type: 'data' };
    }

    case 'message_delta': {
      const aggregatedUsage = convertAnthropicUsage(chunk, context.usage, payload);

      if (aggregatedUsage) {
        context.usage = aggregatedUsage;
      }

      if (aggregatedUsage && (aggregatedUsage.totalTokens ?? 0) > 0) {
        delete context.usageMissingDiagnostics;
        return [
          { data: chunk.delta.stop_reason, id: context.id, type: 'stop' },
          { data: aggregatedUsage, id: context.id, type: 'usage' },
        ];
      }

      context.usageMissingDiagnostics = {
        apiMode: 'messages',
        finishReason: chunk.delta.stop_reason,
        hasUsageMetadata: Boolean(chunk.usage),
        model: payload?.model,
        provider: payload?.provider,
        source: 'anthropic_messages',
        terminalEventType: chunk.type,
      };

      return { data: chunk.delta.stop_reason, id: context.id, type: 'stop' };
    }

    case 'message_stop': {
      if (!context.usage && !context.usageMissingDiagnostics) {
        context.usageMissingDiagnostics = {
          apiMode: 'messages',
          hasUsageMetadata: false,
          model: payload?.model,
          provider: payload?.provider,
          source: 'anthropic_messages',
          terminalEventType: chunk.type,
        };
      }

      return [
        ...(context.returnedCitationArray?.length
          ? [
              {
                data: { citations: context.returnedCitationArray },
                id: context.id,
                type: 'grounding',
              },
            ]
          : []),
        { data: 'message_stop', id: context.id, type: 'stop' },
      ] as any;
    }

    default: {
      return { data: chunk, id: context.id, type: 'data' };
    }
  }
};

export interface AnthropicStreamOptions {
  callbacks?: ChatStreamCallbacks;
  enableStreaming?: boolean; // Select TPS calculation method (pass false for non-streaming)
  inputStartAt?: number;
  payload?: ChatPayloadForTransformStream;
}

export const AnthropicStream = (
  stream: Stream<Anthropic.MessageStreamEvent> | ReadableStream,
  { callbacks, inputStartAt, enableStreaming = true, payload }: AnthropicStreamOptions = {},
) => {
  const streamStack: StreamContext = { id: '' };

  const readableStream =
    stream instanceof ReadableStream
      ? stream
      : convertIterableToStream(stream, { model: payload?.model, provider: payload?.provider });

  const transformWithPayload: typeof transformAnthropicStream = (chunk, ctx) =>
    transformAnthropicStream(chunk, ctx, payload);

  return readableStream
    .pipeThrough(
      createTokenSpeedCalculator(transformWithPayload, {
        enableStreaming,
        inputStartAt,
        streamStack,
      }),
    )
    .pipeThrough(createSSEProtocolTransformer((c) => c, streamStack))
    .pipeThrough(createCallbacksTransformer(callbacks, { streamStack }));
};
