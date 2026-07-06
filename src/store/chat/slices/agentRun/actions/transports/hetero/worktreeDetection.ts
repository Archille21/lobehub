import type { WorkingDirConfig } from '@lobechat/types';
import isEqual from 'fast-deep-equal';

import { topicSelectors } from '@/store/chat/selectors';
import type { ChatStore } from '@/store/chat/store';

/**
 * Detect `git worktree add <path>` in a heterogeneous agent's shell tool call and
 * flip the topic's working-directory state into that worktree.
 *
 * Heterogeneous CLI agents (Claude Code / Codex) run their own shell tool — their
 * calls never pass through our runtime executors, so the server `afterToolCall`
 * hook never fires for them. We instead sniff the command at the tool-ingest seam
 * (`heterogeneousAgentExecutor`) and, once the command SUCCEEDS, record the new
 * worktree as the topic's active one. Mirrors what `WorktreeSwitcher` writes on a
 * manual selection: only `git.activeWorktree` changes; the CLI session cwd stays
 * anchored to the source repo (hetero anchors cwd to source, worktree is a record).
 */

/** Flags on `git worktree add` that consume the following token as their value. */
const VALUE_FLAGS = new Set(['-b', '-B', '--reason']);

const stripQuotes = (token: string): string => {
  if (token.length >= 2) {
    const first = token[0];
    const last = token.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
};

const isAbsolute = (p: string): boolean =>
  p.startsWith('/') || p.startsWith('~') || /^[A-Z]:[\\/]/i.test(p) || p.startsWith('\\\\');

/** Collapse `.`/`..` segments in a POSIX path without touching the filesystem. */
const normalizePosix = (p: string): string => {
  const isAbs = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out.at(-1) !== '..') out.pop();
      else if (!isAbs) out.push('..');
    } else {
      out.push(part);
    }
  }
  return (isAbs ? '/' : '') + out.join('/');
};

const resolveWorktreePath = (p: string, cwd?: string): string => {
  // Windows / home-relative paths: can't resolve without the device fs, keep as-is.
  if (isAbsolute(p)) return p.startsWith('/') ? normalizePosix(p) : p;
  if (!cwd) return p;
  return normalizePosix(`${cwd}/${p}`);
};

/**
 * Pull the shell command out of a tool call's raw `arguments` (a JSON string for
 * CC's `Bash`, but tolerate an already-parsed object or a bare string too).
 */
const extractCommand = (rawArgs: unknown): string | undefined => {
  const fromObject = (obj: any): string | undefined =>
    obj?.command ?? obj?.cmd ?? obj?.script ?? obj?.content;

  if (rawArgs && typeof rawArgs === 'object') return fromObject(rawArgs);
  if (typeof rawArgs !== 'string') return undefined;

  const trimmed = rawArgs.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{')) {
    try {
      return fromObject(JSON.parse(trimmed)) ?? trimmed;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
};

/**
 * Parse a shell tool call for `git worktree add <path>` and return the target
 * worktree path (resolved to absolute against `cwd` when relative). Returns
 * `undefined` when the call isn't a worktree-add.
 */
export const parseWorktreeAddPath = (rawArgs: unknown, cwd?: string): string | undefined => {
  const command = extractCommand(rawArgs);
  if (!command || !/\bworktree\s+add\b/.test(command)) return undefined;

  const after = /\bworktree\s+add\b([\s\S]*)/.exec(command)?.[1] ?? '';
  // Only look at the `worktree add` invocation itself — stop at a shell separator
  // so a chained `&& cd ...` never gets mistaken for the path argument.
  const segment = after.split(/[\n;|&]/)[0] ?? '';
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (VALUE_FLAGS.has(token)) {
      i += 1; // skip this flag's value
      continue;
    }
    if (token.startsWith('-')) continue; // other flags
    const path = stripQuotes(token);
    if (path) return resolveWorktreePath(path, cwd);
  }
  return undefined;
};

/**
 * Record a newly-created worktree as the topic's active one. No-op when the
 * worktree resolves to the source path itself, or when nothing would change.
 */
export const applyWorktreeAddToTopic = async (
  get: () => ChatStore,
  params: { sourcePath?: string; topicId: string; worktreePath: string },
): Promise<void> => {
  const { topicId, sourcePath, worktreePath } = params;
  const topic = topicSelectors.getTopicById(topicId)(get());
  if (!topic) return;

  const currentConfig = topic.metadata?.workingDirectoryConfig;
  const source = currentConfig?.path ?? sourcePath ?? topic.metadata?.workingDirectory;
  if (!source || worktreePath === source) return;

  const git: NonNullable<WorkingDirConfig['git']> = {
    ...currentConfig?.git,
    activeWorktree: worktreePath,
    isWorktree: true,
  };
  const nextConfig: WorkingDirConfig = {
    ...currentConfig,
    git,
    path: source,
    ...(currentConfig?.repoType ? { repoType: currentConfig.repoType } : {}),
  };

  if (isEqual(currentConfig, nextConfig)) return;
  await get().updateTopicMetadata(topicId, { workingDirectoryConfig: nextConfig });
};
