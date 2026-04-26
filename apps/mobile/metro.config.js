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
  async_hooks: path.resolve(projectRoot, 'src/shims/async_hooks.js'),
  crypto: path.resolve(projectRoot, 'src/shims/node_crypto.js'),
};

// 7. `node:` prefix routing. `@dina/brain/src/diagnostics/trace_correlation.ts`
//    imports `node:async_hooks` and `node:crypto` explicitly (the modern Node
//    convention). Metro's extraNodeModules doesn't match the `node:` scheme,
//    so we strip the prefix in resolveRequest and re-enter resolution against
//    the bare module name (which then hits the extraNodeModules entries above).
//    Routing only fires for `node:`-prefixed specifiers; everything else falls
//    through to Metro's default resolver.
const baseResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('node:')) {
    return context.resolveRequest(context, moduleName.slice(5), platform);
  }
  if (typeof baseResolver === 'function') {
    return baseResolver(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
