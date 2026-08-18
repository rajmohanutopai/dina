/**
 * The §8 invite ceremony, driven as TWO real nodes over a paper wire:
 * ordered activation, idempotent re-send under loss, single-use nonce,
 * two-sided revocation, and the activation-proof pong. The wire is a
 * hand-pumped queue so every loss and replay is a test's decision.
 */

import { createHash, randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';

import {
  encodeInviteCode,
  inviteRecordDigest,
  inviteOfferSigningBytes,
  type InviteOffer,
  type Sha256Fn,
} from '@dina/commerce-protocol';

const sha: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

import {
  ACTIVATION_PROOF_WINDOW_MS,
  DEFAULT_INVITE_TTL_MS,
  InviteService,
} from '../../src/commerce/invite_service';
import { InMemoryInviteRepository, SQLiteInviteRepository } from '../../src/commerce/invite_store';

const INVITER = 'did:plc:distributor00000000000000';
const REDEEMER = 'did:plc:vendor0000000000000000000';
const T0 = 1_800_000_000_000;

const inviterPriv = new Uint8Array(randomBytes(32));
const inviterPub = ed25519.getPublicKey(inviterPriv);

interface WireMessage {
  from: string;
  to: string;
  body: Record<string, unknown>;
}

interface Node {
  service: InviteService;
  repo: InMemoryInviteRepository;
  contacts: Set<string>;
  grants: { granteeDid: string; serviceRkeys: readonly string[]; capabilities: readonly string[] }[];
  revokedGrantees: string[];
  coldCards: { nonce: string; inviterDid: string }[];
}

function harness(): {
  inviter: Node;
  redeemer: Node;
  wire: WireMessage[];
  clock: { now: number };
  /** Deliver every queued message to its recipient's handler. */
  pump: () => Promise<void>;
} {
  const wire: WireMessage[] = [];
  const clock = { now: T0 };

  function makeNode(did: string): Node {
    const repo = new InMemoryInviteRepository();
    const contacts = new Set<string>();
    const grants: Node['grants'] = [];
    const revokedGrantees: string[] = [];
    const coldCards: { nonce: string; inviterDid: string }[] = [];
    const service = new InviteService({
      invites: repo,
      nodeDid: () => did,
      now: () => clock.now,
      relayUrl: () => 'wss://msgbox.example.dev',
      signOfferDigest: (bytes) => ed25519.sign(bytes, inviterPriv),
      resolveSigningKey: async (target) => (target === INVITER ? inviterPub : null),
      verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
      writeContact: (c) => contacts.add(c),
      removeContact: (c) => contacts.delete(c),
      writeGrants: (args) => grants.push(args),
      revokeGrants: (granteeDid) => revokedGrantees.push(granteeDid),
      hasPublishedCatalog: () => true,
      acceptColdInvites: () => true,
      notifyColdOffer: (args) => {
        coldCards.push(args);
      },
      send: async (toDid, body) => {
        wire.push({ from: did, to: toDid, body });
        return true;
      },
    });
    return { service, repo, contacts, grants, revokedGrantees, coldCards };
  }

  const inviter = makeNode(INVITER);
  const redeemer = makeNode(REDEEMER);

  async function deliver(msg: WireMessage): Promise<void> {
    const node = msg.to === INVITER ? inviter : redeemer;
    const args = { senderDid: msg.from, body: (msg.body as { document: unknown }).document };
    switch (msg.body.kind) {
      case 'redemption':
        await node.service.applyInboundRedemption(args);
        break;
      case 'confirmation':
        await node.service.applyInboundConfirmation(args);
        break;
      case 'activation_ack':
        await node.service.applyInboundActivationAck(args);
        break;
      case 'ack_receipt':
        node.service.applyInboundAckReceipt(args);
        break;
      case 'revocation':
        node.service.applyInboundRevocation(args);
        break;
      case 'offer':
        await node.service.applyInboundColdOffer(args);
        break;
      default:
        throw new Error(`unknown wire kind ${String(msg.body.kind)}`);
    }
  }

  return {
    inviter,
    redeemer,
    wire,
    clock,
    pump: async () => {
      while (wire.length > 0) {
        const msg = wire.shift();
        if (msg !== undefined) await deliver(msg);
      }
    },
  };
}

const RKEYS = ['wholesale'];
const CAPS = ['com.dinakernel.commerce.request_quote', 'com.dinakernel.commerce.submit_order'];

describe('the four messages, end to end', () => {
  it('you_supply_me: both sides activate, the SUPPLIER (redeemer) grants, proof lands', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);

    const redeemed = await h.redeemer.service.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['veg-stall'],
    });
    expect(redeemed.ok).toBe(true);
    await h.pump(); // redemption → confirmation → ack → receipt, all the way

    const inviterRow = h.inviter.repo.get(minted.value.offer.nonce);
    const redeemerRow = h.redeemer.repo.get(minted.value.offer.nonce);
    expect(inviterRow?.state).toBe('active');
    expect(redeemerRow?.state).toBe('active');
    expect(redeemerRow?.activationProvenAt).toBe(T0);

    // Contacts on BOTH sides; grants only on the supplier (the redeemer),
    // keyed on ITS rkeys, to the inviter, for the offered capabilities.
    expect(h.inviter.contacts.has(REDEEMER)).toBe(true);
    expect(h.redeemer.contacts.has(INVITER)).toBe(true);
    expect(h.inviter.grants).toHaveLength(0);
    expect(h.redeemer.grants).toEqual([
      { granteeDid: INVITER, serviceRkeys: ['veg-stall'], capabilities: CAPS },
    ]);
  });

  it('i_supply_you: the INVITER grants on its own rkeys', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'i_supply_you',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['veg-stall'] });
    await h.pump();
    expect(h.redeemer.grants).toHaveLength(0);
    expect(h.inviter.grants).toEqual([
      { granteeDid: REDEEMER, serviceRkeys: RKEYS, capabilities: CAPS },
    ]);
  });

  it('activation is ORDERED: the redeemer commits first, the inviter only on the ack', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });

    // Deliver redemption and confirmation, but HOLD the ack on the wire.
    const msg1 = h.wire.shift();
    if (msg1 === undefined) throw new Error('no redemption on the wire');
    await (async () => {
      await h.inviter.service.applyInboundRedemption({
        senderDid: msg1.from,
        body: (msg1.body as { document: unknown }).document,
      });
    })();
    const msg2 = h.wire.shift();
    if (msg2 === undefined) throw new Error('no confirmation on the wire');
    await h.redeemer.service.applyInboundConfirmation({
      senderDid: msg2.from,
      body: (msg2.body as { document: unknown }).document,
    });

    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('active');
    expect(h.inviter.repo.get(minted.value.offer.nonce)?.state).toBe('redeemed');
    // The asymmetric moment: the redeemer has written; the inviter has not.
    expect(h.redeemer.contacts.has(INVITER)).toBe(true);
    expect(h.inviter.contacts.has(REDEEMER)).toBe(false);
  });
});

