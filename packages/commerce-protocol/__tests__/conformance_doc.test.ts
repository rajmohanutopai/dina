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

  it('declares the frozen-vector gaps rather than implying full coverage', () => {
    // §25.1 is not fully covered. Saying so in the file a port reads is the
    // difference between an honest partial kit and a misleading one.
    expect(text).toMatch(/Known gaps/);
  });
});
