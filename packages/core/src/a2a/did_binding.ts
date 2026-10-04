/**
 * Binding a Lane 2 client to a DID (design §5.1, M4).
 *
 * The owner names the DID. Asking Core for a challenge for one client and
 * one DID (`issueDidChallenge`) yields a random, single-use value that lives
 * 15 minutes; asking again for the client replaces an unused one. The owner
 * hands it to the client out of band. The client signs
 * `didBindingSigningInput` (node DID, client id, the DID, the challenge)
 * with one of the DID's keys (see `didAuthenticationKeys`) and POSTs
 * `{did, challenge, signature}` to the gateway's binding door.
 *
 * The challenge is the authority: it names the client and the DID, so only
 * the holder of that DID's key can complete it, whatever else an onlooker
 * has seen. No other credential is needed, which also lets a client whose
 * key was removed (see `refreshBoundDidKeys`) be bound again.
 *
 * Core checks the challenge (live, unused) and the DID it named, resolves
 * the DID's keys (a `did:key` carries its own; any other method is resolved
 * by the host, since Core opens no outbound connection), checks the
 * signature, and that no other active client is bound to the DID. Then, in
 * one commit: the challenge is spent, the client's credential becomes the
 * DID and the key that signed (a bearer, if any, is gone), and the
 * credential history gains the change. The principal never changes, so
 * grants and tasks carry over.
 *
 * A bound client's later requests are checked against the key that signed
 * its binding, never a fresh resolution on the request path. The host
 * re-resolves bound DIDs in the background and clears the key of any client
 * whose key has left its document; that client stops authenticating until
 * the owner binds it again.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

import {
  A2A_DID_BINDING_PATH,
  base64urlEncode,
  didBindingSigningInput,
  isPlainObject,
  parseDidBindingRequest,
} from '@dina/a2a';

import { verify } from '../crypto/ed25519';
import { extractPublicKey, multibaseToPublicKey, publicKeyToMultibase } from '../identity/did';

import { a2aPrincipal, endCredentialSetups, getA2AClient } from './clients';

import type { GatewayAnswer, GatewayEnvelope, InboundRuntime } from './ingress_common';
import type { A2AStore } from './store';
import type { DBRow } from '../storage/db_adapter';

/** How long a binding challenge lives. */
export const DID_CHALLENGE_TTL_MS = 15 * 60_000;
/** How often the host re-resolves bound DIDs. */
export const DID_REFRESH_INTERVAL_MS = 10 * 60_000;

const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,480}$/;

/**
 * What the host's lookup of a DID found, as it stands now (no cache): its
 * document, whatever keys it holds; `deactivated`, the directory's
 * tombstone (PLC answers 410 for a DID its owner ended); `not_found` (404);
 * or `unavailable`, anything else (an outage, an answer that is not a
 * document for this DID). D2D's `DIDResolver.lookup` answers in this shape.
 */
