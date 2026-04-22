/**
 * Convenience meta-package — re-exports every value from the 5 granular
 * Expo adapters so apps inside this repo can `import { … } from
 * '@dina/adapters-expo'` without hand-listing each adapter.
 *
 * External consumers and protocol implementers should depend on the
 * granular packages (`@dina/storage-expo`, `@dina/crypto-expo`, etc.)
 * directly for dependency-graph precision.
 *
 * **Not re-exported here**: `@dina/crypto-expo` is side-effect-only
 * (installs polyfills on module evaluation). Import it at startup via
 * the `./polyfills` subpath:
 *
 * ```ts
 * // apps/mobile/app/_layout.tsx (expo-router entrypoint)
 * import '@dina/adapters-expo/polyfills';
 * ```
 */

export * from '@dina/storage-expo';
export * from '@dina/fs-expo';
export * from '@dina/net-expo';
export * from '@dina/keystore-expo';