describe('loss and replay', () => {
  it('a lost confirmation resolves by idempotent re-redeem → same confirmation', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    // Redemption arrives; the confirmation is LOST.
    const redemption = h.wire.shift();
    if (redemption === undefined) throw new Error('empty wire');
    await h.inviter.service.applyInboundRedemption({
      senderDid: redemption.from,
      body: (redemption.body as { document: unknown }).document,
    });
    h.wire.length = 0; // the confirmation vanishes

    // Re-redeem: the SAME redemption goes back; the inviter re-sends the
    // SAME confirmation; the exchange completes.
    const again = await h.redeemer.service.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['ignored-on-resend'],
    });
    expect(again.ok && again.value.resent).toBe(true);
    await h.pump();
    expect(h.inviter.repo.get(minted.value.offer.nonce)?.state).toBe('active');
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('active');
  });

  it('a lost AckReceipt resolves by the sweep re-sending the ack → the idempotent pong', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    // Deliver everything except the final receipt.
    while (h.wire.length > 0) {
      const msg = h.wire.shift();
      if (msg === undefined) break;
      if (msg.body.kind === 'ack_receipt') continue; // lost
      const node = msg.to === INVITER ? h.inviter : h.redeemer;
      const args = { senderDid: msg.from, body: (msg.body as { document: unknown }).document };
      if (msg.body.kind === 'redemption') await node.service.applyInboundRedemption(args);
      else if (msg.body.kind === 'confirmation') await node.service.applyInboundConfirmation(args);
      else if (msg.body.kind === 'activation_ack') await node.service.applyInboundActivationAck(args);
    }
    const row = h.redeemer.repo.get(minted.value.offer.nonce);
    expect(row?.state).toBe('active');
    expect(row?.activationProvenAt).toBeNull();

    // The redeemer's sweep re-sends the ack; the ACTIVE inviter pongs.
    h.clock.now = T0 + 60_000;
    const swept = await h.redeemer.service.sweep();
    expect(swept.ackResent).toBe(1);
    await h.pump();
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.activationProvenAt).toBe(h.clock.now);
  });

  it('ANY authenticated inbound from the inviter is activation proof', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    while (h.wire.length > 0) {
      const msg = h.wire.shift();
      if (msg === undefined || msg.body.kind === 'ack_receipt') continue;
      const node = msg.to === INVITER ? h.inviter : h.redeemer;
      const args = { senderDid: msg.from, body: (msg.body as { document: unknown }).document };
      if (msg.body.kind === 'redemption') await node.service.applyInboundRedemption(args);
      else if (msg.body.kind === 'confirmation') await node.service.applyInboundConfirmation(args);
      else if (msg.body.kind === 'activation_ack') await node.service.applyInboundActivationAck(args);
    }
    h.clock.now = T0 + 5_000;
    h.redeemer.service.noteAuthenticatedInbound(INVITER);
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.activationProvenAt).toBe(h.clock.now);
  });
});