export type A2ADidResolution =
  | { kind: 'document'; document: unknown }
  | { kind: 'deactivated' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/**
 * The host's DID lookup. The server installs D2D's (`DIDResolver.lookup`);
 * with none, only `did:key` binds. A lookup that throws counts as
 * `unavailable`.
 */
export type A2ADidResolver = (did: string) => Promise<A2ADidResolution>;

let resolver: A2ADidResolver | null = null;

export function installA2ADidResolver(fn: A2ADidResolver | null): void {
  resolver = fn;
}

/** The installed DID lookup, or null (the host installs one with Lane 2; close takes it down). */
export function getA2ADidResolver(): A2ADidResolver | null {
  return resolver;
}

/**
 * The Ed25519 keys a DID document lets its subject sign Dina requests with.
 * A document with an `authentication` relationship: the methods it names,
 * by reference or embedded. A document with none, as every `did:plc`
 * document is (PLC carries no relationships; Dina's own name their key
 * `#dina_signing`): its Ed25519 verification methods. Either way only
 * `Multikey` and `Ed25519VerificationKey2020` methods with an Ed25519 key
 * count; a secp256k1 or P-256 key (`#atproto`) cannot sign a Dina request.
 * A document whose `id` is not the DID yields none.
 */
export function didAuthenticationKeys(document: unknown, did: string): Uint8Array[] {
  if (!isPlainObject(document) || document.id !== did) return [];
  const absolute = (id: string): string => (id.startsWith('#') ? `${did}${id}` : id);
  const methods: Record<string, unknown>[] = [];
  if (Array.isArray(document.verificationMethod)) {
    for (const vm of document.verificationMethod) if (isPlainObject(vm)) methods.push(vm);
  }
  let named: Set<string> | null = null;
  if (document.authentication !== undefined) {
    named = new Set<string>();
    for (const entry of Array.isArray(document.authentication) ? document.authentication : []) {
      if (typeof entry === 'string') named.add(absolute(entry));
      else if (isPlainObject(entry) && typeof entry.id === 'string') {
        named.add(absolute(entry.id));
        methods.push(entry);
      }
    }
  }
  const keys: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const vm of methods) {
    if (typeof vm.id !== 'string' || (named !== null && !named.has(absolute(vm.id)))) continue;
    if (vm.type !== 'Multikey' && vm.type !== 'Ed25519VerificationKey2020') continue;
    if (typeof vm.publicKeyMultibase !== 'string' || seen.has(vm.publicKeyMultibase)) continue;
    try {
      keys.push(multibaseToPublicKey(vm.publicKeyMultibase));
      seen.add(vm.publicKeyMultibase);
    } catch {
      /* not an Ed25519 key: it cannot sign a Dina request */
    }
  }
  return keys;
}

type KeysResult = { kind: 'keys'; keys: Uint8Array[] } | Exclude<A2ADidResolution, { kind: 'document' }>;

/** The keys `did` may sign Dina requests with now, or why there are none to read. */
async function signingKeysOf(did: string): Promise<KeysResult> {
  if (did.startsWith('did:key:')) {
    try {
      return { kind: 'keys', keys: [extractPublicKey(did)] };
    } catch {
      return { kind: 'unavailable' };
    }
  }
  if (resolver === null) return { kind: 'unavailable' };
  let found: A2ADidResolution;
  try {
    found = await resolver(did);
  } catch {
    return { kind: 'unavailable' };
  }
  if (found.kind !== 'document') return found;
  return { kind: 'keys', keys: didAuthenticationKeys(found.document, did) };
}

export type ChallengeResult =
  | { ok: true; challenge: string; did: string; expires_at: number }
  | { ok: false; reason: 'not_found' | 'revoked' | 'did_malformed' | 'did_not_expected' };

/**
 * A fresh binding challenge for one active client and the DID the owner
 * names; an unused earlier one for the client stops working. The owner's
 * expected DID, when set, must be the one named.
 */
export function issueDidChallenge(store: A2AStore, clientId: string, did: unknown, nowMs: number): ChallengeResult {
  const client = getA2AClient(store, clientId);
  if (client === null) return { ok: false, reason: 'not_found' };
  if (client.status !== 'active') return { ok: false, reason: 'revoked' };
  if (typeof did !== 'string' || !DID_RE.test(did)) return { ok: false, reason: 'did_malformed' };
  if (client.expected_did !== null && client.expected_did !== did) return { ok: false, reason: 'did_not_expected' };
  const challenge = `dch_${base64urlEncode(randomBytes(32))}`;
  const expiresAt = nowMs + DID_CHALLENGE_TTL_MS;
  store.transaction(() => {
    store.db.run('DELETE FROM a2a_did_challenges WHERE client_id = ? AND used_at IS NULL', [clientId]);
    store.db.execute(
      'INSERT INTO a2a_did_challenges (challenge_hash, client_id, did, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      [challengeHash(challenge), clientId, did, expiresAt, nowMs],
    );
  });
  return { ok: true, challenge, did, expires_at: expiresAt };
}

export type BindingRefusal = 'request_malformed' | 'challenge_invalid' | 'did_unresolvable' | 'signature_invalid' | 'did_in_use';

export type BindingResult = { ok: true; clientId: string; did: string } | { ok: false; reason: BindingRefusal };

