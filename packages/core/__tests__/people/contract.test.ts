/**
 * `SQLitePeopleRepository` against the people-store parity contract.
 *
 * The contract suite (`src/people/contract.ts`) encodes the
 * parity-critical behaviors any implementation must honor to stay in
 * lockstep with main Dina's Go `SQLitePersonStore`. This file just
 * wires the harness — every assertion lives in the contract suite, so
 * a future Go-import or Rust port runs the same checks by pointing
 * its own factory at `runPersonStoreContract`.
 */

import { runPersonStoreContract } from '../../src/people/contract';

import { openPeopleHarness } from './_harness';

describe('SQLitePeopleRepository — Go parity contract', () => {
  runPersonStoreContract({
    makeRepo: () => {
      const harness = openPeopleHarness();
      return { repo: harness.repo, cleanup: harness.cleanup };
    },
  });
});
