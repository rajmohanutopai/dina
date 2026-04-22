/**
 * Task 6.21 — TrustScoreResolver tests.
 */

import {
  DEFAULT_TRUST_STALE_TTL_MS,
  DEFAULT_TRUST_TTL_MS,
  TrustScoreResolver,
  type TrustFetchFn,
  type TrustLookupOutcome,
  type TrustResolverEvent,
} from '../src/appview/trust_score_resolver';

function fakeClock(start = 0) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (d: number) => {
      now += d;
    },
  };
}

const DID_A = 'did:plc:alice';

describe('TrustScoreResolver (task 6.21)', () => {
  describe('construction', () => {
    it('throws without fetchFn', () => {
      expect(
        () =>
          new TrustScoreResolver({
            fetchFn: undefined as unknown as TrustFetchFn,
          }),
      ).toThrow(/fetchFn/);
    });

    it('constants: 10m fresh / 60m stale', () => {
      expect(DEFAULT_TRUST_TTL_MS).toBe(10 * 60 * 1000);
      expect(DEFAULT_TRUST_STALE_TTL_MS).toBe(60 * 60 * 1000);
    });
  });

  describe('happy path', () => {
    it('first call → network (source=network)', async () => {
      const fetchFn: TrustFetchFn = async () => ({
        kind: 'found',
        score: 0.85,
        confidence: 0.9,
        ring: 1,
        flagCount: 0,
      });
      const r = new TrustScoreResolver({ fetchFn });
      const res = await r.getTrustScore(DID_A);
      expect(res.did).toBe(DID_A);
      expect(res.score).toBe(0.85);
      expect(res.confidence).toBe(0.9);
      expect(res.ring).toBe(1);
      expect(res.flagCount).toBe(0);
      expect(res.source).toBe('network');
    });

    it('second call within TTL → fresh hit, no refetch', async () => {
      let calls = 0;
      const fetchFn: TrustFetchFn = async () => {
        calls++;
        return {
          kind: 'found',
          score: 0.7,
          confidence: 0.6,
          flagCount: 0,
        };
      };
      const clock = fakeClock(1000);
      const r = new TrustScoreResolver({ fetchFn, nowMsFn: clock.nowMsFn });
      await r.getTrustScore(DID_A);
      clock.advance(60_000); // 1 min — well within 10 min TTL
      const res2 = await r.getTrustScore(DID_A);
      expect(calls).toBe(1);
      expect(res2.source).toBe('fresh');
      expect(res2.ageMs).toBeGreaterThanOrEqual(60_000);
    });

    it('past TTL but within stale window → stale-while-revalidate', async () => {
      const returns: TrustLookupOutcome[] = [
        { kind: 'found', score: 0.5, confidence: 0.5, flagCount: 0 },
        { kind: 'found', score: 0.6, confidence: 0.7, flagCount: 0 },
      ];
      let i = 0;
      const fetchFn: TrustFetchFn = async () => returns[i++]!;
      const clock = fakeClock(1000);
      const r = new TrustScoreResolver({
        fetchFn,
        nowMsFn: clock.nowMsFn,
        ttlMs: 60_000,
        staleTtlMs: 600_000,
      });
      await r.getTrustScore(DID_A); // primes with score=0.5
      clock.advance(120_000); // past TTL, inside stale window
      const stale = await r.getTrustScore(DID_A);
      expect(stale.source).toBe('stale-while-revalidate');
      expect(stale.score).toBe(0.5); // served stale
      expect(stale.ageMs).toBe(120_000);
      // Let the background refresh settle.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      const fresh = await r.getTrustScore(DID_A);
      expect(fresh.source).toBe('fresh');
      expect(fresh.score).toBe(0.6);
    });

    it('past stale window → blocking network refetch', async () => {
      const returns: TrustLookupOutcome[] = [
        { kind: 'found', score: 0.5, confidence: 0.5, flagCount: 0 },
        { kind: 'found', score: 0.6, confidence: 0.7, flagCount: 0 },
      ];
      let i = 0;
      const fetchFn: TrustFetchFn = async () => returns[i++]!;
      const clock = fakeClock(1000);
      const r = new TrustScoreResolver({
        fetchFn,
        nowMsFn: clock.nowMsFn,
        ttlMs: 60_000,
        staleTtlMs: 60_000,
      });
      await r.getTrustScore(DID_A);
      clock.advance(200_000); // past TTL + staleTtl
      const res = await r.getTrustScore(DID_A);
      expect(res.source).toBe('network');
      expect(res.score).toBe(0.6);
    });

    it('mustRevalidate forces network refetch within TTL', async () => {
      let calls = 0;
      const fetchFn: TrustFetchFn = async () => {
        calls++;
        return {
          kind: 'found',
          score: 0.5 + calls * 0.1,
          confidence: 0.5,
          flagCount: 0,
        };
      };
      const r = new TrustScoreResolver({ fetchFn });
      await r.getTrustScore(DID_A);
      const forced = await r.getTrustScore(DID_A, { mustRevalidate: true });
      expect(calls).toBe(2);
      expect(forced.source).toBe('network');
    });
  });

  describe('unknown subject', () => {
    it('kind=unknown → source=unknown + null score/confidence', async () => {
      const fetchFn: TrustFetchFn = async () => ({ kind: 'unknown' });
      const r = new TrustScoreResolver({ fetchFn });
      const res = await r.getTrustScore(DID_A);
      expect(res.source).toBe('unknown');
      expect(res.score).toBeNull();
      expect(res.confidence).toBeNull();
      expect(res.ring).toBeNull();
      expect(res.flagCount).toBe(0);
    });
  });

  describe('flagCount + ring pass-through', () => {
    it('propagates ring + flag count', async () => {
      const fetchFn: TrustFetchFn = async () => ({
        kind: 'found',
        score: 0.3,
        confidence: 0.4,
        ring: 2,
        flagCount: 3,
      });
      const res = await new TrustScoreResolver({ fetchFn }).getTrustScore(DID_A);
      expect(res.ring).toBe(2);
      expect(res.flagCount).toBe(3);
    });

    it('ring null when omitted', async () => {
      const fetchFn: TrustFetchFn = async () => ({
        kind: 'found',
        score: 0.5,
        confidence: 0.5,
        flagCount: 0,
      });
      const res = await new TrustScoreResolver({ fetchFn }).getTrustScore(DID_A);
      expect(res.ring).toBeNull();
    });
  });

  describe('error fallback', () => {
    it('network failure with stale entry → error-fallback', async () => {
      const sequence = [
        async (): Promise<TrustLookupOutcome> => ({
          kind: 'found',
          score: 0.7,
          confidence: 0.5,
          flagCount: 0,
        }),
        async (): Promise<TrustLookupOutcome> => {
          throw new Error('appview offline');
        },
      ];
      let i = 0;
      const fetchFn: TrustFetchFn = () => sequence[i++]!();
      const clock = fakeClock(1000);
      const r = new TrustScoreResolver({
        fetchFn,
        nowMsFn: clock.nowMsFn,
        ttlMs: 60_000,
        staleTtlMs: 60_000,
      });
      await r.getTrustScore(DID_A);
      clock.advance(200_000); // past stale window → blocking refetch → fails → fallback
      const res = await r.getTrustScore(DID_A);
      expect(res.source).toBe('error-fallback');
      expect(res.score).toBe(0.7);
    });

    it('network failure with no prior entry → throws', async () => {
      const fetchFn: TrustFetchFn = async () => {
        throw new Error('dns failure');
      };
      const r = new TrustScoreResolver({ fetchFn });
      await expect(r.getTrustScore(DID_A)).rejects.toThrow(/dns failure/);
    });
  });

  describe('invalidate + clear', () => {
    it('invalidate(did) forces next call to refetch', async () => {
      let calls = 0;
      const fetchFn: TrustFetchFn = async () => {
        calls++;
        return { kind: 'found', score: 0.5, confidence: 0.5, flagCount: 0 };
      };
      const r = new TrustScoreResolver({ fetchFn });
      await r.getTrustScore(DID_A);
      expect(calls).toBe(1);
      expect(r.invalidate(DID_A)).toBe(true);
      await r.getTrustScore(DID_A);
      expect(calls).toBe(2);
    });

    it('invalidate returns false for unknown did', async () => {
      const r = new TrustScoreResolver({
        fetchFn: async () => ({ kind: 'unknown' }),
      });
      expect(r.invalidate('did:plc:nothing')).toBe(false);
    });

    it('clear empties cache', async () => {
      const fetchFn: TrustFetchFn = async () => ({ kind: 'unknown' });
      const r = new TrustScoreResolver({ fetchFn });
      await r.getTrustScore(DID_A);
      await r.getTrustScore('did:plc:b');
      expect(r.size()).toBe(2);
      r.clear();
      expect(r.size()).toBe(0);
    });
  });

  describe('input validation', () => {
    it('empty did throws', async () => {
      const r = new TrustScoreResolver({
        fetchFn: async () => ({ kind: 'unknown' }),
      });
      await expect(r.getTrustScore('')).rejects.toThrow(/did/);
    });

    it('non-string did throws', async () => {
      const r = new TrustScoreResolver({
        fetchFn: async () => ({ kind: 'unknown' }),
      });
      await expect(
        r.getTrustScore(42 as unknown as string),
      ).rejects.toThrow(/did/);
    });
  });

  describe('events', () => {
    it('fires resolved event per getTrustScore', async () => {
      const events: TrustResolverEvent[] = [];
      const fetchFn: TrustFetchFn = async () => ({
        kind: 'found',
        score: 0.9,
        confidence: 0.8,
        flagCount: 0,
      });
      const r = new TrustScoreResolver({ fetchFn, onEvent: (e) => events.push(e) });
      await r.getTrustScore(DID_A);
      const resolved = events.find((e) => e.kind === 'resolved') as Extract<
        TrustResolverEvent,
        { kind: 'resolved' }
      >;
      expect(resolved.did).toBe(DID_A);
      expect(resolved.source).toBe('network');
      expect(resolved.score).toBe(0.9);
    });

    it('forwards SWR events (revalidate_succeeded, etc.)', async () => {
      const events: TrustResolverEvent[] = [];
      const fetchFn: TrustFetchFn = async () => ({
        kind: 'found',
        score: 0.5,
        confidence: 0.5,
        flagCount: 0,
      });
      const r = new TrustScoreResolver({ fetchFn, onEvent: (e) => events.push(e) });
      await r.getTrustScore(DID_A);
      expect(events.some((e) => e.kind === 'revalidate_succeeded')).toBe(true);
    });
  });

  describe('realistic flow', () => {
    it('resolved tuple is consumable by decideTrust shape', async () => {
      // Verify the resolved score has the fields `decideTrust` (6.23) expects.
      const fetchFn: TrustFetchFn = async () => ({
        kind: 'found',
        score: 0.75,
        confidence: 0.6,
        ring: 2,
        flagCount: 0,
      });
      const r = new TrustScoreResolver({ fetchFn });
      const score = await r.getTrustScore(DID_A);
      // decideTrust wants: score, confidence, flagCount?, ring?
      // All present on the TrustScore object.
      expect(score.score).toBeGreaterThan(0);
      expect(score.confidence).toBeGreaterThan(0);
      expect(score.ring).toBe(2);
      expect(score.flagCount).toBe(0);
    });
  });
});