describe('single use, wrong senders, bad offers', () => {
  it('a DIFFERENT redemption under a used nonce refuses; the same one re-confirms', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    const redemption = h.wire.shift();
    if (redemption === undefined) throw new Error('empty wire');
    const doc = (redemption.body as { document: Record<string, unknown> }).document;
    await h.inviter.service.applyInboundRedemption({ senderDid: REDEEMER, body: doc });

    // A second redeemer presenting a different redemption for the nonce.
    const hijack = await h.inviter.service.applyInboundRedemption({
      senderDid: 'did:plc:mallory000000000000000000',
      body: { ...doc, redeemer_did: 'did:plc:mallory000000000000000000' },
    });
    expect(hijack.ok).toBe(false);
    if (!hijack.ok) expect(hijack.refusal).toContain('does not match');
  });

  it('senders are bound to the transport: a body naming someone else refuses', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    const redemption = h.wire.shift();
    if (redemption === undefined) throw new Error('empty wire');
    const outcome = await h.inviter.service.applyInboundRedemption({
      senderDid: 'did:plc:mallory000000000000000000',
      body: (redemption.body as { document: unknown }).document,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal).toContain('authenticated sender');
  });

  it('an expired offer, an unresolvable key, and self-redemption all refuse', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
      ttlMs: 1000,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    h.clock.now = T0 + 2000;
    const expired = await h.redeemer.service.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['s'],
    });
    expect(!expired.ok && expired.refusal).toContain('expired');

    h.clock.now = T0;
    const self = await h.inviter.service.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['s'],
    });
    expect(!self.ok && self.refusal).toContain('own offer');
  });
});

