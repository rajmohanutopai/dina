/**
 * The §6.4 attribution boundary (TRADE_FIRST_STRATEGY): the durable
 * crossing with its immutable grandfather index (both backends), the
 * v1-record walk, the read rule, and the approval seam's refusal of an
 * unattributed card past the boundary.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  enumerateV1Records,
  InMemoryAttributionBoundaryRepository,
  SQLiteAttributionBoundaryRepository,
  v1RecordAdmissible,
  type AttributionBoundaryRepository,
} from '../../src/commerce/attribution_boundary';
import { InMemoryCatalogDraftRepository } from '../../src/commerce/catalog_draft_store';
import { InMemoryOrderApprovalRepository } from '../../src/commerce/order_approvals';
import { readAnswerableApproval } from '../../src/commerce/order_dispatch';
import { InMemoryOrderDraftRepository } from '../../src/commerce/order_draft_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const T0 = 1_800_000_000_000;

interface Backend {
  name: string;
  make: () => { repo: AttributionBoundaryRepository; close: () => void };
}

const backends: Backend[] = [
  {
    name: 'sqlite',
    make: () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-attr-boundary-'));
      const adapter = new NodeSQLiteAdapter({
        path: path.join(dir, 'identity.sqlite'),
        passphraseHex: randomBytes(32).toString('hex'),
        journalMode: 'WAL',
        synchronous: 'NORMAL',
      });
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return {
        repo: new SQLiteAttributionBoundaryRepository(adapter),
        close: () => {
          adapter.close();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
  {
    name: 'memory',
    make: () => ({ repo: new InMemoryAttributionBoundaryRepository(), close: () => undefined }),
  },
];

describe.each(backends)('attribution boundary ($name)', ({ make }) => {
  let repo: AttributionBoundaryRepository;
  let close: () => void;

  beforeEach(() => {
    ({ repo, close } = make());
  });
  afterEach(() => close());

  it('crosses once with its index; a second crossing refuses and rewrites nothing', () => {
    expect(repo.crossedAt()).toBeNull();
    expect(repo.cross(T0, [{ digest: 'a'.repeat(64), kind: 'content_receipt' }])).toBe(true);
    expect(repo.crossedAt()).toBe(T0);
    expect(repo.isGrandfathered('a'.repeat(64))).toBe(true);
    expect(repo.isGrandfathered('b'.repeat(64))).toBe(false);
    expect(repo.isGrandfathered('')).toBe(false);
    // The first crossing stands: no re-cross, no late additions.
    expect(repo.cross(T0 + 5, [{ digest: 'b'.repeat(64), kind: 'approval' }])).toBe(false);
    expect(repo.crossedAt()).toBe(T0);
    expect(repo.isGrandfathered('b'.repeat(64))).toBe(false);
  });

  it('the read rule: v1 is the current shape before the crossing, index-only after', () => {
    expect(v1RecordAdmissible(repo, 'c'.repeat(64))).toBe(true);
    repo.cross(T0, [{ digest: 'c'.repeat(64), kind: 'vouch_receipt' }]);
    expect(v1RecordAdmissible(repo, 'c'.repeat(64))).toBe(true);
    expect(v1RecordAdmissible(repo, 'd'.repeat(64))).toBe(false);
  });
});

describe('enumerateV1Records', () => {
  it('walks catalog receipts and order-draft vouch entries, deduplicating shared digests', () => {
    const catalogDrafts = new InMemoryCatalogDraftRepository();
    const orderDrafts = new InMemoryOrderDraftRepository();
    const orderApprovals = new InMemoryOrderApprovalRepository();

    catalogDrafts.put({
      draftId: 'cd-1',
      catalogId: 'main',
      state: 'confirmed',
      provenanceClass: 'model_derived',
      defaultScheme: 'sku',
      publishClaim: null,
      extraction: { model: 'm', schemaVersion: 'catalog-rows-1' },
      photoExtraction: null,
      contentRevision: 1,
      rows: [],
      findings: [],
      provenance: {},
      items: [],
      generatedAtIso: '',
      itemRevision: '',
      receipt: { digest: 'a'.repeat(64), revision: 1, vouchedBy: null },
      held: null,
      approval: null,
      publication: null,
      createdAtMs: T0,
      updatedAtMs: T0,
    } as never);

    // One ceremony's digest shared by a line AND a requirement — indexed once.
    orderDrafts.put({
      draftId: 'od-1',
      abandoned: false,
      ceremonyCounter: 1,
      extractionDigest: 'e'.repeat(64),
      lines: [
        {
          lineId: 'l1',
          vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
        },
      ],
      requirements: [
        {
          key: 'r1',
          vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
        },
        { key: 'r2', vouch: null },
      ],
      conversations: [],
      createdAtMs: T0,
      updatedAtMs: T0,
    } as never);

    const records = enumerateV1Records({ catalogDrafts, orderDrafts, orderApprovals });
    expect(records).toEqual([
      { digest: 'a'.repeat(64), kind: 'content_receipt' },
      { digest: 'b'.repeat(64), kind: 'vouch_receipt' },
    ]);
  });

  it('walks RETAINED APPROVALS too — a live card minted pre-staff must survive the crossing', () => {
    const { approvalDigest } = jest.requireActual<
      typeof import('../../src/commerce/approval_payload')
    >('../../src/commerce/approval_payload');
    const helpers = jest.requireActual<typeof import('./helpers')>('./helpers');
    const request = helpers.makeQuoteRequest();
    const quote = helpers.makeSignedQuote(request, { quote_id: 'q-gf' });
    const order = helpers.makeOrder(quote, request.delivery.projection);

    const orderApprovals = new InMemoryOrderApprovalRepository();
    const stored = orderApprovals.put({
      approvalId: 'oap_gf_1',
      order,
      context: {
        actingBusinessDid: order.buyer_did,
        principal: { principalDid: 'did:plc:owner', authorityDomain: 'procurement', policyRevision: null },
        serviceUri: `at://${order.supplier_did}/com.dinakernel.service.profile/self`,
        displayedLabels: Object.fromEntries(order.accepted_lines.map((l) => [l.line_id, 'item'])),
        productKeys: Object.fromEntries(
          quote.lines.map((l) => [l.line_id, `${l.offered_product.scheme}:${l.offered_product.value}`]),
        ),
        linePrices: Object.fromEntries(quote.lines.map((l) => [l.line_id, l.unit_price])),
        charges: [],
        quoteRevision: Number(quote.quote_revision),
        quoteExpiresAt: quote.valid_until,
        install: {
          installId: 'install-gf',
          capabilityId: 'com.dinakernel.commerce.place-order',
          manifestCid: 'bafyreigf',
          installScopeHash: 's'.repeat(64),
          configRevision: '1',
        },
      } as never,
      serviceRkey: 'self',
      createdAt: T0,
      expiresAt: T0 + 60_000,
    });
    expect(stored).toBe(true);

    const records = enumerateV1Records({
      catalogDrafts: new InMemoryCatalogDraftRepository(),
      orderDrafts: new InMemoryOrderDraftRepository(),
      orderApprovals,
    });
    const payload = orderApprovals.get('oap_gf_1')?.payload;
    if (payload === undefined) throw new Error('approval not retained');
    expect(records).toEqual([{ digest: approvalDigest(payload), kind: 'approval' }]);
  });
});

describe('the approval seam past the boundary (§6.4)', () => {
  afterEach(() => installCommerceRuntime(null));

  it('an unattributed approval outside the index refuses; an indexed one stands', () => {
    const boundary = new InMemoryAttributionBoundaryRepository();
    // A stub get: `readAnswerableApproval` needs only the payload and the
    // clock fields, and the InMemory store's put() demands a full §15.2
    // context — the seam under test is the boundary rule, not retention.
    const held = {
      approvalId: 'oap_1',
      payload: { kind: 'buyer_order' } as never,
      order: {} as never,
      context: {} as never,
      serviceRkey: 'self',
      createdAt: T0,
      expiresAt: T0 + 60_000,
      consumedAt: null,
    };
    const runtime = {
      orderApprovals: { get: () => held },
      attributionBoundary: boundary,
    } as unknown as CommerceRuntime;
    installCommerceRuntime(runtime);

    // Pre-boundary: a v1 approval is simply the current shape.
    expect(readAnswerableApproval(runtime, 'oap_1', T0).ok).toBe(true);

    boundary.cross(T0, []);
    const refused = readAnswerableApproval(runtime, 'oap_1', T0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.body).toEqual({ error: 'approval_unattributed' });
    }

    // Grandfathered: compute the digest the seam checks and index it.
    const boundary2 = new InMemoryAttributionBoundaryRepository();
    const runtime2 = {
      orderApprovals: { get: () => held },
      attributionBoundary: boundary2,
    } as unknown as CommerceRuntime;
    const { approvalDigest } = jest.requireActual<
      typeof import('../../src/commerce/approval_payload')
    >('../../src/commerce/approval_payload');
    boundary2.cross(T0, [{ digest: approvalDigest(held.payload), kind: 'approval' }]);
    expect(readAnswerableApproval(runtime2, 'oap_1', T0).ok).toBe(true);

    // A v2 approval needs no index entry.
    const heldV2 = {
      ...held,
      payload: {
        kind: 'buyer_order',
        attribution: { version: 2, vouchedBy: 'did:key:zowner' },
      } as never,
    };
    const runtime3 = {
      orderApprovals: { get: () => heldV2 },
      attributionBoundary: boundary2,
    } as unknown as CommerceRuntime;
    expect(readAnswerableApproval(runtime3, 'oap_1', T0).ok).toBe(true);
  });
});
describe('the one-transaction crossing on the REAL adapter (§6.4)', () => {
  it('a failure after cross() rolls the boundary back — no half-crossed node', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-attr-txn-'));
    const adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    try {
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      const boundary = new SQLiteAttributionBoundaryRepository(adapter);
      const { SQLiteStaffGrantRepository } = jest.requireActual<
        typeof import('../../src/commerce/staff_grants')
      >('../../src/commerce/staff_grants');
      const grants = new SQLiteStaffGrantRepository(adapter);

      // The grant-route block, verbatim: cross + put in ONE transaction —
      // with a grant the schema CHECK refuses, so the put throws AFTER
      // the boundary rows are written.
      expect(() =>
        adapter.transaction(() => {
          boundary.cross(T0, [{ digest: 'a'.repeat(64), kind: 'approval' }]);
          grants.put({
            deviceDid: 'did:key:zstaff',
            scope: 'bogus_scope' as never,
            maxOrderMinorUnits: '',
            currency: '',
            installs: 'both',
            createdAt: T0,
            revokedAt: null,
          });
        }),
      ).toThrow();

      // ATOMIC: the crossing rolled back with the failed grant.
      expect(boundary.crossedAt()).toBeNull();
      expect(boundary.isGrandfathered('a'.repeat(64))).toBe(false);

      // And the same block with a LEGAL grant commits both together.
      adapter.transaction(() => {
        boundary.cross(T0, [{ digest: 'a'.repeat(64), kind: 'approval' }]);
        grants.put({
          deviceDid: 'did:key:zstaff',
          scope: 'commerce_confirm',
          maxOrderMinorUnits: '',
          currency: '',
          installs: 'both',
          createdAt: T0,
          revokedAt: null,
        });
      });
      expect(boundary.crossedAt()).toBe(T0);
      expect(boundary.isGrandfathered('a'.repeat(64))).toBe(true);
      expect(grants.get('did:key:zstaff', 'commerce_confirm')).not.toBeNull();
    } finally {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
