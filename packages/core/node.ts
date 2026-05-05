/**
 * `@dina/core/node` — Node-only adapters that pair with portable Core.
 *
 * Use this subpath from server boot, scripts, and tests that run in a
 * Node runtime. Mobile/Expo and other portable consumers must NOT
 * import from here — the dep-hygiene gate forbids `fs`/`path`/`node:*`
 * in `packages/core/src/**` (excluding `*_node.ts`), and that boundary
 * exists so this subpath stays Node-only.
 */

export { writeServiceKey, loadServiceKey } from './src/identity/keypair_node';

export {
  writeWrappedSeed,
  readWrappedSeed,
  wrappedSeedExists,
} from './src/storage/seed_file_node';

export { DeadDropSpool } from './src/storage/spool_node';
export type { SpoolMessage } from './src/storage/spool_node';

export { getIdentity001DDL, getIdentity002DDL } from './src/schema/identity_node';
export { getPersona001DDL } from './src/schema/persona_node';

export { loadFixtures, loadFixture } from './src/testing/vector_validator_node';