interface ChallengeRow {
  challenge_hash: string;
  client_id: string;
  did: string;
}

/** The stored form of a challenge: its sha256, hex (design §9: kept hashed, like a bearer). */
function challengeHash(challenge: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(challenge)));
}

/** The live challenge with this value for this DID, or null. */
function liveChallenge(store: A2AStore, challenge: string, did: string, nowMs: number): ChallengeRow | null {
  const rows = store.db.query(
    'SELECT challenge_hash, client_id, did FROM a2a_did_challenges WHERE challenge_hash = ? AND did = ? AND used_at IS NULL AND expires_at > ?',
    [challengeHash(challenge), did, nowMs],
  ) as DBRow[];
  return (rows[0] as unknown as ChallengeRow | undefined) ?? null;
}

/** Bind the challenge's client to the DID it named, once every check passes (see the module comment). */
export async function completeDidBinding(
  store: A2AStore,
  args: { nodeDid: string; body: string; nowMs: () => number },
): Promise<BindingResult> {
  const request = parseDidBindingRequest(args.body);
  if (request === null) return { ok: false, reason: 'request_malformed' };
  const found = liveChallenge(store, request.challenge, request.did, args.nowMs());
  if (found === null) return { ok: false, reason: 'challenge_invalid' };
  const clientId = found.client_id;
  if (getA2AClient(store, clientId)?.status !== 'active') return { ok: false, reason: 'challenge_invalid' };

  const keys = await signingKeysOf(request.did);
  if (keys.kind !== 'keys') return { ok: false, reason: 'did_unresolvable' };
  const input = new TextEncoder().encode(
    didBindingSigningInput({ nodeDid: args.nodeDid, clientId, did: request.did, challenge: request.challenge }),
  );
  const signature = hexToBytes(request.signature);
  const signer = keys.keys.find((key) => {
    try {
      return verify(key, input, signature);
    } catch {
      return false;
    }
  });
  if (signer === undefined) return { ok: false, reason: 'signature_invalid' };

  // The resolution was asynchronous: everything that could have moved is
  // checked again inside the commit.
  return store.transaction((): BindingResult => {
    const now = args.nowMs();
    const still = liveChallenge(store, request.challenge, request.did, now);
    if (still === null || still.client_id !== clientId) return { ok: false, reason: 'challenge_invalid' };
    if (getA2AClient(store, clientId)?.status !== 'active') return { ok: false, reason: 'challenge_invalid' };
    const holder = store.db.query(
      "SELECT client_id FROM a2a_clients WHERE bound_did = ? AND status = 'active' AND client_id != ?",
      [request.did, clientId],
    );
    if (holder.length > 0) return { ok: false, reason: 'did_in_use' };
    store.db.run('UPDATE a2a_did_challenges SET used_at = ? WHERE challenge_hash = ?', [now, challengeHash(request.challenge)]);
    store.db.execute(`UPDATE a2a_credential_bindings SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`, [
      now,
      clientId,
    ]);
    store.db.execute(
      `INSERT INTO a2a_credential_bindings (client_id, binding_type, value_hash, created_at, revoked_at)
       VALUES (?, 'did', ?, ?, NULL)`,
      [clientId, bytesToHex(sha256(new TextEncoder().encode(request.did))), now],
    );
    store.db.execute(
      `UPDATE a2a_clients SET bound_did = ?, bound_key = ?, token_hash = NULL, token_expires_at = NULL
        WHERE client_id = ? AND status = 'active'`,
      [request.did, publicKeyToMultibase(signer), clientId],
    );
    // The credential it replaces (a bearer, or the DID's earlier key) ends here, and what it set up with it.
    endCredentialSetups(store, clientId, now);
    return { ok: true, clientId, did: request.did };
  });
}

const BINDING_STATUS: Record<BindingRefusal, number> = {
  request_malformed: 400,
  challenge_invalid: 400,
  did_unresolvable: 400,
  signature_invalid: 403,
  did_in_use: 409,
};

/**
 * The gateway's binding door (`A2A_DID_BINDING_PATH`). Not JSON-RPC: plain
 * JSON in and out, and no credential beyond the challenge and the
 * signature. The challenge's client pays the new-call budget.
 */
