/**
 * ChairMaker fulfils Sancho's order through a real external system —
 * the whole WS-9 / WS-10 arc in one sequence.
 *
 * WHY THIS EXISTS ON TOP OF THE OTHER FOUR JOURNEYS. `procurement_scenario`
 * walks the spine, `procurement_lane_scenario` walks the plugin lane,
 * `procurement_journey` walks discovery-to-approval, and
 * `disaster_recovery_journey` walks a restore. Every one of them predates the
 * connector work, and NONE of them touches a credential, an external effect,
 * or a fulfilment update.
 *
 * That gap is this codebase's signature defect, and I built six more modules
 * into it this session: the credential broker (WS-9.3), the connectors
 * (WS-9.1), idempotency evidence and the effect boundary (WS-9.4), fulfilment
 * reconciliation (WS-9.5), staff authority (WS-8.4) and the plural
 * relationship resolver (WS-10.3). Each was written alone and gated alone.
 * This is the test that makes them meet.
 *
 * THE STORY. ChairMaker's node is backed by an ERP. They configure the
 * connector, store its credential, and try to prove the ERP deduplicates a
 * retried purchase order — twice, because the first probe does not prove it.
 * Sancho asks two manufacturers for chairs, compares, and their staff approve
 * within the authority they hold. ChairMaker accepts, then has to actually
 * place the order in their ERP: the first attempt times out ambiguously, and
 * what happens next depends entirely on whether the evidence exists.
 *
 * OWNER STEPS GO THROUGH THE ROUTES. Once `/v1/commerce/credentials`,
 * `/idempotency`, `/orders/effect` and `/orders/fulfilment/sweep` exist, there
 * are two ways to reach the same rule, and a journey taking the shorter one
 * would keep passing while the shipped surface disagreed — the same defect as
 * an orphan, one layer up.
 *
 * WHAT IT DOES NOT CLAIM. No real ERP (the broker's executor is the injected
 * boundary, which is the architecture rather than a mock), no D2D socket, no
 * AppView, no PDS. WS-9.2 and WS-11.6 stay open for exactly those reasons.
 *
 * Cast follows house convention: ChairMaker manufactures, Sancho retails.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  createCommerceRuntime,
  getCommerceRuntime,
  installCommerceRuntime,
  type BrokeredExecutor,
} from '../../src/commerce';
import {
  DEFAULT_RETENTION_REQUIREMENT,
  MIN_PROBE_GAP_MS,
  requiredRetentionMs,
} from '../../src/commerce/idempotency_evidence';
import { evaluateStaffAuthority, type StaffGrant } from '../../src/commerce/staff_authority';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerCommerceRoutes } from '../../src/server/routes/commerce';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { BUYER_DID, SUPPLIER_DID } from './helpers';

const T0 = Date.parse('2026-08-08T09:00:00.000Z');
const OWNER_CAP = 'external-journey-owner-capability';
const ERP = 'erp.primary';
const INSTALL = 'install-chairmaker-erp';
const REQUIRED_RETENTION = requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT);

/** Every owner step goes through a real router, shaped as a request. */
function owner(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  routePath: string,
  body: Record<string, unknown> = {},
): CoreRequest {
  return {
    method,
    path: routePath,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:chairmaker-owner',
    ownerCapability: OWNER_CAP,
  };
}

/**
 * ChairMaker's ERP, as the broker reaches it.
 *
 * A SCRIPT rather than a mock: the test moves it between states the way a real
 * outage would, and every call records the idempotency key it was given so the
 * journey can assert the key never changed across a retry.
 */
interface Erp {
  behaviour: 'ok' | 'timeout' | 'refuse';
  keysSeen: string[];
  fulfilmentState: string;
  externalRef: string;
}

