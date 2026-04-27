import { dinaMatchers, installUnhandledRejectionGuard } from '@dina/test-harness';
import { clearVaults, DEFAULT_TEST_PERSONAS } from '../src/vault/crud';

expect.extend(dinaMatchers);

// Task 11.8 — unhandled promise rejections are a soak-time concern
// but also a regular-run one: a `.catch`-less Promise slipping through
// a green test is a latent bug. The guard converts any rejection that
// fires during a test into a test failure so the responsible test
// surfaces it immediately.
installUnhandledRejectionGuard();

/**
 * Pre-wire in-memory vaults for the default test persona set before
 * each core test. The strict `requireRepo()` resolver no longer
 * auto-provisions on miss — production needs that strictness so a
 * forgotten `openPersonaDB()` surfaces immediately instead of
 * silently routing writes into volatile RAM. Tests that previously
 * relied on the auto-provision fallback get the same in-memory repos
 * eagerly here, no per-file change required. Tests that need a
 * non-default persona can call `clearVaults([...])` with the
 * extended list inside their own `beforeEach` (the latest call wins).
 */
beforeEach(() => {
  clearVaults(DEFAULT_TEST_PERSONAS);
});
