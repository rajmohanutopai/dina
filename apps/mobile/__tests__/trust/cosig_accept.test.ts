/**
 * Cosig recipient-accept data-layer tests (TN-MOB-042).
 *
 * Pins the contract for the two-phase accept flow:
 *
 *   Phase 1 — `buildCosigEndorsement`:
 *     - subject = attestation author DID
 *     - skill = attestation category (200-char cap)
 *     - endorsementType = 'cosignature' (constant)
 *     - text/relationship/namespace optional, trimmed before cap check
 *     - createdAt = ISO from nowMs
 *
 *   Phase 2 — `buildCosigAcceptFrame`:
 *     - validates against `@dina/protocol`'s `validateCosigAccept`
 *     - rejects malformed frames synchronously (sender-side defence)
 *
 * Pure-function tests — runs under plain Jest.
 */

import { COSIG_ACCEPT_TYPE } from '@dina/protocol';

import {
  COSIG_ENDORSEMENT_TYPE,
  MAX_NAMESPACE_LEN,
  MAX_RELATIONSHIP_LEN,
  MAX_SKILL_LEN,
  MAX_TEXT_LEN,
  buildCosigAcceptFrame,
  buildCosigEndorsement,
} from '../../src/trust/cosig_accept';

const T0 = Date.parse('2026-04-30T12:00:00Z');
const SANCHO_DID = 'did:plc:sancho123';
const ATT_URI = 'at://did:plc:alonso/com.dina.trust.endorsement/abc';
const ATT_CID = 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

// ─── buildCosigEndorsement — happy path ──────────────────────────────────

describe('buildCosigEndorsement — minimal', () => {
  it('builds the minimum-valid endorsement record (subject, skill, type, createdAt)', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'office_furniture',
      nowMs: T0,
    });
    expect(r).toEqual({
      subject: SANCHO_DID,
      skill: 'office_furniture',
      endorsementType: COSIG_ENDORSEMENT_TYPE,
      createdAt: '2026-04-30T12:00:00.000Z',
    });
  });

  it('endorsementType constant is "cosignature" (recognised semantic)', () => {
    // The literal is exposed so AppView (or any future cosig
    // recogniser) can match it without a typo dance. Pinning here
    // prevents an accidental rename.
    expect(COSIG_ENDORSEMENT_TYPE).toBe('cosignature');
  });

  it('createdAt is ISO from nowMs (round-trips)', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      nowMs: T0,
    });
    expect(Date.parse(r.createdAt)).toBe(T0);
  });

  it('returns a frozen record (caller cannot mutate it before publish)', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      nowMs: T0,
    });
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('buildCosigEndorsement — optional fields', () => {
  it('carries through `text` when provided', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      text: 'can confirm — same chair, same problem',
      nowMs: T0,
    });
    expect(r.text).toBe('can confirm — same chair, same problem');
  });

  it('carries through `relationship` when provided', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      relationship: 'co-worker',
      nowMs: T0,
    });
    expect(r.relationship).toBe('co-worker');
  });

  it('carries through `namespace` when provided', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      namespace: 'namespace_2',
      nowMs: T0,
    });
    expect(r.namespace).toBe('namespace_2');
  });

  it('omits absent optional fields entirely (no `text: undefined`)', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      nowMs: T0,
    });
    expect('text' in r).toBe(false);
    expect('relationship' in r).toBe(false);
    expect('namespace' in r).toBe(false);
  });

  it('whitespace-only optional fields omit silently (screen-binds-TextInput pattern)', () => {
    // The screen binds these fields to a TextInput; an empty-input
    // user landing at this builder shouldn't trigger an exception.
    // We omit the whitespace-only value as if the field weren't
    // provided. Over-cap values still throw — that's the caller
    // shipping real content past the lexicon's bound.
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      text: '   ',
      relationship: '',
      namespace: '\t\n',
      nowMs: T0,
    });
    expect('text' in r).toBe(false);
    expect('relationship' in r).toBe(false);
    expect('namespace' in r).toBe(false);
  });

  it('trims whitespace on optional + required fields BEFORE cap check', () => {
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: '   office_furniture   ',
      text: '  trimmed  ',
      relationship: '\tneighbor\n',
      namespace: '  namespace_3  ',
      nowMs: T0,
    });
    expect(r.skill).toBe('office_furniture');
    expect(r.text).toBe('trimmed');
    expect(r.relationship).toBe('neighbor');
    expect(r.namespace).toBe('namespace_3');
  });
});

