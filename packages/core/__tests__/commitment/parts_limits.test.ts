/**
 * COMMITMENT_KERNEL §6, §7 — the kernel's number parts and per-part limits
 * (step 1a of §15).
 *
 *   K-01  direction comes from who pays: lower is the payer's side, higher
 *         the payee's, for either party as holder;
 *   K-02  every reason `validateNumberParts` refuses a vocabulary;
 *   K-03  the premium rounds once in the holder's favour and caps ratios;
 *   K-04  the clamp: within the automatic limit, past it (asks about the
 *         proposal), past the hard limit (asks about the hard limit), equal
 *         limits (no question), an owner-authorised value;
 *   K-05  the Slot Pack's parts are exactly the wire's term table, with the
 *         same kinds and directions, until documents pin a vocabulary;
 *   K-06  no term-engine source reads direction from the table any more.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { TERM_NAMES, TERM_TABLE } from '@dina/commerce-protocol';

import { SLOT_PACK_PARTS } from '../../src/commerce/slot_pack_manifests';
import {
  applyPremium,
  atLeastFor,
  clampPart,
  validateNumberParts,
  type NumberPartSpec,
} from '../../src/commitment';

const RENT: NumberPartSpec = { name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' };
const SHARE: NumberPartSpec = {
  name: 'share_bps',
  kind: 'ratio_bps',
  payer: 'buyer',
  payee: 'seller',
};
const DISCOUNT: NumberPartSpec = { name: 'refund', kind: 'money', payer: 'seller', payee: 'buyer' };

describe('K-01 direction comes from who pays', () => {
  it('the payee wants higher, the payer lower', () => {
    expect(atLeastFor(RENT, 'seller', 1200n, 1000n)).toBe(true);
    expect(atLeastFor(RENT, 'seller', 900n, 1000n)).toBe(false);
    expect(atLeastFor(RENT, 'buyer', 900n, 1000n)).toBe(true);
    expect(atLeastFor(RENT, 'buyer', 1200n, 1000n)).toBe(false);
    expect(atLeastFor(DISCOUNT, 'buyer', 50n, 40n)).toBe(true);
    expect(atLeastFor(DISCOUNT, 'seller', 50n, 40n)).toBe(false);
  });
  it('equal values are at least as good for both', () => {
    expect(atLeastFor(RENT, 'seller', 1000n, 1000n)).toBe(true);
    expect(atLeastFor(RENT, 'buyer', 1000n, 1000n)).toBe(true);
  });
});

describe('K-02 validateNumberParts', () => {
  it('accepts the Slot Pack', () => {
    expect(validateNumberParts(SLOT_PACK_PARTS)).toBeNull();
  });
  it.each<[string, NumberPartSpec[], RegExp]>([
    ['empty', [], /at least one part/],
    ['bad name', [{ ...RENT, name: 'Fee' }], /lowercase/],
    ['unsorted', [SHARE, RENT], /unique and sorted/],
    ['duplicate', [RENT, RENT], /unique and sorted/],
    ['bad kind', [{ ...RENT, kind: 'bps' as never }], /money \| ratio_bps/],
    ['same party', [{ ...RENT, payee: 'buyer' }], /different parties/],
    ['outside party', [{ ...RENT, payee: 'customers' as never }], /deal parties/],
  ])('refuses %s', (_label, parts, reason) => {
    expect(validateNumberParts(parts)).toMatch(reason);
  });
});

describe('K-03 applyPremium', () => {
  it('rounds up for the payee and down for the payer', () => {
    // 1001 × 1.05 = 1051.05
    expect(applyPremium(RENT, 'seller', 1001n, 1, 500)).toBe(1052n);
    expect(applyPremium(RENT, 'buyer', 1001n, 1, 500)).toBe(1051n);
  });
  it('is the identity with no count or no premium', () => {
    expect(applyPremium(RENT, 'seller', 1001n, 0, 500)).toBe(1001n);
    expect(applyPremium(RENT, 'seller', 1001n, 3, 0)).toBe(1001n);
  });
  it('caps a ratio at 10,000 bps', () => {
    expect(applyPremium(SHARE, 'seller', 9_900n, 2, 500)).toBe(10_000n);
  });
});

describe('K-04 clampPart', () => {
  const bounds = { hard: 800n, auto: 1000n };
  it('signs a proposal within the automatic limit as it is', () => {
    expect(clampPart(RENT, 'seller', 1100n, bounds, null)).toEqual({
      value: 1100n,
      needsOwner: false,
    });
  });
  it('signs the automatic limit and asks about a proposal between the limits', () => {
    expect(clampPart(RENT, 'seller', 900n, bounds, null)).toEqual({
      value: 1000n,
      needsOwner: true,
      asked: 900n,
    });
  });
  it('asks about the hard limit, never the proposal, when the proposal is past it', () => {
    expect(clampPart(RENT, 'seller', 700n, bounds, null)).toEqual({
      value: 1000n,
      needsOwner: true,
      asked: 800n,
    });
  });
  it('raises no question when the limits are equal', () => {
    expect(clampPart(RENT, 'seller', 700n, { hard: 800n, auto: 800n }, null)).toEqual({
      value: 800n,
      needsOwner: false,
    });
  });
  it('honours an owner-authorised value between the limits', () => {
    expect(clampPart(RENT, 'seller', 850n, bounds, 900n)).toEqual({
      value: 900n,
      needsOwner: false,
    });
    expect(clampPart(RENT, 'seller', 950n, bounds, 900n)).toEqual({
      value: 950n,
      needsOwner: false,
    });
  });
  it('ignores an authorised value outside the limits', () => {
    expect(clampPart(RENT, 'seller', 900n, bounds, 700n)).toEqual({
      value: 1000n,
      needsOwner: true,
      asked: 900n,
    });
  });
  it('works for a payer holding ceilings', () => {
    expect(clampPart(RENT, 'buyer', 1500n, { hard: 1400n, auto: 1200n }, null)).toEqual({
      value: 1200n,
      needsOwner: true,
      asked: 1400n,
    });
  });
});

describe('K-05 the Slot Pack parts match the wire table', () => {
  it('names the same terms in the same order', () => {
    expect(SLOT_PACK_PARTS.map((p) => p.name)).toEqual([...TERM_NAMES]);
  });
  it('agrees on kind and direction', () => {
    for (const part of SLOT_PACK_PARTS) {
      const spec = TERM_TABLE[part.name as keyof typeof TERM_TABLE];
      expect(part.kind).toBe(spec.kind === 'money' ? 'money' : 'ratio_bps');
      // buyerFavours 'lower' ⇔ the buyer pays.
      expect(part.payer === 'buyer').toBe(spec.buyerFavours === 'lower');
    }
  });
});

describe('K-06 the term engine reads direction from the kernel', () => {
  it('no term source reads buyerFavours or the table kind', () => {
    const dir = path.join(__dirname, '../../src/commerce/term');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect({ file, hits: source.match(/TERM_TABLE|buyerFavours|termMeetsBuyerTarget/g) }).toEqual(
        {
          file,
          hits: null,
        },
      );
    }
  });
});