describe('two-sided revocation', () => {
  it('an unfinished inviter exchange past TTL revokes and TELLS the redeemer, who tears down', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    // Redemption + confirmation flow; the ACK is lost for ever.
    while (h.wire.length > 0) {
      const msg = h.wire.shift();
      if (msg === undefined || msg.body.kind === 'activation_ack') continue;
      const node = msg.to === INVITER ? h.inviter : h.redeemer;
      const args = { senderDid: msg.from, body: (msg.body as { document: unknown }).document };
      if (msg.body.kind === 'redemption') await node.service.applyInboundRedemption(args);
      else if (msg.body.kind === 'confirmation') await node.service.applyInboundConfirmation(args);
    }
    // The redeemer is active with writes; the inviter is stuck at redeemed.
    expect(h.redeemer.contacts.has(INVITER)).toBe(true);

    h.clock.now = T0 + DEFAULT_INVITE_TTL_MS + 1;
    const swept = await h.inviter.service.sweep();
    expect(swept.revoked).toBe(1);
    expect(h.inviter.repo.get(minted.value.offer.nonce)?.state).toBe('revoked');
    // The best-effort notice reaches the redeemer: full teardown.
    await h.pump();
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('revoked');
    expect(h.redeemer.contacts.has(INVITER)).toBe(false);
    expect(h.redeemer.revokedGrantees).toContain(INVITER);
  });

  it('a redeemer with NO proof past the window tears down and tells the inviter', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    while (h.wire.length > 0) {
      const msg = h.wire.shift();
      if (msg === undefined || msg.body.kind === 'ack_receipt') continue;
      const node = msg.to === INVITER ? h.inviter : h.redeemer;
      const args = { senderDid: msg.from, body: (msg.body as { document: unknown }).document };
      if (msg.body.kind === 'redemption') await node.service.applyInboundRedemption(args);
      else if (msg.body.kind === 'confirmation') await node.service.applyInboundConfirmation(args);
      else if (msg.body.kind === 'activation_ack') await node.service.applyInboundActivationAck(args);
    }
    // Inside the window: re-send, never teardown.
    h.clock.now = T0 + ACTIVATION_PROOF_WINDOW_MS - 1;
    h.wire.length = 0;
    const early = await h.redeemer.service.sweep();
    expect(early).toEqual({ revoked: 0, ackResent: 1 });
    h.wire.length = 0; // the inviter never answers

    h.clock.now = T0 + 2 * ACTIVATION_PROOF_WINDOW_MS;
    const late = await h.redeemer.service.sweep();
    expect(late.revoked).toBe(1);
    expect(h.redeemer.contacts.has(INVITER)).toBe(false);
    // Its own best-effort notice went to the inviter.
    expect(h.wire.some((m) => m.body.kind === 'revocation' && m.to === INVITER)).toBe(true);
  });

  it('a redeemer WITH proof stands untouched for ever — idleness triggers nothing', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    await h.pump();
    h.clock.now = T0 + 100 * DEFAULT_INVITE_TTL_MS;
    const swept = await h.redeemer.service.sweep();
    expect(swept).toEqual({ revoked: 0, ackResent: 0 });
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('active');
  });
});

describe('the SQLite repository arm', () => {
  it('is constructible (round-trip parity rides the route/journey suites)', () => {
    expect(SQLiteInviteRepository).toBeDefined();
  });
});

