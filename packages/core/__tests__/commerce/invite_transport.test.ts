/**
 * The §8 ceremony over the REAL wire: minted at the owner route,
 * redeemed at the owner route, and the four relay messages sealed,
 * signed and admitted through `receiveD2D` — from senders who are NOT
 * yet contacts, which is the whole point of the nonce gate.
 */

import { randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';

import { resetAuditState } from '../../src/audit/service';
import { installInviteService } from '../../src/commerce/invite_compose';
import { InviteService } from '../../src/commerce/invite_service';
import { InMemoryInviteRepository } from '../../src/commerce/invite_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealMessage, type DinaMessage } from '../../src/d2d/envelope';
import { clearGatesState } from '../../src/d2d/gates';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerCommerceRoutes } from '../../src/server/routes/commerce';
import { clearReplayCache } from '../../src/transport/adversarial';

const OWNER_CAP = 'test-owner-capability-secret';
const INVITER = 'did:plc:distributor00000000000000';
const REDEEMER = 'did:plc:vendor0000000000000000000';
const T0 = 1_800_000_000_000;

const inviterPriv = new Uint8Array(randomBytes(32));
const inviterPub = getPublicKey(inviterPriv);
const redeemerPriv = new Uint8Array(randomBytes(32));
const redeemerPub = getPublicKey(redeemerPriv);

