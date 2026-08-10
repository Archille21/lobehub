/**
 * `apps/desktop` is its own pnpm workspace root and does not list
 * `packages/business/const` among its packages, so `@lobechat/business-const`
 * has to resolve to something local. This package is that something.
 *
 * It used to hand-copy a subset of the real module's values. That subset went
 * stale — every flag added upstream since (SETTINGS_HIDDEN_TABS,
 * BUILTIN_SKILLS_HIDDEN, HOME_PORTRAIT_ENABLED, …) plus all of `branding.ts`
 * beyond three fields and all of `url.ts` were simply missing, and because the
 * stub only shadows the real package for importers under `apps/desktop` and
 * `apps/cli`, the breakage showed up as a bundler MISSING_EXPORT deep in the
 * CLI build rather than anywhere near this file.
 *
 * Re-exporting removes the copy, and with it the drift: there is now exactly
 * one definition of these values in the repo.
 */
export * from '../../../../../packages/business/const/src/index';
