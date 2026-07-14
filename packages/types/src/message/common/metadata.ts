import { z } from 'zod';

import { RequestTrigger } from '../../agentRuntime';
import type { ContextSelection } from './contextSelection';
import { ContextSelectionSchema } from './contextSelection';
import type { PageSelection } from './pageSelection';
import { PageSelectionSchema } from './pageSelection';

const LocalSystemToolSnapshotSchema = z.object({
  apiName: z.enum(['readFile', 'listFiles', 'readLocalFile', 'listLocalFiles']),
  arguments: z.record(z.string(), z.unknown()),
  capturedAt: z.string(),
  content: z.string().nullable(),
  error: z.unknown().optional(),
  identifier: z.literal('lobe-local-system'),
  result: z.unknown().optional(),
  snapshotId: z.string(),
  state: z.unknown().optional(),
  success: z.boolean(),
  toolCallId: z.string(),
});

export interface LocalSystemToolSnapshot {
  apiName: 'readFile' | 'listFiles' | 'readLocalFile' | 'listLocalFiles';
  arguments: Record<string, unknown>;
  capturedAt: string;
  content: string | null;
  error?: unknown;
  identifier: 'lobe-local-system';
  result?: unknown;
  snapshotId: string;
  state?: unknown;
  success: boolean;
  toolCallId: string;
}

export interface ModelTokensUsage {
  // Prediction tokens
  acceptedPredictionTokens?: number;
  /**
   * Total input audio tokens for the request. This is a modality breakdown, not
   * a cache-miss count.
   */
  inputAudioTokens?: number;
  /**
   * Cached audio tokens for the request.
   */
  inputCachedAudioTokens?: number;
  /**
   * Cached image tokens for the request.
   */
  inputCachedImageTokens?: number;
  /**
   * Cached text tokens for the request.
   */
  inputCachedTextTokens?: number;
  // Input tokens breakdown
  /**
   * user prompt input
   */
  // Input cache tokens
  inputCachedTokens?: number;
  /**
   * Cached video tokens for the request.
   */
  inputCachedVideoTokens?: number;

  inputCacheMissTokens?: number;
  /**
   * currently only pplx has citation_tokens
   */
  inputCitationTokens?: number;
  /**
   * Total user prompt image tokens for the request. This is a modality
   * breakdown, not a cache-miss count.
   */
  inputImageTokens?: number;
  /**
   * Total user prompt text tokens for the request. This is a modality
   * breakdown, not a cache-miss count.
   */
  inputTextTokens?: number;
  /**
   * tool use prompt tokens (Google AI / Vertex AI)
   */
  inputToolTokens?: number;

  /**
   * Total user prompt video tokens for the request. This is a modality
   * breakdown, not a cache-miss count.
   */
  inputVideoTokens?: number;
  inputWriteCacheTokens?: number;
  outputAudioTokens?: number;
  outputImageTokens?: number;
  outputReasoningTokens?: number;

  // Output tokens breakdown
  outputTextTokens?: number;
  rejectedPredictionTokens?: number;

  // Total tokens
  // TODO: make all following fields required
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
}

export const ModelUsageSchema = z.object({
  // Input tokens breakdown
  inputCachedTokens: z.number().optional(),
  inputCacheMissTokens: z.number().optional(),
  inputWriteCacheTokens: z.number().optional(),
  inputCachedTextTokens: z.number().optional(),
  inputCachedImageTokens: z.number().optional(),
  inputCachedAudioTokens: z.number().optional(),
  inputCachedVideoTokens: z.number().optional(),
  inputTextTokens: z.number().optional(),
  inputImageTokens: z.number().optional(),
  inputAudioTokens: z.number().optional(),
  inputVideoTokens: z.number().optional(),
  inputCitationTokens: z.number().optional(),
  inputToolTokens: z.number().optional(),

  // Output tokens breakdown
  outputTextTokens: z.number().optional(),
  outputImageTokens: z.number().optional(),
  outputAudioTokens: z.number().optional(),
  outputReasoningTokens: z.number().optional(),

  // Prediction tokens
  acceptedPredictionTokens: z.number().optional(),
  rejectedPredictionTokens: z.number().optional(),

  // Total tokens
  totalInputTokens: z.number().optional(),
  totalOutputTokens: z.number().optional(),
  totalTokens: z.number().optional(),

  // Cost
  cost: z.number().optional(),
});