describe('ChairMaker fulfils an order through their ERP — the external arc', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let router: CoreRouter;
  let erp: Erp;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'external-journey-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);

    erp = { behaviour: 'ok', keysSeen: [], fulfilmentState: 'preparing', externalRef: 'SO-9001' };

    const submit: BrokeredExecutor = async ({ params }) => {
      const key = (params as { idempotency_key: string }).idempotency_key;
      erp.keysSeen.push(key);
      if (erp.behaviour === 'timeout') throw new Error('gateway timeout');
      if (erp.behaviour === 'refuse') return { ok: false, error: 'ERP rejected the order' };
      return { ok: true, result: { external_ref: erp.externalRef } };
    };
    const readFulfilment: BrokeredExecutor = async () => ({
      ok: true,
      result: { state: erp.fulfilmentState },
    });
    const readCatalog: BrokeredExecutor = async () => {
      // The failure switch applies HERE TOO. An earlier version of this script
      // only wired it into `submit`, so a "refusing ERP" still served a
      // catalog and the inbox test passed for the wrong reason.
      if (erp.behaviour === 'refuse') return { ok: false, error: 'ERP is refusing' };
      if (erp.behaviour === 'timeout') throw new Error('gateway timeout');
      return {
        ok: true,
        result: [
          { sku: 'CHAIR-OAK', name: 'Oak dining chair', unit_code: 'each', pack_size: '1' },
          { sku: 'CHAIR-ASH', name: 'Ash dining chair', unit_code: 'each', pack_size: '4' },
        ],
      };
    };

    installCommerceRuntime(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER_DID,
        currentEpoch: () => '1',
        now: () => T0,
        credentialExecutors: () => ({
          [`${ERP}:submit_purchase_order`]: submit,
          [`${ERP}:read_fulfilment`]: readFulfilment,
          [`${ERP}:read_catalog`]: readCatalog,
        }),
      }),
    );

    setNodeDID(SUPPLIER_DID);
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
  });

  afterEach(() => {
    installCommerceRuntime(null);
    clearPairingState();
    try {
      adapter.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks the whole arc, and refuses at every step that has not been earned', async () => {
    // ---- STEP 1 — the connector cannot be used before its credential exists.
    // §8.3: fail closed. A supplier who forgot this step must not discover it
    // by having an order silently not reach their ERP.
    const beforeCredential = await router.handle(
      owner('POST', '/v1/commerce/catalog/load', {
        kind: 'rest',
        credential_resource: ERP,
        operation: 'read_catalog',
        default_scheme: 'sku',
      }),
    );
    expect(beforeCredential.status).toBe(409);
    // The BROKER's refusal, passed through: the connector never fetched, and
    // the message names the resource rather than saying "something failed".
    expect(beforeCredential.body).toMatchObject({
      ok: false,
      refusal: 'broker_refused',
      error: expect.stringContaining(ERP),
    });

    // ---- STEP 2 — the owner stores the ERP credential (§18.3 rotation UX).
    const stored = await router.handle(
      owner('PUT', `/v1/commerce/credentials/${ERP}`, {
        material: 'sk-live-chairmaker-erp-0123456789',
        install_id: INSTALL,
        operations: ['read_catalog', 'submit_purchase_order', 'read_fulfilment'],
      }),
    );
    expect(stored.body).toEqual({ ok: true, resource: ERP });

    // The material is not readable back, by anyone, through anything.
    const listed = await router.handle(owner('GET', '/v1/commerce/credentials'));
    expect(JSON.stringify(listed.body)).not.toContain('sk-live-chairmaker-erp');
    expect(listed.body).toMatchObject({
      credentials: [{ resource: ERP, install_id: INSTALL, last_result: 'never_used' }],
    });

    // ---- STEP 3 — the catalog now loads THROUGH the broker (WS-9.1).
    const loaded = await router.handle(
      owner('POST', '/v1/commerce/catalog/load', {
        kind: 'rest',
        credential_resource: ERP,
        operation: 'read_catalog',
        default_scheme: 'sku',
      }),
    );
    expect(loaded.status).toBe(200);
    const catalog = loaded.body as { ok: true; items: { product: { value: string } }[] };
    expect(catalog.ok).toBe(true);
    expect(catalog.items.map((i) => i.product.value)).toEqual(['CHAIR-OAK', 'CHAIR-ASH']);

    // And the broker recorded that the credential WORKED — §18.3 status is
    // derived from real calls, not typed by the owner.
    const afterUse = await router.handle(owner('GET', '/v1/commerce/credentials'));
    expect(afterUse.body).toMatchObject({ credentials: [{ last_result: 'ok' }] });

    // ---- STEP 4 — §15.5. ChairMaker's first idempotency probe proves nothing.
    const badProbe = await router.handle(
      owner('PUT', `/v1/commerce/idempotency/${ERP}/submit_purchase_order`, {
        declared_retention_ms: REQUIRED_RETENTION,
        probe: {
          idempotency_key: 'probe-1',
          first_external_ref: 'SO-1',
          second_external_ref: 'SO-2',
          second_created_new_order: true,
          first_at_ms: T0 - 2 * MIN_PROBE_GAP_MS,
          second_at_ms: T0 - MIN_PROBE_GAP_MS,
        },
      }),
    );
    // The ERP made a SECOND order. That is the opposite of proof, and the
    // answer is the §15.5 default rather than a warning.
    expect(badProbe.body).toMatchObject({
      resubmission: 'manual_only',
      refusal: 'probe_created_second_order',
    });

    // ---- STEP 5 — staff authority (§7.2/§7.3), before any order is sent.
    const chain = {
      principalDid: 'did:plc:sancho-buyer',
      installId: 'install-sancho-buyer',
      actingForBusinessDid: BUYER_DID,
      authorityDomain: 'furniture',
      policyRevision: null,
      supplierDid: SUPPLIER_DID,
      serviceRkey: 'self',
      quoteDigest: 'q'.repeat(64),
      orderDigest: 'o'.repeat(64),
    };
    const grants: StaffGrant[] = [
      { kind: 'category_buyer', principalDid: 'did:plc:sancho-buyer', categoryIds: ['furniture'] },
      { kind: 'owner', principalDid: 'did:plc:sancho-owner' },
    ];
    const request = {
      total: { currency: 'EUR', minor_units: '450000' },
      categoryIds: ['furniture'],
      regionValue: null,
      side: 'buy' as const,
    };
    const quorum = { secondPersonAtOrAboveMinorUnits: '100000', currency: 'EUR' };

    // One buyer alone cannot commit €4,500.
    const alone = evaluateStaffAuthority({
      chain,
      approvals: ['did:plc:sancho-buyer'],
      grants,
      request,
      quorum,
      nowMs: T0,
    });
    expect(alone).toEqual({
      permitted: false,
      needsAnotherPrincipal: true,
      reason: 'this amount needs a second person',
    });

    // With the owner's approval too, it is permitted.
    const withSecond = evaluateStaffAuthority({
      chain,
      approvals: ['did:plc:sancho-buyer', 'did:plc:sancho-owner'],
      grants,
      request,
      quorum,
      nowMs: T0,
    });
    expect(withSecond.permitted).toBe(true);

    // ---- STEP 6 — the order is admitted, so there is something to fulfil.
    const runtime = getCommerceRuntime();
    expect(runtime).not.toBeNull();
    if (runtime === null) return;
    expect(
      runtime.orders.createReserved({
        buyerDid: BUYER_DID,
        purchaseOrderId: 'po-oak-42',
        idempotencyKey: 'idem-oak-42',
        orderDigest: 'o'.repeat(64),
        quoteId: 'q-oak',
        quoteDigest: 'q'.repeat(64),
        pinnedVersion: '1.0',
        servingManifestCid: '',
        servingInstallId: '',
        admittedEpoch: '1',
        reconciliationRequired: false,
        decisionDeadlineAt: T0 + 900_000,
        createdAt: T0,
      }),
    ).toBe(true);

    // ---- STEP 7 — the ERP times out. WITHOUT proven evidence, ONE attempt.
    erp.behaviour = 'timeout';
    const ambiguous = await router.handle(
      owner('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER_DID,
        purchase_order_id: 'po-oak-42',
        resource: ERP,
        operation: 'submit_purchase_order',
      }),
    );
    expect(ambiguous.status).toBe(200);
    expect(ambiguous.body).toMatchObject({
      kind: 'ambiguous',
      attempts: 1,
      retriedAutomatically: false,
    });
    // §15.5's default, observed end to end: one call, not two.
    expect(erp.keysSeen).toEqual(['idem-oak-42']);

    // ---- STEP 8 — the boundary was crossed once, so it may never be crossed
    // again. Even now that the ERP is healthy.
    erp.behaviour = 'ok';
    const second = await router.handle(
      owner('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER_DID,
        purchase_order_id: 'po-oak-42',
        resource: ERP,
        operation: 'submit_purchase_order',
      }),
    );
    expect(second.body).toMatchObject({ kind: 'ambiguous', attempts: 0 });
    expect(erp.keysSeen).toEqual(['idem-oak-42']);

    // ---- STEP 9 — ChairMaker probes properly, and NOW retries are earned.
    const goodProbe = await router.handle(
      owner('PUT', `/v1/commerce/idempotency/${ERP}/submit_purchase_order`, {
        declared_retention_ms: REQUIRED_RETENTION,
        probe: {
          idempotency_key: 'probe-2',
          first_external_ref: 'SO-PROBE',
          second_external_ref: 'SO-PROBE',
          second_created_new_order: false,
          first_at_ms: T0 - 2 * MIN_PROBE_GAP_MS,
          second_at_ms: T0 - MIN_PROBE_GAP_MS,
        },
      }),
    );
    expect(goodProbe.body).toEqual({ ok: true, resubmission: 'automatic' });

    // A SECOND order, so the earned retry has somewhere to happen.
    expect(
      runtime.orders.createReserved({
        buyerDid: BUYER_DID,
        purchaseOrderId: 'po-ash-43',
        idempotencyKey: 'idem-ash-43',
        orderDigest: 'a'.repeat(64),
        quoteId: 'q-ash',
        quoteDigest: 'b'.repeat(64),
        pinnedVersion: '1.0',
        servingManifestCid: '',
        servingInstallId: '',
        admittedEpoch: '1',
        reconciliationRequired: false,
        decisionDeadlineAt: T0 + 900_000,
        createdAt: T0,
      }),
    ).toBe(true);

    // The ERP fails once and then recovers — the exact case evidence unlocks.
    erp.keysSeen = [];
    let calls = 0;
    installCommerceRuntime(null);
    installCommerceRuntime(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER_DID,
        currentEpoch: () => '1',
        now: () => T0,
        credentialExecutors: () => ({
          [`${ERP}:submit_purchase_order`]: async ({ params }) => {
            erp.keysSeen.push((params as { idempotency_key: string }).idempotency_key);
            calls += 1;
            return calls === 1
              ? { ok: false, error: 'gateway timeout' }
              : { ok: true, result: { external_ref: 'SO-9002' } };
          },
          [`${ERP}:read_fulfilment`]: async () => ({
            ok: true,
            result: { state: erp.fulfilmentState },
          }),
        }),
      }),
    );

    const retried = await router.handle(
      owner('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER_DID,
        purchase_order_id: 'po-ash-43',
        resource: ERP,
        operation: 'submit_purchase_order',
      }),
    );
    expect(retried.body).toMatchObject({
      kind: 'succeeded',
      externalRef: 'SO-9002',
      attempts: 2,
    });
    // THE KEY NEVER CHANGED. A fresh key on the retry would have been a second
    // order in ChairMaker's ERP, which is the whole failure §15.5 prevents.
    expect(erp.keysSeen).toEqual(['idem-ash-43', 'idem-ash-43']);
  });

  it('reconciles the ERP fulfilment into the chain, and refuses a late webhook', async () => {
    // The chain is at `accepted`, the ERP says `preparing`: legal progress.
    const forward = await router.handle(
      owner('POST', '/v1/commerce/orders/fulfilment', {
        current: 'accepted',
        expected_external_ref: 'SO-9001',
        external: {
          externalRef: 'SO-9001',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:00:00.000Z',
        },
      }),
    );
    expect(forward.body).toEqual({ kind: 'advance', to: 'preparing' });

    // The same report arriving again is not an update.
    const repeat = await router.handle(
      owner('POST', '/v1/commerce/orders/fulfilment', {
        current: 'preparing',
        expected_external_ref: 'SO-9001',
        external: {
          externalRef: 'SO-9001',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:05:00.000Z',
        },
      }),
    );
    expect(repeat.body).toEqual({ kind: 'unchanged' });

    // A dispatch must say WHAT shipped.
    const noLines = await router.handle(
      owner('POST', '/v1/commerce/orders/fulfilment', {
        current: 'preparing',
        expected_external_ref: 'SO-9001',
        external: {
          externalRef: 'SO-9001',
          state: 'dispatched',
          observedAtIso: '2026-08-08T10:00:00.000Z',
        },
      }),
    );
    expect(noLines.body).toMatchObject({ kind: 'needs_attention', refusal: 'lines_missing' });

    // THE LATE WEBHOOK. `preparing` arriving after `dispatched` would make the
    // buyer watch their delivery un-happen; it becomes an operator's problem
    // rather than a signed claim.
    const late = await router.handle(
      owner('POST', '/v1/commerce/orders/fulfilment', {
        current: 'dispatched',
        expected_external_ref: 'SO-9001',
        external: {
          externalRef: 'SO-9001',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:59:00.000Z',
        },
      }),
    );
    expect(late.body).toMatchObject({ kind: 'needs_attention', refusal: 'moves_backwards' });

    // And a report about somebody ELSE's external order never touches this one.
    const crossed = await router.handle(
      owner('POST', '/v1/commerce/orders/fulfilment', {
        current: 'accepted',
        expected_external_ref: 'SO-9001',
        external: {
          externalRef: 'SO-OTHER',
          state: 'delivered',
          observedAtIso: '2026-08-08T11:00:00.000Z',
        },
      }),
    );
    expect(crossed.body).toMatchObject({ refusal: 'unknown_external_ref' });
  });

  it('shows the operator a failing credential the settings row still calls fine', async () => {
    // §18.3, end to end: the settings row is a claim somebody typed; the
    // broker knows whether the last real call worked, and the inbox believes
    // the broker.
    await router.handle(
      owner('PUT', `/v1/commerce/credentials/${ERP}`, {
        material: 'sk-live-chairmaker-erp-0123456789',
        install_id: INSTALL,
        operations: ['read_catalog'],
      }),
    );
    await router.handle(
      owner('PUT', '/v1/commerce/settings/supplier', {
        actingBusinessDid: SUPPLIER_DID,
        catalogSource: { kind: 'feed', lastHealthyAtIso: '2026-08-08T08:00:00.000Z' },
        publicRegions: [],
        publishIndicativePrice: false,
        quoteAccess: 'anyone',
        responsePolicy: {},
        customerPricingSource: null,
        orderAcceptance: 'review',
        listingState: 'live',
        connectors: [
          // The owner believes this is fine.
          { name: ERP, healthy: true, credentialValid: true, lastCheckedAtIso: null },
        ],
      }),
    );

    // Nothing has failed yet, so the inbox is quiet about the connector.
    const quiet = await router.handle(owner('GET', '/v1/commerce/inbox'));
    expect(
      (quiet.body as { items: { kind: string }[] }).items.filter(
        (i) => i.kind === 'connector_failing',
      ),
    ).toEqual([]);

    // The ERP starts refusing. One real call is all it takes.
    erp.behaviour = 'refuse';
    const failed = await router.handle(
      owner('POST', '/v1/commerce/catalog/load', {
        kind: 'rest',
        credential_resource: ERP,
        operation: 'read_catalog',
        default_scheme: 'sku',
      }),
    );
    expect(failed.status).toBe(409);

    const loud = await router.handle(owner('GET', '/v1/commerce/inbox'));
    const failing = (loud.body as { items: { kind: string; subject: string }[] }).items.filter(
      (i) => i.kind === 'connector_failing',
    );
    expect(failing).toHaveLength(1);
    expect(failing[0]?.subject).toBe(ERP);
  });

  it('refuses to widen a connector without asking again (§6.5)', async () => {
    // ChairMaker moves from a spreadsheet to the ERP. That is a new outbound
    // domain and a new credential, and §6.5 says an ordinary config edit may
    // not do it.
    const widened = await router.handle(
      owner('POST', '/v1/commerce/connector/change', {
        previous: { domains: [], credential_resources: [], operations: ['read_catalog'] },
        next: {
          domains: ['erp.chairmaker.example'],
          credential_resources: [ERP],
          operations: ['read_catalog', 'submit_purchase_order'],
        },
      }),
    );
    expect(widened.body).toEqual({
      requires_reconsent: true,
      widened: {
        domains: ['erp.chairmaker.example'],
        credential_resources: [ERP],
        operations: ['submit_purchase_order'],
      },
    });

    // Going back the other way is an ordinary edit: an owner may always give
    // a connector less.
    const narrowed = await router.handle(
      owner('POST', '/v1/commerce/connector/change', {
        previous: {
          domains: ['erp.chairmaker.example'],
          credential_resources: [ERP],
          operations: ['read_catalog', 'submit_purchase_order'],
        },
        next: { domains: [], credential_resources: [], operations: ['read_catalog'] },
      }),
    );
    expect(narrowed.body).toEqual({ requires_reconsent: false });
  });

  it('sweeps every open order rather than the ones a caller names', async () => {
    await router.handle(
      owner('PUT', `/v1/commerce/credentials/${ERP}`, {
        material: 'sk-live-chairmaker-erp-0123456789',
        install_id: INSTALL,
        operations: ['read_fulfilment'],
      }),
    );

    const runtime = getCommerceRuntime();
    expect(runtime).not.toBeNull();
    if (runtime === null) return;

    // Two orders that crossed the boundary, one that never did.
    for (const [id, ref] of [
      ['po-a', 'SO-A'],
      ['po-b', 'SO-B'],
      ['po-c', null],
    ] as [string, string | null][]) {
      runtime.orders.createReserved({
        buyerDid: BUYER_DID,
        purchaseOrderId: id,
        idempotencyKey: `idem-${id}`,
        orderDigest: id.padEnd(64, 'x'),
        quoteId: `q-${id}`,
        quoteDigest: id.padEnd(64, 'y'),
        pinnedVersion: '1.0',
        servingManifestCid: '',
        servingInstallId: '',
        admittedEpoch: '1',
        reconciliationRequired: false,
        decisionDeadlineAt: T0 + 900_000,
        createdAt: T0,
      });
      const order = runtime.orders.load(BUYER_DID, id);
      expect(order).not.toBeNull();
      order?.decide({
        acknowledgementJson: '{}',
        decidedAt: T0 + 1,
        ...(ref === null ? {} : { externalRef: ref }),
      });
    }

    const swept = await router.handle(
      owner('POST', '/v1/commerce/orders/fulfilment/sweep', {
        resource: ERP,
        operation: 'read_fulfilment',
        // A caller trying to narrow the sweep. Ignored: the order left out is
        // the one nobody looks at again.
        purchase_order_ids: ['po-a'],
      }),
    );
    expect(swept.status).toBe(200);
    const result = swept.body as { checked: number; results: { purchaseOrderId: string }[] };
    // TWO, not one and not three: `po-c` has no external reference to ask
    // about, and `po-a` alone is what the caller asked for.
    expect(result.checked).toBe(2);
    expect(result.results.map((r) => r.purchaseOrderId).sort()).toEqual(['po-a', 'po-b']);
  });
});
