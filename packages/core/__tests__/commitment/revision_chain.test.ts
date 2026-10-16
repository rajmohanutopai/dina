/**
 * COMMITMENT_KERNEL §6, §7 — revising inside per-part limits and the offer
 * chain (step 1b of §15). The term engine's own suites cover these through
 * two real engines; these pin the kernel rules on their own.
 *
 *   K-10  a first offer raises a part short of its automatic limit;
 *   K-11  a revision never retreats; it holds when a hard limit moved past
 *         the current offer; it asks about what passed the automatic limit;
 *         the note's example (current 900, hard 800, auto raised to 950,
 *         proposal 850) keeps 900 and asks;
 *   K-12  an owner's yes concedes only, and only inside hard limits now;
 *   K-13  the hard-limit check at the owner's approval;
 *   K-14  a yes may bind the head, or the offer before a yes-revision, never
 *         older and never before a counter's revision;
 *   K-15  lateness is judged on the signed time, within a grace.
 */

import {
  bindableDigests,
  firstWithinLimits,
  judgeLateness,
  meetsHardLimits,
  ownerConcession,
  reviseWithinLimits,
  type NumberPartSpec,
} from '../../src/commitment';

type N = 'fee' | 'share_bps';
const PARTS: NumberPartSpec[] = [
  { name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' },
  { name: 'share_bps', kind: 'ratio_bps', payer: 'buyer', payee: 'seller' },
];
const bounds = (fee: [bigint, bigint], share: [bigint, bigint]) => ({
  fee: { hard: fee[0], auto: fee[1] },
  share_bps: { hard: share[0], auto: share[1] },
});
const values = (fee: bigint, share: bigint): Record<N, bigint> => ({ fee, share_bps: share });
const none = new Map<string, bigint>();

describe('K-10 firstWithinLimits', () => {
  it('raises only the parts short of the automatic limit', () => {
    expect(
      firstWithinLimits<N>(
        PARTS,
        'seller',
        values(900n, 800n),
        bounds([800n, 1000n], [500n, 600n]),
      ),
    ).toEqual(values(1000n, 800n));
  });
});

describe('K-11 reviseWithinLimits', () => {
  const b = bounds([800n, 1000n], [500n, 600n]);
  it('moves within the automatic limit without asking', () => {
    const r = reviseWithinLimits<N>({
      parts: PARTS,
      holder: 'seller',
      current: values(1200n, 700n),
      proposed: values(1100n, 650n),
      bounds: b,
      authorised: none,
    });
    expect(r).toEqual({ kind: 'signed', signed: values(1100n, 650n), asked: {}, unchanged: false });
  });
  it('clamps to the automatic limit and asks about the proposal', () => {
    const r = reviseWithinLimits<N>({
      parts: PARTS,
      holder: 'seller',
      current: values(1200n, 700n),
      proposed: values(900n, 700n),
      bounds: b,
      authorised: none,
    });
    expect(r).toEqual({
      kind: 'signed',
      signed: values(1000n, 700n),
      asked: { fee: 900n },
      unchanged: false,
    });
  });
  it('never retreats: keeps the current value and only asks (the note example)', () => {
    const r = reviseWithinLimits<N>({
      parts: PARTS,
      holder: 'seller',
      current: values(900n, 700n),
      proposed: values(850n, 700n),
      bounds: bounds([800n, 950n], [500n, 600n]),
      authorised: none,
    });
    expect(r).toEqual({
      kind: 'signed',
      signed: values(900n, 700n),
      asked: { fee: 850n },
      unchanged: true,
    });
  });
  it('holds when a hard limit has moved past the current offer', () => {
    const r = reviseWithinLimits<N>({
      parts: PARTS,
      holder: 'seller',
      current: values(900n, 700n),
      proposed: values(900n, 650n),
      bounds: bounds([950n, 1000n], [500n, 600n]),
      authorised: none,
    });
    expect(r).toEqual({ kind: 'hold' });
  });
  it('honours an owner-authorised value', () => {
    const r = reviseWithinLimits<N>({
      parts: PARTS,
      holder: 'seller',
      current: values(1200n, 700n),
      proposed: values(850n, 700n),
      bounds: b,
      authorised: new Map([['fee', 900n]]),
    });
    expect(r).toEqual({ kind: 'signed', signed: values(900n, 700n), asked: {}, unchanged: false });
  });
});

describe('K-12 ownerConcession', () => {
  const b = bounds([800n, 1000n], [500n, 600n]);
  it('takes an authorised value that concedes', () => {
    expect(
      ownerConcession<N>({
        parts: PARTS,
        holder: 'seller',
        current: values(1000n, 600n),
        authorised: new Map([['fee', 900n]]),
        bounds: b,
      }),
    ).toEqual(values(900n, 600n));
  });
  it('ignores a value that would take back, and returns null when nothing moves', () => {
    expect(
      ownerConcession<N>({
        parts: PARTS,
        holder: 'seller',
        current: values(1000n, 600n),
        authorised: new Map([['fee', 1100n]]),
        bounds: b,
      }),
    ).toBeNull();
  });
  it('returns null when a carried-over part is past a hard limit now', () => {
    expect(
      ownerConcession<N>({
        parts: PARTS,
        holder: 'seller',
        current: values(1000n, 600n),
        authorised: new Map([['fee', 900n]]),
        bounds: bounds([800n, 1000n], [650n, 700n]),
      }),
    ).toBeNull();
  });
});

describe('K-13 meetsHardLimits', () => {
  it('checks every part against its hard limit, not the automatic one', () => {
    const b = bounds([800n, 1200n], [500n, 600n]);
    expect(meetsHardLimits<N>(PARTS, 'seller', values(1100n, 550n), b)).toBe(true);
    expect(meetsHardLimits<N>(PARTS, 'seller', values(1100n, 450n), b)).toBe(false);
  });
});

describe('K-14 bindableDigests', () => {
  it('is empty for an empty chain', () => {
    expect(bindableDigests([])).toEqual([]);
  });
  it("is the head alone after a counter's revision", () => {
    expect(
      bindableDigests([
        { digest: 'o1', answersDigest: 'req' },
        { digest: 'o2', previousDigest: 'o1', answersDigest: 'counter1' },
      ]),
    ).toEqual(['o2']);
  });
  it('adds the offer before a yes-revision', () => {
    expect(
      bindableDigests([
        { digest: 'o1', answersDigest: 'req' },
        { digest: 'o2', previousDigest: 'o1', answersDigest: 'counter1' },
        { digest: 'o3', previousDigest: 'o2', answersDigest: 'o2' },
      ]),
    ).toEqual(['o3', 'o2']);
  });
});

describe('K-15 judgeLateness', () => {
  const at = (h: number) => h * 3_600_000;
  it('counts a yes signed in time that arrives within the grace', () => {
    expect(
      judgeLateness({ signedAtMs: at(9), validUntilMs: at(10), nowMs: at(30), graceMs: at(24) }),
    ).toBe('in_time');
  });
  it('refuses a yes signed after expiry', () => {
    expect(
      judgeLateness({ signedAtMs: at(11), validUntilMs: at(10), nowMs: at(11), graceMs: at(24) }),
    ).toBe('signed_after_expiry');
  });
  it('refuses a yes that arrives past the grace', () => {
    expect(
      judgeLateness({ signedAtMs: at(9), validUntilMs: at(10), nowMs: at(35), graceMs: at(24) }),
    ).toBe('arrived_too_late');
  });
});
