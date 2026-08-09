/**
 * The conformance doc is part of the contract, not commentary on it.
 *
 * `docs/conformance.md` currently declares `1.x` UNFROZEN — no implementation
 * may claim conformance, and no third party should target the wire. That
 * declaration is the only thing standing between "we changed the spine
 * without a version bump" and "we shipped an incompatible change while
 * claiming 1.0".
 *
 * A prose warning nobody checks decays: the version drifts, the freeze
 * happens informally, or the note is deleted in a tidy-up. These tests fail
 * when the document and the code disagree, so the claim stays true or the
 * build goes red.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { COMMERCE_PROTOCOL_VERSION } from '../src/common';

const DOC = path.join(__dirname, '..', 'docs', 'conformance.md');

describe('conformance documentation', () => {
  const text = fs.readFileSync(DOC, 'utf8');

  it('exists and names the version the code actually emits', () => {
    // If the two drift, a reader trusts a number the build does not produce.
    expect(text).toContain(`\`${COMMERCE_PROTOCOL_VERSION}\``);
  });

  it('carries the pre-freeze declaration while the version is 1.x', () => {
    // Removing the warning is a decision, not a cleanup: it asserts that the
    // wire is stable and third parties may target it. Make that decision
    // fail loudly here rather than quietly in someone else's port.
    if (COMMERCE_PROTOCOL_VERSION.startsWith('1.')) {
      expect(text).toMatch(/IS NOT FROZEN/);
      expect(text).toMatch(/no implementation may claim commerce conformance/i);
    }
  });

  it('records the incompatible changes made without a version bump', () => {
    // Each of these broke the wire. A changelog that omits them lets a
    // future reader conclude 1.0 always meant what it means today.
    for (const change of ['HeldEvidence', 'computeTotal', 'BuyerQuoteContext']) {
      expect(text).toContain(change);
    }
  });

  it('lists the Phase 0 exit criteria as checkable items', () => {
    // "Freeze when ready" is not a criterion. The doc has to say what would
    // make it ready, and show what is still open.
    expect(text).toMatch(/Phase 0 exit criteria/);
    expect(text).toMatch(/- \[ \]/); // at least one criterion still open
  });

  /**
   * The doc's vector TABLE is an inventory, and an inventory that nobody
   * checks goes stale silently — this one did: three vectors were added and
   * the table still listed the original three, so the document understated
   * coverage until someone happened to read both.
   *
   * Comparing against the directory is the only version of this check that
   * cannot itself drift.
   */
  it('lists every frozen vector file that actually exists', () => {
    const vectorDir = path.join(__dirname, '..', 'conformance', 'vectors');
    const onDisk = fs
      .readdirSync(vectorDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(onDisk.length).toBeGreaterThan(0);

    // Scoped to the TABLE, not the whole document. A first attempt searched
    // the file and passed while the table was wrong, because the same
    // filename appeared in prose below it — the check has to look where the
    // inventory actually lives.
    const listed = new Set(
      text
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .flatMap((row) => [...row.matchAll(/`([a-z_]+\.json)`/g)].map((m) => m[1])),
    );

    expect([...listed].sort()).toEqual(onDisk);
  });

  it('declares the frozen-vector gaps rather than implying full coverage', () => {
    // §25.1 is not fully covered. Saying so in the file a port reads is the
    // difference between an honest partial kit and a misleading one.
    expect(text).toMatch(/Known gaps/);
  });
});
