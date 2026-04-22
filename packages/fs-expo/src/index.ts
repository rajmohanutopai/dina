/**
 * Expo filesystem adapter — thin wrappers over `expo-file-system` for the
 * use-cases `apps/mobile` currently has.
 *
 * Scope today: document-directory + cache-directory URI lookups.
 *
 * Planned expansion (Phase 2, alongside FsPort in @dina/core):
 *   - readFile, writeFile (safe write = tmp + rename), stat, exists, chmod
 *   - conforms to the `FsPort` interface that @dina/core will declare
 *
 * Extracted per docs/HOME_NODE_LITE_TASKS.md task 1.14.3c.
 *
 * NOTE on imports: `expo-file-system` v55 moved the document-directory
 * constant behind `Paths.document` (a `PathObject`, not a string).
 * `Paths.document.uri` yields the legacy `file://.../` URI that
 * `@op-engineering/op-sqlite`'s `location` argument expects. If this
 * module is imported in a non-Expo runtime, the dynamic `require` path
 * below throws `Cannot find module 'expo-file-system'` by design — pick
 * @dina/fs-node on Node.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const expoFS = require('expo-file-system') as {
  Paths: { document: { uri: string }; cache: { uri: string } };
};

/** URI of the app's persistent document directory (e.g. SQLCipher vaults). */
export function documentDirectoryUri(): string {
  return expoFS.Paths.document.uri;
}

/** URI of the app's cache directory (for short-lived artefacts like export temp files). */
export function cacheDirectoryUri(): string {
  return expoFS.Paths.cache.uri;
}