describe('cold invites (§8 second half)', () => {
  function coldHarness(): ReturnType<typeof harness> & { cards: { nonce: string }[] } {
    const h = harness();
    // Repoint the redeemer node's policy hooks by rebuilding it would be
    // heavy; instead the harness defaults already say catalog+accept —
    // this wrapper only exists for the refusal cases, driven through a
    // dedicated service below.
    return Object.assign(h, { cards: h.redeemer.coldCards });
  }

  it("a stranger's offer is HELD, carded, never auto-redeemed; accept continues at step 2", async () => {
    const h = coldHarness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);

    const held = await h.redeemer.service.applyInboundColdOffer({
      senderDid: INVITER,
      body: minted.value.offer,
    });
    expect(held.ok).toBe(true);
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('held');
    // NOTHING was written or sent — the whole point of holding.
    expect(h.wire).toHaveLength(0);
    expect(h.redeemer.contacts.size).toBe(0);
    expect(h.redeemer.coldCards).toEqual([
      expect.objectContaining({ nonce: minted.value.offer.nonce, inviterDid: INVITER }),
    ]);
    // Re-delivery of the same held offer is one offer.
    const again = await h.redeemer.service.applyInboundColdOffer({
      senderDid: INVITER,
      body: minted.value.offer,
    });
    expect(again.ok).toBe(true);
    expect(h.redeemer.coldCards).toHaveLength(1);

    // The consent tap: the ceremony continues exactly as a pasted code.
    const accepted = await h.redeemer.service.acceptHeldOffer({
      nonce: minted.value.offer.nonce,
      serviceRkeys: ['veg-stall'],
    });
    expect(accepted.ok).toBe(true);
    await h.pump();
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('active');
    expect(h.inviter.repo.get(minted.value.offer.nonce)?.state).toBe('active');
  });

  it('sender binding, self-invite, expiry and a used nonce all refuse', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    const wrongSender = await h.redeemer.service.applyInboundColdOffer({
      senderDid: 'did:plc:mallory000000000000000000',
      body: minted.value.offer,
    });
    expect(!wrongSender.ok && wrongSender.refusal).toContain('authenticated sender');

    // Redeem the offer normally; a cold re-delivery under the used nonce refuses.
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['s'] });
    const used = await h.redeemer.service.applyInboundColdOffer({
      senderDid: INVITER,
      body: minted.value.offer,
    });
    expect(!used.ok && used.refusal).toContain('already used');
  });

  it('refuse-all policy and no-published-catalog both drop before any card', async () => {
    const wire: WireMessage[] = [];
    void wire;
    const cards: unknown[] = [];
    const repo = new InMemoryInviteRepository();
    const service = new InviteService({
      invites: repo,
      nodeDid: () => REDEEMER,
      now: () => T0,
      relayUrl: () => 'wss://msgbox.example.dev',
      signOfferDigest: (bytes) => ed25519.sign(bytes, inviterPriv),
      resolveSigningKey: async (target) => (target === INVITER ? inviterPub : null),
      verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
      writeContact: () => undefined,
      removeContact: () => undefined,
      writeGrants: () => undefined,
      revokeGrants: () => undefined,
      hasPublishedCatalog: () => false,
      acceptColdInvites: () => true,
      notifyColdOffer: (args) => cards.push(args),
      send: async () => true,
    });
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    const noCatalog = await service.applyInboundColdOffer({
      senderDid: INVITER,
      body: minted.value.offer,
    });
    expect(!noCatalog.ok && noCatalog.refusal).toContain('no catalog');
    expect(cards).toHaveLength(0);
    expect(repo.list()).toHaveLength(0);
  });

  it('per-sender and aggregate throttles hold, and expired holds sweep silently', async () => {
    const h = harness();
    const first = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    const second = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!first.ok || !second.ok) throw new Error('mint failed');
    expect(
      (await h.redeemer.service.applyInboundColdOffer({ senderDid: INVITER, body: first.value.offer })).ok,
    ).toBe(true);
    const throttled = await h.redeemer.service.applyInboundColdOffer({
      senderDid: INVITER,
      body: second.value.offer,
    });
    expect(!throttled.ok && throttled.refusal).toContain('already held');

    // Past the offer TTL the hold expires with no notice on the wire.
    h.clock.now = T0 + DEFAULT_INVITE_TTL_MS + 1;
    h.wire.length = 0;
    const swept = await h.redeemer.service.sweep();
    expect(swept.revoked).toBe(1);
    expect(h.wire.filter((m) => m.body.kind === 'revocation')).toHaveLength(0);
    expect(h.redeemer.repo.get(first.value.offer.nonce)?.state).toBe('revoked');
  });
});
describe('the offer signature is the ONLY origin proof (§8)', () => {
  it('a tampered offer with a recomputed digest but a stale signature refuses', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    // The attack the embedded signature exists for: the code travelled
    // over WhatsApp, someone edits what it grants and fixes the digest
    // up — but cannot re-sign without the inviter key.
    const { offer_digest: _oldDigest, inviter_signature, ...rest } = minted.value.offer;
    const widened = { ...rest, capabilities: [...CAPS, 'com.dinakernel.commerce.cancel_order'] };
    const tampered = {
      ...widened,
      offer_digest: inviteRecordDigest('invite_offer', widened, sha),
      inviter_signature,
    } as InviteOffer;
    const outcome = await h.redeemer.service.redeemCode({
      code: encodeInviteCode(tampered),
      serviceRkeys: ['veg-stall'],
    });
    expect(!outcome.ok && outcome.refusal).toContain('signature');
    expect(h.redeemer.repo.list()).toHaveLength(0);
  });

  it('a signature verifying under the WRONG resolved key refuses', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    // The redeemer resolves a DIFFERENT key for the inviter DID (a
    // directory that rotated, or an impersonation): must refuse.
    const otherPub = ed25519.getPublicKey(new Uint8Array(randomBytes(32)));
    const service = new InviteService({
      invites: new InMemoryInviteRepository(),
      nodeDid: () => REDEEMER,
      now: () => T0,
      relayUrl: () => 'wss://msgbox.example.dev',
      signOfferDigest: (bytes) => ed25519.sign(bytes, inviterPriv),
      resolveSigningKey: async () => otherPub,
      verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
      writeContact: () => undefined,
      removeContact: () => undefined,
      writeGrants: () => undefined,
      revokeGrants: () => undefined,
      hasPublishedCatalog: () => true,
      acceptColdInvites: () => true,
      notifyColdOffer: () => undefined,
      send: async () => true,
    });
    const outcome = await service.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['veg-stall'],
    });
    expect(!outcome.ok && outcome.refusal).toContain('signature');
  });
});

