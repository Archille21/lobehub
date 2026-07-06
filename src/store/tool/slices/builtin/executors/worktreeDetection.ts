import type { WorkingDirConfig } from '@lobechat/types';
import { getWorkingDirSourcePath } from '@lobechat/types';
import isEqual from 'fast-deep-equal';

import { topicSelectors } from '@/store/chat/selectors';
import { getChatStoreState } from '@/store/chat/store';

/**
 * Detect `git worktree add <path>` in a heterogeneous CLI agent's shell tool call
 * and flip the active topic's working-directory state into that worktree.
 *
 * Runs from the `claude-code` / `codex` executor's `onAfterCall` hook (renderer-side,
 * fired on `tool_end`). Mirrors what `WorktreeSwitcher` writes on a manual selection:
 * only `git.activeWorktree` / `isWorktree` change — the CLI session cwd stays anchored
 * to the source repo (hetero anchors cwd to source; the worktree is a record).
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
 * Pull the shell command out of a tool call's parsed `params`. Only reads the
 * `command`/`cmd` field (CC `Bash`, Codex shell) — deliberately NOT `content`, so
 * a `writeFile` whose body happens to contain "git worktree add" never misfires.
 * Codex may send the command as an argv array; join it.
 */
const extractCommand = (params: unknown): string | undefined => {
  if (!params || typeof params !== 'object') return undefined;
  const raw = (params as any).command ?? (params as any).cmd;
  if (Array.isArray(raw))
    return raw.every((x) => typeof x === 'string') ? raw.join(' ') : undefined;
  return typeof raw === 'string' ? raw : undefined;
};

/**
 * Parse a shell tool call's `params` for `git worktree add <path>` and return the
 * target worktree path (resolved to absolute against `cwd` when relative). Returns
 * `undefined` when the call isn't a worktree-add.
 */
export const parseWorktreeAddPath = (params: unknown, cwd?: string): string | undefined => {
  const command = extractCommand(params);
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
 * If the tool call was a successful `git worktree add`, record the new worktree as
 * the ACTIVE topic's active one. `onAfterCall` carries no run topicId, so this
 * targets `activeTopicId` — during a CLI run that IS the run's topic (mirrors how
 * other executors, e.g. Task, key off active store state). No-op when the worktree
 * resolves to the source path itself or nothing would change.
 */
export const applyWorktreeAddFromToolCall = async (params: unknown): Promise<void> => {
  const state = getChatStoreState();
  const topicId = state.activeTopicId;
  if (!topicId) return;

  const topic = topicSelectors.getTopicById(topicId)(state);
  const currentConfig = topic?.metadata?.workingDirectoryConfig;
  const source = getWorkingDirSourcePath(currentConfig) ?? topic?.metadata?.workingDirectory;

  const worktreePath = parseWorktreeAddPath(params, source);
  if (!worktreePath || !source || worktreePath === source) return;

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
  await state.updateTopicMetadata(topicId, { workingDirectoryConfig: nextConfig });
};
