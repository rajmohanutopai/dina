/**
 * §10.6 — combining catalog AppViews (WS-10.4).
 *
 * The rule with consequences is the third sentence: every result carries
 * enough source and snapshot evidence "to identify where it came from and to
 * verify the supplier live before commitment". A combiner that merged two
 * indexes into one anonymous list would satisfy the first half of §10.6 and
 * destroy the second.
 *
 * So the cases below are mostly about what SURVIVES the merge — which index
 * said it, from which snapshot, and whether two indexes disagreed.
 */

import {
  combineIndexAnswers,
  needsLiveVerification,
  type IndexAnswer,
} from '../src/cross_index';

import type { CommerceSearchCandidate } from '../src/search';

const SUPPLIER = 'did:plc:chairmaker99';
const RIVAL = 'did:plc:rivalwood77';
const SNAP_A = 'a'.repeat(64);
const SNAP_B = 'b'.repeat(64);

function candidate(over: Partial<CommerceSearchCandidate> = {}): CommerceSearchCandidate {
  return {
    supplier_did: SUPPLIER,
    service_uri: `at://${SUPPLIER}/com.dinakernel.service.profile/self`,
    service_rkey: 'self',
    product: { scheme: 'manufacturer_sku', value: 'CHAIR-1', issuer_did: SUPPLIER },
    catalog_snapshot_ref: SNAP_A,
    matched_fields: ['identifier'],
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    generated_at: '2026-08-08T09:00:00.000Z',
    retrieval_score_bp: 6000,
    ...over,
  };
}

const answer = (indexId: string, candidates: CommerceSearchCandidate[]): IndexAnswer => ({
  indexId,
  candidates,
});

describe('the source survives the merge', () => {
  it('one product seen by two indexes keeps BOTH sightings', () => {
    const out = combineIndexAnswers([
      answer('appview-one', [candidate({ retrieval_score_bp: 6000 })]),
      answer('appview-two', [candidate({ retrieval_score_bp: 8000 })]),
    ]);

    expect(out.candidates).toHaveLength(1);
    const only = out.candidates[0];
    expect(only?.sightings.map((s) => s.indexId).sort()).toEqual(['appview-one', 'appview-two']);
  });

  it('every sighting names the SNAPSHOT it was projected from', () => {
    // Half of §10.6's evidence. Without it a buyer cannot tell a stale index
    // from a supplier who has not published lately.
    const out = combineIndexAnswers([answer('appview-one', [candidate()])]);
    expect(out.candidates[0]?.sightings[0]?.catalogSnapshotRef).toBe(SNAP_A);
  });

  it('two products from two suppliers stay two candidates', () => {
    const out = combineIndexAnswers([
      answer('appview-one', [candidate(), candidate({ supplier_did: RIVAL })]),
    ]);
    expect(out.candidates).toHaveLength(2);
  });

  it('the same identifier from DIFFERENT suppliers never merges', () => {
    // Two suppliers may both stock the same GTIN. Merging them would answer a
    // buyer's question about one with the other's evidence.
    const out = combineIndexAnswers([
      answer('one', [candidate({ supplier_did: SUPPLIER })]),
      answer('two', [candidate({ supplier_did: RIVAL })]),
    ]);
    expect(out.candidates).toHaveLength(2);
  });

  it('keeps products apart when only a separator character distinguishes them', () => {
    // WHAT THIS DOES AND DOES NOT PROVE, recorded rather than implied. The
    // merge key is length-prefixed for the reason the product key is: a
    // separator that can occur inside a field can splice two refs into one.
    // Against TODAY'S validator that is defence in depth rather than a live
    // hazard — `scheme` is closed, `issuer_did` must be a DID and
    // `variant_digest` is hex64, so `value` is the only free-form field and a
    // collision needs two. The encoding earns its place against a future
    // widening; my first attempt at a colliding pair was simply refused as an
    // invalid DID, which is the validator doing its job.
    const out = combineIndexAnswers([
      answer('one', [
        candidate({ product: { scheme: 'custom', value: 'a:b', issuer_did: SUPPLIER } }),
        candidate({ product: { scheme: 'custom', value: 'a:b:c', issuer_did: SUPPLIER } }),
      ]),
    ]);
    expect(out.candidates).toHaveLength(2);
    expect(out.findings).toEqual([]);
  });
});

describe('disagreement is surfaced, never resolved', () => {
  it('marks a candidate DIVERGENT when two indexes name different snapshots', () => {
    const out = combineIndexAnswers([
      answer('one', [candidate({ catalog_snapshot_ref: SNAP_A })]),
      answer('two', [candidate({ catalog_snapshot_ref: SNAP_B })]),
    ]);
    expect(out.candidates[0]?.divergentSnapshots).toBe(true);
  });

  it('does NOT mark agreement as divergence', () => {
    const out = combineIndexAnswers([
      answer('one', [candidate({ catalog_snapshot_ref: SNAP_A })]),
      answer('two', [candidate({ catalog_snapshot_ref: SNAP_A })]),
    ]);
    expect(out.candidates[0]?.divergentSnapshots).toBe(false);
  });

  it('keeps BOTH snapshot references so a buyer can see what differed', () => {
    // Picking the "newest" would be resolving on the buyer's behalf, using a
    // claim made by the very index that wants to win.
    const out = combineIndexAnswers([
      answer('one', [candidate({ catalog_snapshot_ref: SNAP_A })]),
      answer('two', [candidate({ catalog_snapshot_ref: SNAP_B })]),
    ]);
    expect(out.candidates[0]?.sightings.map((s) => s.catalogSnapshotRef).sort()).toEqual(
      [SNAP_A, SNAP_B].sort(),
    );
  });
})

