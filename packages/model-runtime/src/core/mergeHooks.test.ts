import { describe, expect, it, vi } from 'vitest';

import { mergeModelRuntimeHooks } from './mergeHooks';
import type { ModelRuntimeHooks } from './ModelRuntime';

describe('mergeModelRuntimeHooks', () => {
  it('returns undefined when both hooks are empty', () => {
    expect(mergeModelRuntimeHooks(undefined, undefined)).toBeUndefined();
  });

  it('returns the only present hook untouched', () => {
    const fn = vi.fn();
    const merged = mergeModelRuntimeHooks({ beforeChat: fn }, undefined);
    expect(merged?.beforeChat).toBe(fn);
  });

  it('chains hooks of the same name in a → b order', async () => {
    const order: string[] = [];
    const a: ModelRuntimeHooks = {
      onGenerateObjectComplete: vi.fn(async () => {
        order.push('a');
      }),
    };
    const b: ModelRuntimeHooks = {
      onGenerateObjectComplete: vi.fn(async () => {
        order.push('b');
      }),
    };

    const merged = mergeModelRuntimeHooks(a, b);
    await merged?.onGenerateObjectComplete?.(
      { latencyMs: 0, success: true },
      {} as Parameters<NonNullable<ModelRuntimeHooks['onGenerateObjectComplete']>>[1],
    );
    expect(order).toEqual(['a', 'b']);
    expect(a.onGenerateObjectComplete).toHaveBeenCalledTimes(1);
    expect(b.onGenerateObjectComplete).toHaveBeenCalledTimes(1);
  });

  it('does not run b when a throws (a is load-bearing)', async () => {
    const bSpy = vi.fn();
    const merged = mergeModelRuntimeHooks(
      {
        onGenerateObjectComplete: async () => {
          throw new Error('billing failed');
        },
      },
      { onGenerateObjectComplete: bSpy },
    );

    await expect(
      merged?.onGenerateObjectComplete?.(
        { latencyMs: 0, success: true },
        {} as Parameters<NonNullable<ModelRuntimeHooks['onGenerateObjectComplete']>>[1],
      ),
    ).rejects.toThrow('billing failed');
    expect(bSpy).not.toHaveBeenCalled();
  });

  it('keeps hooks that exist in only one side without wrapping', () => {
    const onlyInA = vi.fn();
    const onlyInB = vi.fn();
    const merged = mergeModelRuntimeHooks({ beforeChat: onlyInA }, { onChatFinal: onlyInB });
    expect(merged?.beforeChat).toBe(onlyInA);
    expect(merged?.onChatFinal).toBe(onlyInB);
  });

  describe('interceptChat merge semantics', () => {
    const payload = { messages: [], model: 'm', temperature: 0 } as never;

    it('a intercepting short-circuits: b never runs', async () => {
      const blocked = new Response('blocked');
      const bSpy = vi.fn();
      const merged = mergeModelRuntimeHooks(
        { interceptChat: vi.fn(async () => blocked) },
        { interceptChat: bSpy },
      );

      await expect(merged?.interceptChat?.(payload)).resolves.toBe(blocked);
      expect(bSpy).not.toHaveBeenCalled();
    });

    it('a passing (undefined) falls through to b', async () => {
      const blocked = new Response('blocked');
      const merged = mergeModelRuntimeHooks(
        { interceptChat: vi.fn(async () => undefined) },
        { interceptChat: vi.fn(async () => blocked) },
      );

      await expect(merged?.interceptChat?.(payload)).resolves.toBe(blocked);
    });

    it('both passing resolves undefined', async () => {
      const merged = mergeModelRuntimeHooks(
        { interceptChat: vi.fn(async () => undefined) },
        { interceptChat: vi.fn(async () => undefined) },
      );

      await expect(merged?.interceptChat?.(payload)).resolves.toBeUndefined();
    });
  });

  describe('transformChatResponse merge semantics', () => {
    const context = {} as Parameters<NonNullable<ModelRuntimeHooks['transformChatResponse']>>[1];

    it('pipelines: b receives the response produced by a', async () => {
      const original = new Response('original');
      const afterA = new Response('after-a');
      const afterB = new Response('after-b');
      const bSpy = vi.fn(async () => afterB);
      const merged = mergeModelRuntimeHooks(
        { transformChatResponse: vi.fn(async () => afterA) },
        { transformChatResponse: bSpy },
      );

      await expect(merged?.transformChatResponse?.(original, context)).resolves.toBe(afterB);
      expect(bSpy).toHaveBeenCalledWith(afterA, context);
    });

    it('undefined from a stage keeps the previous response flowing', async () => {
      const original = new Response('original');
      const afterB = new Response('after-b');
      const bSpy = vi.fn(async () => afterB);
      const merged = mergeModelRuntimeHooks(
        { transformChatResponse: vi.fn(async () => undefined) },
        { transformChatResponse: bSpy },
      );

      await expect(merged?.transformChatResponse?.(original, context)).resolves.toBe(afterB);
      expect(bSpy).toHaveBeenCalledWith(original, context);
    });

    it('both undefined resolves to the last known response', async () => {
      const original = new Response('original');
      const merged = mergeModelRuntimeHooks(
        { transformChatResponse: vi.fn(async () => undefined) },
        { transformChatResponse: vi.fn(async () => undefined) },
      );

      await expect(merged?.transformChatResponse?.(original, context)).resolves.toBe(original);
    });
  });
});
