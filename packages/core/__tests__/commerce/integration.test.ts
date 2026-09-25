/**
 * The merchant integration surface, pure half (JIFFY_MERCHANT_INTEGRATION_PLAN
 * §3.2, Piece B): admission on a live grant for exactly one scope; the status
 * as retained facts and digests; the orders export as a total order over
 * `(decided_at, order_digest)` derived from retained rows, so a replay from
 * any cursor is the same page.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { InMemoryCatalogPointerRepository } from '../../src/commerce/catalog_pointer_store';
import { InMemoryCatalogSourceBindingRepository } from '../../src/commerce/catalog_source_bindings';
import { CommerceOrderStore, type CommerceOrder } from '../../src/commerce/commerce_order';
import {
  INTEGRATION_API_VERSION,
  ORDERS_EXPORT_MAX_LIMIT,
  admitIntegrationCaller,
  buildIntegrationStatus,
  encodeOrdersCursor,
  listOrderDecisionEvents,
  parseOrdersCursor,
  settingsRevision,
} from '../../src/commerce/integration';
import {
  InMemoryCommerceOrderRefRepository,
  SQLiteCommerceOrderRefRepository,
  type CommerceOrderRefRepository,
  type NewCommerceOrderRef,
} from '../../src/commerce/order_refs';
import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import { InMemoryCommerceSettingsRepository } from '../../src/commerce/settings_store';
import {
  INTEGRATION_SCOPES,
  InMemoryStaffGrantRepository,
  STAFF_SCOPES,
  SQLiteStaffGrantRepository,
  validateStaffGrantInput,
} from '../../src/commerce/staff_grants';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  makeAcknowledgement,
  makeOrder,
  makeQuoteRequest,
  makeSignedQuote,
} from './helpers';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const DEVICE = 'did:key:zJiffyIntegration';
const T0 = 1_800_000_000_000;
const DIGEST_A = 'a'.repeat(64);

function sqliteAdapter(): { adapter: DatabaseAdapter; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-integration-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  return {
    adapter,
    close: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function reservedRef(
  purchaseOrderId: string,
  orderDigest: string,
  over: Partial<NewCommerceOrderRef> = {},
): NewCommerceOrderRef {
  return {
    buyerDid: BUYER_DID,
    purchaseOrderId,
    idempotencyKey: `idem-${purchaseOrderId}`,
    orderDigest,
    quoteId: 'q-1',
    quoteDigest: 'b'.repeat(64),
    pinnedVersion: '1.0',
    servingManifestCid: '',
    servingInstallId: '',
    admittedEpoch: '1',
    reconciliationRequired: false,
    decisionDeadlineAt: null,
    createdAt: T0,
    ...over,
  };
}

function acceptedAck(
  purchaseOrderId: string,
  orderDigest: string,
  supplierOrderId = 'so-1',
): string {
  return JSON.stringify(
    makeAcknowledgement({
      purchase_order_id: purchaseOrderId,
      order_digest: orderDigest,
      kind: 'accepted',
      supplier_order_id: supplierOrderId,
      accepted_quote_digest: 'b'.repeat(64),
      accepted_at: '2026-09-23T10:00:00.000Z',
    }),
  );
}

function hashHex(text: string): string {
  return Buffer.from(hash(new TextEncoder().encode(text))).toString('hex');
}

describe('admission (one scope, one live grant, supplier install)', () => {
  it('the owner is admitted; a device is admitted only on a live grant for exactly that scope', () => {
    const staffGrants = new InMemoryStaffGrantRepository();
    const runtime = { staffGrants };
    expect(admitIntegrationCaller(runtime, { kind: 'owner' }, 'integration_status')).toEqual({
      ok: true,
    });
    const device = { kind: 'staff' as const, deviceDid: DEVICE };
    expect(admitIntegrationCaller(runtime, device, 'integration_status').ok).toBe(false);
    staffGrants.put({
      deviceDid: DEVICE,
      scope: 'integration_status',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: null,
    });
    expect(admitIntegrationCaller(runtime, device, 'integration_status')).toEqual({ ok: true });
    // Another scope's grant admits nothing here.
    expect(admitIntegrationCaller(runtime, device, 'integration_orders_export').ok).toBe(false);
    // A buyer-only grant is the wrong install for a supplier read.
    staffGrants.put({
      deviceDid: DEVICE,
      scope: 'integration_orders_export',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'buyer',
      createdAt: T0,
      revokedAt: null,
    });
    expect(admitIntegrationCaller(runtime, device, 'integration_orders_export').ok).toBe(false);
    // `both` covers the supplier side.
    staffGrants.put({
      deviceDid: DEVICE,
      scope: 'integration_orders_export',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'both',
      createdAt: T0,
      revokedAt: null,
    });
    expect(admitIntegrationCaller(runtime, device, 'integration_orders_export')).toEqual({
      ok: true,
    });
    // Revocation closes every door at once.
    staffGrants.revokeDevice(DEVICE, T0 + 1);
    expect(admitIntegrationCaller(runtime, device, 'integration_status').ok).toBe(false);
    expect(admitIntegrationCaller(runtime, device, 'integration_orders_export').ok).toBe(false);
  });

  it('every integration scope is a staff scope, uncapped, and refuses a cap', () => {
    for (const scope of INTEGRATION_SCOPES) {
      expect(STAFF_SCOPES).toContain(scope);
      expect(validateStaffGrantInput({ scope, installs: 'supplier' })).toBeNull();
      expect(
        validateStaffGrantInput({
          scope,
          installs: 'supplier',
          maxOrderMinorUnits: '1',
          currency: 'INR',
        }),
      ).toContain('no cap');
    }
  });
});

describe('settings revision', () => {
  it('is a digest of the stored record: absent → null, same content → same digest, any change → a new one', () => {
    const settings = new InMemoryCommerceSettingsRepository();
    expect(settingsRevision(settings.readBusiness())).toBeNull();
    expect(settings.writeBusiness({ legalName: 'Albert Bakes LLC', registrations: [] }).ok).toBe(
      true,
    );
    const first = settingsRevision(settings.readBusiness());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(settingsRevision(settings.readBusiness())).toBe(first);
    expect(settings.writeBusiness({ legalName: 'Albert Bakes Inc', registrations: [] }).ok).toBe(
      true,
    );
    expect(settingsRevision(settings.readBusiness())).not.toBe(first);
  });
});

describe('status', () => {
  it('names the node, the API version, the caller’s live integration grants, the catalogues and the settings digests — never the terms', () => {
    const staffGrants = new InMemoryStaffGrantRepository();
    staffGrants.put({
      deviceDid: DEVICE,
      scope: 'integration_status',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: null,
    });
    staffGrants.put({
      deviceDid: DEVICE,
      scope: 'commerce_receive_goods',
      maxOrderMinorUnits: '100',
      currency: 'INR',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: null,
    });
    staffGrants.put({
      deviceDid: 'did:key:zOther',
      scope: 'integration_orders_export',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: null,
    });
    staffGrants.put({
      deviceDid: 'did:key:zGone',
      scope: 'integration_status',
      maxOrderMinorUnits: '',
      currency: '',
      installs: 'supplier',
      createdAt: T0,
      revokedAt: T0 + 5,
    });
    const catalogPointers = new InMemoryCatalogPointerRepository();
    catalogPointers.put({
      catalogId: 'cat-1',
      pointer: {
        supplier_did: SUPPLIER_DID,
        catalog_id: 'cat-1',
        snapshot_sequence: 3,
        protocol_version: '1.0',
        published_at: '2026-09-23T00:00:00.000Z',
      } as never,
      pointerCid: 'bafy-pointer',
      snapshotDigest: DIGEST_A,
      withdrawn: false,
      publishedAtMs: T0,
    });
    const settings = new InMemoryCommerceSettingsRepository();
    settings.writeBusiness({ legalName: 'Albert Bakes LLC', registrations: [] });
    // cat-1 is published AND bound; cat-new is bound but has never published —
    // a first refresh runs before a first publication, so it must be listed.
    const catalogSourceBindings = new InMemoryCatalogSourceBindingRepository();
    for (const catalogId of ['cat-new', 'cat-1']) {
      catalogSourceBindings.put({
        catalogId,
        kind: 'rest',
        credentialResource: 'catalog.source',
        operation: 'read_catalog',
        defaultScheme: 'sku',
        serviceRkey: null,
        boundAt: T0,
      });
    }
    const runtime = {
      staffGrants,
      catalogPointers,
      catalogSourceBindings,
      settings,
      nodeDid: () => SUPPLIER_DID,
    };

    const forDevice = buildIntegrationStatus(runtime, { kind: 'staff', deviceDid: DEVICE });
    expect(forDevice.apiVersion).toBe(INTEGRATION_API_VERSION);
    expect(forDevice.businessDid).toBe(SUPPLIER_DID);
    expect(forDevice.deviceDid).toBe(DEVICE);
    // Only this device's live INTEGRATION grants: the capped clerk scope is not one.
    expect(forDevice.grants).toEqual([
      { deviceDid: DEVICE, scope: 'integration_status', installs: 'supplier', createdAt: T0 },
    ]);
    expect(forDevice.catalogs).toEqual([
      {
        catalogId: 'cat-1',
        state: 'published',
        snapshotSequence: 3,
        snapshotDigest: DIGEST_A,
        publishedAtMs: T0,
        bound: true,
      },
      {
        catalogId: 'cat-new',
        state: 'unpublished',
        snapshotSequence: null,
        snapshotDigest: null,
        publishedAtMs: null,
        bound: true,
      },
    ]);
    expect(forDevice.settingsRevision.business).toMatch(/^[0-9a-f]{64}$/);
    expect(forDevice.settingsRevision.supplier).toBeNull();
    expect(JSON.stringify(forDevice)).not.toContain('Albert Bakes');

    // The owner sees every device's live integration grants; the revoked one is gone.
    const forOwner = buildIntegrationStatus(runtime, { kind: 'owner' });
    expect(forOwner.deviceDid).toBeNull();
    expect(forOwner.grants.map((g) => `${g.deviceDid}:${g.scope}`)).toEqual([
      `${DEVICE}:integration_status`,
      'did:key:zOther:integration_orders_export',
    ]);
  });
});

describe('orders cursor', () => {
  it('round-trips and refuses every other shape', () => {
    const cursor = { decidedAt: T0, orderDigest: DIGEST_A };
    expect(parseOrdersCursor(encodeOrdersCursor(cursor))).toEqual(cursor);
    for (const bad of [
      '',
      'v2.1.' + DIGEST_A,
      `v1.${T0}`,
      `v1.-1.${DIGEST_A}`,
      `v1.${T0}.abc`,
      `v1.x.${DIGEST_A}`,
      `v1.${T0}.${DIGEST_A}.extra`,
    ]) {
      expect([bad, parseOrdersCursor(bad)]).toEqual([bad, null]);
    }
  });
});

interface Backend {
  name: string;
  make: () => { refs: CommerceOrderRefRepository; close: () => void };
}
const backends: Backend[] = [
  {
    name: 'sqlite',
    make: () => {
      const { adapter, close } = sqliteAdapter();
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      return { refs: new SQLiteCommerceOrderRefRepository(adapter), close };
    },
  },
  {
    name: 'memory',
    make: () => ({ refs: new InMemoryCommerceOrderRefRepository(), close: () => undefined }),
  },
];

describe.each(backends)('orders export ($name)', ({ make }) => {
  let refs: CommerceOrderRefRepository;
  let close: () => void;
  let orders: CommerceOrderStore;
  let receipts: InMemoryCommerceReceiptRepository;
  beforeEach(() => {
    ({ refs, close } = make());
    orders = new CommerceOrderStore({ refs, now: () => T0 });
    receipts = new InMemoryCommerceReceiptRepository();
  });
  afterEach(() => close());

  function loaded(purchaseOrderId: string): CommerceOrder {
    const order = orders.load(BUYER_DID, purchaseOrderId);
    if (order === null) throw new Error(`test: ${purchaseOrderId} was not reserved`);
    return order;
  }

  function decide(
    purchaseOrderId: string,
    orderDigest: string,
    decidedAt: number,
    ackJson: string,
    externalRef?: string,
  ): void {
    expect(orders.createReserved(reservedRef(purchaseOrderId, orderDigest))).toBe(true);
    const outcome = loaded(purchaseOrderId).decide({
      acknowledgementJson: ackJson,
      decidedAt,
      ...(externalRef !== undefined ? { externalRef } : {}),
    });
    expect(outcome.ok).toBe(true);
  }

  it('lists decided orders only, oldest first, ties by digest; reserved and unreadable rows never become events', () => {
    const runtime = { orders, receipts };
    // Reserved: never exported.
    expect(orders.createReserved(reservedRef('po-reserved', 'e'.repeat(64)))).toBe(true);
    decide('po-b', 'd'.repeat(64), T0 + 10, acceptedAck('po-b', 'd'.repeat(64), 'so-b'));
    decide('po-a', 'c'.repeat(64), T0 + 10, acceptedAck('po-a', 'c'.repeat(64), 'so-a'));
    decide(
      'po-first',
      'f'.repeat(64),
      T0 + 1,
      acceptedAck('po-first', 'f'.repeat(64), 'so-first'),
      'clover-77',
    );
    decide('po-broken', '9'.repeat(64), T0 + 20, '{not json');
    const page = listOrderDecisionEvents(runtime, { after: null, limit: 50 });
    expect(page.events.map((e) => e.purchaseOrderId)).toEqual(['po-first', 'po-a', 'po-b']);
    expect(page.unreadable).toBe(1);
    expect(page.events[0]).toMatchObject({
      decision: 'accepted',
      supplierOrderId: 'so-first',
      externalRef: 'clover-77',
      order: null,
    });
    expect(page.events[0].eventId).toMatch(/^[0-9a-f]{64}$/);
    // The last row read sets the cursor, unreadable or not, so a reader never re-reads it.
    expect(page.nextCursor).toBe(
      encodeOrdersCursor({ decidedAt: T0 + 20, orderDigest: '9'.repeat(64) }),
    );
  });

  it('pages are a total order: the same cursor yields the same page, and pages chain without gaps or repeats', () => {
    const runtime = { orders, receipts };
    const all: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const digest = i.toString(16).repeat(64);
      decide(`po-${i}`, digest, T0 + (i % 3), acceptedAck(`po-${i}`, digest, `so-${i}`));
      all.push(`po-${i}`);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const after = cursor === null ? null : parseOrdersCursor(cursor);
      const page = listOrderDecisionEvents(runtime, { after, limit: 3 });
      if (page.events.length === 0) break;
      seen.push(...page.events.map((e) => e.purchaseOrderId));
      // Replaying the same cursor is the same page.
      expect(listOrderDecisionEvents(runtime, { after, limit: 3 }).events).toEqual(page.events);
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(7);
    expect(seen.sort()).toEqual(all.sort());
  });

  it('an accepted event carries the RETAINED order: totals, lines with the quote’s unit prices, the delivery projection; a rejection carries none', () => {
    const request = makeQuoteRequest();
    const quote = makeSignedQuote(request);
    const order = makeOrder(quote, request.delivery.projection);
    receipts.put({
      recordDigest: order.order_digest,
      domain: 'order',
      buyerDid: BUYER_DID,
      quoteId: quote.quote_id,
      purchaseOrderId: order.purchase_order_id,
      recordJson: JSON.stringify(order),
      evidenceJson: '{}',
      createdAt: T0,
    });
    receipts.put({
      recordDigest: quote.quote_digest,
      domain: 'quote',
      buyerDid: BUYER_DID,
      quoteId: quote.quote_id,
      purchaseOrderId: '',
      recordJson: JSON.stringify(quote),
      evidenceJson: '{}',
      createdAt: T0,
    });
    expect(
      orders.createReserved(
        reservedRef(order.purchase_order_id, order.order_digest, {
          quoteId: quote.quote_id,
          quoteDigest: quote.quote_digest,
        }),
      ),
    ).toBe(true);
    expect(
      loaded(order.purchase_order_id).decide({
        acknowledgementJson: acceptedAck(order.purchase_order_id, order.order_digest),
        decidedAt: T0 + 5,
      }).ok,
    ).toBe(true);
    const rejectedDigest = '1'.repeat(64);
    expect(orders.createReserved(reservedRef('po-no', rejectedDigest))).toBe(true);
    const rejectedAck = JSON.stringify(
      makeAcknowledgement({
        purchase_order_id: 'po-no',
        order_digest: rejectedDigest,
        kind: 'rejected',
        reason_code: 'quote_expired',
      }),
    );
    expect(loaded('po-no').decide({ acknowledgementJson: rejectedAck, decidedAt: T0 + 6 }).ok).toBe(
      true,
    );
    const counterDigest = '3'.repeat(64);
    expect(orders.createReserved(reservedRef('po-counter', counterDigest))).toBe(true);
    const counterAck = makeAcknowledgement({
      purchase_order_id: 'po-counter',
      order_digest: counterDigest,
      kind: 'counterproposal',
      replacement_quote: makeSignedQuote(request, {
        quote_id: 'q-counter',
        replaces_quote_digest: quote.quote_digest,
      }),
    });
    expect(
      loaded('po-counter').decide({
        acknowledgementJson: JSON.stringify(counterAck),
        decidedAt: T0 + 7,
      }).ok,
    ).toBe(true);

    const { events } = listOrderDecisionEvents({ orders, receipts }, { after: null, limit: 10 });
    expect(events.map((e) => [e.purchaseOrderId, e.decision, e.reasonCode ?? null])).toEqual([
      [order.purchase_order_id, 'accepted', null],
      ['po-no', 'rejected', 'quote_expired'],
      ['po-counter', 'rejected', 'counterproposal'],
    ]);
    const accepted = events[0];
    expect(accepted.order).toEqual({
      totals: quote.total,
      lines: [
        {
          lineId: 'l1',
          product: order.accepted_lines[0].product,
          quantity: order.accepted_lines[0].quantity,
          unitPrice: quote.lines[0].unit_price,
        },
      ],
      deliveryProjection: order.delivery,
    });
    expect(accepted.quoteDigest).toBe(quote.quote_digest);
    expect(events[1].order).toBeNull();
    // The event id is a function of the retained digests alone.
    expect(accepted.eventId).toBe(
      hashHex(
        `${order.order_digest}\n${JSON.parse(acceptedAck(order.purchase_order_id, order.order_digest)).acknowledgement_digest}`,
      ),
    );
  });

  it('respects the page limit bound the routes enforce', () => {
    for (let i = 0; i < ORDERS_EXPORT_MAX_LIMIT + 5; i += 1) {
      const digest = (i % 16).toString(16).repeat(60) + i.toString(16).padStart(4, '0');
      decide(`po-${i}`, digest, T0 + i, acceptedAck(`po-${i}`, digest, `so-${i}`));
    }
    const page = listOrderDecisionEvents(
      { orders, receipts },
      { after: null, limit: ORDERS_EXPORT_MAX_LIMIT },
    );
    expect(page.events).toHaveLength(ORDERS_EXPORT_MAX_LIMIT);
  });
});

describe('migration v46 — the grants table admits the integration scopes and keeps every row', () => {
  it('rebuilds commerce_staff_grants: old rows survive, an integration scope inserts, an unknown scope is still refused by the CHECK', () => {
    const { adapter, close } = sqliteAdapter();
    try {
      const upToV45 = IDENTITY_MIGRATIONS.filter((m) => m.version <= 45);
      applyMigrations(adapter, upToV45);
      const before = new SQLiteStaffGrantRepository(adapter);
      before.put({
        deviceDid: 'did:key:zClerk',
        scope: 'commerce_confirm',
        maxOrderMinorUnits: '',
        currency: '',
        installs: 'buyer',
        createdAt: T0,
        revokedAt: null,
      });
      expect(() =>
        before.put({
          deviceDid: DEVICE,
          scope: 'integration_status',
          maxOrderMinorUnits: '',
          currency: '',
          installs: 'supplier',
          createdAt: T0,
          revokedAt: null,
        }),
      ).toThrow();
      applyMigrations(adapter, IDENTITY_MIGRATIONS);
      const after = new SQLiteStaffGrantRepository(adapter);
      expect(after.get('did:key:zClerk', 'commerce_confirm')).toMatchObject({
        installs: 'buyer',
        revokedAt: null,
      });
      after.put({
        deviceDid: DEVICE,
        scope: 'integration_status',
        maxOrderMinorUnits: '',
        currency: '',
        installs: 'supplier',
        createdAt: T0,
        revokedAt: null,
      });
      expect(after.get(DEVICE, 'integration_status')?.scope).toBe('integration_status');
      after.put({
        deviceDid: DEVICE,
        scope: 'integration_trade_evidence',
        maxOrderMinorUnits: '',
        currency: '',
        installs: 'supplier',
        createdAt: T0,
        revokedAt: null,
      });
      expect(after.listAll().map((g) => g.scope)).toEqual([
        'commerce_confirm',
        'integration_status',
        'integration_trade_evidence',
      ]);
      expect(() =>
        adapter.run(
          `INSERT INTO commerce_staff_grants (device_did, scope, max_order_minor_units, currency, installs, created_at, revoked_at) VALUES (?, ?, '', '', 'supplier', ?, NULL)`,
          [DEVICE, 'integration_publish', T0],
        ),
      ).toThrow();
    } finally {
      close();
    }
  });
});