export const ModelPerformanceSchema = z.object({
  tps: z.number().optional(),
  ttft: z.number().optional(),
  duration: z.number().optional(),
  latency: z.number().optional(),
});

// ============ Emoji Reaction ============ //

export interface EmojiReaction {
  count: number;
  emoji: string;
  users: string[];
}

export const EmojiReactionSchema = z.object({
  emoji: z.string(),
  count: z.number(),
  users: z.array(z.string()),
});

export const MessageSignalSchema = z.object({
  sequence: z.number().optional(),
  sourceToolCallId: z.string(),
  sourceToolName: z.string(),
  type: z.enum(['tool-stdout', 'tool-callback', 'task-completion']),
});

export const MessageTaskCallbackSchema = z.object({
  // Task identifier (e.g. `T-42`) for the card header + jump link.
  identifier: z.string(),
  // Terminal outcome of the task run that produced this callback.
  reason: z.enum(['done', 'error', 'interrupted']),
  // The task id (jump target → task detail).
  taskId: z.string(),
  // The completed task topic, for an optional "view run" link.
  topicId: z.string().optional(),
});

export const MessageMetadataSchema = ModelUsageSchema.merge(ModelPerformanceSchema).extend({
  collapsed: z.boolean().optional(),
  contextSelections: z.array(ContextSelectionSchema).optional(),
  // Hetero-agent (Claude Code) per-message provenance. Listed here so zod does
  // NOT strip them from writes going through UpdateMessageParamsSchema /
  // CreateMessageParamsSchema (the renderer executor's `messageService` path).
  heteroMessageId: z.string().optional(),
  heteroSessionId: z.string().optional(),
  inspectExpanded: z.boolean().optional(),
  isMultimodal: z.boolean().optional(),
  isSupervisor: z.boolean().optional(),
  localSystemToolSnapshots: z.array(LocalSystemToolSnapshotSchema).optional(),
  orchestrationRole: z.enum(['supervisor', 'member']).optional(),
  pageSelections: z.array(PageSelectionSchema).optional(),
  // Canonical nested shape — flat fields above are deprecated. Must be listed
  // here so zod doesn't strip them from writes going through UpdateMessageParamsSchema
  // (e.g. messageService.updateMessage, used by the heterogeneous-agent executor).
  performance: ModelPerformanceSchema.optional(),
  reactions: z.array(EmojiReactionSchema).optional(),
  scope: z.string().optional(),
  // External-signal lineage for Monitor-style callback turns ().
  signal: MessageSignalSchema.optional(),
  // The writer's verdict that a woken turn was main-chain after all. MUST stay
  // listed: the renderer executor flushes it through UpdateMessageParamsSchema, so
  // an unlisted key is silently stripped and the desktop path would persist no
  // verdict at all — leaving the reader to guess from content forever.
  signalPromoted: z.boolean().optional(),
  subAgentId: z.string().optional(),
  // role='taskCallback' card: which task delivered its handoff back to this
  // conversation, and the run outcome. The card header + jump link read this.
  taskCallback: MessageTaskCallbackSchema.optional(),
  toolExecutionTimeMs: z.number().optional(),
  trigger: z.nativeEnum(RequestTrigger).optional(),
  // role='verify' card: which Agent Run (agent_operations.id) it renders.
  verifyOperationId: z.string().optional(),
  verifyRound: z.number().optional(),
  // @deprecated token usage moved to the top-level `usage` column. Still listed
  // so zod doesn't strip `metadata.usage` from legacy writes during migration.
  usage: ModelUsageSchema.optional(),
});

export interface ModelUsage extends ModelTokensUsage {
  /**
   * dollar
   */
  cost?: number;
}

