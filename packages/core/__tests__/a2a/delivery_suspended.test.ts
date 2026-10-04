/**
 * A DID client the re-check suspends (its key left its document) cannot
 * authenticate until the owner binds it again (notes M4 step 1), so nothing
 * its calls produce leaves either (design §7.3): its streams close and its
 * events wait. The hold ends: binding again releases the stream's events in
 * order, and revoking turns it into the final loss. A webhook the old key
 * set up ended with the key (design §10).
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import { A2A_DID_BINDING_PATH, didBindingSigningInput } from '@dina/a2a';

import {
  A2A_RPC_PATH,
  SUSPENDED_HOLD_MS,
  ackDeliveries,
  admitInboundClaimWith,
  claimDeliveries,
  createA2AClient,
  ingressCompleteDidBinding,
  ingressSendMessage,
  installA2ADidResolver,
  issueDidChallenge,
  refreshBoundDidKeys,
  revokeA2AClient,
  streamClientKeyOf,
  type A2ADidResolution,
  type GatewayEnvelope,
} from '../../src/a2a';
import { getPublicKey, sign } from '../../src/crypto/ed25519';
import { publicKeyToMultibase } from '../../src/identity/did';
import { SQLiteServiceGrantRepository } from '../../src/service/service_grant_repository';

import { InboundWorld, didRequestSignature, sentTask } from './inbound_fixture';

const NODE_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const PLC = 'did:plc:alice0000000000000000000';
const GATEWAY = 'did:key:z6MkGateway';

const keyOf = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: getPublicKey(privateKey) };
};
const ALICE = keyOf(51);
const ALICE_NEXT = keyOf(52);

const plcDocument = (key: Uint8Array) => ({
  id: PLC,
  verificationMethod: [{ id: `${PLC}#dina_signing`, type: 'Multikey', controller: PLC, publicKeyMultibase: publicKeyToMultibase(key) }],
});

let iw: InboundWorld;
let document: unknown;
beforeEach(async () => {
  iw = await InboundWorld.create();
  document = plcDocument(ALICE.publicKey);
  installA2ADidResolver(async (): Promise<A2ADidResolution> => ({ kind: 'document', document }));
});
afterEach(() => {
  installA2ADidResolver(null);
  iw.close();
});

async function bindPlc(signer: { privateKey: Uint8Array }): Promise<void> {
  const out = issueDidChallenge(iw.world.store, iw.clientId, PLC, iw.world.clock);
  if (!out.ok) throw new Error(out.reason);
  const input = didBindingSigningInput({ nodeDid: NODE_DID, clientId: iw.clientId, did: PLC, challenge: out.challenge });
  const body = JSON.stringify({ did: PLC, challenge: out.challenge, signature: bytesToHex(sign(signer.privateKey, new TextEncoder().encode(input))) });
  const answer = await ingressCompleteDidBinding(
    iw.rt,
    { request: { method: 'POST', path: A2A_DID_BINDING_PATH, query: '', body }, client_auth: {} },
    NODE_DID,
  );
  if (answer.status !== 200) throw new Error(`bind: ${JSON.stringify(answer.body)}`);
}

function signedStream(params: Record<string, unknown>, signer: { privateKey: Uint8Array }): GatewayEnvelope {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params });
  return {
    request: { method: 'POST', path: A2A_RPC_PATH, query: '', body, version: '1.0' },
    client_auth: { did_signature: didRequestSignature({ body, signer: { ...signer, did: PLC } }) },
  };
}

const claim = (limit = 100) => claimDeliveries(iw.rt, { claimant: GATEWAY, limit, webhookLimit: 100 });
const deliverAll = (items: ReturnType<typeof claim>['items']) =>
  ackDeliveries(iw.rt, { claimant: GATEWAY, acks: items.map((i) => ({ id: i.id, claim_id: i.claim_id, outcome: 'delivered' as const })) });
const shape = (items: ReturnType<typeof claim>['items'], id: string) =>
  items.filter((i) => i.task_id === id).map((i) => [i.target, i.seq, Object.keys(i.event)[0]]);

/** A bound client's streaming call with a webhook, caught up, then suspended, then finished: its result waits. */
async function suspendedWithResult(): Promise<string> {
  await bindPlc(ALICE);
  const sent = ingressSendMessage(
    iw.rt,
    signedStream(
      {
        ...iw.message({ skill: 'eta_query', params: { route_id: '42' } }, { messageId: 'held-call' }),
        configuration: { taskPushNotificationConfig: { url: 'https://hooks.example.test/a2a' } },
      },
      ALICE,
    ),
    'SendStreamingMessage',
  );
  const id = sentTask(sent).id as string;
  const { taskId } = iw.claimChild(id);
  const first = claim();
  expect(first.items.map((i) => i.target).sort()).toEqual(['sse', 'webhook']);
  deliverAll(first.items);
  document = plcDocument(ALICE_NEXT.publicKey);
  expect(await refreshBoundDidKeys(iw.world.store, () => iw.world.clock)).toEqual({ checked: 1, suspended: 1, unresolved: 0 });
  iw.world.workflow.complete(taskId, JSON.stringify({ eta_minutes: 5 }), 'done', iw.runnerDid);
  return id;
}

