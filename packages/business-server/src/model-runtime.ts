// Delegates to the pnpm-overridable business slot package so downstream
// distributions can inject hooks via package overrides alone (thin-shell
// wrappers without tsconfig path shadowing). Cloud-style path shadowing of
// this file keeps working unchanged and takes precedence.
//
// Imports the './hooks' subpath (server-only) instead of the package root:
// the root entry is bundled into browser code via model-runtime providers,
// so it must stay free of server-only dependencies.
export { getBusinessModelRuntimeHooks } from '@lobechat/business-model-runtime/hooks';
