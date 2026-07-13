import { SIGNAL_TURN_ANSWER_MIN_LENGTH } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import type { Message } from '../../types';
import { BranchResolver } from '../BranchResolver';
import { FlatListBuilder } from '../FlatListBuilder';
import { MessageCollector } from '../MessageCollector';
import { MessageTransformer } from '../MessageTransformer';

/**
 * Read-side half of the tpc_MAA6wBdUN1gw "消息链又断了" fix.
 *
 * When the agent parks on a long-running background tool, the stdout push that
 * wakes it is exactly how its REAL answer arrives: a toolless turn tagged
 * `signal` at stream_start, carrying the whole plan. Treated as a reactive
 * callback, it was folded into the collapsed SignalCallbacks accordion while two
 * throwaway acks rendered inline — the user sees the run trail off and asks why
 * the chain broke.
 *
 * `signal` is trigger provenance, not structure. A woken turn that PRODUCES
 * something — a tool_use (see signalTurnWithTools.pipeline.test.ts) or prose
 * addressed to the user — is on the main chain and renders as a normal step.
 * Only a turn that produced nothing stays a callback.
 */

const toolArr = (id: string) => [
  { apiName: 'Bash', arguments: '{}', id, identifier: 'claude-code', type: 'default' as const },
];

const stdout = (seq: number) =>
  ({
    signal: {
      sequence: seq,
      sourceToolCallId: 'bashwait',
      sourceToolName: 'Bash',
      type: 'tool-stdout',
    },
  }) as any;

const flatten = (messages: Message[]) => {
  const messageMap = new Map<string, Message>();
  const childrenMap = new Map<string | null, string[]>();
  messages.forEach((msg) => {
    messageMap.set(msg.id, msg);
    const parentId = msg.parentId || null;
    if (!childrenMap.has(parentId)) childrenMap.set(parentId, []);
    childrenMap.get(parentId)!.push(msg.id);
  });
  const builder = new FlatListBuilder(
    messageMap,
    new Map(),
    childrenMap,
    new BranchResolver(),
    new MessageCollector(messageMap, childrenMap),
    new MessageTransformer(),
  );
  return builder.flatten(messages);
};

const groupOf = (flat: Message[]) =>
  flat.find((m) => m.role === ('assistantGroup' as any)) as any | undefined;

//   W     — spine turn that launched a background Bash and parked
//   PLAN  — the turn its stdout push woke; toolless, and it carries the ANSWER
//   ACK   — a second push wakes another toolless turn ("timer fired, nothing new"),
//           short enough to stay a callback
//   NEXT  — the run's next normal turn
//
// Woken turns always mount on the tool that woke them, before and after the fix.
// What the fix changes is `parentOfNext`: the spine advances onto the answer, so
// the next normal turn continues FROM it (PLAN) instead of jumping back over it
// to the pre-callback assistant (W) and forking the wire.
const plan = `PLANMARKER 探查回来了，方案可以落到文件级`.padEnd(
  SIGNAL_TURN_ANSWER_MIN_LENGTH + 1,
  '。',
);

const scenario = (parentOfNext: 'PLAN' | 'W'): Message[] => [
  { content: 'go', createdAt: 0, id: 'u1', role: 'user', updatedAt: 0 },
  {
    agentId: 'a',
    content: '两个探查 agent 在跑',
    createdAt: 100,
    id: 'W',
    parentId: 'u1',
    role: 'assistant',
    tools: toolArr('bashwait'),
    updatedAt: 100,
  },
  {
    content: 'Command running in background',
    createdAt: 110,
    id: 'toolW',
    parentId: 'W',
    role: 'tool',
    tool_call_id: 'bashwait',
    updatedAt: 110,
  } as any,
  {
    agentId: 'a',
    content: plan,
    createdAt: 120,
    id: 'PLAN',
    metadata: stdout(1),
    parentId: 'toolW',
    role: 'assistant',
    updatedAt: 120,
  },
  {
    agentId: 'a',
    content: 'ACKMARKER （那只是计时器到点了，没有新信息。）',
    createdAt: 130,
    id: 'ACK',
    metadata: stdout(2),
    parentId: 'toolW',
    role: 'assistant',
    updatedAt: 130,
  },
  {
    agentId: 'a',
    content: 'TAILMARKER 开做，先切分支',
    createdAt: 140,
    id: 'NEXT',
    parentId: parentOfNext,
    role: 'assistant',
    updatedAt: 140,
  },
];

describe('signal turn that answers — main-chain promotion (tpc_MAA6wBdUN1gw)', () => {
  it('LINEAR (post-fix): the answer is a chain step, the ack stays in the accordion', () => {
    const flat = flatten(scenario('PLAN'));
    const group = groupOf(flat);

    // The answer renders as a step of the run, NOT folded away …
    expect(JSON.stringify(group?.children ?? [])).toContain('PLANMARKER');
    // … the throwaway ack is still a callback, which is what the accordion is for …
    const callbacks = (group?.signalCallbacks ?? []).flatMap((b: any) => b.callbacks);
    expect(callbacks.map((c: any) => c.id)).toEqual(['ACK']);
    // … and the run continues past it.
    expect(JSON.stringify(flat)).toContain('TAILMARKER');
  });

  it('FORKED (pre-fix): the next turn re-mounts over the answer — reader DROPS the tail', () => {
    const flat = flatten(scenario('W'));
    const json = JSON.stringify(flat);

    // The answer itself surfaces (the read-side defang alone gets that far) …
    expect(json).toContain('PLANMARKER');
    // … but with the next turn hung off the PRE-callback assistant, the wire forks
    // around the answer and everything after it silently vanishes. This is what
    // the write-side spine promotion eliminates.
    expect(json).not.toContain('TAILMARKER');
  });

  it('a wake-up that produced nothing is still a callback', () => {
    const flat = flatten([
      ...scenario('PLAN').slice(0, 3),
      {
        agentId: 'a',
        content: '',
        createdAt: 120,
        id: 'EMPTY',
        metadata: stdout(1),
        parentId: 'toolW',
        role: 'assistant',
        updatedAt: 120,
      } as Message,
    ]);

    expect(groupOf(flat)?.signalCallbacks?.[0]?.callbacks ?? []).toHaveLength(1);
  });
});