export interface ModelPerformance {
  /**
   * from output start to output finish (ms)
   */
  duration?: number;
  /**
   * from input start to output finish (ms)
   */
  latency?: number;
  /**
   * tokens per second
   */
  tps?: number;
  /**
   * time to first token (ms)
   */
  ttft?: number;
}

export interface MessageMetadata {
  // ───────────────────────────────────────────────────────────────
  // Token usage + performance fields — DEPRECATED flat shape.
  // Token usage now lives in the dedicated top-level `usage` column
  // (`UIChatMessage.usage`); performance still lives in `metadata.performance`.
  // These flat fields (and the nested `metadata.usage` below) are kept so legacy
  // reads still type-check during migration; writers should stop populating them.
  // ───────────────────────────────────────────────────────────────
  /** @deprecated use the top-level message `usage` field instead */
  acceptedPredictionTokens?: number;
  activeBranchIndex?: number;
  activeColumn?: boolean;
  /**
   * Marks a `role: 'tool'` message (a group broadcast tool call) as an
   * AgentCouncil: its member responses render as one parallel-streaming block.
   */
  agentCouncil?: boolean;
  /**
   * Message collapse state
   * true: collapsed, false/undefined: expanded
   */
  collapsed?: boolean;
  compare?: boolean;
  /**
   * Generic context selections attached to user messages.
   * Page selections remain mirrored in `pageSelections` for compatibility.
   */
  contextSelections?: ContextSelection[];
  /** @deprecated use the top-level message `usage` field instead */
  cost?: number;
  /** @deprecated use `metadata.performance` instead */
  duration?: number;
  finishType?: string;
  /**
   * The native id of this message inside the hetero agent (Claude Code /
   * Codex) that produced it — forensic provenance tying a row back to its
   * source.
   *
   * - live runs: the CC API `message.id` of the turn (all the stream exposes),
   *   stamped by the server persistence handler and the renderer executor
   * - imported transcripts: the record's own id in the source file (CC session
   *   record `uuid`; codex call item `fc_...` / `ctc_...` id)
   */
  heteroMessageId?: string;
  /**
   * The CC-native session id this hetero-agent message was produced under.
   * `topic.metadata.heteroSessionId` keeps only the single latest value (written
   * at run end); this per-message copy lets a diff pinpoint the exact row where
   * CC forked to a new session — the signal for a lost-`--resume` "session break".
   */
  heteroSessionId?: string;
  /** @deprecated use the top-level message `usage` field instead */
  inputAudioTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputCachedAudioTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputCachedImageTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputCachedTextTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputCachedTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputCachedVideoTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputCacheMissTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputCitationTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputImageTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputTextTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputToolTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputVideoTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  inputWriteCacheTokens?: number;
  /**
   * Tool inspect expanded state
   * true: expanded, false/undefined: collapsed
   */
  inspectExpanded?: boolean;
  /**
   * Task instruction (for role='task' messages)
   * The instruction given by supervisor to the agent
   * Thread's sourceMessageId links back to this message for status tracking
   */
  instruction?: string;
  /**
   * Flag indicating if message content is multimodal (serialized MessageContentPart[])
   */
  isMultimodal?: boolean;
  /**
   * Flag indicating if message is from the Supervisor agent in group orchestration
   * Used by conversation-flow to transform role to 'supervisor' for UI rendering
   */
  isSupervisor?: boolean;
  /** @deprecated use `metadata.performance` instead */
  latency?: number;
  /**
   * Local-system tool snapshots materialized when the user sent @file mentions.
   */
  localSystemToolSnapshots?: LocalSystemToolSnapshot[];