describe('the pasted code meets its own cold offer (§8 both-lanes delivery)', () => {
  it('redeeming a code whose nonce is already HELD continues as the accept — one exchange, not a 500', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    // The offer arrives COLD first (relay beat the WhatsApp paste).
    expect(
      (await h.redeemer.service.applyInboundColdOffer({ senderDid: INVITER, body: minted.value.offer })).ok,
    ).toBe(true);
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('held');
    // The paste IS consent: the ceremony continues at step 2.
    const outcome = await h.redeemer.service.redeemCode({
      code: minted.value.code,
      serviceRkeys: ['veg-stall'],
    });
    expect(outcome.ok).toBe(true);
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('redeemed');
    expect(h.wire.filter((m) => m.body.kind === 'redemption')).toHaveLength(1);
  });

  it('a code whose bytes differ from the held offer under the same nonce refuses (forgery, not duplicate)', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    expect(
      (await h.redeemer.service.applyInboundColdOffer({ senderDid: INVITER, body: minted.value.offer })).ok,
    ).toBe(true);
    // Same nonce, different grant, freshly re-signed WITH the inviter
    // key (the strongest forger): the held bytes still win.
    const { offer_digest: _d, inviter_signature: _s, ...rest } = minted.value.offer;
    const widened = { ...rest, capabilities: [...CAPS, 'com.dinakernel.commerce.cancel_order'] };
    const digest = inviteRecordDigest('invite_offer', widened, sha);
    const forged = {
      ...widened,
      offer_digest: digest,
      inviter_signature: Buffer.from(ed25519.sign(inviteOfferSigningBytes(digest), inviterPriv)).toString('hex'),
    } as InviteOffer;
    const outcome = await h.redeemer.service.redeemCode({
      code: encodeInviteCode(forged),
      serviceRkeys: ['veg-stall'],
    });
    expect(!outcome.ok && outcome.refusal).toContain('already used');
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('held');
  });
});

