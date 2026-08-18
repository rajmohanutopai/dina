/**
 * The §5.1 transition and invalidation matrix, row by row. Each test names
 * the rule it pins; the confirm ceremony's receipt is recomputed through
 * the frozen §2.1 digest to prove the chain, not just the bookkeeping.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { vouchReceiptDigest } from '@dina/commerce-protocol';

import { InMemoryAttributionBoundaryRepository } from '../../src/commerce/attribution_boundary';
import { OrderDraftService } from '../../src/commerce/order_draft_service';
import {
  InMemoryOrderDraftRepository,
  type OrderConversation,
  type OrderDraft,
  type OrderDraftLine,
} from '../../src/commerce/order_draft_store';

const T0 = 1_800_000_000_000;
const SUPPLIER = 'did:plc:chairmaker';
const HEX = 'a'.repeat(64);
const hash = (data: Uint8Array): Uint8Array => sha256(data);

function resolvedLine(overrides: Partial<OrderDraftLine> = {}): OrderDraftLine {
  return {
    lineId: 'line-1',
    text: '20 dining chairs - oak',
    pageIndex: 0,
    fields: { quantity: '20', product_hint: 'dining chairs oak' },
    provenance: { quantity: 'accepted', product_hint: 'accepted' },
    resolution: {
      kind: 'resolved',
      product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER },
      supplierDid: SUPPLIER,
      flaggedNewSupplier: false,
    },
    generation: 1,
    assignmentGeneration: 0,
    vouch: null,
    deferred: false,
    evidence: null,
    submittedIn: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<OrderDraft> = {}): OrderDraft {
  return {
    draftId: 'odr-1',
    manifest: [{ artifact_id: 'img-1', content_hash: HEX, page_index: 0 }],
    extraction: { model: 'gpt-4o-mini', schemaVersion: 'order-lines-1' },
    extractionDigest: HEX,
    lines: [resolvedLine()],
    requirements: [
      {
        key: 'required_by',
        kind: 'transmitted',
        value: '2026-08-21',
        omitted: false,
        provenance: 'accepted',
        generation: 1,
        vouch: null,
      },
      {
        key: 'instruction',
        kind: 'draft_local',
        value: 'deliver to the back entrance',
        omitted: false,
        provenance: 'accepted',
        generation: 1,
        vouch: null,
      },
    ],
    conversations: [],
    ceremonyCounter: 0,
    abandoned: false,
    createdAtMs: T0,
    updatedAtMs: T0,
    ...overrides,
  };
}

function sentConversation(overrides: Partial<OrderConversation> = {}): OrderConversation {
  return {
    conversationId: 'conv-1',
    supplierDid: SUPPLIER,
    state: 'quoted',
    lineIds: ['line-1'],
    snapshot: {
      draft_id: 'odr-1',
      conversation_id: 'conv-1',
      supplier_did: SUPPLIER,
      request_digest: 'c'.repeat(64),
      lines: [{ line_id: 'line-1', generation: 1, vouch_receipt_digest: 'b'.repeat(64) }],
      requirements: [{ key: 'required_by', omitted: false, value: '2026-08-21', generation: 1 }],
    },
    snapshotDigest: 'd'.repeat(64),
    requestDigest: 'c'.repeat(64),
    requestId: 'req-1',
    quoteDigest: 'e'.repeat(64),
    quoteId: null,
    quoteValidUntil: '2026-08-22T00:00:00.000Z',
    approvalId: 'oap_1',
    purchaseOrderId: null,
    dispatchIntent: null,
    outcome: null,
    ...overrides,
  };
}

function makeService(
  present = true,
  boundary = new InMemoryAttributionBoundaryRepository(),
  voucher: string | null = 'did:plc:draftowner000000000000000',
): { service: OrderDraftService; repo: InMemoryOrderDraftRepository; boundary: InMemoryAttributionBoundaryRepository } {
  const repo = new InMemoryOrderDraftRepository();
  const service = new OrderDraftService({
    drafts: repo,
    now: () => T0 + 1000,
    sha256: hash,
    userPresent: () => present,
    // §6.4 — the default harness sits BEFORE the boundary (v1 minting);
    // tests cross it explicitly.
    attributionBoundary: boundary,
    vouchedBy: () => voucher,
  });
  return { service, repo, boundary };
}

describe('REPAIR A LINE (matrix row 1)', () => {
  it('the typed field goes to edited, the generation bumps, the vouch voids, carriers invalidate', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({
        lines: [
          resolvedLine({ vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null } }),
        ],
        conversations: [sentConversation()],
      }),
    );
    const outcome = service.repairLine('odr-1', { lineId: 'line-1', field: 'quantity', value: '25' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const line = outcome.draft.lines[0]!;
    expect(line.fields.quantity).toBe('25');
    // They WROTE it — demanding they accept their own words confuses the
    // vocabulary §2 pins.
    expect(line.provenance.quantity).toBe('edited');
    expect(line.generation).toBe(2);
    expect(line.vouch).toBeNull();
    const conversation = outcome.draft.conversations[0]!;
    expect(conversation.state).toBe('superseded');
    expect(conversation.approvalId).toBeNull();
  });

  it('a line in a SUBMITTED order refuses — rejected/timed-out lines reopen first', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft({ lines: [resolvedLine({ submittedIn: 'conv-9' })] }));
    const outcome = service.repairLine('odr-1', { lineId: 'line-1', field: 'quantity', value: '25' });
    expect(outcome).toMatchObject({ ok: false, refusal: 'line_submitted' });
  });

  it('other lines\' vouch entries STAND', () => {
    const { service, repo } = makeService();
    const untouched = resolvedLine({
      lineId: 'line-2',
      vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
    });
    repo.put(makeDraft({ lines: [resolvedLine(), untouched] }));
    const outcome = service.repairLine('odr-1', { lineId: 'line-1', field: 'quantity', value: '25' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.draft.lines[1]?.vouch).not.toBeNull();
  });
});

describe('RESOLVE (matrix row 2) — refuse what the store cannot re-read', () => {
  // The SQLite store validates rows on LOAD and treats an invalid one as
  // absent, so a stored resolution the read path refuses does not fail
  // the write — it makes the whole draft unreadable for ever. The first
  // live run against a real node did exactly that: a `manufacturer_sku`
  // ref without `issuer_did` was accepted, and every later call answered
  // `no_such_draft`. These pin the write-side mirror.

  it('a scoped product ref missing issuer_did is refused, and the line is untouched', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft());
    const outcome = service.resolveLine('odr-1', {
      lineId: 'line-1',
      resolution: {
        kind: 'resolved',
        // No issuer_did — exactly what readResolution refuses on load.
        product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1' } as never,
        supplierDid: SUPPLIER,
        flaggedNewSupplier: false,
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('invalid_resolution');
    // The draft still reads, resolution unchanged.
    const draft = repo.get('odr-1');
    expect(draft?.lines[0]?.resolution.kind).toBe('resolved');
    expect(draft?.lines[0]?.generation).toBe(1);
  });

  it('an ambiguous set with one invalid candidate is refused whole', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft());
    const outcome = service.resolveLine('odr-1', {
      lineId: 'line-1',
      resolution: {
        kind: 'ambiguous',
        candidates: [
          {
            product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER },
            supplierDid: SUPPLIER,
            flaggedNewSupplier: false,
          },
          {
            product: { scheme: 'gtin', value: 'not-digits' } as never,
            supplierDid: SUPPLIER,
            flaggedNewSupplier: false,
          },
        ],
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('invalid_resolution');
  });

  it('an unknown resolution kind is refused, never stored', () => {
    const { service } = makeService();
    const outcome = service.resolveLine('odr-1', {
      lineId: 'line-1',
      resolution: { kind: 'decided' } as never,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toBe('invalid_resolution');
  });

  it('a valid resolved ref still lands: generation bumps, vouch voids', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({
        lines: [
          resolvedLine({ vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null } }),
        ],
      }),
    );
    const outcome = service.resolveLine('odr-1', {
      lineId: 'line-1',
      resolution: {
        kind: 'resolved',
        product: { scheme: 'manufacturer_sku', value: 'CM-STOOL-1', issuer_did: SUPPLIER },
        supplierDid: SUPPLIER,
        flaggedNewSupplier: false,
      },
    });
    expect(outcome.ok).toBe(true);
    const line = repo.get('odr-1')?.lines[0];
    expect(line?.generation).toBe(2);
    expect(line?.vouch).toBeNull();
    expect(line?.resolution.kind === 'resolved' && line.resolution.product.value).toBe('CM-STOOL-1');
  });
});

describe('DEFER (matrix row 3)', () => {
  it('excludes an ambiguous line from confirm rather than blocking it', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({
        lines: [
          resolvedLine(),
          resolvedLine({
            lineId: 'line-2',
            resolution: {
              kind: 'ambiguous',
              candidates: [
                {
                  product: { scheme: 'manufacturer_sku', value: 'X-1', issuer_did: SUPPLIER },
                  supplierDid: SUPPLIER,
                  flaggedNewSupplier: true,
                },
              ],
            },
          }),
        ],
      }),
    );
    // Undeferred ambiguity blocks the ceremony...
    expect(service.confirm('odr-1')).toMatchObject({ ok: false, refusal: 'undecided_candidates' });
    // ...defer unblocks it without deciding it.
    expect(service.deferLine('odr-1', 'line-2').ok).toBe(true);
    expect(service.confirm('odr-1').ok).toBe(true);
  });

  it('defer refuses on a line that is not ambiguous', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft());
    expect(service.deferLine('odr-1', 'line-1')).toMatchObject({ ok: false, refusal: 'not_ambiguous' });
  });
});

describe('ACCEPT LINE FIELDS (matrix row 4 — the confirm gate\'s exit)', () => {
  it('accepts only named, existing, currently-proposed fields', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({
        lines: [resolvedLine({ provenance: { quantity: 'proposed', product_hint: 'accepted' } })],
      }),
    );
    expect(
      service.acceptLineFields('odr-1', [{ lineId: 'line-1', field: 'invented' }]),
    ).toMatchObject({ ok: false, refusal: 'unknown_field' });
    expect(
      service.acceptLineFields('odr-1', [{ lineId: 'line-1', field: 'product_hint' }]),
    ).toMatchObject({ ok: false, refusal: 'not_proposed' });
    expect(service.acceptLineFields('odr-1', [])).toMatchObject({ ok: false, refusal: 'nothing_named' });

    const accepted = service.acceptLineFields('odr-1', [{ lineId: 'line-1', field: 'quantity' }]);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.draft.lines[0]?.provenance.quantity).toBe('accepted');
  });
});

describe('REQUIREMENTS (matrix row 5 — always allowed)', () => {
  it('an edit bumps the generation, voids the vouch, and invalidates TRANSMITTED carriers', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft({ conversations: [sentConversation()] }));
    const outcome = service.editRequirement('odr-1', {
      key: 'required_by',
      action: 'edit',
      value: '2026-08-28',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const requirement = outcome.draft.requirements[0]!;
    expect(requirement.value).toBe('2026-08-28');
    expect(requirement.generation).toBe(2);
    expect(requirement.vouch).toBeNull();
    // A changed delivery date changes what every outstanding request asked.
    expect(outcome.draft.conversations[0]?.state).toBe('superseded');
  });

  it('a DRAFT-LOCAL edit invalidates nothing — the wire never carried it', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft({ conversations: [sentConversation()] }));
    const outcome = service.editRequirement('odr-1', {
      key: 'instruction',
      action: 'edit',
      value: 'front entrance after all',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.draft.conversations[0]?.state).toBe('quoted');
  });

  it('omit sets the null pair; reinstate returns it to proposed', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft());
    const omitted = service.editRequirement('odr-1', { key: 'required_by', action: 'omit' });
    expect(omitted.ok).toBe(true);
    if (omitted.ok) {
      expect(omitted.draft.requirements[0]).toMatchObject({ value: null, omitted: true });
    }
    const back = service.editRequirement('odr-1', { key: 'required_by', action: 'reinstate' });
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.draft.requirements[0]).toMatchObject({ omitted: false, provenance: 'proposed' });
    }
  });

  it('an acceptance changes no value and invalidates nothing', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({
        requirements: [
          {
            key: 'required_by',
            kind: 'transmitted',
            value: '2026-08-21',
            omitted: false,
            provenance: 'proposed',
            generation: 1,
            vouch: null,
          },
        ],
        conversations: [sentConversation()],
      }),
    );
    const outcome = service.editRequirement('odr-1', { key: 'required_by', action: 'accept' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.draft.requirements[0]?.generation).toBe(1);
    expect(outcome.draft.conversations[0]?.state).toBe('quoted');
  });
});

describe('CONFIRM — the ceremony', () => {
  it('refuses without presence: a batch tap cannot vouch a quantity nobody looked at', () => {
    const { service, repo } = makeService(false);
    repo.put(makeDraft());
    expect(service.confirm('odr-1')).toMatchObject({ ok: false, refusal: 'no_user_presence' });
  });

  it('names the still-proposed field that blocks it', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({ lines: [resolvedLine({ provenance: { quantity: 'proposed' } })] }),
    );
    const outcome = service.confirm('odr-1');
    expect(outcome).toMatchObject({ ok: false, refusal: 'unconfirmed_fields' });
    if (!outcome.ok) expect(outcome.detail).toContain('quantity');
  });

  it('names an undecided requirement INCLUDING a draft-local one', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({
        requirements: [
          {
            key: 'instruction',
            kind: 'draft_local',
            value: 'urgent',
            omitted: false,
            provenance: 'proposed',
            generation: 1,
            vouch: null,
          },
        ],
      }),
    );
    const outcome = service.confirm('odr-1');
    expect(outcome).toMatchObject({ ok: false, refusal: 'undecided_requirement' });
    if (!outcome.ok) expect(outcome.detail).toContain('instruction');
  });

  it('mints the §2.1 receipt: extraction digest committed, per-line entries, recomputable', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft());
    const outcome = service.confirm('odr-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const draft = outcome.draft;
    expect(draft.ceremonyCounter).toBe(1);
    const vouch = draft.lines[0]?.vouch;
    expect(vouch).not.toBeNull();

    // The chain, recomputed through the frozen digest — not trusted from
    // the bookkeeping: the receipt this ceremony describes hashes to the
    // digest the line carries.
    const recomputed = vouchReceiptDigest(
      {
        draft_id: 'odr-1',
        ceremony: 1,
        extraction_digest: HEX,
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
          { key: 'instruction', omitted: false, value: 'deliver to the back entrance', generation: 1 },
        ],
      },
      hash,
    );
    expect(vouch?.receiptDigest).toBe(recomputed);
    // Requirements carry the SAME ceremony's entry.
    expect(draft.requirements[0]?.vouch?.receiptDigest).toBe(recomputed);
  });

  it('the ceremony counter is bumped by confirm and NOTHING else', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft());
    service.repairLine('odr-1', { lineId: 'line-1', field: 'quantity', value: '25' });
    service.editRequirement('odr-1', { key: 'required_by', action: 'edit', value: '2026-09-01' });
    expect(repo.get('odr-1')?.ceremonyCounter).toBe(0);
    // Repair re-opened the quantity as edited (fine for confirm) — decide
    // the requirement again and confirm.
    service.confirm('odr-1');
    expect(repo.get('odr-1')?.ceremonyCounter).toBe(1);
  });

  it('a draft with no extraction chain refuses — the vouch would prove nothing', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft({ extractionDigest: '' }));
    expect(service.confirm('odr-1')).toMatchObject({ ok: false, refusal: 'no_extraction_chain' });
  });
});

describe('REOPEN and ABANDON', () => {
  it('reopen retires assignments on a TERMINAL conversation only', () => {
    const { service, repo } = makeService();
    repo.put(
      makeDraft({
        lines: [
          resolvedLine({ vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null } }),
        ],
        conversations: [sentConversation({ state: 'timed_out' })],
      }),
    );
    expect(service.reopenLines('odr-1', 'conv-1').ok).toBe(true);
    const line = repo.get('odr-1')?.lines[0];
    expect(line?.assignmentGeneration).toBe(1);
    expect(line?.vouch).toBeNull();

    repo.put(makeDraft({ conversations: [sentConversation({ state: 'sent' })] }));
    expect(service.reopenLines('odr-1', 'conv-1')).toMatchObject({
      ok: false,
      refusal: 'not_terminal',
    });
  });

  it('abandon closes open conversations; submitted_unconfirmed HOLDS the draft', () => {
    const { service, repo } = makeService();
    repo.put(makeDraft({ conversations: [sentConversation({ state: 'submitted_unconfirmed' })] }));
    expect(service.abandon('odr-1')).toMatchObject({
      ok: false,
      refusal: 'submitted_unconfirmed_held',
    });

    repo.put(makeDraft({ conversations: [sentConversation({ state: 'quoted' })] }));
    const outcome = service.abandon('odr-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.draft.abandoned).toBe(true);
    expect(outcome.draft.conversations[0]).toMatchObject({ state: 'closed', outcome: 'abandoned' });
  });
});

describe('§6.4 attribution at the vouch ceremony', () => {
  it('past the boundary, confirm commits the voucher under the v2 domain and stamps every entry', () => {
    const boundary = new InMemoryAttributionBoundaryRepository();
    boundary.cross(T0, []);
    const voucher = 'did:plc:draftowner000000000000000';
    const { service, repo } = makeService(true, boundary, voucher);
    repo.put(makeDraft());
    const outcome = service.confirm('odr-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const vouch = outcome.draft.lines[0]?.vouch;
    expect(vouch?.vouchedBy).toBe(voucher);
    expect(outcome.draft.requirements[0]?.vouch?.vouchedBy).toBe(voucher);
    // The digest moved to the v2 domain: recomputing WITHOUT attribution
    // (the v1 preimage) must not reproduce it, and recomputing WITH it must.
    const v1Twin = vouchReceiptDigest(
      {
        draft_id: 'odr-1',
        ceremony: 1,
        extraction_digest: HEX,
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
          { key: 'instruction', omitted: false, value: 'deliver to the back entrance', generation: 1 },
        ],
      },
      hash,
    );
    expect(vouch?.receiptDigest).not.toBe(v1Twin);
    const v2 = vouchReceiptDigest(
      {
        draft_id: 'odr-1',
        ceremony: 1,
        extraction_digest: HEX,
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
          { key: 'instruction', omitted: false, value: 'deliver to the back entrance', generation: 1 },
        ],
        attribution: { version: 2, vouched_by: voucher },
      },
      hash,
    );
    expect(vouch?.receiptDigest).toBe(v2);
  });

  it('past the boundary with no known voucher, confirm refuses', () => {
    const boundary = new InMemoryAttributionBoundaryRepository();
    boundary.cross(T0, []);
    const { service, repo } = makeService(true, boundary, null);
    repo.put(makeDraft());
    expect(service.confirm('odr-1')).toMatchObject({
      ok: false,
      refusal: 'no_user_presence',
    });
  });
});
