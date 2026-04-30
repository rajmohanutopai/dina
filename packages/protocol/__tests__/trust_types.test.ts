/**
 * Trust types — type-shape compatibility tests (TN-PROTO-001).
 *
 * Compile-time checks: if a wire-type interface drifts in a way that
 * a structural fixture stops conforming, `tsc` fails this file. The
 * runtime assertions are nominal — we just need the test runner to
 * actually load the module.
 *
 * The fixtures below mirror what AppView's Zod accepts on the wire,
 * so the same record literal must validate at runtime over there
 * too. Drift between the two is the regression class this file
 * guards against.
 */

import {
  TRUST_NSIDS,
  type Attestation,
  type Vouch,
  type Endorsement,
  type Flag,
  type Reply,
  type Reaction,
  type ReportRecord,
  type Revocation,
  type Delegation,
  type Collection,
  type Media,
  type SubjectRecord,
  type Amendment,
  type Verification,
  type ReviewRequest,
  type Comparison,
  type SubjectClaim,
  type TrustPolicy,
  type NotificationPrefs,
  type SubjectRef,
  type SubjectType,
  type DimensionValue,
  type Sentiment,
  type Confidence,
  type FlagSeverity,
  type ReplyIntent,
  type ReactionType,
  type ReportType,
  type VouchConfidence,
  type VerificationResult,
  type SubjectClaimType,
  type TrustNsid,
} from '../src/index';

const ISO = '2026-01-15T12:00:00.000Z';

