/**
 * The buyer aggregate's store (§5.1) — driven against real SQLite AND the
 * double from one body, the same parity discipline as the catalog store.
 * The invariants the readers enforce are the ones the design pins: one
 * LIVE conversation per supplier, fail-closed provenance, vouch entries
 * whole or absent, derived top-level state.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  deriveOrderDraftState,
  InMemoryOrderDraftRepository,
  liveConversationFor,
  SQLiteOrderDraftRepository,
  type OrderConversation,
  type OrderDraft,
  type OrderDraftLine,
  type OrderDraftRepository,
} from '../../src/commerce/order_draft_store';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = 1_800_000_000_000;
const SUPPLIER = 'did:plc:chairmaker';
const HEX = 'a'.repeat(64);

function makeLine(overrides: Partial<OrderDraftLine> = {}): OrderDraftLine {
  return {
    lineId: 'line-1',
    text: '20 dining chairs - oak',
    pageIndex: 0,
    fields: { quantity: '20', product_hint: 'dining chairs oak' },
    provenance: { quantity: 'proposed', product_hint: 'proposed' },
    resolution: { kind: 'unresolved' },
    generation: 1,
    assignmentGeneration: 0,
    vouch: null,
    deferred: false,
    evidence: null,
    submittedIn: null,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<OrderConversation> = {}): OrderConversation {
  return {
    conversationId: 'conv-1',
    supplierDid: SUPPLIER,
    state: 'draft',
    lineIds: ['line-1'],
    snapshot: null,
    snapshotDigest: null,
    requestDigest: null,
    requestId: null,
    quoteDigest: null,
    quoteId: null,
    quoteValidUntil: null,
    approvalId: null,
    purchaseOrderId: null,
    dispatchIntent: null,
    outcome: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<OrderDraft> = {}): OrderDraft {
  return {
    draftId: 'odr-1',
    manifest: [{ artifact_id: 'img-1', content_hash: HEX, page_index: 0 }],
    extraction: { model: 'gpt-4o-mini', schemaVersion: 'order-lines-1' },
    extractionDigest: HEX,
    lines: [makeLine()],
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
      {
        key: 'instruction',
        kind: 'draft_local',
        value: 'deliver to the back entrance',
        omitted: false,
        provenance: 'proposed',
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

function forEachRepo(name: string, body: (repo: OrderDraftRepository) => void): void {
  describe(name, () => {
    let dir: string;
    let adapter: NodeSQLiteAdapter;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'order-drafts-'));
      adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
    });
    afterEach(() => {
      adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('sqlite', () => {
      body(new SQLiteOrderDraftRepository(adapter));
    });
    it('in-memory double', () => {
      body(new InMemoryOrderDraftRepository());
    });
  });
}

forEachRepo('round trip, whole', (repo) => {
  const draft = makeDraft({
    lines: [
      makeLine({
        resolution: {
          kind: 'resolved',
          product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER },
          supplierDid: SUPPLIER,
          flaggedNewSupplier: false,
        },
        vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
      }),
    ],
    conversations: [makeConversation({ state: 'sent', requestDigest: 'c'.repeat(64) })],
    ceremonyCounter: 1,
  });
  repo.put(draft);
  expect(repo.get('odr-1')).toEqual(draft);
});

forEachRepo('a returned draft cannot mutate stored state through the reference', (repo) => {
  repo.put(makeDraft());
  const first = repo.get('odr-1');
  if (first !== null) first.lines[0]!.fields.quantity = '9999';
  expect(repo.get('odr-1')?.lines[0]?.fields.quantity).toBe('20');
});

forEachRepo('derived state: open → awaiting → closed, never stored', (repo) => {
  const open = makeDraft();
  expect(deriveOrderDraftState(open)).toBe('open');
  const waiting = makeDraft({ conversations: [makeConversation({ state: 'sent' })] });
  expect(deriveOrderDraftState(waiting)).toBe('awaiting_answers');
  const settled = makeDraft({
    lines: [makeLine({ submittedIn: 'conv-1' })],
    conversations: [makeConversation({ state: 'submitted' })],
  });
  expect(deriveOrderDraftState(settled)).toBe('closed');
  expect(deriveOrderDraftState(makeDraft({ abandoned: true }))).toBe('closed');
  repo.put(open);
});

forEachRepo('liveConversationFor honours terminal states', (repo) => {
  const draft = makeDraft({
    conversations: [
      makeConversation({ conversationId: 'conv-old', state: 'timed_out' }),
      makeConversation({ conversationId: 'conv-new', state: 'sent' }),
    ],
  });
  repo.put(draft);
  const read = repo.get('odr-1');
  expect(read).not.toBeNull();
  expect(liveConversationFor(read as OrderDraft, SUPPLIER)?.conversationId).toBe('conv-new');
});

describe('fail-closed hydration (sqlite rows edited after writing)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let repo: SQLiteOrderDraftRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'order-drafts-corrupt-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    repo = new SQLiteOrderDraftRepository(adapter);
    repo.put(makeDraft());
  });
  afterEach(() => {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function corrupt(column: string, value: string): void {
    adapter.run(`UPDATE commerce_order_drafts SET ${column} = ? WHERE draft_id = ?`, [
      value,
      'odr-1',
    ]);
  }

  it('TWO LIVE conversations for one supplier reads as no draft', () => {
    // Both would claim the same lines — the §5.0 one-live rule is a stored
    // invariant, refused on the way out rather than half-believed.
    corrupt(
      'conversations_json',
      JSON.stringify([
        makeConversation({ conversationId: 'conv-a', state: 'sent' }),
        makeConversation({ conversationId: 'conv-b', state: 'draft' }),
      ]),
    );
    expect(repo.get('odr-1')).toBeNull();
  });

  it('a corrupted provenance STATE fails closed to proposed', () => {
    const line = makeLine();
    (line.provenance as Record<string, string>).quantity = 'proposd';
    corrupt('lines_json', JSON.stringify([line]));
    expect(repo.get('odr-1')?.lines[0]?.provenance.quantity).toBe('proposed');
  });

  it('a half-written vouch entry reads as no draft, never as vouched', () => {
    const line = makeLine({ vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null } });
    (line.vouch as unknown as Record<string, unknown>).receiptDigest = 'not-hex';
    corrupt('lines_json', JSON.stringify([line]));
    expect(repo.get('odr-1')).toBeNull();
  });

  it('an omitted requirement carrying a value reads as no draft', () => {
    corrupt(
      'requirements_json',
      JSON.stringify([
        {
          key: 'destination',
          kind: 'transmitted',
          value: 'Bangalore',
          omitted: true,
          provenance: 'accepted',
          generation: 1,
          vouch: null,
        },
      ]),
    );
    expect(repo.get('odr-1')).toBeNull();
  });

  it('an unknown conversation state reads as no draft', () => {
    corrupt(
      'conversations_json',
      JSON.stringify([makeConversation({ state: 'sneaky' as OrderConversation['state'] })]),
    );
    expect(repo.get('odr-1')).toBeNull();
  });

  it('a shuffled manifest reads as no draft — the order is the commitment', () => {
    corrupt(
      'manifest_json',
      JSON.stringify([{ artifact_id: 'img-1', content_hash: HEX, page_index: 1 }]),
    );
    expect(repo.get('odr-1')).toBeNull();
  });
});
