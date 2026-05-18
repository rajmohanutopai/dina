/**
 * Native keychain wrapper — re-exports the subset of
 * `react-native-keychain` Dina actually uses.
 *
 * Mobile (iOS + Android) call sites import from here so the web target
 * can resolve the `.web.ts` peer instead. Metro's platform-extension
 * resolution picks `.web.ts` first when bundling for web; native
 * builds get this `.ts` file.
 *
 * Three functions cover every call site (`grep "Keychain\\." apps/mobile/src`):
 *   - `setGenericPassword(username, value, opts)`
 *   - `getGenericPassword(opts)`
 *   - `resetGenericPassword(opts)`
 *
 * Anything else from `react-native-keychain` (accessControl, biometric
 * prompts, internet-credential helpers) is intentionally not surfaced.
 * If a future caller needs more API, add it here AND in `keychain.web.ts`
 * so the platforms stay symmetric — the dual-mode jest spec at
 * `__tests__/services/keychain_dual.test.ts` will block PRs that drift.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 2 "Storage shim".
 */

export {
  getGenericPassword,
  resetGenericPassword,
  setGenericPassword,
} from 'react-native-keychain';

export type {
  BaseOptions,
  GetOptions,
  Result,
  SetOptions,
  UserCredentials,
} from 'react-native-keychain';
