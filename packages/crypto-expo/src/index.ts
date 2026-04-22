/**
 * Side-effectful import — installs crypto polyfills + native KDF override.
 * Must be imported **once** at mobile-app startup, before any other
 * `@dina/*` module evaluates.
 *
 * ```ts
 * // apps/mobile/src/index.ts or expo-router/entry
 * import '@dina/crypto-expo';
 * ```
 */
import './polyfills';
