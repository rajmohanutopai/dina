/**
 * The trust producer (§5.A3). It turns a seller's PeerLens `overallTrustScore`
 * (0..1) into the `trustBp` the ranker consumes, FAIL-SOFT: absent history is
 * `undefined` (never a zero, §13.4), and one unreadable profile never sinks the
 * comparison.
 */

import { fetchSellerTrustBp, sellerTrustBp } from '../../src/reasoning/trust_producer';

describe('sellerTrustBp — overallTrustScore → trustBp', () => {
  it('maps 0..1 to 0..10000 basis points', () => {
    expect(sellerTrustBp(0.7)).toBe(7000);
    expect(sellerTrustBp(0)).toBe(0);
    expect(sellerTrustBp(1)).toBe(10000);
  });

  it('returns undefined for a null score (absent history, never a zero)', () => {
    expect(sellerTrustBp(null)).toBeUndefined();
  });

  it('clamps a score that arrives outside 0..1 defensively', () => {
    expect(sellerTrustBp(1.5)).toBe(10000);
    expect(sellerTrustBp(-0.2)).toBe(0);
  });
});

describe('fetchSellerTrustBp — fail-soft per DID', () => {
  function stub(map: Record<string, { overallTrustScore: number | null } | null | Error>) {
    return {
      getProfile: async (did: string): Promise<{ overallTrustScore: number | null } | null> => {
        const v = map[did];
        if (v instanceof Error) throw v;
        return v ?? null;
      },
    };
  }

  it('returns a map of DID → trustBp for suppliers with a score', async () => {
    const client = stub({
      'did:plc:a': { overallTrustScore: 0.7 },
      'did:plc:b': { overallTrustScore: 0.5 },
    });
    const result = await fetchSellerTrustBp(client, ['did:plc:a', 'did:plc:b']);
    expect(result.get('did:plc:a')).toBe(7000);
    expect(result.get('did:plc:b')).toBe(5000);
  });

  it('omits a DID with a null score (no history) rather than inserting a zero', async () => {
    const client = stub({ 'did:plc:new': { overallTrustScore: null } });
    const result = await fetchSellerTrustBp(client, ['did:plc:new']);
    expect(result.has('did:plc:new')).toBe(false);
  });

  it('omits a DID with no profile', async () => {
    const client = stub({ 'did:plc:missing': null });
    const result = await fetchSellerTrustBp(client, ['did:plc:missing']);
    expect(result.has('did:plc:missing')).toBe(false);
  });

  it('KEEPS a genuine zero score (a rated-badly seller) with value 0 — the other half of §13.4', async () => {
    // A seller with a real, bad rating (score 0, has history) must be KEPT at 0
    // — the ranker penalises it — while only a null/absent seller is omitted.
    // Guards the load-bearing `if (bp !== undefined)` insertion, not just the
    // pure mapper: a truthy-check regression would drop the bad seller and let
    // the ranker treat it as "no history" (weight redistributed in its favour).
    const client = stub({ 'did:plc:badseller': { overallTrustScore: 0 } });
    const result = await fetchSellerTrustBp(client, ['did:plc:badseller']);
    expect(result.has('did:plc:badseller')).toBe(true);
    expect(result.get('did:plc:badseller')).toBe(0);
  });

  it('logs a failed lookup, never throws, and omits only that supplier', async () => {
    const events: Record<string, unknown>[] = [];
    const client = stub({
      'did:plc:ok': { overallTrustScore: 0.6 },
      'did:plc:boom': new Error('appview down'),
    });
    const result = await fetchSellerTrustBp(
      client,
      ['did:plc:ok', 'did:plc:boom'],
      (e) => events.push(e),
    );
    expect(result.get('did:plc:ok')).toBe(6000);
    expect(result.has('did:plc:boom')).toBe(false);
    expect(
      events.some(
        (e) => e.event === 'trust_producer.getProfile_failed' && e.did === 'did:plc:boom',
      ),
    ).toBe(true);
  });

  it('de-duplicates DIDs so a repeated supplier costs one fetch', async () => {
    let calls = 0;
    const client = {
      getProfile: async (): Promise<{ overallTrustScore: number | null } | null> => {
        calls++;
        return { overallTrustScore: 0.9 };
      },
    };
    const result = await fetchSellerTrustBp(client, ['did:plc:x', 'did:plc:x', 'did:plc:x']);
    expect(calls).toBe(1);
    expect(result.get('did:plc:x')).toBe(9000);
  });
});