describe('scores are evidence, not arithmetic', () => {
  it('takes the STRONGEST sighting, never a sum', () => {
    // Two indexes mirroring each other would otherwise manufacture rank.
    const out = combineIndexAnswers([
      answer('one', [candidate({ retrieval_score_bp: 5000 })]),
      answer('two', [candidate({ retrieval_score_bp: 4000 })]),
      answer('three', [candidate({ retrieval_score_bp: 3000 })]),
    ]);
    expect(out.candidates[0]?.retrievalScoreBp).toBe(5000);
  });

  it('shows the representative from the strongest sighting', () => {
    const out = combineIndexAnswers([
      answer('one', [candidate({ retrieval_score_bp: 5000, matched_fields: ['category'] })]),
      answer('two', [candidate({ retrieval_score_bp: 9000, matched_fields: ['identifier'] })]),
    ]);
    expect(out.candidates[0]?.representative.matched_fields).toEqual(['identifier']);
  });

  it('orders by score, and breaks ties on something with no commercial meaning', () => {
    // A tie broken by index order would let whoever the buyer listed first win.
    const out = combineIndexAnswers([
      answer('one', [
        candidate({ product: { scheme: 'manufacturer_sku', value: 'B', issuer_did: SUPPLIER } }),
        candidate({ product: { scheme: 'manufacturer_sku', value: 'A', issuer_did: SUPPLIER } }),
      ]),
    ]);
    const values = out.candidates.map((c) => c.product.value);
    expect(values).toEqual(['A', 'B']);
  });
});

describe('a stranger’s answer is checked, not trusted', () => {
  it('refuses a malformed candidate and REPORTS which index sent it', () => {
    // An index quietly returning nonsense is something a buyer should be able
    // to notice about it.
    const out = combineIndexAnswers([
      answer('sloppy-index', [
        { ...candidate(), retrieval_score_bp: 99999 } as CommerceSearchCandidate,
      ]),
    ]);
    expect(out.candidates).toHaveLength(0);
    expect(out.findings[0]?.indexId).toBe('sloppy-index');
    expect(out.findings[0]?.position).toBe(0);
  });

  it('one bad candidate does not discard the good ones beside it', () => {
    const out = combineIndexAnswers([
      answer('mixed', [
        { ...candidate(), retrieval_score_bp: -1 } as CommerceSearchCandidate,
        candidate({ product: { scheme: 'manufacturer_sku', value: 'GOOD', issuer_did: SUPPLIER } }),
      ]),
    ]);
    expect(out.candidates).toHaveLength(1);
    expect(out.findings).toHaveLength(1);
  });

  it('an index that returned nothing usable is NAMED as empty', () => {
    // Distinct from an index the buyer never asked: one is a silent index and
    // the other is a choice the buyer made.
    const out = combineIndexAnswers([answer('quiet', []), answer('one', [candidate()])]);
    expect(out.emptyIndexes).toEqual(['quiet']);
  });

  it('an index whose every candidate was refused counts as empty too', () => {
    const out = combineIndexAnswers([
      answer('broken', [{ ...candidate(), supplier_did: '' } as CommerceSearchCandidate]),
    ]);
    expect(out.emptyIndexes).toEqual(['broken']);
    expect(out.findings).toHaveLength(1);
  });
});

describe('verify live before commitment (§10.6)', () => {
  it('a divergent candidate needs a live check', () => {
    const out = combineIndexAnswers([
      answer('one', [candidate({ catalog_snapshot_ref: SNAP_A })]),
      answer('two', [candidate({ catalog_snapshot_ref: SNAP_B })]),
    ]);
    expect(needsLiveVerification(out.candidates[0]!)).toBe(true);
  });

  it('a SINGLE index agreeing with itself needs one too', () => {
    // One opinion is not corroboration, however confident. §10.6 asks for
    // enough evidence to verify, not enough to skip verifying.
    const out = combineIndexAnswers([answer('one', [candidate({ retrieval_score_bp: 10000 })])]);
    expect(needsLiveVerification(out.candidates[0]!)).toBe(true);
  });

  it('several independent indexes on the SAME snapshot do not', () => {
    const out = combineIndexAnswers([
      answer('one', [candidate({ catalog_snapshot_ref: SNAP_A })]),
      answer('two', [candidate({ catalog_snapshot_ref: SNAP_A })]),
    ]);
    expect(needsLiveVerification(out.candidates[0]!)).toBe(false);
  });

  it('the same index listed twice is still ONE opinion', () => {
    // A buyer who accidentally configured one AppView under two names has not
    // gained corroboration, and the combiner must not pretend they have.
    const out = combineIndexAnswers([
      answer('one', [candidate()]),
      answer('one', [candidate()]),
    ]);
    expect(needsLiveVerification(out.candidates[0]!)).toBe(true);
  });
});