// ─── buildCosigEndorsement — validation ──────────────────────────────────

describe('buildCosigEndorsement — required-field validation', () => {
  it('throws on empty attestationAuthorDid', () => {
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: '',
        attestationCategory: 'x',
        nowMs: T0,
      }),
    ).toThrow(/non-empty/);
  });

  it('throws on non-string attestationAuthorDid', () => {
    expect(() =>
      buildCosigEndorsement({
        // @ts-expect-error — runtime guard
        attestationAuthorDid: 42,
        attestationCategory: 'x',
        nowMs: T0,
      }),
    ).toThrow(/non-empty/);
  });

  it('throws on whitespace-only attestationCategory', () => {
    // A whitespace category trims to empty — would publish with
    // `skill: ''` which AppView rejects.
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: SANCHO_DID,
        attestationCategory: '   ',
        nowMs: T0,
      }),
    ).toThrow(/non-empty/);
  });

  it('throws on non-finite nowMs', () => {
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: SANCHO_DID,
        attestationCategory: 'x',
        nowMs: NaN,
      }),
    ).toThrow(/finite/);
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: SANCHO_DID,
        attestationCategory: 'x',
        nowMs: Infinity,
      }),
    ).toThrow(/finite/);
  });
});

describe('buildCosigEndorsement — length caps (mirror lexicon)', () => {
  it('skill cap is 200 (matches lexicon endorsementSchema)', () => {
    expect(MAX_SKILL_LEN).toBe(200);
  });

  it('text cap is 2000 (matches lexicon endorsementSchema)', () => {
    expect(MAX_TEXT_LEN).toBe(2000);
  });

  it('relationship cap is 200 (matches lexicon endorsementSchema)', () => {
    expect(MAX_RELATIONSHIP_LEN).toBe(200);
  });

  it('namespace cap is 255 (matches lexicon namespaceFragment)', () => {
    expect(MAX_NAMESPACE_LEN).toBe(255);
  });

  it('throws when skill exceeds 200 chars after trim', () => {
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: SANCHO_DID,
        attestationCategory: 'a'.repeat(201),
        nowMs: T0,
      }),
    ).toThrow(/exceeds max length 200/);
  });

  it('throws when text exceeds 2000 chars after trim', () => {
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: SANCHO_DID,
        attestationCategory: 'x',
        text: 'a'.repeat(2001),
        nowMs: T0,
      }),
    ).toThrow(/exceeds max length 2000/);
  });

  it('throws when relationship exceeds 200 chars after trim', () => {
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: SANCHO_DID,
        attestationCategory: 'x',
        relationship: 'a'.repeat(201),
        nowMs: T0,
      }),
    ).toThrow(/exceeds max length 200/);
  });

  it('throws when namespace exceeds 255 chars after trim', () => {
    expect(() =>
      buildCosigEndorsement({
        attestationAuthorDid: SANCHO_DID,
        attestationCategory: 'x',
        namespace: 'a'.repeat(256),
        nowMs: T0,
      }),
    ).toThrow(/exceeds max length 255/);
  });

  it('trim-before-cap: 2001-char value with trim becomes 1999, ACCEPTED', () => {
    // The cap check operates on the trimmed value. A 2001-char
    // input that trims to 1999 is fine.
    const padded = '  ' + 'a'.repeat(1999);
    const r = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'x',
      text: padded,
      nowMs: T0,
    });
    expect(r.text).toBe('a'.repeat(1999));
  });
});

// ─── buildCosigAcceptFrame ──────────────────────────────────────────────

