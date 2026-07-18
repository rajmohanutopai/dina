/**
 * Narrow entry point for the platform-safe `fetch` accessor.
 *
 * Importers that only need `defaultFetch` (e.g. `@dina/net-node`'s HttpClient)
 * MUST import from here, not the `@dina/core` barrel: the barrel re-exports the
 * whole vault-keeper domain (including `@noble/*` crypto), and because
 * `@dina/core` isn't marked side-effect-free, pulling a single value from the
 * barrel drags the entire transitive graph into a consumer's bundle. This
 * subpath is a leaf module with zero dependencies, so bundling it stays tiny
 * and crypto-free (pinned by `adapters-node/__tests__/treeshaking.test.ts`).
 */

export { defaultFetch } from './src/runtime/fetch';
