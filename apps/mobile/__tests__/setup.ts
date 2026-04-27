/**
 * Mobile test setup — pre-wires in-memory vaults for the default
 * persona set before each test.
 *
 * The strict `requireRepo()` resolver in `packages/core/src/vault/crud.ts`
 * no longer auto-provisions on miss — production needs that
 * strictness so a forgotten `openPersonaDB()` surfaces immediately
 * instead of silently routing writes into volatile RAM. Mobile tests
 * that previously relied on the auto-provision fallback get the
 * same in-memory repos eagerly here, no per-file change required.
 *
 * Tests that need a non-default persona (`work`, `finance`, etc.)
 * can call `clearVaults([...])` with the extended list inside their
 * own `beforeEach` (the latest call wins).
 *
 * Mirrors `packages/{core,brain}/__tests__/setup.ts`.
 */

import {
  clearVaults,
  DEFAULT_TEST_PERSONAS,
} from '../../../packages/core/src/vault/crud';

beforeEach(() => {
  clearVaults(DEFAULT_TEST_PERSONAS);
});
