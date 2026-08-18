/**
 * §8 composition seam. The invite machine needs four facts only the app
 * layer holds — the signing key, DID-document resolution, the relay
 * route, and nothing else — so the BOOT calls `composeInviteService`
 * with those and this module fills in everything Core already owns:
 * the runtime's invite store, the D2D sender, the contact gate, and the
 * service-grant repository.
 *
 * FAIL-CLOSED WRITES. Activation writes grants through the singleton
 * grant repository; on a node where it is not wired, a supplier-side
 * activation THROWS rather than activating a relationship whose grants
 * silently do not exist — half an activation is worse than none, and
 * the thrown refusal keeps the exchange retryable.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { addContactIfNotExists, deleteContact } from '../contacts/directory';
import { getD2DSender } from '../server/routes/d2d_msg';
import { getServiceGrantRepository } from '../service/service_grant_repository';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import { InviteService } from './invite_service';
import { getCommerceRuntime } from './runtime';


export interface InviteAppDeps {
  /** Signs the offer's embedded signature with THIS node's signing key. */
  signOfferDigest: (bytes: Uint8Array) => Uint8Array;
  /** Resolves a DID's signing key (DID-document lookup). Null = cannot. */
  resolveSigningKey: (did: string) => Promise<Uint8Array | null>;
  verify: (message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => boolean;
  /** The relay this node is reachable on. Null = offers cannot be minted. */
  relayUrl: () => string | null;
}

let service: InviteService | null = null;

export function installInviteService(value: InviteService | null): void {
  service = value;
}

/** Null until a boot composes it. Callers must fail closed. */
export function getInviteService(): InviteService | null {
  return service;
}

/** Build the service over Core's own seams and INSTALL it. */
export function composeInviteService(app: InviteAppDeps): InviteService {
  const composed = new InviteService({
    invites: {
      // Resolved per call: commerce storage may initialise after this
      // composition runs, and a captured null repo would be forever null.
      put: (row) => requireRuntime().invites.put(row),
      get: (nonce) => requireRuntime().invites.get(nonce),
      list: () => requireRuntime().invites.list(),
      listByState: (state) => requireRuntime().invites.listByState(state),
    },
    nodeDid: () => requireRuntime().nodeDid(),
    now: () => requireRuntime().now(),
    relayUrl: app.relayUrl,
    signOfferDigest: app.signOfferDigest,
    resolveSigningKey: app.resolveSigningKey,
    verify: app.verify,
    // THE DIRECTORY, not the raw egress allowlist: `establishContact`
    // writes the durable contact row AND syncs the egress gate + source
    // trust + people graph. The gates-module function of the same name
    // fills only the in-RAM allowlist — a relationship that vanished on
    // reboot and never appeared in /v1/contacts (found live, 2026-08-18).
    writeContact: (did) => {
      // VERIFIED, not 'unknown': the ceremony proved possession of the
      // out-of-band code, the offer's Ed25519 signature, and both
      // relay-authenticated DIDs — and the inbound `commerce.trade`
      // gate (deliberately) refuses an 'unknown'-trust contact, so an
      // activation at the default level produced a relationship no
      // khata document could ever travel (found live, 2026-08-18).
      addContactIfNotExists(did, did, 'verified');
    },
    removeContact: (did) => {
      deleteContact(did);
    },
    writeGrants: ({ granteeDid, serviceRkeys, capabilities }) => {
      const grants = getServiceGrantRepository();
      if (grants === null) {
        throw new Error('invite activation: the service-grant repository is not wired');
      }
      const nowSec = Math.floor(requireRuntime().now() / 1000);
      for (const serviceRkey of serviceRkeys) {
        for (const capability of capabilities) {
          grants.create({
            grantId: `invg_${bytesToHex(randomBytes(12))}`,
            granteeDid,
            serviceRkey,
            capability,
            grantType: 'standing',
            createdAt: nowSec,
          });
        }
      }
    },
    revokeGrants: (granteeDid) => {
      const grants = getServiceGrantRepository();
      if (grants === null) return; // nothing was ever written
      const nowSec = Math.floor(requireRuntime().now() / 1000);
      for (const grant of grants.listByGrantee(granteeDid)) {
        grants.revoke(grant.grantId, nowSec);
      }
    },
    // §8 cold invites — publishing a catalog is the consent to receive
    // introductions; the pointer store is what "published" MEANS here.
    hasPublishedCatalog: () => requireRuntime().catalogPointers.list().length > 0,
    acceptColdInvites: () => {
      const read = requireRuntime().settings.readSupplier();
      return read.ok ? (read.settings.acceptColdInvites ?? true) : true;
    },
    notifyColdOffer: ({ nonce, inviterDid, direction, capabilities }) => {
      // A consent card, idempotent by nonce; a node with no workflow
      // service still HOLDS the offer (listable) — the card is surface.
      const service = getWorkflowService();
      if (service === null) return;
      const idemKey = `commerce_cold_invite:${nonce}`;
      if (service.store().getActiveByIdempotencyKey(idemKey) !== null) return;
      const shortDid =
        inviterDid.length > 24 ? `${inviterDid.slice(0, 16)}…${inviterDid.slice(-6)}` : inviterDid;
      service.create({
        id: `cold-invite-${bytesToHex(randomBytes(8))}`,
        kind: WorkflowTaskKind.Approval,
        description: `Cold invite from ${shortDid} (${direction}): grants ${capabilities.join(', ')}`,
        payload: JSON.stringify({
          type: 'commerce_cold_invite',
          nonce,
          inviter_did: inviterDid,
          direction,
          capabilities,
        }),
        expiresAtSec: Math.floor(requireRuntime().now() / 1000) + 7 * 24 * 60 * 60,
        idempotencyKey: idemKey,
        origin: 'd2d',
        initialState: WorkflowTaskState.PendingApproval,
      });
    },
    send: async (toDid, body) => {
      const send = getD2DSender();
      if (send === null) return false;
      try {
        const outcome = await send(toDid, 'commerce.invite', body);
        return outcome === undefined
          ? true
          : outcome.delivered || outcome.buffered || outcome.queued;
      } catch {
        return false;
      }
    },
  });
  installInviteService(composed);
  return composed;
}

function requireRuntime(): NonNullable<ReturnType<typeof getCommerceRuntime>> {
  const runtime = getCommerceRuntime();
  if (runtime === null) {
    throw new Error('invite: commerce storage is not initialised on this node');
  }
  return runtime;
}
