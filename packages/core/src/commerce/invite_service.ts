/**
 * The invite ceremony's state machine (TRADE_FIRST_STRATEGY §8) —
 * offered → redeemed → active | revoked, per role, keyed by the
 * single-use nonce.
 *
 * ORDERED ACTIVATION, exactly as §8 claims it: the redeemer activates
 * FIRST, on durably storing the confirmation (contact + grants written
 * in that same act), and answers with the ActivationAck; the inviter
 * activates on the ack. The asymmetric window is safe by construction —
 * each side's grant only ENABLES the other side's requests, and the
 * not-yet-active side sends none.
 *
 * IDEMPOTENT RE-SEND is the loss story. Every message pins its
 * predecessor's digest and the nonce keys the whole exchange, so a
 * replay of a message this node already answered re-produces the SAME
 * answer (the inviter's AckReceipt pong is the load-bearing case: it is
 * the redeemer's activation PROOF). A DIFFERENT message under a used
 * nonce refuses — single-use means one redemption, ever.
 *
 * TWO-SIDED REVOCATION. Past the offer's TTL an unfinished exchange
 * resolves by compensating revocation on whichever side is stuck, each
 * sending a best-effort RevocationNotice so neither direction retains
 * one-sided state. Idleness alone never triggers anything: a redeemer
 * holding activation proof stands for ever.
 *
 * WHO GRANTS WHAT. The SUPPLIER side grants the offer's capability set
 * on its own rkeys to the counterparty; the buyer side writes only the
 * contact (inbound khata documents ride `commerce.trade` under
 * known-contact trust — no execution grant exists to write).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  decodeInviteCode,
  encodeInviteCode,
  inviteOfferSigningBytes,
  inviteRecordDigest,
  validateInviteActivationAck,
  validateInviteAckReceipt,
  validateInviteConfirmation,
  validateInviteOffer,
  validateInviteRedemption,
  validateInviteRevocationNotice,
  type InviteActivationAck,
  type InviteAckReceipt,
  type InviteConfirmation,
  type InviteDirection,
  type InviteOffer,
  type InviteRedemption,
  type InviteRevocationNotice,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import {
  rehydrateStoredInviteActivationAck,
  rehydrateStoredInviteConfirmation,
  rehydrateStoredInviteOffer,
  rehydrateStoredInviteRedemption,
} from './rehydrate';

import type { InviteRepository, InviteRole, InviteRow } from './invite_store';

const hash: Sha256Fn = (data) => sha256(data);

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

/** How long an offer stands unless the owner says otherwise: 7 days. A
 *  vendor onboards in a shop visit, not a quarter. */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a redeemer waits for activation proof before tearing down:
 *  3 days past its own activation, re-sending the ack as it waits. */
export const ACTIVATION_PROOF_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** §8 cold invites — the aggregate holding cap. Sixteen pending
 *  introductions is a queue nobody is reading; more is pressure. */
export const COLD_INVITE_MAX_HELD = 16;

export interface InviteServiceDeps {
  invites: InviteRepository;
  nodeDid: () => string;
  now: () => number;
  /** The relay this node is reachable on, for the offer. Null = cannot mint. */
  relayUrl: () => string | null;
  /** Signs the offer's embedded signature with THIS node's signing key. */
  signOfferDigest: (bytes: Uint8Array) => Uint8Array;
  /** Resolves a DID's signing key for offer verification. Null = unresolvable. */
  resolveSigningKey: (did: string) => Promise<Uint8Array | null>;
  verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
  /** Durable activation writes — the contact entry and (supplier side) grants. */
  writeContact: (did: string) => void;
  removeContact: (did: string) => void;
  writeGrants: (args: {
    granteeDid: string;
    serviceRkeys: readonly string[];
    capabilities: readonly string[];
  }) => void;
  revokeGrants: (granteeDid: string) => void;
  /** Dispatch a `commerce.invite` message. False = nothing left this node. */
  send: (toDid: string, body: Record<string, unknown>) => Promise<boolean>;
  /**
   * §8 cold invites — does this node PUBLISH a commerce catalog?
   * Publishing one is the act of consenting to receive introductions;
   * a node with none refuses cold offers outright.
   */
  hasPublishedCatalog: () => boolean;
  /** §8 cold invites — the owner's refuse-all policy switch. */
  acceptColdInvites: () => boolean;
  /**
   * Surface a held cold offer to the owner (a consent card). Courtesy,
   * not gatekeeping: the held row exists and is listable either way.
   */
  notifyColdOffer: (args: {
    nonce: string;
    inviterDid: string;
    direction: InviteDirection;
    capabilities: readonly string[];
  }) => void;
}

