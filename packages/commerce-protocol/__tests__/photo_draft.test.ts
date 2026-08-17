/**
 * §2.1 frozen shapes (PHOTO_COMMERCE_LANES_DESIGN).
 *
 * The design's own review history is the test plan: three commitments that
 * each verify alone prove nothing about belonging together, so most of
 * these tests substitute one link and assert the digests come apart. The
 * named negative vectors — cross-draft, substituted manifest, detached
 * receipt, stripped discriminator, forged supplier — each appear here by
 * name.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  CATALOG_POINTER_NSID,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '../src/catalog_publication';
import {
  APPROVAL_ORIGIN_PHOTO_ORDER_DRAFT,
  catalogExtractionBindingDigest,
  conversationSnapshotDigest,
  EXTRACTION_SCHEMA_CATALOG,
  EXTRACTION_SCHEMA_ORDER,
  extractionCommitmentDigest,
  MAX_DRAFT_REQUIREMENTS,
  MAX_EXTRACTION_PAGES,
  validateApprovalSourceBinding,
  validateCatalogExtractionBinding,
  validateConversationSnapshot,
  validateExtractionCommitment,
  validateVouchReceipt,
  verifyCatalogEvidenceRecord,
  vouchReceiptDigest,
  type ApprovalSourceBinding,
  type CatalogEvidenceRecord,
  type CatalogExtractionBinding,
  type ConversationSnapshot,
  type ExtractionCommitment,
  type VouchReceipt,
} from '../src/photo_draft';

const hash = (data: Uint8Array): Uint8Array => sha256(data);
const hexOf = (input: string): string =>
  Array.from(sha256(new TextEncoder().encode(input)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const SUPPLIER = 'did:plc:chairmaker';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCommitment(overrides: Partial<ExtractionCommitment> = {}): ExtractionCommitment {
  return {
    draft_id: 'draft-a',
    manifest: [
      { artifact_id: 'img-1', content_hash: hexOf('page-1-bytes'), page_index: 0 },
      { artifact_id: 'img-2', content_hash: hexOf('page-2-bytes'), page_index: 1 },
    ],
    schema_id: EXTRACTION_SCHEMA_ORDER,
    model: 'gpt-4o-mini',
    rows: [
      { page_index: 0, row: 2, content: { text: '20 dining chairs - oak' } },
      { page_index: 1, row: 3, content: { text: '6 benches, the 4ft teak ones' } },
    ],
    ...overrides,
  };
}

function makeVouch(overrides: Partial<VouchReceipt> = {}): VouchReceipt {
  return {
    draft_id: 'draft-a',
    ceremony: 1,
    extraction_digest: extractionCommitmentDigest('order', makeCommitment(), hash),
    lines: [
      {
        line_id: 'line-1',
        generation: 1,
        quantity: { value: '20', unit_code: 'each' },
        resolved_product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER },
        supplier_did: SUPPLIER,
      },
    ],
    requirements: [
      { key: 'required_by', omitted: false, value: '2026-08-21', generation: 1 },
      { key: 'destination', omitted: true, value: null, generation: 1 },
    ],
    ...overrides,
  };
}

function makeConversationSnapshot(
  overrides: Partial<ConversationSnapshot> = {},
): ConversationSnapshot {
  return {
    draft_id: 'draft-a',
    conversation_id: 'conv-1',
    supplier_did: SUPPLIER,
    request_digest: hexOf('quote-request'),
    lines: [
      { line_id: 'line-1', generation: 1, vouch_receipt_digest: vouchReceiptDigest(makeVouch(), hash) },
    ],
    requirements: [{ key: 'required_by', omitted: false, value: '2026-08-21', generation: 1 }],
    ...overrides,
  };
}

function makeSourceBinding(overrides: Partial<ApprovalSourceBinding> = {}): ApprovalSourceBinding {
  return {
    origin: APPROVAL_ORIGIN_PHOTO_ORDER_DRAFT,
    binding_version: 1,
    draft_id: 'draft-a',
    conversation_id: 'conv-1',
    assignment_generations: [{ line_id: 'line-1', generation: 1 }],
    requirement_generations: [{ key: 'required_by', generation: 1 }],
    snapshot_digest: conversationSnapshotDigest(makeConversationSnapshot(), hash),
    ...overrides,
  };
}

function makeEvidence(): CatalogEvidenceRecord {
  const pageDraft: CatalogSnapshotPage = {
    catalog_id: 'chairmaker-main',
    snapshot_sequence: 1,
    page_index: 0,
    items: [{ sku: 'CM-CHAIR-1', name: 'Oak dining chair' }],
    page_digest: '',
  };
  const page = { ...pageDraft, page_digest: catalogPageDigest(pageDraft, hash) };
  const snapshotDraft: CatalogSnapshot = {
    supplier_did: SUPPLIER,
    catalog_id: 'chairmaker-main',
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: '2026-08-15T10:00:00.000Z',
    page_digests: [page.page_digest],
    item_count: 1,
    payload_root: catalogPayloadRoot([page.page_digest], hash),
    snapshot_digest: '',
  };
  const snapshot = {
    ...snapshotDraft,
    snapshot_digest: catalogSnapshotDigest(snapshotDraft, hash),
  };
  const pointer: CatalogPointer = {
    supplier_did: SUPPLIER,
    catalog_id: 'chairmaker-main',
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: '2026-08-15T10:00:00.000Z',
    snapshot_rkey: snapshot.snapshot_digest,
    snapshot_digest: snapshot.snapshot_digest,
  };
  return {
    repo_did: SUPPLIER,
    collection: CATALOG_POINTER_NSID,
    rkey: 'chairmaker-main',
    pointer_cid: 'bafyreib-pointer-cid',
    pointer,
    snapshot,
    page,
  };
}

// ---------------------------------------------------------------------------
// Extraction commitment
// ---------------------------------------------------------------------------

describe('extraction commitment', () => {
  it('validates the well-formed commitment', () => {
    expect(validateExtractionCommitment(makeCommitment())).toBeNull();
  });

  it('CROSS-LANE: the same commitment digests differently per lane', () => {
    const commitment = makeCommitment();
    expect(extractionCommitmentDigest('catalog', commitment, hash)).not.toBe(
      extractionCommitmentDigest('order', commitment, hash),
    );
  });

  it('CROSS-DRAFT: draft A\'s commitment can never stand for draft B\'s', () => {
    // The whole point of draft_id being in the preimage. Without it these
    // two digests would be equal and the chain would prove nothing.
    const a = extractionCommitmentDigest('order', makeCommitment({ draft_id: 'draft-a' }), hash);
    const b = extractionCommitmentDigest('order', makeCommitment({ draft_id: 'draft-b' }), hash);
    expect(a).not.toBe(b);
  });

  it('SUBSTITUTED MANIFEST: swapping one page\'s bytes changes the digest', () => {
    const original = makeCommitment();
    const substituted = makeCommitment({
      manifest: [
        { artifact_id: 'img-1', content_hash: hexOf('different-bytes'), page_index: 0 },
        original.manifest[1] as (typeof original.manifest)[number],
      ],
    });
    expect(extractionCommitmentDigest('order', original, hash)).not.toBe(
      extractionCommitmentDigest('order', substituted, hash),
    );
  });

  it('refuses a manifest whose page_index disagrees with its position', () => {
    const commitment = makeCommitment({
      manifest: [
        { artifact_id: 'img-1', content_hash: hexOf('page-1-bytes'), page_index: 1 },
        { artifact_id: 'img-2', content_hash: hexOf('page-2-bytes'), page_index: 0 },
      ],
    });
    expect(validateExtractionCommitment(commitment)).toContain('page_index must equal its position');
  });

  it('refuses an empty manifest, an unknown schema, a header row, and an off-manifest row', () => {
    expect(validateExtractionCommitment(makeCommitment({ manifest: [] }))).toContain(
      'at least one page',
    );
    expect(validateExtractionCommitment(makeCommitment({ schema_id: 'rows-99' }))).toContain(
      'known extraction schema',
    );
    // Row 1 is the header; data starts at 2 (§4.1's convention, pinned).
    expect(
      validateExtractionCommitment(
        makeCommitment({ rows: [{ page_index: 0, row: 1, content: {} }] }),
      ),
    ).toContain('row must be an integer >= 2');
    expect(
      validateExtractionCommitment(
        makeCommitment({ rows: [{ page_index: 2, row: 2, content: {} }] }),
      ),
    ).toContain('must name a manifest page');
  });

  it('bounds pages', () => {
    const manifest = Array.from({ length: MAX_EXTRACTION_PAGES + 1 }, (_, i) => ({
      artifact_id: `img-${String(i)}`,
      content_hash: hexOf(`page-${String(i)}`),
      page_index: i,
    }));
    expect(validateExtractionCommitment(makeCommitment({ manifest }))).toContain('too many pages');
  });

  it('accepts the catalog schema for the catalog lane fixture', () => {
    expect(
      validateExtractionCommitment(makeCommitment({ schema_id: EXTRACTION_SCHEMA_CATALOG })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Catalog extraction binding
// ---------------------------------------------------------------------------

describe('catalog extraction binding', () => {
  const binding: CatalogExtractionBinding = {
    binding_version: 1,
    draft_id: 'draft-a',
    content_revision: 3,
    extraction_digest: extractionCommitmentDigest(
      'catalog',
      makeCommitment({ schema_id: EXTRACTION_SCHEMA_CATALOG }),
      hash,
    ),
  };

  it('validates and digests deterministically', () => {
    expect(validateCatalogExtractionBinding(binding)).toBeNull();
    expect(catalogExtractionBindingDigest(binding, hash)).toBe(
      catalogExtractionBindingDigest({ ...binding }, hash),
    );
  });

  it('CROSS-DRAFT: the binding is draft-specific', () => {
    expect(catalogExtractionBindingDigest(binding, hash)).not.toBe(
      catalogExtractionBindingDigest({ ...binding, draft_id: 'draft-b' }, hash),
    );
  });

  it('a stale content revision is a different binding', () => {
    // The revision is in the preimage for the same reason it is inside the
    // content receipt: an edit that reverted the rows must not leave an old
    // binding looking current.
    expect(catalogExtractionBindingDigest(binding, hash)).not.toBe(
      catalogExtractionBindingDigest({ ...binding, content_revision: 4 }, hash),
    );
  });

  it('refuses a wrong version, a bad revision, and a malformed digest', () => {
    expect(
      validateCatalogExtractionBinding({ ...binding, binding_version: 2 }),
    ).toContain('binding_version must be 1');
    expect(validateCatalogExtractionBinding({ ...binding, content_revision: -1 })).toContain(
      'non-negative',
    );
    expect(validateCatalogExtractionBinding({ ...binding, extraction_digest: 'nope' })).toContain(
      'extraction_digest',
    );
  });
});

// ---------------------------------------------------------------------------
// Vouch receipt
// ---------------------------------------------------------------------------

describe('vouch receipt (order lane)', () => {
  it('validates the well-formed receipt', () => {
    expect(validateVouchReceipt(makeVouch())).toBeNull();
  });

  it('DETACHED RECEIPT: a vouch minted over extraction A does not stand beside extraction B', () => {
    // The receipt commits the extraction digest; swap the extraction and
    // the receipt digest moves with it. This is the chain working.
    const overB = makeVouch({
      extraction_digest: extractionCommitmentDigest(
        'order',
        makeCommitment({ draft_id: 'draft-b' }),
        hash,
      ),
    });
    expect(vouchReceiptDigest(makeVouch(), hash)).not.toBe(vouchReceiptDigest(overB, hash));
  });

  it('CROSS-DOMAIN: a vouch receipt can never collide with an extraction commitment', () => {
    // Same draft, same hash function — different kinds under the domain, so
    // even a crafted equal canonical body cannot make the digests meet.
    const vouch = makeVouch();
    expect(vouchReceiptDigest(vouch, hash)).not.toBe(
      extractionCommitmentDigest('order', makeCommitment(), hash),
    );
  });

  it('a stale line generation is a different receipt', () => {
    const bumped = makeVouch();
    const line = bumped.lines[0];
    expect(line).toBeDefined();
    const stale = makeVouch({
      lines: [{ ...(line as NonNullable<typeof line>), generation: 2 }],
    });
    expect(vouchReceiptDigest(makeVouch(), hash)).not.toBe(vouchReceiptDigest(stale, hash));
  });

  it('refuses an omitted requirement that still carries a value', () => {
    expect(
      validateVouchReceipt(
        makeVouch({
          requirements: [{ key: 'destination', omitted: true, value: 'Bangalore', generation: 1 }],
        }),
      ),
    ).toContain('omitted requirement carries value null');
  });

  it('refuses zero lines, a zero ceremony, and unbounded requirements', () => {
    expect(validateVouchReceipt(makeVouch({ lines: [] }))).toContain('at least one line');
    expect(validateVouchReceipt(makeVouch({ ceremony: 0 }))).toContain('positive integer');
    const requirements = Array.from({ length: MAX_DRAFT_REQUIREMENTS + 1 }, (_, i) => ({
      key: `k${String(i)}`,
      omitted: false,
      value: 'v',
      generation: 1,
    }));
    expect(validateVouchReceipt(makeVouch({ requirements }))).toContain('too many requirements');
  });
});

// ---------------------------------------------------------------------------
// Conversation snapshot
// ---------------------------------------------------------------------------

describe('conversation snapshot', () => {
  it('validates and digests deterministically', () => {
    const snapshot = makeConversationSnapshot();
    expect(validateConversationSnapshot(snapshot)).toBeNull();
    expect(conversationSnapshotDigest(snapshot, hash)).toBe(
      conversationSnapshotDigest({ ...snapshot }, hash),
    );
  });

  it('a different conversation is a different snapshot', () => {
    expect(conversationSnapshotDigest(makeConversationSnapshot(), hash)).not.toBe(
      conversationSnapshotDigest(makeConversationSnapshot({ conversation_id: 'conv-2' }), hash),
    );
  });

  it('a line vouched under a different receipt changes the snapshot', () => {
    const other = makeConversationSnapshot({
      lines: [{ line_id: 'line-1', generation: 1, vouch_receipt_digest: hexOf('other-receipt') }],
    });
    expect(conversationSnapshotDigest(makeConversationSnapshot(), hash)).not.toBe(
      conversationSnapshotDigest(other, hash),
    );
  });

  it('refuses an empty line set and a malformed request digest', () => {
    expect(validateConversationSnapshot(makeConversationSnapshot({ lines: [] }))).toContain(
      'at least one line',
    );
    expect(
      validateConversationSnapshot(makeConversationSnapshot({ request_digest: 'short' })),
    ).toContain('request_digest');
  });
});

// ---------------------------------------------------------------------------
// Approval source binding
// ---------------------------------------------------------------------------

describe('approval source binding', () => {
  it('validates the complete binding', () => {
    expect(validateApprovalSourceBinding(makeSourceBinding())).toBeNull();
  });

  it('STRIPPED DISCRIMINATOR: a binding without its origin is refused', () => {
    const stripped = { ...makeSourceBinding() } as Record<string, unknown>;
    delete stripped.origin;
    expect(validateApprovalSourceBinding(stripped)).toContain('origin must be photo_order_draft');
  });

  it('EVERY field is required — a photo approval may not hydrate partially', () => {
    // "Absent = legacy" failed open; this is the fail-closed replacement.
    // Each field in turn is removed and the binding must refuse.
    for (const field of [
      'binding_version',
      'draft_id',
      'conversation_id',
      'assignment_generations',
      'requirement_generations',
      'snapshot_digest',
    ]) {
      const partial = { ...makeSourceBinding() } as Record<string, unknown>;
      delete partial[field];
      expect(validateApprovalSourceBinding(partial)).not.toBeNull();
    }
  });

  it('refuses an unknown origin, an empty assignment set, and a bad generation', () => {
    expect(
      validateApprovalSourceBinding({ ...makeSourceBinding(), origin: 'hand_built' }),
    ).toContain('origin must be photo_order_draft');
    expect(
      validateApprovalSourceBinding({ ...makeSourceBinding(), assignment_generations: [] }),
    ).toContain('at least one line');
    expect(
      validateApprovalSourceBinding({
        ...makeSourceBinding(),
        assignment_generations: [{ line_id: 'line-1', generation: -1 }],
      }),
    ).toContain('non-negative');
  });
});

// ---------------------------------------------------------------------------
// Catalog evidence record
// ---------------------------------------------------------------------------

describe('catalog evidence record', () => {
  it('verifies the genuine chain', () => {
    expect(verifyCatalogEvidenceRecord(makeEvidence(), hash)).toBeNull();
  });

  it('FORGED SUPPLIER: a pointer claiming a different supplier than its repo is refused', () => {
    // The fabricated-chain shape: internally consistent digests under an
    // attacker-chosen supplier_did. The repo context is the anchor, and a
    // pointer that disagrees with it dies before any digest is computed.
    const forged = makeEvidence();
    const record: CatalogEvidenceRecord = {
      ...forged,
      pointer: { ...forged.pointer, supplier_did: 'did:plc:attacker' },
    };
    expect(verifyCatalogEvidenceRecord(record, hash)).toBe(
      'evidence: pointer supplier does not match the publishing repo',
    );
  });

  it('WRONG REPO: authority refusal comes BEFORE the chain check', () => {
    // Break the chain AND the authority together; the refusal must name
    // authority, proving the ordering the design demands.
    const evidence = makeEvidence();
    const record: CatalogEvidenceRecord = {
      ...evidence,
      repo_did: 'did:plc:somebody-else',
      snapshot: { ...evidence.snapshot, payload_root: hexOf('broken-root') },
    };
    expect(verifyCatalogEvidenceRecord(record, hash)).toBe(
      'evidence: pointer supplier does not match the publishing repo',
    );
  });

  it('WRONG COLLECTION / WRONG RKEY: the repo context is validated', () => {
    expect(
      verifyCatalogEvidenceRecord({ ...makeEvidence(), collection: 'com.example.other' }, hash),
    ).toContain('not the catalog pointer collection');
    expect(verifyCatalogEvidenceRecord({ ...makeEvidence(), rkey: '' }, hash)).toContain('rkey');
  });

  it('WRONG SNAPSHOT: a pointer naming a different snapshot is refused', () => {
    const evidence = makeEvidence();
    expect(
      verifyCatalogEvidenceRecord(
        {
          ...evidence,
          pointer: { ...evidence.pointer, snapshot_digest: hexOf('other-snapshot') },
        },
        hash,
      ),
    ).toBe('evidence: pointer names a different snapshot');
  });

  it('STALE ITEM / WRONG PAGE: page tampering fails the digest chain', () => {
    const evidence = makeEvidence();
    const tampered: CatalogEvidenceRecord = {
      ...evidence,
      page: {
        ...evidence.page,
        items: [{ sku: 'CM-CHAIR-1', name: 'Oak dining chair', price: 'changed' }],
      },
    };
    expect(verifyCatalogEvidenceRecord(tampered, hash)).toContain('page');
  });

  it('a withdrawal pointer carries no evidence', () => {
    const evidence = makeEvidence();
    const withdrawn: CatalogEvidenceRecord = {
      ...evidence,
      pointer: {
        supplier_did: evidence.pointer.supplier_did,
        catalog_id: evidence.pointer.catalog_id,
        snapshot_sequence: 2,
        protocol_version: '1.0',
        published_at: '2026-08-16T10:00:00.000Z',
        previous_snapshot_digest: evidence.snapshot.snapshot_digest,
        withdrawn: true,
      },
    };
    expect(verifyCatalogEvidenceRecord(withdrawn, hash)).toBe(
      'evidence: pointer is a withdrawal and names no snapshot',
    );
  });
});