  /**
   * Orchestration role of the message author within a group conversation.
   * `'supervisor'` = the group's coordinating agent, `'member'` = a delegated
   * member agent. Persisted as a snapshot at write time (not derived at render)
   * so historical transcripts stay stable across later membership/role changes,
   * and so the standard message `role` stays `'assistant'` (training-friendly).
   * Supersedes the boolean {@link isSupervisor}, which is kept for back-compat.
   */
  orchestrationRole?: 'supervisor' | 'member';
  /** @deprecated use the top-level message `usage` field instead */
  outputAudioTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  outputImageTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  outputReasoningTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  outputTextTokens?: number;
  /**
   * Page selections attached to user message
   * Used for Ask AI functionality to persist selection context
   */
  pageSelections?: PageSelection[];
  performance?: ModelPerformance;
  /**
   * Flag indicating if message is pinned (excluded from compression)
   */
  pinned?: boolean;
  /**
   * Emoji reactions on this message
   */
  reactions?: EmojiReaction[];
  /** @deprecated use the top-level message `usage` field instead */
  rejectedPredictionTokens?: number;
  /**
   * Message scope - indicates the context in which this message was created
   * Used by conversation-flow to determine how to handle message grouping and display
   * See MessageMapScope for available values
   */
  scope?: string;
  /**
   * External-signal lineage for messages produced as reactive replies
   * to an out-of-band trigger (Monitor stdout push, webhook callback,
   * scheduled tick, …) rather than a fresh user turn. Phase-1 storage —
   * Phase 2 () promotes this to a dedicated `messages.signal`
   * jsonb column.
   *
   * Conversation-flow groups signal-tagged TOOLLESS assistants into a
   * SignalCallbacksNode under the source tool. Tool-using assistants
   * may still carry this tag (the adapter clears the pending signal AT
   * tool_use time, but the stream_start tag fired one event earlier);
   * collectors must ignore the tag when `tools.length > 0`.
   *
   * Shape mirrors `ExternalSignalContext` in
   * `packages/heterogeneous-agents/src/types.ts` — duplicated here so
   * `@lobechat/types` stays free of an adapter-package dependency.
   */
  signal?: MessageSignal;
  /**
   * Set on a `signal`-tagged turn that turned out to be on the MAIN CHAIN: it
   * emitted a tool_use, or delivered an answer rather than a one-line reactive
   * note (see `isSignalTurnAnswer`). Readers must treat it as a normal step and
   * NOT fold it into the SignalCallbacks accordion.
   *
   * The writer stamps `signal` at stream_start, before the turn's output is
   * known, so the verdict can only be reached once the turn flushes — and it is
   * the WRITER that reaches it (it holds the turn's tools and prose). Persisting
   * the verdict is what keeps the read side and the cold-replica spine query from
   * each re-deriving it from message content, three copies of one rule that would
   * drift.
   *
   * Deliberately TOP-LEVEL rather than nested under `signal`: the spine query
   * filters on it, and nested access (`metadata -> 'signal'`) crashes the
   * serverless Postgres engine as a WHERE predicate — only `jsonb_exists` on a
   * top-level key survives there.
   */
  signalPromoted?: boolean;
  /**
   * Sub Agent ID - behavior depends on scope
   * - scope: 'sub_agent': conversation-flow will transform message.agentId to this value for display
   * - scope: 'group' | 'group_agent': indicates the agent that generated this message in group mode
   * Used by callAgent tool (sub_agent) and group orchestration (group modes)
   */
  subAgentId?: string;
  /**
   * Task-callback card pointer (for role='taskCallback' messages). Identifies
   * the task whose handoff result was delivered back into this conversation and
   * the run outcome; the card header + jump link read off it.
   */
  taskCallback?: MessageTaskCallback;
  taskTitle?: string;
  // message content is multimodal, display content in the streaming, won't save to db
  tempDisplayContent?: string;
  /**
   * Tool execution time for tool messages (ms)
   */
  toolExecutionTimeMs?: number;
  /** @deprecated use the top-level message `usage` field instead */
  totalInputTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  totalOutputTokens?: number;
  /** @deprecated use the top-level message `usage` field instead */
  totalTokens?: number;
  /** @deprecated use `metadata.performance` instead */
  tps?: number;
  /**
   * Request source used by runtime routing, billing, and logs.
   */
  trigger?: RequestTrigger;
  /** @deprecated use `metadata.performance` instead */
  ttft?: number;
  /**
   * @deprecated Token usage has been promoted to the dedicated top-level `usage`
   * column / `UIChatMessage.usage` field. Reads fall back here for legacy rows,
   * but new writers should target the top-level `usage` instead.
   */
  usage?: ModelUsage;
  /**
   * Agent Run operation id this verify card belongs to (for role='verify' messages).
   * References `agent_operations.id`; the card reads the verify plan + results off it.
   */
  verifyOperationId?: string;
  /** Display round number for the verify card (1-based; repair rounds are separate). */
  verifyRound?: number;
}

