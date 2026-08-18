/**
 * §5.4 stage 1 — the draft-scoped send route and its SEND GATE (§5.1's
 * send row): nothing machine-read reaches a supplier unvouched, one
 * identity fills both wire fields, and the conversation snapshot is
 * immutable evidence of what this request meant.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { conversationSnapshotDigest } from '@dina/commerce-protocol';

import { installCommerceRuntime, createCommerceRuntime } from '../../../src/commerce/runtime';
import { installCommerceServiceQueryDispatch } from '../../../src/commerce/buyer_sender';
import {
  type OrderDraft,
  type OrderDraftLine,
} from '../../../src/commerce/order_draft_store';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { makeProjection } from '../../commerce/helpers';

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';
const BUYER = 'did:plc:retailer00000000';
const T0 = 1_800_000_000_000;
const hash = (data: Uint8Array): Uint8Array => sha256(data);

let dir: string;
let adapter: NodeSQLiteAdapter;
let router: CoreRouter;
let sent: { toDid: string; body: Record<string, unknown> }[];

function vouchedLine(overrides: Partial<OrderDraftLine> = {}): OrderDraftLine {
  return {
    lineId: 'line-1',
    text: '20 dining chairs - oak',
    pageIndex: 0,
    fields: { quantity: '20' },
    provenance: { quantity: 'accepted' },
    resolution: {
      kind: 'resolved',
      product: { scheme: 'manufacturer_sku', value: 'CM-CHAIR-1', issuer_did: SUPPLIER },
      supplierDid: SUPPLIER,
      flaggedNewSupplier: false,
    },
    generation: 1,
    assignmentGeneration: 0,
    vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
    deferred: false,
    evidence: null,
    submittedIn: null,
    ...overrides,
  };
}

function seedDraft(overrides: Partial<OrderDraft> = {}): void {
  const runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => BUYER,
    currentEpoch: () => '2',
    now: () => T0,
  });
  runtime.orderDrafts.put({
    draftId: 'odr-1',
    manifest: [{ artifact_id: 'img-1', content_hash: 'a'.repeat(64), page_index: 0 }],
    extraction: { model: 'gpt-4o-mini', schemaVersion: 'order-lines-1' },
    extractionDigest: 'a'.repeat(64),
    lines: [vouchedLine()],
    requirements: [
      {
        key: 'required_by',
        kind: 'transmitted',
        value: '2026-08-21T00:00:00.000Z',
        omitted: false,
        provenance: 'accepted',
        generation: 1,
        vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null },
      },
    ],
    conversations: [],
    ceremonyCounter: 1,
    abandoned: false,
    createdAtMs: T0,
    updatedAtMs: T0,
    ...overrides,
  });
  installCommerceRuntime(runtime);
}

const owner = (body: Record<string, unknown>): CoreRequest => ({
  method: 'POST',
  path: '/v1/commerce/orders/drafts/request-quote',
  query: {},
  headers: {},
  body,
  rawBody: new Uint8Array(),
  params: {},
  trustedInProcess: true,
  callerType: 'owner',
  ownerCapability: OWNER_CAP,
});

function sendBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draft_id: 'odr-1',
    supplier_did: SUPPLIER,
    projection: makeProjection(),
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-send-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  setNodeDID(BUYER);
  sent = [];
  installCommerceServiceQueryDispatch(async (args) => {
    sent.push({ toDid: args.toDid, body: args.body as unknown as Record<string, unknown> });
    return { sent: true };
  });
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceServiceQueryDispatch(null);
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('sends: ONE identity in both wire fields, and the snapshot recomputes', async () => {
  seedDraft();
  const resp = await router.handle(owner(sendBody()));
  expect(resp.status).toBe(200);
  const answer = resp.body as {
    conversation_id: string;
    request_id: string;
    request_digest: string;
    snapshot_digest: string;
  };
  // The dispatched request carries the SAME identity in both fields —
  // a design naming only one leaves the other to be invented at a keyboard.
  expect(sent.length).toBe(1);
  const params = sent[0]?.body.params as { request_id: string; idempotency_key: string };
  expect(params.request_id).toBe(answer.request_id);
  expect(params.idempotency_key).toBe(answer.request_id);

  // The conversation is durable, SENT, and its snapshot digest recomputes
  // through the frozen §2.1 function from what the draft now holds.
  const runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => BUYER,
    currentEpoch: () => '2',
    now: () => T0,
  });
  const draft = runtime.orderDrafts.get('odr-1');
  const conversation = draft?.conversations[0];
  expect(conversation?.state).toBe('sent');
  expect(conversation?.requestId).toBe(answer.request_id);
  if (conversation?.snapshot != null) {
    expect(conversationSnapshotDigest(conversation.snapshot, hash)).toBe(answer.snapshot_digest);
  } else {
    throw new Error('no snapshot retained');
  }
});

it('THE SEND GATE: an unvouched line refuses, named', async () => {
  seedDraft({ lines: [vouchedLine({ vouch: null })] });
  const resp = await router.handle(owner(sendBody()));
  expect(resp.status).toBe(409);
  expect(resp.body).toMatchObject({ error: 'unvouched_lines', lines: ['line-1'] });
  expect(sent.length).toBe(0);
});

it('THE SEND GATE: a vouch at a STALE generation is not a vouch', async () => {
  seedDraft({
    lines: [vouchedLine({ generation: 2, vouch: { generation: 1, ceremony: 1, receiptDigest: 'b'.repeat(64), vouchedBy: null } })],
  });
  const resp = await router.handle(owner(sendBody()));
  expect(resp.status).toBe(409);
  expect((resp.body as { error: string }).error).toBe('unvouched_lines');
  expect(sent.length).toBe(0);
});

it('THE SEND GATE: a model-derived field still proposed blocks the send', async () => {
  seedDraft({
    lines: [vouchedLine({ provenance: { quantity: 'proposed' } })],
  });
  const resp = await router.handle(owner(sendBody()));
  expect(resp.status).toBe(409);
  expect(sent.length).toBe(0);
});

it('THE SEND GATE: an undecided DRAFT-LOCAL requirement blocks — never transmitted, still reviewed', async () => {
  seedDraft({
    requirements: [
      {
        key: 'instruction',
        kind: 'draft_local',
        value: 'back entrance',
        omitted: false,
        provenance: 'proposed',
        generation: 1,
        vouch: null,
      },
    ],
  });
  const resp = await router.handle(owner(sendBody()));
  expect(resp.status).toBe(409);
  expect(resp.body).toMatchObject({ error: 'unvouched_requirement', key: 'instruction' });
  expect(sent.length).toBe(0);
});

it('ONE LIVE CONVERSATION per supplier: a second send waits', async () => {
  seedDraft();
  expect((await router.handle(owner(sendBody()))).status).toBe(200);
  const second = await router.handle(owner(sendBody()));
  expect(second.status).toBe(409);
  expect((second.body as { error: string }).error).toBe('conversation_in_flight');
  expect(sent.length).toBe(1);
});

it('a supplier no line resolves to has nothing to ask', async () => {
  seedDraft();
  const resp = await router.handle(
    owner(sendBody({ supplier_did: 'did:plc:someoneelse0000' })),
  );
  expect(resp.status).toBe(409);
  expect((resp.body as { error: string }).error).toBe('no_lines_for_supplier');
});