it('binding a bearer client to a DID ends what the bearer set up: its webhook goes, its streams close', async () => {
  const sent = ingressSendMessage(
    iw.rt,
    iw.request('SendStreamingMessage', {
      ...iw.message({ skill: 'eta_query', params: { route_id: '42' } }, { messageId: 'bearer-call' }),
      configuration: { taskPushNotificationConfig: { url: 'https://hooks.example.test/a2a' } },
    }),
    'SendStreamingMessage',
  );
  expect((sentTask(sent).status as { state: string }).state).toBe('TASK_STATE_SUBMITTED');
  expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 1 }]);
  await bindPlc(ALICE);
  expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 0 }]);
  // Streams opened under the bearer (generation 0) end at the next claim, on this task and any other.
  expect(claim().fenced).toEqual([{ client: streamClientKeyOf(`a2a:${iw.clientId}`), before_gen: 1 }]);
});

it('a suspended client gets nothing more on its stream or webhook, and its streams are closed', async () => {
  const id = await suspendedWithResult();
  // The webhook the suspended key set up ended with it, before any rebinding.
  expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 0 }]);
  const held = claim();
  expect(shape(held.items, id)).toEqual([]);
  expect(held.closed).toContain(id);
  // Held rows leave the due set for the wait, so no claim keeps reading them (the claim loop's guarantee).
  const op = iw.world.store.getTaskByExternal('inbound', `a2a:${iw.clientId}`, id);
  const due = [...iw.world.store.dueStreamRows(iw.world.clock, 100), ...iw.world.store.dueWebhookHeads(iw.world.clock, 100)];
  expect(due.filter((r) => r.operation_ref === op?.id)).toEqual([]);
  // Still held once the wait passes, while the client stays suspended.
  iw.world.clock += SUSPENDED_HOLD_MS + 1;
  const again = claim();
  expect(shape(again.items, id)).toEqual([]);
  expect(again.closed).toContain(id);
});

it('the owner binding the client again releases the stream’s events in order; the webhook the old key set up ended with it', async () => {
  const id = await suspendedWithResult();
  expect(shape(claim().items, id)).toEqual([]);
  await bindPlc(ALICE_NEXT);
  iw.world.clock += SUSPENDED_HOLD_MS + 1;
  const released = claim();
  expect(shape(released.items, id)).toEqual([
    ['sse', 2, 'artifactUpdate'],
    ['sse', 3, 'statusUpdate'],
  ]);
  // The first binding (ending the bearer), the suspension and the new binding each ended a credential:
  // only a stream opened under the new key gets them.
  expect(released.items.map((i) => (i.target === 'sse' ? i.credential_gen : null))).toEqual([3, 3]);
  // Design §10: what a credential set up ends with it; the client sets a webhook again under the new key.
  // The config went with the key, so the result wrote no webhook event at all.
  expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_configs`)).toEqual([{ n: 0 }]);
  expect(
    iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_outbox WHERE target_kind = 'webhook' AND status IN ('pending', 'claimed')`),
  ).toEqual([{ n: 0 }]);
});

it('revoking a suspended client turns the hold into the final loss: its waiting events are suppressed', async () => {
  const id = await suspendedWithResult();
  expect(shape(claim().items, id)).toEqual([]);
  const revoked = revokeA2AClient(iw.world.store, new SQLiteServiceGrantRepository(iw.world.store.db), iw.clientId, iw.world.clock);
  expect(revoked.ok).toBe(true);
  iw.world.clock += SUSPENDED_HOLD_MS + 1;
  const lost = claim();
  expect(shape(lost.items, id)).toEqual([]);
  expect(lost.closed).toContain(id);
  expect(iw.world.store.db.query(`SELECT COUNT(*) AS n FROM a2a_push_outbox WHERE status = 'pending'`)).toEqual([{ n: 0 }]);
});