describe('cold-invite guardrails the first pass left unpinned', () => {
  it('acceptColdInvites=false drops the offer before any card', async () => {
    const cards: unknown[] = [];
    const repo = new InMemoryInviteRepository();
    const service = new InviteService({
      invites: repo,
      nodeDid: () => REDEEMER,
      now: () => T0,
      relayUrl: () => 'wss://msgbox.example.dev',
      signOfferDigest: (bytes) => ed25519.sign(bytes, inviterPriv),
      resolveSigningKey: async (target) => (target === INVITER ? inviterPub : null),
      verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
      writeContact: () => undefined,
      removeContact: () => undefined,
      writeGrants: () => undefined,
      revokeGrants: () => undefined,
      hasPublishedCatalog: () => true,
      acceptColdInvites: () => false,
      notifyColdOffer: (args) => cards.push(args),
      send: async () => true,
    });
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    const refused = await service.applyInboundColdOffer({ senderDid: INVITER, body: minted.value.offer });
    expect(refused.ok).toBe(false);
    expect(cards).toHaveLength(0);
    expect(repo.list()).toHaveLength(0);
  });

  it('the AGGREGATE hold cap refuses the seventeenth stranger', async () => {
    const repo = new InMemoryInviteRepository();
    const service = new InviteService({
      invites: repo,
      nodeDid: () => REDEEMER,
      now: () => T0,
      relayUrl: () => 'wss://msgbox.example.dev',
      signOfferDigest: (bytes) => ed25519.sign(bytes, inviterPriv),
      // EVERY sender resolves to the shared test key: sixteen strangers
      // without sixteen keypairs.
      resolveSigningKey: async () => inviterPub,
      verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
      writeContact: () => undefined,
      removeContact: () => undefined,
      writeGrants: () => undefined,
      revokeGrants: () => undefined,
      hasPublishedCatalog: () => true,
      acceptColdInvites: () => true,
      notifyColdOffer: () => undefined,
      send: async () => true,
    });
    const offerFrom = (sender: string): InviteOffer => {
      const minter = new InviteService({
        invites: new InMemoryInviteRepository(),
        nodeDid: () => sender,
        now: () => T0,
        relayUrl: () => 'wss://msgbox.example.dev',
        signOfferDigest: (bytes) => ed25519.sign(bytes, inviterPriv),
        resolveSigningKey: async () => inviterPub,
        verify: (message, signature, publicKey) => ed25519.verify(signature, message, publicKey),
        writeContact: () => undefined,
        removeContact: () => undefined,
        writeGrants: () => undefined,
        revokeGrants: () => undefined,
        hasPublishedCatalog: () => true,
        acceptColdInvites: () => true,
        notifyColdOffer: () => undefined,
        send: async () => true,
      });
      const minted = minter.mintOffer({
        direction: 'you_supply_me',
        serviceRkeys: RKEYS,
        capabilities: CAPS,
      });
      if (!minted.ok) throw new Error(minted.refusal);
      return minted.value.offer;
    };
    for (let i = 0; i < 16; i += 1) {
      const sender = `did:plc:stranger${String(i).padStart(17, '0')}`;
      expect((await service.applyInboundColdOffer({ senderDid: sender, body: offerFrom(sender) })).ok).toBe(true);
    }
    const seventeenth = 'did:plc:stranger00000000000000016';
    const overflow = await service.applyInboundColdOffer({
      senderDid: seventeenth,
      body: offerFrom(seventeenth),
    });
    expect(overflow.ok).toBe(false);
    expect(repo.list().filter((row) => row.state === 'held')).toHaveLength(16);
  });
});

