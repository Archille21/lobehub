// Delegates to the pnpm-overridable business slot package so downstream
// distributions can inject hooks via package overrides alone (thin-shell
// wrappers without tsconfig path shadowing). Cloud-style path shadowing of
// this file keeps working unchanged and takes precedence.
export { getBusinessModelRuntimeHooks } from '@lobechat/business-model-runtime';
