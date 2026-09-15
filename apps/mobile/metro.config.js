/**
 * Metro config for the Expo monorepo.
 *
 * Resolves `@dina/*` workspace packages from the repo root. Three knobs
 * required for the "hoist to root node_modules + symlink into each
 * workspace" pattern npm uses:
 *
 *   1. `watchFolders` — Metro must watch the monorepo root so file-
 *      changes in `packages/**` trigger rebuilds.
 *   2. `nodeModulesPaths` — Metro must resolve modules from both the
 *      app-local node_modules (for mobile-app-specific deps) and the
 *      root node_modules (for hoisted shared deps like React, TypeScript,
 *      and the `@dina/*` symlinks).
 *   3. `unstable_enableSymlinks` — Metro has historically stumbled on
 *      symlinks; this flag tells it to follow them. Required for the
 *      `@dina/core` → `../../packages/core` symlink to resolve.
 *
 * Matches the Expo monorepo guide:
 * https://docs.expo.dev/guides/monorepos/
 *
 * Owner: docs/HOME_NODE_LITE_TASKS.md Phase 1a' task 1.14.5.
 */

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// 1. Watch all monorepo packages so HMR fires on edits anywhere in the workspace.
config.watchFolders = [monorepoRoot];

// 2. Resolve node_modules from both app and monorepo root. App-local first so
//    mobile-app-specific versions (expo-router, react-native, etc.) aren't
//    shadowed by a hoisted copy.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// 3. Follow symlinks — required for workspace packages (`@dina/core` →
//    `../../packages/core`). Flag is `unstable_` but has been stable across
//    Metro 0.80+ and is in Expo's official monorepo docs.
config.resolver.unstable_enableSymlinks = true;

// 4. Package exports — Metro 0.80+ understands the `exports` field in
//    `package.json`, which `@dina/adapters-expo` relies on for its
//    `./polyfills` subpath. Without this, `import '@dina/adapters-expo/polyfills'`
//    falls back to the filesystem and misses the subpath remap.
config.resolver.unstable_enablePackageExports = true;

// 5. TS source files live in workspace packages — make sure Metro accepts
//    `.ts`/`.tsx` extensions during resolution.
config.resolver.sourceExts = [...(config.resolver.sourceExts || []), 'ts', 'tsx'];

// 6. Node-builtin shims. `@dina/core`'s barrel re-exports node-only modules
//    (`identity/keypair`, `schema/{identity,persona}`, `storage/{seed_file,spool}`,
//    `testing/vector_validator`) that statically `import * as fs from 'fs'` +
//    `import * as path from 'path'`. Mobile boots through `@dina/storage-expo`
//    + op-sqlite and never invokes those code paths at runtime, but Metro
//    still has to resolve the static import sites or the whole bundle fails.
//    Map both to an empty shim — runtime calls into a stubbed function would
//    throw immediately, surfacing any accidental regression loudly.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  fs: path.resolve(projectRoot, 'src/shims/empty.js'),
  path: path.resolve(projectRoot, 'src/shims/empty.js'),
};

// 7. The repo-proof verifier's audited AT-Protocol stack (§5.C1-mobile,
//    `@dina/net-expo/repo_proof`). Three imports in that tree are Node-only and
//    unused by the verification path; each maps to a shim that satisfies the
//    import and throws (or stays silent) if ever called at runtime:
//      - `node:timers/promises` — `@atproto/repo` yields the event loop while
//        reading a CAR; shimmed with RN's own `setImmediate`.
//      - `node:dns/promises`    — `@atproto/identity` handle resolution
//        (never used: the verifier resolves DIDs).
//      - `@atproto/common`      — one `subsystemLogger` import in
//        `@atproto/repo`, whose real barrel drags pino + node streams.
//    `extraNodeModules` cannot express the `node:` protocol or a scoped
//    package alias, so this is a resolveRequest hook that hands everything else
//    to Metro's default resolver.
const SHIMS = {
  'node:timers/promises': path.resolve(projectRoot, 'src/shims/node_timers_promises.js'),
  'timers/promises': path.resolve(projectRoot, 'src/shims/node_timers_promises.js'),
  'node:dns/promises': path.resolve(projectRoot, 'src/shims/node_dns_promises.js'),
  'dns/promises': path.resolve(projectRoot, 'src/shims/node_dns_promises.js'),
  '@atproto/common': path.resolve(projectRoot, 'src/shims/atproto_common.js'),
};
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const shim = SHIMS[moduleName];
  if (shim !== undefined) return { type: 'sourceFile', filePath: shim };
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
