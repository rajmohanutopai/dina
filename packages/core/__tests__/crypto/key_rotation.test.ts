/** The key ring (UCP plan §4.8, U7): staged, active, retiring, gone; pure. */
import {
  advance,
  dropExpired,
  freshRing,
  highestGeneration,
  listedGenerations,
  nextStepAt,
  promote,
  promoteAt,
  readKeyRing,
  stage,
  stagedConfirmed,
  stagedPublished,
  type KeyRing,
} from '../../src/crypto/key_rotation';

const WAIT = 360_000;
const OVERLAP = 7 * 86_400_000;

describe('key ring', () => {
  it('stages the next generation above the ring and above the floor; only one at a time', () => {
    expect(stage(freshRing(0), 0).staged).toEqual({ generation: 1 });
    // The host has seen generation 4 (a compromise on another device): start above it.
    expect(stage(freshRing(0), 4).staged).toEqual({ generation: 5 });
    const ring: KeyRing = { active: 3, retiring: [{ generation: 2, retireAfter: 9 }] };
    expect(stage(ring, 0).staged?.generation).toBe(4);
    const once = stage(freshRing(0), 0);
    expect(stage(once, 9)).toBe(once);
  });

  it('switches only once published AND confirmed served, the wait after the later of the two', () => {
    let r = stage(freshRing(0), 0);
    expect(promoteAt(r, WAIT)).toBeNull();
    // Confirmation before publication counts for nothing.
    expect(stagedConfirmed(r, 50)).toBe(r);
    r = stagedPublished(r, 100);
    expect(promoteAt(r, WAIT)).toBeNull();
    expect(promote(r, 10 ** 12, WAIT, OVERLAP)).toBe(r);
    r = stagedConfirmed(r, 400);
    expect(promoteAt(r, WAIT)).toBe(400 + WAIT);
    // First times only: a later publication or check does not move the switch.
    expect(stagedPublished(r, 5000)).toBe(r);
    expect(stagedConfirmed(r, 5000)).toBe(r);
    expect(promote(r, 400 + WAIT - 1, WAIT, OVERLAP)).toBe(r);
    expect(promote(r, 400 + WAIT, WAIT, OVERLAP)).toEqual({
      active: 1,
      retiring: [{ generation: 0, retireAfter: 400 + WAIT + OVERLAP }],
    });
  });

  it('drops a retiring key at its time, not before', () => {
    const r: KeyRing = { active: 2, retiring: [{ generation: 1, retireAfter: 100 }] };
    expect(dropExpired(r, 99)).toBe(r);
    expect(dropExpired(r, 100)).toEqual({ active: 2, retiring: [] });
  });

  it('names its next step: the switch or the earliest removal; nothing when idle', () => {
    expect(nextStepAt(freshRing(0), WAIT)).toBeNull();
    const r = stagedConfirmed(stagedPublished(stage(freshRing(0), 0), 10), 20);
    expect(nextStepAt(r, WAIT)).toBe(20 + WAIT);
    const after = advance(r, 20 + WAIT, WAIT, OVERLAP);
    expect(nextStepAt(after, WAIT)).toBe(20 + WAIT + OVERLAP);
    expect(advance(after, 20 + WAIT + OVERLAP, WAIT, OVERLAP)).toEqual({ active: 1, retiring: [] });
  });

  it('lists active, staged, then retiring; the highest is any of them', () => {
    const r: KeyRing = {
      active: 2,
      staged: { generation: 3 },
      retiring: [{ generation: 1, retireAfter: 5 }],
    };
    expect(listedGenerations(r)).toEqual([2, 3, 1]);
    expect(highestGeneration(r)).toBe(3);
  });

  it('reads a stored ring strictly', () => {
    const good = {
      active: 1,
      staged: { generation: 2, publishedAt: 5, confirmedAt: 6 },
      retiring: [{ generation: 0, retireAfter: 9 }],
    };
    expect(readKeyRing(good)).toEqual(good);
    expect(readKeyRing({ active: 0, retiring: [] })).toEqual({ active: 0, retiring: [] });
    for (const bad of [
      null,
      [],
      { active: -1, retiring: [] },
      { active: 0 },
      { active: 0, retiring: [{ generation: 1 }] },
      { active: 0, retiring: [], staged: { generation: 1.5 } },
      { active: 0, retiring: [], staged: { generation: 1, publishedAt: 'x' } },
      { active: 0, retiring: [], staged: null },
      // A generation listed twice.
      { active: 1, retiring: [{ generation: 1, retireAfter: 9 }] },
      { active: 1, staged: { generation: 1 }, retiring: [] },
    ])
      expect(readKeyRing(bad)).toBeNull();
  });
});
