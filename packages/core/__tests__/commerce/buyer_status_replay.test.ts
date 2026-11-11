/**
 * A status chain arriving through the response lane, replayed and overlapping
 * (docs/STATE_MACHINES.md COM-11, COM-12). Real SQLite.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { commerceRecordDigest } from '@dina/commerce-protocol';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { newBuyerOrder } from '../../src/commerce/buyer_reconciliation';
import { applyInboundBuyerResponse } from '../../src/commerce/buyer_response';
import {
  createCommerceRuntime,
  installCommerceRuntime,
  type CommerceRuntime,
} from '../../src/commerce/runtime';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

import { BUYER_DID, hash, makeAcknowledgement } from './helpers';

const SUPPLIER = 'did:plc:chair';
const PO = 'po-s';

let dir: string;
let adapter: NodeSQLiteAdapter;
let runtime: CommerceRuntime;

const sign = (
  fields: Record<string, unknown>,
): Record<string, unknown> & { status_digest: string } => {
  const base = {
    protocol_version: '1.0',
    purchase_order_id: PO,
    buyer_did: BUYER_DID,
    supplier_did: SUPPLIER,
    sequence: '0',
    state: 'accepted',
    supplier_epoch: '1',
    updated_at: '2026-08-01T09:00:00.000Z',
    ...fields,
  };
  return { ...base, status_digest: commerceRecordDigest('status', base as never, hash) };
};
const s0 = sign({});
const s1 = sign({ sequence: '1', state: 'preparing', previous_status_digest: s0.status_digest });
const s2 = sign({ sequence: '2', state: 'cancelled', previous_status_digest: s1.status_digest });

const envelope = (id: string): Record<string, unknown> => ({
  envelopeId: id,
  signature: 'ab',
  envelope: {
    id,
    type: 'service.response',
    from: SUPPLIER,
    to: [BUYER_DID],
    created_time: 1,
    body: '{}',
  },
});

const answer = (chain: unknown[], id: string): unknown =>
  applyInboundBuyerResponse({
    supplierDid: SUPPLIER,
    envelope: envelope(id),
    response: {
      capability: 'order_status',
      query_id: PO,
      status: 'success',
      result: { signed_status_chain: chain },
    },
    nowMs: Date.now(),
  } as never);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-status-replay-'));
  adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  runtime = createCommerceRuntime({
    adapter,
    supplierDid: () => BUYER_DID,
    currentEpoch: () => '1',
    now: () => Date.now(),
  });
  installCommerceRuntime(runtime);
  const lines = [
    {
      line_id: 'l1',
      product: { scheme: 'manufacturer_sku', value: 'x', issuer_did: SUPPLIER },
      quantity: { unit_code: 'each', value: '10' },
    },
  ];
  runtime.buyerOrders.create(
    SUPPLIER,
    newBuyerOrder(PO, {
      orderDigest: 'd',
      idempotencyKey: 'i',
      quoteDigest: 'q',
      quoteId: 'q',
      buyerDid: BUYER_DID,
      supplierDid: SUPPLIER,
      protocolVersion: '1.0',
      serviceRkey: 'self',
      orderLines: lines,
    } as never),
  );
  const ack = makeAcknowledgement({
    purchase_order_id: PO,
    order_digest: 'd'.repeat(64),
    buyer_did: BUYER_DID,
    supplier_did: SUPPLIER,
    accepted_quote_digest: 'a'.repeat(64),
  } as never);
  const live = runtime.buyerOrders.get(SUPPLIER, PO);
  if (live === null) throw new Error('no order');
  expect(
    runtime.buyerOrders.put(SUPPLIER, { ...live, state: 'accepted', acknowledgement: ack }),
  ).toBe(true);
});

afterEach(() => {
  installCommerceRuntime(null);
  adapter.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('COM-11: an older record already held', () => {
  it('the same answer twice is no change and no fault', () => {
    expect(answer([s0, s1], 'e1')).toBe('applied');
    expect(answer([s1, s2], 'e2')).toBe('applied');
    expect(answer([s1, s2], 'e3')).toBe('no_change');
    expect(runtime.buyerOrders.get(SUPPLIER, PO)?.protocolFault).toBeFalsy();
    expect(runtime.buyerStatus.chain(SUPPLIER, PO).map((r) => r.sequence)).toEqual(['0', '1', '2']);
  });

  it('a late answer behind the head does not cut off the rest of it', () => {
    expect(answer([s0, s1], 'e1')).toBe('applied');
    expect(answer([s0, s1, s2], 'e2')).toBe('applied');
    expect(runtime.buyerStatus.chain(SUPPLIER, PO).map((r) => r.sequence)).toEqual(['0', '1', '2']);
  });

  it('a second record at a held sequence with another digest is still a fork', () => {
    expect(answer([s0, s1, s2], 'e1')).toBe('applied');
    const other = sign({
      sequence: '1',
      state: 'cancelled',
      previous_status_digest: s0.status_digest,
    });
    expect(answer([other], 'e2')).toBe('chain_fork');
    expect(runtime.buyerOrders.get(SUPPLIER, PO)?.protocolFault).toBeTruthy();
  });
});

describe('COM-12: every status keeps its envelope', () => {
  it('a three-record chain holds three pieces of evidence', () => {
    expect(answer([s0, s1, s2], 'e1')).toBe('applied');
    expect(runtime.buyerStatus.evidenceChain(SUPPLIER, PO).map((e) => e.record.sequence)).toEqual([
      '0',
      '1',
      '2',
    ]);
  });
});