export type InviteOutcome<T> = { ok: true; value: T } | { ok: false; refusal: string };

function refuse<T>(refusal: string): InviteOutcome<T> {
  return { ok: false, refusal };
}

function mintId(prefix: string): string {
  return `${prefix}_${bytesToHex(randomBytes(12))}`;
}

/** Which party supplies, given the direction and the role reading it. */
export function supplierRole(direction: InviteDirection): InviteRole {
  return direction === 'i_supply_you' ? 'inviter' : 'redeemer';
}

export class InviteService {
  constructor(private readonly deps: InviteServiceDeps) {}

  private iso(nowMs: number): string {
    return new Date(nowMs).toISOString();
  }

  // -------------------------------------------------------------------------
  // Inviter side
  // -------------------------------------------------------------------------

  mintOffer(args: {
    direction: InviteDirection;
    serviceRkeys: readonly string[];
    capabilities: readonly string[];
    ttlMs?: number;
  }): InviteOutcome<{ offer: InviteOffer; code: string }> {
    const relay = this.deps.relayUrl();
    if (relay === null) return refuse('this node has no relay route to put in an offer');
    const now = this.deps.now();
    const expiresAtMs = now + (args.ttlMs ?? DEFAULT_INVITE_TTL_MS);
    const draft = {
      protocol_version: '1.0',
      offer_id: mintId('inv'),
      inviter_did: this.deps.nodeDid(),
      relay_url: relay,
      direction: args.direction,
      service_rkeys: args.serviceRkeys,
      capabilities: args.capabilities,
      nonce: bytesToHex(randomBytes(32)),
      expires_at: this.iso(expiresAtMs),
    };
    const offerDigest = inviteRecordDigest('invite_offer', draft, hash);
    const offer: InviteOffer = {
      ...draft,
      offer_digest: offerDigest,
      inviter_signature: bytesToHex(this.deps.signOfferDigest(inviteOfferSigningBytes(offerDigest))),
    };
    const shapeError = validateInviteOffer(offer, hash);
    if (shapeError !== null) return refuse(shapeError);
    this.deps.invites.put({
      nonce: offer.nonce,
      role: 'inviter',
      state: 'offered',
      direction: offer.direction,
      counterpartyDid: '',
      offerJson: JSON.stringify(offer),
      redemptionJson: '',
      confirmationJson: '',
      ackJson: '',
      activationProvenAt: null,
      expiresAt: expiresAtMs,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, value: { offer, code: encodeInviteCode(offer) } };
  }

  /** The inviter's inbound: a redemption arrives over the relay. */
  async applyInboundRedemption(args: {
    senderDid: string;
    body: unknown;
  }): Promise<InviteOutcome<{ confirmation: InviteConfirmation; resent: boolean }>> {
    const bad = validateInviteRedemption(args.body, hash);
    if (bad !== null) return refuse(bad);
    const redemption = args.body as InviteRedemption;
    if (redemption.redeemer_did !== args.senderDid) {
      // The transport-authenticated sender is the authority; a body
      // naming someone else is a confused-deputy attempt.
      return refuse('redemption redeemer does not match the authenticated sender');
    }
    const row = this.deps.invites.get(redemption.nonce);
    if (row === null || row.role !== 'inviter') return refuse('no such offer');
    const offer = rehydrateStoredInviteOffer(row.offerJson);
    if (redemption.offer_digest !== offer.offer_digest) {
      return refuse('redemption answers a different offer');
    }
    if (row.state === 'revoked') return refuse('the offer was revoked');
    const now = this.deps.now();

    if (row.state === 'offered') {
      if (now >= row.expiresAt) return refuse('the offer expired');
      const confirmationDraft = {
        protocol_version: offer.protocol_version,
        confirmation_id: mintId('conf'),
        redemption_digest: redemption.redemption_digest,
        nonce: offer.nonce,
        confirmed_at: this.iso(now),
      };
      const confirmation: InviteConfirmation = {
        ...confirmationDraft,
        confirmation_digest: inviteRecordDigest('invite_confirmation', confirmationDraft, hash),
      };
      this.deps.invites.put({
        ...row,
        state: 'redeemed',
        counterpartyDid: redemption.redeemer_did,
        redemptionJson: JSON.stringify(redemption),
        confirmationJson: JSON.stringify(confirmation),
        updatedAt: now,
      });
      await this.deps.send(redemption.redeemer_did, {
        kind: 'confirmation',
        document: confirmation,
      });
      return { ok: true, value: { confirmation, resent: false } };
    }

    // Redeemed or active: a RE-SENT redemption from the SAME redeemer with
    // the SAME digest gets the same confirmation back — the loss story.
    // Anything else under a used nonce refuses: single-use means one
    // redemption, ever.
    const stored = row.redemptionJson === '' ? null : rehydrateStoredInviteRedemption(row.redemptionJson);
    if (
      stored === null ||
      stored.redemption_digest !== redemption.redemption_digest ||
      row.counterpartyDid !== args.senderDid
    ) {
      return refuse('the offer nonce is already used');
    }
    const confirmation = rehydrateStoredInviteConfirmation(row.confirmationJson);
    await this.deps.send(args.senderDid, { kind: 'confirmation', document: confirmation });
    return { ok: true, value: { confirmation, resent: true } };
  }

  /** The inviter's inbound: the ActivationAck — the inviter ACTIVATES here. */
  async applyInboundActivationAck(args: {
    senderDid: string;
    body: unknown;
  }): Promise<InviteOutcome<{ receipt: InviteAckReceipt; resent: boolean }>> {
    const bad = validateInviteActivationAck(args.body, hash);
    if (bad !== null) return refuse(bad);
    const ack = args.body as InviteActivationAck;
    const row = this.deps.invites.get(ack.nonce);
    if (row === null || row.role !== 'inviter') return refuse('no such offer');
    if (row.state === 'revoked') return refuse('the offer was revoked');
    if (row.counterpartyDid !== args.senderDid) {
      return refuse('ack sender is not the redeemer of this offer');
    }
    const confirmation =
      row.confirmationJson === '' ? null : rehydrateStoredInviteConfirmation(row.confirmationJson);
    if (confirmation === null || ack.confirmation_digest !== confirmation.confirmation_digest) {
      return refuse('ack answers a different confirmation');
    }
    const now = this.deps.now();

    const pong = (storedAckJson: string): InviteAckReceipt => {
      const receiptDraft = {
        protocol_version: ack.protocol_version,
        receipt_id: mintId('ackr'),
        ack_digest: rehydrateStoredInviteActivationAck(storedAckJson).ack_digest,
        nonce: ack.nonce,
        received_at: this.iso(now),
      };
      return {
        ...receiptDraft,
        receipt_digest: inviteRecordDigest('invite_ack_receipt', receiptDraft, hash),
      };
    };

    if (row.state === 'redeemed') {
      // ACTIVATION: the durable writes, then the pong. The contact is
      // written on both directions; grants only when THIS side supplies.
      this.deps.writeContact(row.counterpartyDid);
      if (supplierRole(row.direction) === 'inviter') {
        const offer = rehydrateStoredInviteOffer(row.offerJson);
        this.deps.writeGrants({
          granteeDid: row.counterpartyDid,
          serviceRkeys: offer.service_rkeys,
          capabilities: offer.capabilities,
        });
      }
      this.deps.invites.put({ ...row, state: 'active', ackJson: JSON.stringify(ack), updatedAt: now });
      const receipt = pong(JSON.stringify(ack));
      await this.deps.send(args.senderDid, { kind: 'ack_receipt', document: receipt });
      return { ok: true, value: { receipt, resent: false } };
    }

    // Active: the idempotent pong (§8's activation-proof answer). Only for
    // the SAME ack this row activated on.
    const storedAck = row.ackJson === '' ? null : rehydrateStoredInviteActivationAck(row.ackJson);
    if (storedAck === null || storedAck.ack_digest !== ack.ack_digest) {
      return refuse('a different ack under a used nonce');
    }
    const receipt = pong(row.ackJson);
    await this.deps.send(args.senderDid, { kind: 'ack_receipt', document: receipt });
    return { ok: true, value: { receipt, resent: true } };
  }

  /**
   * §8's COLD LEG, sender side: dispatch a minted offer over the relay
   * to a DID discovered in search, instead of handing the code over
   * WhatsApp. The receive side has always existed
   * (`applyInboundColdOffer` holds the offer for a consent card); until
   * now nothing in the product could SEND one. Idempotent while the
   * offer is still open — a re-send carries the same bytes; anything
   * past 'offered' is an exchange already under way, and re-broadcasting
   * its offer could only fork it.
   */
  async sendOffer(args: {
    nonce: string;
    toDid: string;
  }): Promise<InviteOutcome<{ dispatched: boolean }>> {
    if (args.toDid === '' || args.toDid === this.deps.nodeDid()) {
      return refuse('a cold offer travels to somebody else');
    }
    const row = this.deps.invites.get(args.nonce);
    if (row === null || row.role !== 'inviter') {
      return refuse('no minted offer with that nonce');
    }
    if (row.state !== 'offered') {
      return refuse(`the exchange is already ${row.state}`);
    }
    const offer = rehydrateStoredInviteOffer(row.offerJson);
    if (Date.parse(offer.expires_at) <= this.deps.now()) {
      return refuse('the offer expired');
    }
    const dispatched = await this.deps.send(args.toDid, { kind: 'offer', document: offer });
    return { ok: true, value: { dispatched } };
  }

  // -------------------------------------------------------------------------
  // Redeemer side
  // -------------------------------------------------------------------------

  /** Redeem a pasted/scanned code: verify, store, send the redemption. */
  async redeemCode(args: {
    code: string;
    serviceRkeys: readonly string[];
  }): Promise<InviteOutcome<{ redemption: InviteRedemption; resent: boolean; dispatched: boolean }>> {
    const decoded = decodeInviteCode(args.code, hash);
    if ('error' in decoded) return refuse(decoded.error);
    const offer = decoded.offer;
    const now = this.deps.now();
    if (Date.parse(offer.expires_at) <= now) return refuse('the offer expired');
    if (offer.inviter_did === this.deps.nodeDid()) return refuse('a node cannot redeem its own offer');

    // The embedded signature is the offer's ONLY origin proof — the string
    // travelled outside any envelope. Unresolvable key = unverifiable = no.
    const key = await this.deps.resolveSigningKey(offer.inviter_did);
    if (key === null) return refuse('cannot resolve the inviter signing key');
    const signature = hexToBytes(offer.inviter_signature);
    if (
      signature === null ||
      !this.deps.verify(inviteOfferSigningBytes(offer.offer_digest), signature, key)
    ) {
      return refuse('the offer signature does not verify');
    }

    const existing = this.deps.invites.get(offer.nonce);
    if (existing !== null) {
      if (existing.role !== 'redeemer' || existing.state === 'revoked') {
        return refuse('this offer nonce is already used');
      }
      if (existing.state === 'held') {
        // The same offer arrived COLD over the relay while the code
        // travelled by hand (§8 sends both in one message). The paste IS
        // consent — same as tapping the held card — and the held row has
        // no redemption to re-send, so continue at the accept step. The
        // stored offer must be the one pasted: a held row under a nonce
        // whose bytes differ is a forgery, not a duplicate.
        const held = rehydrateStoredInviteOffer(existing.offerJson);
        if (held.offer_digest !== offer.offer_digest) {
          return refuse('this offer nonce is already used');
        }
        const accepted = await this.acceptHeldOffer({
          nonce: offer.nonce,
          serviceRkeys: args.serviceRkeys,
        });
        return accepted.ok
          ? {
              ok: true,
              value: {
                redemption: accepted.value.redemption,
                resent: false,
                dispatched: accepted.value.dispatched,
              },
            }
          : accepted;
      }
      // Idempotent re-redeem: re-send the SAME stored redemption.
      const stored = rehydrateStoredInviteRedemption(existing.redemptionJson);
      const redispatched = await this.deps.send(offer.inviter_did, {
        kind: 'redemption',
        document: stored,
      });
      return { ok: true, value: { redemption: stored, resent: true, dispatched: redispatched } };
    }

    const redemptionDraft = {
      protocol_version: offer.protocol_version,
      redemption_id: mintId('red'),
      offer_digest: offer.offer_digest,
      nonce: offer.nonce,
      redeemer_did: this.deps.nodeDid(),
      service_rkeys: args.serviceRkeys,
      redeemed_at: this.iso(now),
    };
    const redemption: InviteRedemption = {
      ...redemptionDraft,
      redemption_digest: inviteRecordDigest('invite_redemption', redemptionDraft, hash),
    };
    const shapeError = validateInviteRedemption(redemption, hash);
    if (shapeError !== null) return refuse(shapeError);
    this.deps.invites.put({
      nonce: offer.nonce,
      role: 'redeemer',
      state: 'redeemed',
      direction: offer.direction,
      counterpartyDid: offer.inviter_did,
      offerJson: JSON.stringify(offer),
      redemptionJson: JSON.stringify(redemption),
      confirmationJson: '',
      ackJson: '',
      activationProvenAt: null,
      expiresAt: Date.parse(offer.expires_at),
      createdAt: now,
      updatedAt: now,
    });
    // BEST-EFFORT BY DESIGN (the khata dispatch rule): the row is stored
    // either way and a re-paste re-sends — but the caller must SEE a
    // failed dispatch, or a denied egress reads as a working ceremony.
    const dispatched = await this.deps.send(offer.inviter_did, {
      kind: 'redemption',
      document: redemption,
    });
    return { ok: true, value: { redemption, resent: false, dispatched } };
  }

  /** The redeemer's inbound: the confirmation — the redeemer ACTIVATES here. */
  async applyInboundConfirmation(args: {
    senderDid: string;
    body: unknown;
  }): Promise<InviteOutcome<{ ack: InviteActivationAck; resent: boolean }>> {
    const bad = validateInviteConfirmation(args.body, hash);
    if (bad !== null) return refuse(bad);
    const confirmation = args.body as InviteConfirmation;
    const row = this.deps.invites.get(confirmation.nonce);
    if (row === null || row.role !== 'redeemer') return refuse('no such redemption');
    if (row.state === 'revoked') return refuse('this exchange was revoked');
    if (row.counterpartyDid !== args.senderDid) {
      return refuse('confirmation sender is not the inviter of this offer');
    }
    const redemption = rehydrateStoredInviteRedemption(row.redemptionJson);
    if (confirmation.redemption_digest !== redemption.redemption_digest) {
      return refuse('confirmation answers a different redemption');
    }
    const now = this.deps.now();

    if (row.state === 'redeemed') {
      // ACTIVATION FIRST (§8): the durable writes commit BEFORE the ack
      // leaves, because the ack's meaning is "I have committed".
      this.deps.writeContact(row.counterpartyDid);
      if (supplierRole(row.direction) === 'redeemer') {
        this.deps.writeGrants({
          granteeDid: row.counterpartyDid,
          serviceRkeys: redemption.service_rkeys,
          capabilities: rehydrateStoredInviteOffer(row.offerJson).capabilities,
        });
      }
      const ackDraft = {
        protocol_version: confirmation.protocol_version,
        ack_id: mintId('ack'),
        confirmation_digest: confirmation.confirmation_digest,
        nonce: confirmation.nonce,
        activated_at: this.iso(now),
      };
      const ack: InviteActivationAck = {
        ...ackDraft,
        ack_digest: inviteRecordDigest('invite_activation_ack', ackDraft, hash),
      };
      this.deps.invites.put({
        ...row,
        state: 'active',
        confirmationJson: JSON.stringify(confirmation),
        ackJson: JSON.stringify(ack),
        updatedAt: now,
      });
      await this.deps.send(args.senderDid, { kind: 'activation_ack', document: ack });
      return { ok: true, value: { ack, resent: false } };
    }

    // Active already: the same confirmation re-arrived — re-send the ack.
    const storedConfirmation =
      row.confirmationJson === '' ? null : rehydrateStoredInviteConfirmation(row.confirmationJson);
    if (
      storedConfirmation === null ||
      storedConfirmation.confirmation_digest !== confirmation.confirmation_digest
    ) {
      return refuse('a different confirmation under a used nonce');
    }
    const ack = rehydrateStoredInviteActivationAck(row.ackJson);
    await this.deps.send(args.senderDid, { kind: 'activation_ack', document: ack });
    return { ok: true, value: { ack, resent: true } };
  }

  /** The redeemer's inbound: the AckReceipt — activation PROOF. */
  applyInboundAckReceipt(args: { senderDid: string; body: unknown }): InviteOutcome<null> {
    const bad = validateInviteAckReceipt(args.body, hash);
    if (bad !== null) return refuse(bad);
    const receipt = args.body as InviteAckReceipt;
    const row = this.deps.invites.get(receipt.nonce);
    if (row === null || row.role !== 'redeemer' || row.state !== 'active') {
      return refuse('no active redemption for this receipt');
    }
    if (row.counterpartyDid !== args.senderDid) return refuse('receipt sender is not the inviter');
    const ack = rehydrateStoredInviteActivationAck(row.ackJson);
    if (receipt.ack_digest !== ack.ack_digest) return refuse('receipt answers a different ack');
    this.markActivationProven(row);
    return { ok: true, value: null };
  }

  /**
   * §8's activation-proof rule: ANY authenticated inbound envelope from
   * the inviter counts. Called by the receive pipeline per accepted
   * message; O(active redeemer rows awaiting proof), which is ~0.
   */
  noteAuthenticatedInbound(senderDid: string): void {
    for (const row of this.deps.invites.listByState('active')) {
      if (row.role !== 'redeemer') continue;
      if (row.activationProvenAt !== null) continue;
      if (row.counterpartyDid !== senderDid) continue;
      this.markActivationProven(row);
    }
  }

  private markActivationProven(row: InviteRow): void {
    this.deps.invites.put({ ...row, activationProvenAt: this.deps.now(), updatedAt: this.deps.now() });
  }

  // -------------------------------------------------------------------------
  // Cold invites (§8 second half)
  // -------------------------------------------------------------------------

  /**
   * A relay-delivered InviteOffer from a shortlisted stranger. The
   * receiving node renders a consent card and writes NOTHING beyond the
   * held row before the owner accepts — never auto-redeemed; per-sender
   * and aggregate throttles apply; ignoring one costs nothing (it
   * expires out of the sweep); and refuse-all policy drops it before
   * the card.
   */
  async applyInboundColdOffer(args: {
    senderDid: string;
    body: unknown;
  }): Promise<InviteOutcome<{ held: boolean }>> {
    const bad = validateInviteOffer(args.body, hash);
    if (bad !== null) return refuse(bad);
    const offer = args.body as InviteOffer;
    if (offer.inviter_did !== args.senderDid) {
      return refuse('cold offer inviter does not match the authenticated sender');
    }
    if (offer.inviter_did === this.deps.nodeDid()) return refuse('a node cannot invite itself');
    const now = this.deps.now();
    if (Date.parse(offer.expires_at) <= now) return refuse('the offer expired');
    if (!this.deps.acceptColdInvites()) return refuse('this node refuses cold invites');
    // Publishing a catalog is the CONSENT to receive introductions.
    if (!this.deps.hasPublishedCatalog()) {
      return refuse('this node publishes no catalog and accepts no cold introductions');
    }
    // The relay envelope authenticated the sender; the EMBEDDED signature
    // still has to verify — the offer's own origin proof, and the value
    // the accept step will trust.
    const key = await this.deps.resolveSigningKey(offer.inviter_did);
    if (key === null) return refuse('cannot resolve the inviter signing key');
    const signature = hexToBytes(offer.inviter_signature);
    if (
      signature === null ||
      !this.deps.verify(inviteOfferSigningBytes(offer.offer_digest), signature, key)
    ) {
      return refuse('the offer signature does not verify');
    }

    const existing = this.deps.invites.get(offer.nonce);
    if (existing !== null) {
      // A byte-identical re-delivery of a held offer is one offer.
      return existing.role === 'redeemer' && existing.state === 'held'
        ? { ok: true, value: { held: true } }
        : refuse('this offer nonce is already used');
    }

    // Throttles — the §3.4 spam vector by another door. Counted over
    // HELD rows only: an accepted introduction is a relationship, not
    // pressure.
    const held = this.deps.invites.listByState('held');
    if (held.length >= COLD_INVITE_MAX_HELD) return refuse('cold invite holding is full');
    if (held.some((row) => row.counterpartyDid === args.senderDid)) {
      return refuse('a cold offer from this sender is already held');
    }

    this.deps.invites.put({
      nonce: offer.nonce,
      role: 'redeemer',
      state: 'held',
      direction: offer.direction,
      counterpartyDid: offer.inviter_did,
      offerJson: JSON.stringify(offer),
      redemptionJson: '',
      confirmationJson: '',
      ackJson: '',
      activationProvenAt: null,
      expiresAt: Date.parse(offer.expires_at),
      createdAt: now,
      updatedAt: now,
    });
    this.deps.notifyColdOffer({
      nonce: offer.nonce,
      inviterDid: offer.inviter_did,
      direction: offer.direction,
      capabilities: offer.capabilities,
    });
    return { ok: true, value: { held: true } };
  }

  /** The owner's consent tap on a held cold offer: continue at §8 step 2. */
  async acceptHeldOffer(args: {
    nonce: string;
    serviceRkeys: readonly string[];
  }): Promise<InviteOutcome<{ redemption: InviteRedemption; dispatched: boolean }>> {
    const row = this.deps.invites.get(args.nonce);
    if (row === null || row.role !== 'redeemer' || row.state !== 'held') {
      return refuse('no held offer with that nonce');
    }
    const offer = rehydrateStoredInviteOffer(row.offerJson);
    const now = this.deps.now();
    if (Date.parse(offer.expires_at) <= now) return refuse('the offer expired');

    const redemptionDraft = {
      protocol_version: offer.protocol_version,
      redemption_id: mintId('red'),
      offer_digest: offer.offer_digest,
      nonce: offer.nonce,
      redeemer_did: this.deps.nodeDid(),
      service_rkeys: args.serviceRkeys,
      redeemed_at: this.iso(now),
    };
    const redemption: InviteRedemption = {
      ...redemptionDraft,
      redemption_digest: inviteRecordDigest('invite_redemption', redemptionDraft, hash),
    };
    const shapeError = validateInviteRedemption(redemption, hash);
    if (shapeError !== null) return refuse(shapeError);
    this.deps.invites.put({
      ...row,
      state: 'redeemed',
      redemptionJson: JSON.stringify(redemption),
      updatedAt: now,
    });
    const dispatched = await this.deps.send(offer.inviter_did, {
      kind: 'redemption',
      document: redemption,
    });
    return { ok: true, value: { redemption, dispatched } };
  }

  // -------------------------------------------------------------------------
  // Revocation — both directions
  // -------------------------------------------------------------------------

  /** An inbound RevocationNotice from the counterparty: tear down. */
  applyInboundRevocation(args: { senderDid: string; body: unknown }): InviteOutcome<null> {
    const bad = validateInviteRevocationNotice(args.body, hash);
    if (bad !== null) return refuse(bad);
    const notice = args.body as InviteRevocationNotice;
    const row = this.deps.invites.get(notice.nonce);
    if (row === null) return refuse('no such exchange');
    if (row.counterpartyDid !== args.senderDid) {
      return refuse('revocation sender is not this exchange counterparty');
    }
    this.tearDown(row);
    return { ok: true, value: null };
  }

  private tearDown(row: InviteRow): void {
    if (row.state === 'active') {
      this.deps.removeContact(row.counterpartyDid);
      this.deps.revokeGrants(row.counterpartyDid);
    }
    this.deps.invites.put({ ...row, state: 'revoked', updatedAt: this.deps.now() });
  }

  private async sendRevocation(row: InviteRow, reason: 'expired' | 'no_activation_proof'): Promise<void> {
    if (row.counterpartyDid === '') return;
    const draft = {
      protocol_version: '1.0',
      revocation_id: mintId('rev'),
      nonce: row.nonce,
      reason,
      revoked_at: this.iso(this.deps.now()),
    };
    const notice: InviteRevocationNotice = {
      ...draft,
      revocation_digest: inviteRecordDigest('invite_revocation', draft, hash),
    };
    // Best-effort by design: the other side's own sweep converges anyway.
    await this.deps.send(row.counterpartyDid, { kind: 'revocation', document: notice });
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * Resolve stuck exchanges. Idleness alone never triggers anything —
   * every branch keys on the offer TTL or the activation-proof window,
   * and an ACTIVE row with proof stands untouched for ever.
   */
  async sweep(): Promise<{ revoked: number; ackResent: number }> {
    const now = this.deps.now();
    let revoked = 0;
    let ackResent = 0;
    for (const row of this.deps.invites.list()) {
      if (row.state === 'revoked') continue;

      if (row.role === 'inviter') {
        // Unfinished past the TTL: compensating revocation, told to the
        // counterparty when one exists.
        if (row.state !== 'active' && now >= row.expiresAt) {
          await this.sendRevocation(row, 'expired');
          this.tearDown(row);
          revoked += 1;
        }
        continue;
      }

      // Redeemer.
      if (row.state === 'held' && now >= row.expiresAt) {
        // Ignoring a cold offer costs the receiver nothing: it expires
        // with no notice and no writes to unwind.
        this.deps.invites.put({ ...row, state: 'revoked', updatedAt: now });
        revoked += 1;
        continue;
      }
      if (row.state === 'redeemed' && now >= row.expiresAt) {
        // Never confirmed and the offer is dead: local teardown (nothing
        // was written; no counterparty state exists to notify away).
        this.tearDown(row);
        revoked += 1;
        continue;
      }
      if (row.state === 'active' && row.activationProvenAt === null) {
        const waitedMs = now - row.updatedAt;
        if (waitedMs >= ACTIVATION_PROOF_WINDOW_MS) {
          // No proof after the window: tear down AND tell the inviter, so
          // neither direction retains one-sided state.
          await this.sendRevocation(row, 'no_activation_proof');
          this.tearDown(row);
          revoked += 1;
        } else {
          // Re-send the ack: an alive, active inviter answers with the
          // idempotent AckReceipt, which IS the proof.
          const ack = rehydrateStoredInviteActivationAck(row.ackJson);
          await this.deps.send(row.counterpartyDid, { kind: 'activation_ack', document: ack });
          ackResent += 1;
        }
      }
    }
    return { revoked, ackResent };
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
