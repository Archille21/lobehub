import { type BetterAuthPlugin } from 'better-auth/types';

/**
 * Better Auth plugins contributed by the distribution, merged ahead of the
 * built-in ones in `src/auth.ts`.
 *
 * The slot exists because access policy is a property of the deployment, not of
 * the product: who may register, and on what evidence, is decided by whoever
 * runs the install. The built-in `emailWhitelist` covers the common case from
 * `AUTH_ALLOWED_EMAILS`, but an env var is a poor fit once the answer changes
 * during the deployment's life — every edit needs a config change and a
 * restart, and the whole list is rewritten to add one address. A distribution
 * that keeps its list in a database, a directory, or an upstream IdP has
 * nowhere to say so without this.
 *
 * Empty by default: the built-in plugins are the whole policy unless a
 * distribution adds to it.
 */
export const businessAuthPlugins: BetterAuthPlugin[] = [];