// Cold audit C6-6: claims a gateway took and never answered leave the due set with the hold
it('a held task’s lapsed claims are held too: a crashed gateway’s full batch never keeps another client’s events out', async () => {
  const id = await suspendedWithResult();
  const op = iw.world.store.getTaskByExternal('inbound', `a2a:${iw.clientId}`, id);
  if (op === null) throw new Error('op');
  // A gateway claimed the held task's waiting events, and more than a claim round reads
  // (MIN_CLAIM_BATCH, 100), then went away before answering: every claim lapsed.
  const db = iw.world.store.db;
  const lapsed = iw.world.clock - 1;
  db.run(`UPDATE a2a_push_outbox SET status = 'claimed', claim_id = 'gone', claimed_by = ?, claimed_until = ? WHERE operation_ref = ? AND status = 'pending'`, [
    GATEWAY,
    lapsed,
    op.id,
  ]);
  const [last] = db.query(`SELECT * FROM a2a_push_outbox WHERE operation_ref = ? AND target_kind = 'sse' ORDER BY id DESC LIMIT 1`, [op.id]) as {
    seq: number;
    event_json: string;
  }[];
  if (last === undefined) throw new Error('no row');
  for (let n = 1; n <= 120; n += 1) {
    db.run(
      `INSERT INTO a2a_push_outbox (operation_ref, source_event_id, seq, target_kind, target_id, event_json, status, claim_id, claimed_by, claimed_until, created_at)
       VALUES (?, ?, ?, 'sse', '', ?, 'claimed', 'gone', ?, ?, ?)`,
      [op.id, `stuck-${n}`, last.seq + n, last.event_json, GATEWAY, lapsed, iw.world.clock],
    );
  }
  // Another client's call: its runner claims it, and that change is its first event, behind them all.
  const other = createA2AClient(iw.world.store, { display_name: 'Other agent' }, iw.world.clock);
  if (!other.ok) throw new Error(other.reason);
  const sent = ingressSendMessage(
    iw.rt,
    iw.request('SendStreamingMessage', iw.message({ skill: 'eta_query', params: { route_id: '7' } }, { messageId: 'other-call' }), {}, `Bearer ${other.token}`),
    'SendStreamingMessage',
  );
  const otherId = sentTask(sent).id as string;
  const otherOp = iw.world.store.getTaskByExternal('inbound', `a2a:${other.client.client_id}`, otherId);
  const claimed = iw.world.repo.claimDelegationTask(iw.runnerDid, iw.world.clock, 60_000, 'transit');
  if (otherOp === null || claimed === null || claimed.id !== otherOp.internal_id) throw new Error('claim');
  expect(admitInboundClaimWith(iw.rt, claimed, iw.runnerDid)).toBe('admitted');
  const one = claim(1);
  expect(one.items.map((i) => i.task_id)).toEqual([otherId]);
  // The lapsed claims were given back and held with the task's other events, out of the due set.
  expect(db.query(`SELECT DISTINCT status, claim_id, next_attempt_at > ? AS held FROM a2a_push_outbox WHERE operation_ref = ? AND status != 'delivered'`, [iw.world.clock, op.id])).toEqual([
    { status: 'pending', claim_id: null, held: 1 },
  ]);
});

it('control: the hold gives back only lapsed claims; a live one stays with the gateway that holds it', async () => {
  const id = await suspendedWithResult();
  const op = iw.world.store.getTaskByExternal('inbound', `a2a:${iw.clientId}`, id);
  if (op === null) throw new Error('op');
  const db = iw.world.store.db;
  const now = iw.world.clock;
  const rowsOf = () =>
    db.query(`SELECT id, status, claim_id, claimed_until, next_attempt_at FROM a2a_push_outbox WHERE operation_ref = ? AND status != 'delivered' ORDER BY id`, [
      op.id,
    ]) as { id: number; status: string; claim_id: string | null; claimed_until: number | null; next_attempt_at: number | null }[];
  const [lapsedRow, liveRow] = rowsOf();
  if (lapsedRow === undefined || liveRow === undefined) throw new Error('rows');
  db.run(`UPDATE a2a_push_outbox SET status = 'claimed', claim_id = 'gone', claimed_by = ?, claimed_until = ? WHERE id = ?`, [GATEWAY, now - 1, lapsedRow.id]);
  db.run(`UPDATE a2a_push_outbox SET status = 'claimed', claim_id = 'mine', claimed_by = ?, claimed_until = ? WHERE id = ?`, [GATEWAY, now + 10_000, liveRow.id]);
  iw.world.store.deferOutbox(op.id, now + SUSPENDED_HOLD_MS, now);
  expect(rowsOf()).toEqual([
    { id: lapsedRow.id, status: 'pending', claim_id: null, claimed_until: null, next_attempt_at: now + SUSPENDED_HOLD_MS },
    { id: liveRow.id, status: 'claimed', claim_id: 'mine', claimed_until: now + 10_000, next_attempt_at: null },
  ]);
});

it('a held backlog never keeps another client’s events out of a claim', async () => {
  const id = await suspendedWithResult();
  const other = createA2AClient(iw.world.store, { display_name: 'Other agent' }, iw.world.clock);
  if (!other.ok) throw new Error(other.reason);
  const sent = ingressSendMessage(
    iw.rt,
    iw.request('SendStreamingMessage', iw.message({ skill: 'eta_query', params: { route_id: '7' } }, { messageId: 'other-call' }), {}, `Bearer ${other.token}`),
    'SendStreamingMessage',
  );
  const otherId = sentTask(sent).id as string;
  // Its runner claims it: the task is WORKING, and that change is its first event.
  const otherOp = iw.world.store.getTaskByExternal('inbound', `a2a:${other.client.client_id}`, otherId);
  const claimed = iw.world.repo.claimDelegationTask(iw.runnerDid, iw.world.clock, 60_000, 'transit');
  if (otherOp === null || claimed === null || claimed.id !== otherOp.internal_id) throw new Error('claim');
  expect(admitInboundClaimWith(iw.rt, claimed, iw.runnerDid)).toBe('admitted');
  // One slot: the held task's older rows step aside, and the other client's event takes it.
  const one = claim(1);
  expect(one.items.map((i) => i.task_id)).toEqual([otherId]);
  expect(shape(one.items, id)).toEqual([]);
});