describe('late and unknown messages', () => {
  it('an unknown nonce refuses at the inviter (the nonce IS the credential)', async () => {
    const h = harness();
    const outcome = await h.inviter.service.applyInboundRedemption({
      senderDid: REDEEMER,
      body: {
        protocol_version: '1.0',
        redemption_id: 'red-unknown',
        offer_digest: 'a'.repeat(64),
        nonce: 'f'.repeat(32),
        redeemer_did: REDEEMER,
        service_rkeys: ['veg-stall'],
        redeemed_at: '2027-01-15T08:00:00.000Z',
      },
    });
    expect(outcome.ok).toBe(false);
  });

  it('messages for a REVOKED exchange refuse — nothing resurrects', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'you_supply_me',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['veg-stall'] });
    // Deliver ONLY the redemption; the confirmation stays on the wire.
    const redemptionMsg = h.wire.shift();
    if (redemptionMsg === undefined) throw new Error('no redemption queued');
    await h.inviter.service.applyInboundRedemption({
      senderDid: REDEEMER,
      body: (redemptionMsg.body as { document: unknown }).document,
    });
    // The exchange dies before the confirmation lands (the sweep's
    // teardown, compressed to its stored effect).
    const row = h.redeemer.repo.get(minted.value.offer.nonce);
    if (row === null) throw new Error('no redeemer row');
    h.redeemer.repo.put({ ...row, state: 'revoked' });
    const late = h.wire.find((m) => m.body.kind === 'confirmation');
    if (late === undefined) throw new Error('no confirmation queued');
    const outcome = await h.redeemer.service.applyInboundConfirmation({
      senderDid: INVITER,
      body: (late.body as { document: unknown }).document,
    });
    expect(outcome.ok).toBe(false);
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('revoked');
  });
});
describe('the cold-offer SENDER (§8 — the lane finally has one)', () => {
  it('mint → sendOffer → held at the stranger → accept completes the ceremony', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'i_supply_you',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);

    const sent = await h.inviter.service.sendOffer({
      nonce: minted.value.offer.nonce,
      toDid: REDEEMER,
    });
    expect(sent.ok && sent.value.dispatched).toBe(true);
    // The wire now carries the OFFER itself; deliver it cold.
    await h.pump();
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('held');
    expect(h.redeemer.coldCards).toHaveLength(1);

    // The consent tap continues at step 2 and the ceremony completes.
    const accepted = await h.redeemer.service.acceptHeldOffer({
      nonce: minted.value.offer.nonce,
      serviceRkeys: ['veg-stall'],
    });
    expect(accepted.ok && accepted.value.dispatched).toBe(true);
    await h.pump();
    await h.pump();
    await h.pump();
    expect(h.redeemer.repo.get(minted.value.offer.nonce)?.state).toBe('active');
    expect(h.inviter.repo.get(minted.value.offer.nonce)?.state).toBe('active');
  });

  it('re-send while offered is idempotent; sent to self, unknown, or under-way exchanges refuse', async () => {
    const h = harness();
    const minted = h.inviter.service.mintOffer({
      direction: 'i_supply_you',
      serviceRkeys: RKEYS,
      capabilities: CAPS,
    });
    if (!minted.ok) throw new Error(minted.refusal);
    const nonce = minted.value.offer.nonce;

    expect((await h.inviter.service.sendOffer({ nonce, toDid: REDEEMER })).ok).toBe(true);
    expect((await h.inviter.service.sendOffer({ nonce, toDid: REDEEMER })).ok).toBe(true);
    expect(h.wire.filter((m) => m.body.kind === 'offer')).toHaveLength(2);
    const same = h.wire.filter((m) => m.body.kind === 'offer').map((m) => JSON.stringify(m.body));
    expect(same[0]).toBe(same[1]); // the SAME bytes — nothing re-minted

    const toSelf = await h.inviter.service.sendOffer({ nonce, toDid: INVITER });
    expect(!toSelf.ok && toSelf.refusal).toContain('somebody else');
    const unknown = await h.inviter.service.sendOffer({ nonce: 'f'.repeat(32), toDid: REDEEMER });
    expect(unknown.ok).toBe(false);

    // Once the exchange moves past 'offered', re-broadcast refuses.
    await h.pump();
    await h.redeemer.service.redeemCode({ code: minted.value.code, serviceRkeys: ['veg-stall'] });
    await h.pump();
    const underWay = await h.inviter.service.sendOffer({ nonce, toDid: REDEEMER });
    expect(!underWay.ok && underWay.refusal).toContain('already');
  });
});
