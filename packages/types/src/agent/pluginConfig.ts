import { z } from 'zod';

/**
 * Three-state per-agent plugin config.
 *
 * `agents.plugins` (JSONB) stays `AgentPluginEntry[]` at the DB layer — no
 * schema migration. Legacy rows only ever contain bare identifier strings;
 * new writes upgrade a touched entry to `AgentPluginConfigItem` in place and
 * leave every other, untouched entry in its original shape (lazy per-item
 * upgrade — mixed-shape arrays are a permanent, not transitional, state).
 */
export type AgentPluginMode = 'pinned' | 'auto' | 'disabled';

export interface AgentPluginConfigItem {
  /**
   * Which specific connector rows of this identifier the agent may use.
   *
   * Absent = every connection of this identifier (today's behavior: one
   * identifier resolves to whatever single connector wins). Present = restrict
   * to exactly these `user_connectors.id`s. This is what turns the
   * identifier→connector relationship from one-to-one into one-to-many without
   * a schema change — it rides in the same JSONB column as `mode`.
   */
  connectorIds?: string[];
  identifier: string;
  /**
   * @default 'pinned' — absent on legacy string entries and on object
   * entries written before this field existed.
   */
  mode?: AgentPluginMode;
}

export type AgentPluginEntry = string | AgentPluginConfigItem;

export const AgentPluginModeSchema = z.enum(['pinned', 'auto', 'disabled']);

/**
 * Zod schema for a single `plugins[]` entry — for input validation on
 * routers/procedures that accept a caller-supplied plugins array (e.g. group
 * member creation). Accepts both the legacy bare string and the tri-state
 * object shape, so a client can pre-seed a disabled/pinned entry instead of
 * being rejected by a `z.array(z.string())` schema.
 */
export const AgentPluginEntrySchema: z.ZodType<AgentPluginEntry> = z.union([
  z.string(),
  z.object({
    connectorIds: z.array(z.string()).optional(),
    identifier: z.string(),
    mode: AgentPluginModeSchema.optional(),
  }),
]);

/**
 * Normalizes a single entry: legacy strings and mode-less objects both
 * resolve to `'pinned'`, matching the pre-existing "present in the array ==
 * pinned" behavior.
 */
export const parsePluginEntry = (
  entry: AgentPluginEntry,
): { connectorIds?: string[]; identifier: string; mode: AgentPluginMode } =>
  typeof entry === 'string'
    ? { identifier: entry, mode: 'pinned' }
    : {
        connectorIds: entry.connectorIds,
        identifier: entry.identifier,
        mode: entry.mode ?? 'pinned',
      };

/**
 * Resolves an identifier's mode. An identifier absent from `plugins`
 * altogether is `'auto'` — the implicit default for anything in the user's
 * installed/connected pool that the agent hasn't explicitly pinned or
 * disabled.
 */
export const getPluginMode = (
  plugins: AgentPluginEntry[] | undefined,
  identifier: string,
): AgentPluginMode => {
  const entry = plugins?.find((item) => parsePluginEntry(item).identifier === identifier);
  return entry ? parsePluginEntry(entry).mode : 'auto';
};

/**
 * The connector rows `identifier` is restricted to, or `undefined` for "no
 * restriction — every connection of this identifier is available". Legacy
 * string entries and objects written before this field existed both return
 * `undefined`, i.e. today's all-connections behavior.
 *
 * An empty array is normalized to `undefined`: "restricted to nothing" is not
 * a state we want to persist or resolve, and reads as all-connections instead.
 */
export const getPluginConnectorIds = (
  plugins: AgentPluginEntry[] | undefined,
  identifier: string,
): string[] | undefined => {
  const entry = plugins?.find((item) => parsePluginEntry(item).identifier === identifier);
  const ids = entry ? parsePluginEntry(entry).connectorIds : undefined;
  return ids && ids.length > 0 ? ids : undefined;
};

const getPluginIdsByMode = (
  plugins: AgentPluginEntry[] | undefined,
  mode: AgentPluginMode,
): string[] =>
  (plugins ?? [])
    .map((item) => parsePluginEntry(item))
    .filter((item) => item.mode === mode)
    .map((item) => item.identifier);

export const getPinnedPluginIds = (plugins: AgentPluginEntry[] | undefined): string[] =>
  getPluginIdsByMode(plugins, 'pinned');

export const getDisabledPluginIds = (plugins: AgentPluginEntry[] | undefined): string[] =>
  getPluginIdsByMode(plugins, 'disabled');

/**
 * Pinned identifiers — the drop-in replacement for runtime boundaries that
 * used to read `agentConfig?.plugins ?? []` directly as the enabled-tool
 * list. Kept as a distinct name from `getPinnedPluginIds` so call sites read
 * as "what should actually run" rather than "what's pinned".
 */
export const getActivePluginIds = (plugins: AgentPluginEntry[] | undefined): string[] =>
  getPinnedPluginIds(plugins);

/**
 * Sets `identifier`'s mode, upgrading only that one entry. Every other entry
 * — including untouched legacy strings — is returned unchanged.
 *
 * `'auto'` is the implicit default for an identifier absent from `plugins`
 * altogether, so setting it explicitly removes any existing entry instead of
 * persisting a redundant `{ identifier, mode: 'auto' }` record — this mirrors
 * the pre-tri-state behavior where unpinning spliced the id out of the array.
 */
export const upsertPluginMode = (
  plugins: AgentPluginEntry[] | undefined,
  identifier: string,
  mode: AgentPluginMode,
): AgentPluginEntry[] => {
  const list = plugins ? [...plugins] : [];
  const index = list.findIndex((item) => parsePluginEntry(item).identifier === identifier);

  if (mode === 'auto') {
    if (index !== -1) list.splice(index, 1);
    return list;
  }

  if (index === -1) {
    list.push({ identifier, mode });
    return list;
  }

  const existing = list[index];
  list[index] =
    typeof existing === 'string' ? { identifier: existing, mode } : { ...existing, mode };

  return list;
};