describe('buildCosigAcceptFrame — happy path', () => {
  it('builds a valid CosigAccept frame', () => {
    const f = buildCosigAcceptFrame({
      requestId: 'req-1',
      endorsementUri: ATT_URI,
      endorsementCid: ATT_CID,
      nowMs: T0,
    });
    expect(f).toEqual({
      type: COSIG_ACCEPT_TYPE,
      requestId: 'req-1',
      endorsementUri: ATT_URI,
      endorsementCid: ATT_CID,
      createdAt: '2026-04-30T12:00:00.000Z',
    });
  });

  it('returns a frozen frame', () => {
    const f = buildCosigAcceptFrame({
      requestId: 'req-1',
      endorsementUri: ATT_URI,
      endorsementCid: ATT_CID,
      nowMs: T0,
    });
    expect(Object.isFrozen(f)).toBe(true);
  });

  it('type literal matches the protocol export', () => {
    const f = buildCosigAcceptFrame({
      requestId: 'r',
      endorsementUri: ATT_URI,
      endorsementCid: ATT_CID,
      nowMs: T0,
    });
    expect(f.type).toBe(COSIG_ACCEPT_TYPE);
  });
});

describe('buildCosigAcceptFrame — sender-side validation', () => {
  it('throws on empty requestId (rejected by validateCosigAccept)', () => {
    expect(() =>
      buildCosigAcceptFrame({
        requestId: '',
        endorsementUri: ATT_URI,
        endorsementCid: ATT_CID,
        nowMs: T0,
      }),
    ).toThrow(/invalid frame/);
  });

  it('throws on empty endorsementUri', () => {
    expect(() =>
      buildCosigAcceptFrame({
        requestId: 'r',
        endorsementUri: '',
        endorsementCid: ATT_CID,
        nowMs: T0,
      }),
    ).toThrow(/invalid frame/);
  });

  it('throws on empty endorsementCid', () => {
    expect(() =>
      buildCosigAcceptFrame({
        requestId: 'r',
        endorsementUri: ATT_URI,
        endorsementCid: '',
        nowMs: T0,
      }),
    ).toThrow(/invalid frame/);
  });

  it('throws on non-finite nowMs', () => {
    expect(() =>
      buildCosigAcceptFrame({
        requestId: 'r',
        endorsementUri: ATT_URI,
        endorsementCid: ATT_CID,
        nowMs: NaN,
      }),
    ).toThrow(/finite/);
  });

  it('error message surfaces the protocol validator output (rules drift on one side stays loud)', () => {
    let thrown: unknown = null;
    try {
      buildCosigAcceptFrame({
        requestId: '',
        endorsementUri: '',
        endorsementCid: '',
        nowMs: T0,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/invalid frame/);
    // Multiple errors surface joined with `; ` so the screen can
    // show all of them, not just the first.
    expect((thrown as Error).message).toMatch(/;/);
  });
});

// ─── End-to-end two-phase orchestration ──────────────────────────────────

describe('two-phase orchestration (phase 1 → publish stub → phase 2)', () => {
  it('round-trips through the screen layer\'s expected shape', () => {
    // Simulate what the screen does:
    //   1. Build endorsement record (from this module).
    //   2. Stub-publish — return a fixed (uri, cid).
    //   3. Build accept frame from the publish result.
    const record = buildCosigEndorsement({
      attestationAuthorDid: SANCHO_DID,
      attestationCategory: 'office_furniture',
      text: 'can confirm',
      nowMs: T0,
    });
    expect(record.subject).toBe(SANCHO_DID);

    // Stub publish — in real code this is `publishToPDS` returning
    // an AT-URI + the record's CID.
    const publishResult = {
      uri: 'at://did:plc:alonso/com.dina.trust.endorsement/abc',
      cid: 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
    };

    const frame = buildCosigAcceptFrame({
      requestId: 'req-1',
      endorsementUri: publishResult.uri,
      endorsementCid: publishResult.cid,
      nowMs: T0,
    });
    expect(frame.endorsementUri).toBe(publishResult.uri);
    expect(frame.endorsementCid).toBe(publishResult.cid);
    expect(frame.requestId).toBe('req-1');
    expect(frame.createdAt).toBe(record.createdAt);
  });
});