/**
 * Pointer carried on a `role='taskCallback'` message — the result-bridge card
 * that reports a finished task's handoff back to its creator conversation
 * The handoff summary itself lives in the message `content`; this
 * pointer drives the card header (identifier + outcome) and the jump link.
 */
export interface MessageTaskCallback {
  /** Task identifier (e.g. `T-42`) for the card header + jump link. */
  identifier: string;
  /** Terminal outcome of the task run that produced this callback. */
  reason: 'done' | 'error' | 'interrupted';
  /** The task id (jump target → task detail). */
  taskId: string;
  /** The completed task topic, for an optional "view run" link. */
  topicId?: string;
}

/**
 * Persisted form of an external-signal trigger context — stamped on
 * messages produced as reactive replies to out-of-band events.
 *
 * Phase 1 lives under `MessageMetadata.signal`; Phase 2 ()
 * promotes to a dedicated `messages.signal` column with the same
 * shape (plus `rootSourceId` / `scopeKey` for agent-signal alignment).
 */
export interface MessageSignal {
  /** Nth push from the same source (1 = first repeat result). */
  sequence?: number;
  /** Source `tool_use.id` (CC) / function call id whose repeat fired this signal. */
  sourceToolCallId: string;
  /** Tool name for UI labelling, e.g. `Monitor`. */
  sourceToolName: string;
  /**
   * Discriminator for the trigger source.
   *
   * - `tool-stdout`: reactive turn driven by a long-running tool's stdout push.
   * - `tool-callback`: (future) one-shot async callback variant.
   * - `task-completion`: post-task summary turn after the long-running tool
   *   ended; keeps the summary inside the same AssistantGroup as the
   *   preceding callbacks.
   */
  type: 'tool-stdout' | 'tool-callback' | 'task-completion';
}

/**
 * Prose length (trimmed characters) above which a signal-triggered turn counts as
 * an ANSWER rather than a reactive note — and is therefore treated as a
 * main-chain step instead of a callback.
 *
 * `signal` is trigger provenance, stamped at stream_start before the turn's
 * output is known, so the two sides of the wire have to tell the cases apart
 * after the fact. A tool_use settles it outright (the LLM kept working). Prose
 * does not: a Monitor push and a finished background agent both wake the LLM,
 * and both replies are prose. What separates them is scale — a progress note is
 * a line ("100/84842 全 skip…"), an answer is the reply the user was waiting for.
 *
 * The threshold is the deliberate part of that trade: it keeps the
 * SignalCallbacks accordion useful for chatty tools while stopping it from
 * swallowing the run's real reply (which is how the answer arrives whenever the
 * agent parks on a long-running background tool). Borderline prose either way is
 * mis-slotted, so it is set well clear of observed progress notes (5–50 chars)
 * and observed answers (1000+).
 *
 * Consumed by all three places that must agree on the classification: the write
 * side (`promoteTurnToMainChain`), the cold-replica spine query
 * (`getLatestSpineMessageId`), and the read side (`getMessageSignal`).
 */
export const SIGNAL_TURN_ANSWER_MIN_LENGTH = 200;

/** True when a signal-triggered turn's prose is long enough to be an answer. */
export const isSignalTurnAnswer = (content: string | null | undefined): boolean =>
  (content?.trim().length ?? 0) > SIGNAL_TURN_ANSWER_MIN_LENGTH;