describe('@dina/protocol/trust types (TN-PROTO-001)', () => {
  it('TRUST_NSIDS spans every com.dina.trust.* record handled by AppView', () => {
    // 19 record types per the AppView Zod ingester. If a new lexicon
    // is added or removed, this count + the keys here must be kept in
    // lockstep — otherwise consumers can't reference it by name.
    expect(Object.keys(TRUST_NSIDS).length).toBe(19);
    expect(TRUST_NSIDS.attestation).toBe('com.dina.trust.attestation');
    expect(TRUST_NSIDS.vouch).toBe('com.dina.trust.vouch');
    expect(TRUST_NSIDS.endorsement).toBe('com.dina.trust.endorsement');
    expect(TRUST_NSIDS.flag).toBe('com.dina.trust.flag');
    // Every value must start with the canonical namespace prefix.
    for (const id of Object.values(TRUST_NSIDS)) {
      expect(id.startsWith('com.dina.trust.')).toBe(true);
    }
  });

  it('TrustNsid union covers every value in TRUST_NSIDS', () => {
    // Compile-time exhaustiveness: assigning every NSID to TrustNsid
    // would fail if a value were missing from the union.
    const ids: TrustNsid[] = Object.values(TRUST_NSIDS);
    expect(ids.length).toBe(19);
  });

  it('SubjectRef accepts every documented SubjectType', () => {
    const types: SubjectType[] = [
      'did',
      'content',
      'product',
      'dataset',
      'organization',
      'claim',
      'place',
    ];
    for (const t of types) {
      const ref: SubjectRef =
        t === 'did' ? { type: t, did: 'did:plc:abc' } : { type: t, identifier: 'x' };
      expect(ref.type).toBe(t);
    }
  });

  it('Attestation accepts the minimum required wire shape', () => {
    const minimal: Attestation = {
      subject: { type: 'product', identifier: 'B0EXAMPLE' },
      category: 'product',
      sentiment: 'positive',
      createdAt: ISO,
    };
    expect(minimal.category).toBe('product');
  });

  it('Attestation accepts all optional wire fields', () => {
    const dim: DimensionValue = 'exceeded';
    const sentiment: Sentiment = 'neutral';
    const conf: Confidence = 'high';
    const full: Attestation = {
      subject: { type: 'did', did: 'did:plc:abc' },
      category: 'identity',
      sentiment,
      createdAt: ISO,
      dimensions: [{ dimension: 'q', value: dim, note: 'ok' }],
      text: 'hello',
      tags: ['tag1', 'tag2'],
      domain: 'example.com',
      interactionContext: { mode: 'unit' },
      contentContext: { mime: 'text/plain' },
      productContext: { sku: 'X' },
      evidence: [{ type: 'video', uri: 'https://e.example' }],
      confidence: conf,
      isAgentGenerated: false,
      coSignature: { did: 'did:plc:cosig', sig: 'h', sigCreatedAt: ISO },
      mentions: [{ did: 'did:plc:m', role: 'witness' }],
      relatedAttestations: [{ uri: 'at://x', relation: 'amends' }],
      bilateralReview: { reciprocal: true },
    };
    expect(full.dimensions?.[0]?.value).toBe('exceeded');
  });

  it('Vouch / Endorsement / Flag / Reply / Reaction shapes compile', () => {
    const vConf: VouchConfidence = 'moderate';
    const v: Vouch = { subject: 'did:plc:x', vouchType: 't', confidence: vConf, createdAt: ISO };
    const e: Endorsement = {
      subject: 'did:plc:x',
      skill: 'cooking',
      endorsementType: 'peer',
      createdAt: ISO,
    };
    const sev: FlagSeverity = 'warning';
    const f: Flag = {
      subject: { type: 'product', identifier: 'B0X' },
      flagType: 'spam',
      severity: sev,
      createdAt: ISO,
    };
    const intent: ReplyIntent = 'agree';
    const r: Reply = { rootUri: 'at://r', parentUri: 'at://p', intent, text: 'ok', createdAt: ISO };
    const reaction: ReactionType = 'helpful';
    const rxn: Reaction = { targetUri: 'at://t', reaction, createdAt: ISO };
    expect([v, e, f, r, rxn].every((rec) => rec.createdAt === ISO)).toBe(true);
  });

  it('ReportRecord / Revocation / Delegation / Collection / Media compile', () => {
    const rt: ReportType = 'spam';
    const rr: ReportRecord = { targetUri: 'at://t', reportType: rt, createdAt: ISO };
    const rev: Revocation = { targetUri: 'at://t', reason: 'mistake', createdAt: ISO };
    const del: Delegation = {
      subject: 'did:plc:x',
      scope: 'feed',
      permissions: ['read'],
      createdAt: ISO,
    };
    const col: Collection = { name: 'list', items: [], isDiscoverable: true, createdAt: ISO };
    const med: Media = {
      parentUri: 'at://p',
      mediaType: 'image/png',
      url: 'https://e/x.png',
      createdAt: ISO,
    };
    expect([rr, rev, del, col, med].every((r) => r.createdAt === ISO)).toBe(true);
  });

  it('SubjectRecord / Amendment / Verification / ReviewRequest / Comparison compile', () => {
    const sub: SubjectRecord = { name: 's', subjectType: 'product', createdAt: ISO };
    const am: Amendment = { targetUri: 'at://t', amendmentType: 'fix', createdAt: ISO };
    const verRes: VerificationResult = 'confirmed';
    const ver: Verification = {
      targetUri: 'at://t',
      verificationType: 'expert',
      result: verRes,
      createdAt: ISO,
    };
    const rq: ReviewRequest = {
      subject: { type: 'product', identifier: 'X' },
      requestType: 'opinion',
      createdAt: ISO,
    };
    const comp: Comparison = {
      subjects: [
        { type: 'product', identifier: 'A' },
        { type: 'product', identifier: 'B' },
      ],
      category: 'value',
      createdAt: ISO,
    };
    expect([sub, am, ver, rq, comp].every((r) => r.createdAt === ISO)).toBe(true);
  });

  it('SubjectClaim / TrustPolicy / NotificationPrefs compile', () => {
    const claimType: SubjectClaimType = 'related';
    const sc: SubjectClaim = {
      sourceSubjectId: 's1',
      targetSubjectId: 's2',
      claimType,
      createdAt: ISO,
    };
    const tp: TrustPolicy = { maxGraphDepth: 3, requireVouch: false, createdAt: ISO };
    const np: NotificationPrefs = {
      enableMentions: true,
      enableReactions: true,
      enableReplies: true,
      enableFlags: false,
      createdAt: ISO,
    };
    expect([sc, tp, np].every((r) => r.createdAt === ISO)).toBe(true);
  });
});
