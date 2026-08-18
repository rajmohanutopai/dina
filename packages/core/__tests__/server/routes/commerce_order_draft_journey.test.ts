/**
 * The buyer's photographed order, END TO END through the real routes
 * (§5.0–§5.4 stage 1): capture → §3 gate → extract → review (the §5.1
 * rows) → confirm (presence) → resolve → SEND. One journey, every gate on
 * the way — because each screen exists only to reach the next rule, and a
 * rule proven in isolation has already been the recorded failure mode.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { installCommerceRuntime, createCommerceRuntime } from '../../../src/commerce/runtime';
import { installCommerceServiceQueryDispatch } from '../../../src/commerce/buyer_sender';
import { installImageReencoder } from '../../../src/commerce/image_artifacts';
import { installImageEgressBroker } from '../../../src/commerce/image_egress';
import {
  installCommerceObserver,
  type CommerceEvent,
} from '../../../src/commerce/observability';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { makeProjection } from '../../commerce/helpers';

import type { OrderDraft } from '../../../src/commerce/order_draft_store';

const OWNER_CAP = 'test-owner-capability-secret';
const BUYER = 'did:plc:retailer00000000';
const SUPPLIER = 'did:plc:chairmaker99';

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;
let sent: { toDid: string }[];

function pngPage(seed: number): Uint8Array {
  const u32 = (v: number): number[] => [
    (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff,
  ];
  const chunk = (type: string, data: number[]): number[] => [
    ...u32(data.length),
    ...[...type].map((c) => c.charCodeAt(0)),
    ...data,
    0, 0, 0, 0,
  ];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(640), ...u32(480), 8, 6, 0, 0, 0]),
    ...chunk('IDAT', [seed, 2, 3]),
    ...chunk('IEND', []),
  ]);
}

const owner = (routePath: string, body: Record<string, unknown>): CoreRequest => ({
  method: 'POST',
  path: routePath,
  query: {},
  headers: {},
  body,
  rawBody: new Uint8Array(),
  params: {},
  trustedInProcess: true,
  callerType: 'owner',
  ownerCapability: OWNER_CAP,
});

const read = (routePath: string, query: Record<string, string>): CoreRequest => ({
  method: 'GET',
  path: routePath,
  query,
  headers: {},
  body: {},
  rawBody: new Uint8Array(),
  params: {},
  trustedInProcess: true,
  callerType: 'owner',
  ownerCapability: OWNER_CAP,
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-journey-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setNodeDID(BUYER);
  installCommerceRuntime(
    createCommerceRuntime({
      adapter,
      supplierDid: () => BUYER,
      currentEpoch: () => '1',
      now: () => Date.now(),
    }),
  );
  sent = [];
  installCommerceServiceQueryDispatch(async (args) => {
    sent.push({ toDid: args.toDid });
    return { sent: true };
  });
  installImageReencoder((bytes: Uint8Array) =>
    Promise.resolve({ bytes: pngPage(bytes[41] ?? 9), mime: 'image/png' as const }),
  );
  installImageEgressBroker({
    provider: 'openai',
    extractRows: () => {
      const rows: { page_index: number; cells: Record<string, string> }[] = [
        {
          page_index: 0,
          cells: { text: '20 dining chairs - oak', quantity: '20', required_by: '2036-08-21T00:00:00.000Z' },
        },
        { page_index: 0, cells: { text: '4ft teak benches', quantity: '6' } },
      ];
      return Promise.resolve({ rows, model: 'gpt-4o-mini' });
    },
  });
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  await proveOwnerPresence('correct horse', Date.now());
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceServiceQueryDispatch(null);
  installImageReencoder(null);
  installImageEgressBroker(null);
  installOwnerPresenceVerifier(null);
  installCommerceObserver(null);
  clearOwnerPresence();
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('the whole §5 journey: photograph → gate → review → ceremony → send', async () => {
  // §8b — every named event this journey emits, watched from the seam the
  // composition root installs a logger on.
  const observed: CommerceEvent[] = [];
  installCommerceObserver((event) => observed.push(event));

  // CAPTURE — the §6 boundary, ORDER lane, single-use authorization.
  const captured = await router.handle(
    owner('/v1/commerce/orders/drafts/photo_capture', {
      pages: [Buffer.from(pngPage(1)).toString('base64')],
    }),
  );
  expect(captured.status).toBe(200);
  const cap = captured.body as { draft_id: string; authorization_id: string };

  // EXTRACT — through the §3 gate; the draft carries the §2.1 chain and
  // EVERYTHING machine-read arrives `proposed`, including the draft-level
  // requirement the schema produced.
  const extracted = await router.handle(
    owner('/v1/commerce/orders/drafts/photo_extract', {
      draft_id: cap.draft_id,
      authorization_id: cap.authorization_id,
    }),
  );
  expect(extracted.status).toBe(200);
  const draft = (extracted.body as { draft: OrderDraft }).draft;
  expect(draft.extractionDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(draft.lines).toHaveLength(2);
  expect(draft.lines[0]?.provenance.quantity).toBe('proposed');
  expect(draft.requirements).toEqual([
    expect.objectContaining({ key: 'required_by', kind: 'transmitted', provenance: 'proposed' }),
  ]);

  // CONFIRM before review refuses — the gates hold in order.
  const early = await router.handle(
    owner('/v1/commerce/orders/drafts/confirm', { draft_id: cap.draft_id }),
  );
  expect(early.status).toBe(409);

  // REVIEW — repair one quantity (the epigraph's "I wrote 20, not 200"
  // in reverse), accept the other, resolve both lines, decide the date.
  const repaired = await router.handle(
    owner('/v1/commerce/orders/drafts/line/repair', {
      draft_id: cap.draft_id,
      line_id: 'line_1',
      field: 'quantity',
      value: '22',
    }),
  );
  expect(repaired.status).toBe(200);
  const accepted = await router.handle(
    owner('/v1/commerce/orders/drafts/accept_fields', {
      draft_id: cap.draft_id,
      refs: [{ line_id: 'line_2', field: 'quantity' }],
    }),
  );
  expect(accepted.status).toBe(200);
  for (const [lineId, sku, snake] of [
    ['line_1', 'CM-CHAIR-1', false],
    // line_2 uses the SNAKE_CASE wire spelling — the §9.13 convention a
    // hand-written or ported client follows; the route normalizes it.
    ['line_2', 'CM-BENCH-2', true],
  ] as const) {
    const resolution = snake
      ? {
          kind: 'resolved',
          product: { scheme: 'manufacturer_sku', value: sku, issuer_did: SUPPLIER },
          supplier_did: SUPPLIER,
          flagged_new_supplier: false,
        }
      : {
          kind: 'resolved',
          product: { scheme: 'manufacturer_sku', value: sku, issuer_did: SUPPLIER },
          supplierDid: SUPPLIER,
          flaggedNewSupplier: false,
        };
    const resolved = await router.handle(
      owner('/v1/commerce/orders/drafts/line/resolve', {
        draft_id: cap.draft_id,
        line_id: lineId,
        resolution,
      }),
    );
    expect(resolved.status).toBe(200);
  }
  const dated = await router.handle(
    owner('/v1/commerce/orders/drafts/requirement', {
      draft_id: cap.draft_id,
      key: 'required_by',
      action: 'accept',
    }),
  );
  expect(dated.status).toBe(200);

  // CONFIRM — the §5.3 ceremony: the batch receipt commits the extraction
  // digest and every included line's vouch entry updates to it.
  const confirmed = await router.handle(
    owner('/v1/commerce/orders/drafts/confirm', { draft_id: cap.draft_id }),
  );
  expect(confirmed.status).toBe(200);
  const vouched = (confirmed.body as { draft: OrderDraft }).draft;
  expect(vouched.ceremonyCounter).toBe(1);
  expect(vouched.lines.every((l) => l.vouch !== null)).toBe(true);

  // SEND — the §5.1 send gate passes because every carried decision was
  // made; the request leaves for the supplier both lines resolved to.
  const sentResp = await router.handle(
    owner('/v1/commerce/orders/drafts/request-quote', {
      draft_id: cap.draft_id,
      supplier_did: SUPPLIER,
      projection: makeProjection(),
    }),
  );
  expect(sentResp.status).toBe(200);
  expect(sent).toEqual([{ toDid: SUPPLIER }]);

  // The read seam the screens live on sees all of it.
  const listed = await router.handle(read('/v1/commerce/orders/drafts', {}));
  expect(
    (listed.body as { drafts: { draft_id: string; state: string }[] }).drafts,
  ).toEqual([
    expect.objectContaining({ draft_id: cap.draft_id, state: 'awaiting_answers' }),
  ]);

  // §8b — the named events, in journey order, METADATA ONLY: the serialized
  // stream must not carry a single extracted value, quantity or fragment of
  // photographed text — the PII-never-in-logs rule, proven on the wire the
  // logger reads.
  expect(observed.map((e) => e.event)).toEqual([
    'photo_capture',
    'egress_authorization',
    'extraction',
    'confirm',
    'send',
  ]);
  const serialized = JSON.stringify(observed);
  for (const fragment of ['dining chairs', 'teak benches', '2036-08-21', 'CM-CHAIR-1']) {
    expect(serialized).not.toContain(fragment);
  }
});

it('a batch tap cannot vouch a quantity nobody looked at — the epigraph, enforced', async () => {
  const captured = await router.handle(
    owner('/v1/commerce/orders/drafts/photo_capture', {
      pages: [Buffer.from(pngPage(3)).toString('base64')],
    }),
  );
  const cap = captured.body as { draft_id: string; authorization_id: string };
  await router.handle(
    owner('/v1/commerce/orders/drafts/photo_extract', {
      draft_id: cap.draft_id,
      authorization_id: cap.authorization_id,
    }),
  );
  // Resolve WITHOUT deciding the proposed quantities, then confirm.
  await router.handle(
    owner('/v1/commerce/orders/drafts/line/resolve', {
      draft_id: cap.draft_id,
      line_id: 'line_1',
      resolution: {
        kind: 'resolved',
        product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER },
        supplierDid: SUPPLIER,
        flaggedNewSupplier: false,
      },
    }),
  );
  const confirmed = await router.handle(
    owner('/v1/commerce/orders/drafts/confirm', { draft_id: cap.draft_id }),
  );
  expect(confirmed.status).toBe(409);
  expect((confirmed.body as { error: string }).error).toBe('unconfirmed_fields');
});

it('abandon erases the photographs with the draft — §6 erasure follows ownership', async () => {
  const captured = await router.handle(
    owner('/v1/commerce/orders/drafts/photo_capture', {
      pages: [Buffer.from(pngPage(5)).toString('base64')],
    }),
  );
  const cap = captured.body as {
    draft_id: string;
    authorization_id: string;
    manifest: { artifact_id: string }[];
  };
  await router.handle(
    owner('/v1/commerce/orders/drafts/photo_extract', {
      draft_id: cap.draft_id,
      authorization_id: cap.authorization_id,
    }),
  );
  const gone = await router.handle(
    owner('/v1/commerce/orders/drafts/abandon', { draft_id: cap.draft_id }),
  );
  expect(gone.status).toBe(200);
  const runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => BUYER,
    currentEpoch: () => '1',
    now: () => Date.now(),
  });
  expect(runtime.imageArtifacts.listByDraft(cap.draft_id)).toEqual([]);
});