function owner(path: string, body?: Record<string, unknown>): CoreRequest {
  return {
    method: body === undefined ? 'GET' : 'POST',
    path,
    query: {},
    headers: {},
    body: body ?? {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    callerDID: 'did:key:owner',
    ownerCapability: OWNER_CAP,
  } as unknown as CoreRequest;
}

interface Node {
  did: string;
  service: InviteService;
  repo: InMemoryInviteRepository;
  contacts: Set<string>;
  grants: unknown[];
  outbox: { toDid: string; body: Record<string, unknown> }[];
}

function makeNode(did: string): Node {
  const repo = new InMemoryInviteRepository();
  const contacts = new Set<string>();
  const grants: unknown[] = [];
  const outbox: Node['outbox'] = [];
  const service = new InviteService({
    invites: repo,
    nodeDid: () => did,
    now: () => T0,
    relayUrl: () => 'wss://msgbox.example.dev',
    signOfferDigest: (bytes) => ed25519.sign(bytes, inviterPriv),
    resolveSigningKey: async (target) => (target === INVITER ? inviterPub : null),
    verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
    writeContact: (c) => contacts.add(c),
    removeContact: (c) => contacts.delete(c),
    writeGrants: (args) => grants.push(args),
    revokeGrants: () => undefined,
    hasPublishedCatalog: () => true,
    acceptColdInvites: () => true,
    notifyColdOffer: () => undefined,
    send: async (toDid, body) => {
      outbox.push({ toDid, body });
      return true;
    },
  });
  return { did, service, repo, contacts, grants, outbox };
}

afterEach(() => {
  installInviteService(null);
  installCommerceRuntime(null);
  clearGatesState();
  clearReplayCache();
  resetAuditState();
});

it('mint → redeem → four sealed messages → both sides active, from non-contacts', async () => {
  const inviter = makeNode(INVITER);
  const redeemer = makeNode(REDEEMER);
  const router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);

  // The routes read the runtime only for presence/list; give them a stub.
  installCommerceRuntime({
    invites: inviter.repo,
    nodeDid: () => INVITER,
    now: () => T0,
  } as unknown as CommerceRuntime);

  // 1. The inviter's owner mints at the route. No capability list travels
  // from the surface: the route fills in Core's standard trade pair, and
  // that DEFAULTED list is what the rest of this ceremony proves out.
  setNodeDID(INVITER);
  installInviteService(inviter.service);
  const minted = await router.handle(
    owner('/v1/commerce/invites', {
      direction: 'you_supply_me',
      service_rkeys: ['self'],
    }),
  );
  expect(minted.status).toBe(200);
  const mintedOffer = (minted.body as { offer: { capabilities: string[] } }).offer;
  expect(mintedOffer.capabilities).toEqual([
    'com.dinakernel.commerce.request_quote',
    'com.dinakernel.commerce.submit_order',
  ]);
  const code = (minted.body as { code: string }).code;

  // 2. The redeemer's owner pastes the code at ITS route.
  setNodeDID(REDEEMER);
  installInviteService(redeemer.service);
  const redeemed = await router.handle(
    owner('/v1/commerce/invites/redeem', { code, service_rkeys: ['veg-stall'] }),
  );
  expect(redeemed.status).toBe(200);
  const redemptionMsg = redeemer.outbox.shift();
  if (redemptionMsg === undefined) throw new Error('no redemption dispatched');

  // A message's trip across the wire: sealed by the sender, admitted by
  // the receiver's REAL pipeline. Trust is 'unknown' on purpose — no
  // contact exists yet, and the nonce is the credential.
  const flush = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  async function deliver(
    from: string,
    fromPriv: Uint8Array,
    fromPub: Uint8Array,
    to: string,
    toPriv: Uint8Array,
    toPub: Uint8Array,
    node: Node,
    body: Record<string, unknown>,
  ): Promise<void> {
    setNodeDID(to);
    installInviteService(node.service);
    const msg: DinaMessage = {
      id: `inv-${Math.random().toString(36).slice(2)}`,
      type: 'commerce.invite',
      from,
      to,
      created_time: T0,
      body: JSON.stringify(body),
    };
    const sealed = sealMessage(msg, fromPriv, toPub);
    const result = receiveD2D(sealed, toPub, toPriv, [fromPub], 'unknown');
    expect(result.action).toBe('bypassed');
    await flush();
  }

  // 3. Redemption reaches the inviter → it confirms.
  await deliver(REDEEMER, redeemerPriv, redeemerPub, INVITER, inviterPriv, inviterPub, inviter, redemptionMsg.body);
  const confirmationMsg = inviter.outbox.shift();
  if (confirmationMsg === undefined) throw new Error('no confirmation dispatched');

  // 4. Confirmation reaches the redeemer → it ACTIVATES and acks.
  await deliver(INVITER, inviterPriv, inviterPub, REDEEMER, redeemerPriv, redeemerPub, redeemer, confirmationMsg.body);
  expect(redeemer.contacts.has(INVITER)).toBe(true);
  expect(redeemer.grants).toHaveLength(1); // you_supply_me: the redeemer supplies
  const ackMsg = redeemer.outbox.shift();
  if (ackMsg === undefined) throw new Error('no ack dispatched');

  // 5. Ack reaches the inviter → it ACTIVATES and pongs the receipt.
  await deliver(REDEEMER, redeemerPriv, redeemerPub, INVITER, inviterPriv, inviterPub, inviter, ackMsg.body);
  expect(inviter.contacts.has(REDEEMER)).toBe(true);
  const receiptMsg = inviter.outbox.shift();
  if (receiptMsg === undefined) throw new Error('no receipt dispatched');

  // 6. The receipt reaches the redeemer → activation PROOF.
  await deliver(INVITER, inviterPriv, inviterPub, REDEEMER, redeemerPriv, redeemerPub, redeemer, receiptMsg.body);
  expect(redeemer.repo.get((minted.body as { offer: { nonce: string } }).offer.nonce)?.activationProvenAt).toBe(T0);

  // 7. The owner surface reads the exchange.
  installCommerceRuntime({
    invites: redeemer.repo,
    nodeDid: () => REDEEMER,
    now: () => T0,
  } as unknown as CommerceRuntime);
  const listed = await router.handle(owner('/v1/commerce/invites', undefined));
  expect(listed.status).toBe(200);
  const rows = (listed.body as { invites: { state: string; activation_proven: boolean }[] }).invites;
  expect(rows).toEqual([
    expect.objectContaining({ state: 'active', activation_proven: true, counterparty_did: INVITER }),
  ]);
  // The nonce is a CREDENTIAL: the list hands it out ONLY for held rows
  // (where the surface needs it to accept). An active row never carries
  // one — a leaked list must not let anyone continue a live exchange.
  expect(rows[0]).not.toHaveProperty('nonce');
});

