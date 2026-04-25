/**
 * Empty Node-builtin shim for Metro.
 *
 * `@dina/core`'s barrel re-exports modules that statically `import * as fs
 * from 'fs'` and `import * as path from 'path'` (e.g. `identity/keypair`,
 * `schema/identity`, `schema/persona`, `storage/seed_file`, `storage/spool`).
 * These code paths are node-only — mobile boots through `@dina/storage-expo`
 * + op-sqlite and never invokes them at runtime — but Metro must still
 * statically resolve the import sites.
 *
 * Aliasing `fs` + `path` to this empty module via metro.config.js'
 * `resolver.extraNodeModules` lets the bundle compile cleanly. Any
 * accidental runtime call into a stubbed function would throw immediately
 * (`undefined is not a function`), surfacing the regression loudly rather
 * than silently corrupting state.
 */
module.exports = {};