export async function ingressCompleteDidBinding(
  rt: InboundRuntime,
  envelope: GatewayEnvelope,
  nodeDid: string | null,
): Promise<GatewayAnswer> {
  if (envelope.request.method !== 'POST' || envelope.request.path !== A2A_DID_BINDING_PATH || envelope.request.query !== '') {
    return { status: 400, body: { error: 'external_mismatch' } };
  }
  if (nodeDid === null) return { status: 503, body: { error: 'unavailable' } };
  const request = parseDidBindingRequest(envelope.request.body);
  if (request === null) return { status: 400, body: { error: 'request_malformed' } };
  const found = liveChallenge(rt.a2a.store, request.challenge, request.did, rt.a2a.nowMs());
  if (found === null) return { status: 400, body: { error: 'challenge_invalid' } };
  if (!rt.budgets.chargeMiss(a2aPrincipal(found.client_id), rt.a2a.nowMs())) {
    return { status: 429, headers: { 'retry-after': '60' }, body: { error: 'rate_limited' } };
  }
  const out = await completeDidBinding(rt.a2a.store, { nodeDid, body: envelope.request.body, nowMs: rt.a2a.nowMs });
  if (!out.ok) return { status: BINDING_STATUS[out.reason], body: { error: out.reason } };
  return { status: 200, body: { client_id: out.clientId, principal: a2aPrincipal(out.clientId), did: out.did } };
}

export interface DidRefreshCounts {
  checked: number;
  /**
   * Clients whose bound key left their DID's document (every key removed
   * included), or whose DID its owner deactivated; they no longer
   * authenticate.
   */
  suspended: number;
  /** DIDs the lookup could not answer for this time; their clients are left as they are. */
  unresolved: number;
}

/**
 * Re-resolve every bound DID that is not a `did:key` (whose key cannot
 * change) and clear the bound key of any client whose key has left its
 * document, or whose DID is deactivated: that client's signatures stop
 * working, its DID binding ends in the credential history, and the owner
 * binds it again (a new challenge) to restore it. A lookup that answers
 * nothing definite leaves the client alone, so an outage, or a directory
 * fault, never cuts clients off: that includes `not_found`, since a PLC
 * DID that resolved at binding can only end in a tombstone, so a 404 for
 * it is the directory's error. The host calls this every
 * `DID_REFRESH_INTERVAL_MS`, off the request path.
 */
export async function refreshBoundDidKeys(store: A2AStore, nowMs: () => number): Promise<DidRefreshCounts> {
  const counts: DidRefreshCounts = { checked: 0, suspended: 0, unresolved: 0 };
  const bound = store.db.query(
    `SELECT client_id, bound_did, bound_key FROM a2a_clients
      WHERE status = 'active' AND bound_did IS NOT NULL AND bound_key IS NOT NULL AND bound_did NOT LIKE 'did:key:%'`,
  ) as unknown as { client_id: string; bound_did: string; bound_key: string }[];
  for (const client of bound) {
    counts.checked += 1;
    const found = await signingKeysOf(client.bound_did);
    if (found.kind === 'unavailable' || found.kind === 'not_found') {
      counts.unresolved += 1;
      continue;
    }
    if (found.kind === 'keys' && found.keys.some((key) => publicKeyToMultibase(key) === client.bound_key)) continue;
    const suspended = store.transaction(() => {
      const now = nowMs();
      const changed = store.db.run(
        `UPDATE a2a_clients SET bound_key = NULL WHERE client_id = ? AND bound_did = ? AND bound_key = ?`,
        [client.client_id, client.bound_did, client.bound_key],
      );
      if (changed === 1) {
        store.db.execute(
          `UPDATE a2a_credential_bindings SET revoked_at = ?
            WHERE client_id = ? AND binding_type = 'did' AND revoked_at IS NULL`,
          [now, client.client_id],
        );
        endCredentialSetups(store, client.client_id, now);
      }
      return changed === 1;
    });
    if (suspended) counts.suspended += 1;
  }
  return counts;
}