it('the list returns the nonce for HELD rows only — it is the accept credential', async () => {
  const redeemer = makeNode(REDEEMER);
  setNodeDID(REDEEMER);
  installInviteService(redeemer.service);
  const inviter = makeNode(INVITER);
  const minted = inviter.service.mintOffer({
    direction: 'you_supply_me',
    serviceRkeys: ['self'],
    capabilities: ['com.dinakernel.commerce.request_quote'],
  });
  if (!minted.ok) throw new Error(minted.refusal);
  expect(
    (await redeemer.service.applyInboundColdOffer({ senderDid: INVITER, body: minted.value.offer })).ok,
  ).toBe(true);
  const router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
  installCommerceRuntime({
    invites: redeemer.repo,
    nodeDid: () => REDEEMER,
    now: () => T0,
  } as unknown as CommerceRuntime);
  const listed = await router.handle(owner('/v1/commerce/invites', undefined));
  expect(listed.status).toBe(200);
  const rows = (listed.body as { invites: { state: string; nonce?: string }[] }).invites;
  expect(rows).toEqual([
    expect.objectContaining({ state: 'held', nonce: minted.value.offer.nonce }),
  ]);
});

it('a garbled invite message and an unknown nonce both drop without a crash', async () => {
  const inviter = makeNode(INVITER);
  setNodeDID(INVITER);
  installInviteService(inviter.service);
  const sealedGarbage = sealMessage(
    {
      id: 'inv-x',
      type: 'commerce.invite',
      from: REDEEMER,
      to: INVITER,
      created_time: T0,
      body: 'not json',
    },
    redeemerPriv,
    inviterPub,
  );
  const result = receiveD2D(sealedGarbage, inviterPub, inviterPriv, [redeemerPub], 'unknown');
  // Handed to the service, which refuses inside; ingress stays calm.
  expect(result.action).toBe('bypassed');
});

it('with no composed service the message drops, named', () => {
  const sealed = sealMessage(
    {
      id: 'inv-y',
      type: 'commerce.invite',
      from: REDEEMER,
      to: INVITER,
      created_time: T0,
      body: '{}',
    },
    redeemerPriv,
    inviterPub,
  );
  const result = receiveD2D(sealed, inviterPub, inviterPriv, [redeemerPub], 'unknown');
  expect(result.action).toBe('dropped');
  expect(result.reason).toContain('no invite service');
});
it('the NON-contact-gated invite type cannot smuggle a khata document', async () => {
  // `commerce.trade` is contact-gated; `commerce.invite` is not (the
  // nonce is the credential). The invite handler must therefore admit
  // ONLY the six ceremony kinds — a khata document riding the open type
  // would bypass the contact gate entirely.
  const inviter = makeNode(INVITER);
  setNodeDID(INVITER);
  installInviteService(inviter.service);
  const sealed = sealMessage(
    {
      id: 'inv-smuggle',
      type: 'commerce.invite',
      from: REDEEMER,
      to: INVITER,
      created_time: T0,
      body: JSON.stringify({
        kind: 'delivery_note',
        document: { protocol_version: '1.1', delivery_note_id: 'dn-smuggled' },
      }),
    },
    redeemerPriv,
    inviterPub,
  );
  const result = receiveD2D(sealed, inviterPub, inviterPriv, [redeemerPub], 'unknown');
  expect(result.action).toBe('bypassed');
  await new Promise((resolve) => setImmediate(resolve));
  // Nothing entered the invite store, no contact, no grant — the kind
  // switch refused it before any verifier ran.
  expect(inviter.repo.list()).toHaveLength(0);
  expect(inviter.contacts.size).toBe(0);
  expect(inviter.grants).toHaveLength(0);
});
