/**
 * Inbound A2A clients (design §5.1, §5.2): who may call this node's
 * published services over A2A, and with what.
 *
 * The owner registers a client: a display name, an optional public-skill
 * scope (empty means every public skill), and an optional expected DID for
 * the M4 DID upgrade. Core mints a bearer token, shows it once, and keeps
 * only its SHA-256. The client's stable principal is `a2a:<client_id>`: the
 * grantee of its grants, the owner of its tasks, the key of its receipts.
 *
 * A bearer lives 90 days. Rotation mints a new one and ends the old one at
 * once; revocation ends the client, every credential it held and every grant
 * issued to it, in one commit. `a2a_credential_bindings` keeps the history
 * of which credential stood for the client when, append-only.
 *
 * Grants are `service_grants` rows whose grantee is the principal (§5.2):
 * the check, the table and revocation are the ones D2D `known_only` uses.
 * A grant names one capability on one `surface:'services'` listing.
 *
 * The bearer is the only secret here. It never enters a log, a view or a
 * response other than the one that mints it.
 *
 * M4 (design §5.1): a client may trade its bearer for a DID (`did_binding.ts`).
 * A DID-bound client has no bearer; it signs each request, and Core checks
 * the signature against the Ed25519 key that signed its binding
 * (`authenticateA2ADidRequest`). Its principal is the same before and after.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import {
  A2A_STREAM_FENCE_HOLD_MS,
  a2aDisplayText,
  base64urlEncode,
  didRequestSigningInput,
  parseQualifiedSkill,
} from '@dina/a2a';
import { effectiveSurface } from '@dina/protocol';

import { checkRequestSignature, type SignedRequestParts } from '../auth/signed_request';
import { multibaseToPublicKey } from '../identity/did';
import { configuredCapabilityKey, getServiceConfig } from '../service/service_config';

import { a2aNonceGuard } from './did_replay';
import { type A2AStore } from './store';

import type { ServiceGrant, ServiceGrantRepository } from '../service/service_grant_repository';
import type { DBRow } from '../storage/db_adapter';

/** A bearer's life (design §5.1). */
export const A2A_BEARER_LIFETIME_MS = 90 * 24 * 60 * 60_000;
/** `last_used_at` moves at most this often: a busy client is not a write per call. */
export const LAST_USED_RESOLUTION_MS = 60_000;
export const MAX_CLIENT_SCOPE = 64;
export const MAX_CLIENT_NAME_CHARS = 64;
const MAX_DID_CHARS = 512;

const PRINCIPAL_PREFIX = 'a2a:';
const TOKEN_PREFIX = 'dina_a2a_';
/** The prefix and 43 base64url characters (32 random bytes). */
const TOKEN_RE = /^dina_a2a_[A-Za-z0-9_-]{43}$/;
const CLIENT_ID_RE = /^ac_[0-9a-f]{32}$/;
const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

export interface A2AClientRow {
  client_id: string;
  display_name: string;
  token_hash: string | null;
  token_expires_at: number | null;
  bound_did: string | null;
  /** The bound DID's Ed25519 key that signed the binding (multibase); null while unbound. */
  bound_key: string | null;
  expected_did: string | null;
  scope_json: string | null;
  last_used_at: number | null;
  status: 'active' | 'revoked';
  created_at: number;
  revoked_at: number | null;
}

/** What the owner sees of a client. Never the token, never its hash. */
export interface A2AClientView {
  client_id: string;
  principal: string;
  display_name: string;
  /** Public skills this client may call; empty means every public skill. */
  scope: string[];
  expected_did: string | null;
  bound_did: string | null;
  /**
   * How the client proves itself: its bearer, its bound DID, or nothing yet
   * because the bound key left the DID's document (the owner binds it again).
   */
  credential: 'bearer' | 'did' | 'did_key_removed';
  token_expires_at: number | null;
  last_used_at: number | null;
  status: 'active' | 'revoked';
  created_at: number;
  revoked_at: number | null;
}

export function a2aPrincipal(clientId: string): string {
  return `${PRINCIPAL_PREFIX}${clientId}`;
}

/** The client id inside an A2A principal, or null when it is not one. */
export function clientIdOfPrincipal(principal: string): string | null {
  if (!principal.startsWith(PRINCIPAL_PREFIX)) return null;
  const id = principal.slice(PRINCIPAL_PREFIX.length);
  return CLIENT_ID_RE.test(id) ? id : null;
}

/**
 * The credential generation of a principal's client (design §10): it rises
 * each time one of the client's credentials ends, so a stream opened under
 * an earlier one is ended rather than sent anything more. 0 for a principal
 * that is no client.
 */
export function credentialGenOf(store: A2AStore, principal: string): number {
  const clientId = clientIdOfPrincipal(principal);
  return clientId === null ? 0 : store.credentialGen(clientId);
}

function tokenHash(token: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(token)));
}

function mintToken(): { token: string; hash: string } {
  const token = `${TOKEN_PREFIX}${base64urlEncode(randomBytes(32))}`;
  return { token, hash: tokenHash(token) };
}

function view(row: A2AClientRow): A2AClientView {
  let scope: string[] = [];
  try {
    const parsed = row.scope_json === null ? [] : (JSON.parse(row.scope_json) as unknown);
    if (Array.isArray(parsed)) scope = parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    scope = [];
  }
  return {
    client_id: row.client_id,
    principal: a2aPrincipal(row.client_id),
    display_name: row.display_name,
    scope,
    expected_did: row.expected_did,
    bound_did: row.bound_did,
    credential: row.bound_did === null ? 'bearer' : row.bound_key === null ? 'did_key_removed' : 'did',
    token_expires_at: row.token_expires_at,
    last_used_at: row.last_used_at,
    status: row.status,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

function getRow(store: A2AStore, clientId: string): A2AClientRow | null {
  const rows = store.db.query('SELECT * FROM a2a_clients WHERE client_id = ?', [clientId]) as DBRow[];
  return (rows[0] as unknown as A2AClientRow | undefined) ?? null;
}

// ---------------------------------------------------------------- input

export type ClientInputRefusal =
  | 'name_required'
  | 'name_too_long'
  | 'scope_malformed'
  | 'scope_too_large'
  | 'expected_did_malformed';

function parseName(raw: unknown): string | ClientInputRefusal {
  const name = a2aDisplayText(typeof raw === 'string' ? raw : '').trim();
  if (name === '') return 'name_required';
  if ([...name].length > MAX_CLIENT_NAME_CHARS) return 'name_too_long';
  return name;
}

/** A scope is a list of distinct skill ids, as the card names them. */
function parseScope(raw: unknown): string[] | ClientInputRefusal {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return 'scope_malformed';
  if (raw.length > MAX_CLIENT_SCOPE) return 'scope_too_large';
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || parseQualifiedSkill(entry) === null) return 'scope_malformed';
    if (!out.includes(entry)) out.push(entry);
  }
  return out.sort();
}

function parseExpectedDid(raw: unknown): string | null | ClientInputRefusal {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > MAX_DID_CHARS || !DID_RE.test(raw)) return 'expected_did_malformed';
  return raw;
}

// ---------------------------------------------------------------- lifecycle

export type CreateClientResult =
  | { ok: true; client: A2AClientView; token: string }
  | { ok: false; reason: ClientInputRefusal };

/** Register a client and mint its first bearer. The token is shown here once. */
export function createA2AClient(
  store: A2AStore,
  input: { display_name?: unknown; scope?: unknown; expected_did?: unknown },
  nowMs: number,
): CreateClientResult {
  const name = parseName(input.display_name);
  if (name === 'name_required' || name === 'name_too_long') return { ok: false, reason: name };
  const scope = parseScope(input.scope);
  if (!Array.isArray(scope)) return { ok: false, reason: scope };
  const expectedDid = parseExpectedDid(input.expected_did);
  if (expectedDid === 'expected_did_malformed') return { ok: false, reason: expectedDid };

  const clientId = `ac_${bytesToHex(randomBytes(16))}`;
  const { token, hash } = mintToken();
  store.transaction(() => {
    store.db.execute(
      `INSERT INTO a2a_clients
         (client_id, display_name, token_hash, token_expires_at, bound_did, expected_did,
          scope_json, last_used_at, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 'active', ?, NULL)`,
      [clientId, name, hash, nowMs + A2A_BEARER_LIFETIME_MS, expectedDid, JSON.stringify(scope), nowMs],
    );
    store.db.execute(
      `INSERT INTO a2a_credential_bindings (client_id, binding_type, value_hash, created_at, revoked_at)
       VALUES (?, 'bearer', ?, ?, NULL)`,
      [clientId, hash, nowMs],
    );
  });
  const row = getRow(store, clientId);
  if (row === null) throw new Error('createA2AClient: row vanished');
  return { ok: true, client: view(row), token };
}

export function listA2AClients(store: A2AStore): A2AClientView[] {
  const rows = store.db.query('SELECT * FROM a2a_clients ORDER BY created_at DESC, client_id') as DBRow[];
  return rows.map((r) => view(r as unknown as A2AClientRow));
}

export function getA2AClient(store: A2AStore, clientId: string): A2AClientView | null {
  const row = getRow(store, clientId);
  return row === null ? null : view(row);
}

export type RotateResult =
  | { ok: true; token: string; token_expires_at: number }
  | { ok: false; reason: 'not_found' | 'revoked' | 'did_bound' };

/**
 * A new bearer for an active client; the old one stops working in the same
 * commit. A DID-bound client has no bearer to rotate: it changes keys by
 * binding again.
 */
export function rotateA2AClientToken(store: A2AStore, clientId: string, nowMs: number): RotateResult {
  const row = getRow(store, clientId);
  if (row === null) return { ok: false, reason: 'not_found' };
  if (row.status !== 'active') return { ok: false, reason: 'revoked' };
  if (row.bound_did !== null) return { ok: false, reason: 'did_bound' };
  const { token, hash } = mintToken();
  const expiresAt = nowMs + A2A_BEARER_LIFETIME_MS;
  store.transaction(() => {
    store.db.execute(
      `UPDATE a2a_credential_bindings SET revoked_at = ?
        WHERE client_id = ? AND binding_type = 'bearer' AND revoked_at IS NULL`,
      [nowMs, clientId],
    );
    store.db.execute(
      `INSERT INTO a2a_credential_bindings (client_id, binding_type, value_hash, created_at, revoked_at)
       VALUES (?, 'bearer', ?, ?, NULL)`,
      [clientId, hash, nowMs],
    );
    store.db.execute(
      `UPDATE a2a_clients SET token_hash = ?, token_expires_at = ? WHERE client_id = ? AND status = 'active'`,
      [hash, expiresAt, clientId],
    );
    endCredentialSetups(store, clientId, nowMs);
  });
  return { ok: true, token, token_expires_at: expiresAt };
}

/**
 * What a client's credential set up ends with it (design §10: rotation is
 * the answer to a stolen bearer; expiry, revocation and a DID bind or
 * suspension end a credential too). The webhook configs on its tasks are
 * deleted, so their waiting events are suppressed at the next claim like
 * any config gone. Its credential generation rises, and its stream fence
 * holds for `A2A_STREAM_FENCE_HOLD_MS`: every delivery claim meanwhile
 * tells the gateway to end the client's streams opened under an earlier
 * generation, on any task, and to refuse one that opens late; every stream
 * event carries the generation too. A stream or a webhook the old
 * credential's holder set up does not outlive it; under its new credential
 * the client subscribes and sets webhooks again. A `SendMessage` still
 * waiting under the old one is answered 401. Called inside the transaction
 * that ends the credential.
 */
export function endCredentialSetups(store: A2AStore, clientId: string, nowMs: number): void {
  const principal = a2aPrincipal(clientId);
  store.db.execute(
    `DELETE FROM a2a_push_configs
      WHERE operation_ref IN (SELECT id FROM a2a_tasks WHERE direction = 'inbound' AND principal = ?)`,
    [principal],
  );
  store.db.execute(
    `UPDATE a2a_clients SET credential_gen = credential_gen + 1, streams_fence_until = ? WHERE client_id = ?`,
    [nowMs + A2A_STREAM_FENCE_HOLD_MS, clientId],
  );
}

/**
 * A bearer past its expiry is a credential that ended (design §5.1, §10):
 * what it set up ends with it, as at a rotation, and once. Its binding row
 * is marked ended (`revoked_at`), which is how a later look knows it was
 * done; the token itself is already refused by `authenticateA2ABearer`.
 * Every delivery claim runs it, and so does a waiting `SendMessage`, so no
 * stream, webhook or wait outlives the bearer. `clientId` limits it to one
 * client. Returns how many bearers ended.
 */
export function endExpiredBearers(store: A2AStore, nowMs: number, clientId?: string): number {
  return store.transaction(() => {
    const expired = store.db.query(
      `SELECT DISTINCT c.client_id FROM a2a_clients c
         JOIN a2a_credential_bindings b
           ON b.client_id = c.client_id AND b.binding_type = 'bearer' AND b.revoked_at IS NULL
        WHERE c.status = 'active' AND c.token_expires_at IS NOT NULL AND c.token_expires_at <= ?
          ${clientId === undefined ? '' : 'AND c.client_id = ?'}`,
      clientId === undefined ? [nowMs] : [nowMs, clientId],
    ) as unknown as { client_id: string }[];
    for (const { client_id: id } of expired) {
      store.db.execute(
        `UPDATE a2a_credential_bindings SET revoked_at = ? WHERE client_id = ? AND binding_type = 'bearer' AND revoked_at IS NULL`,
        [nowMs, id],
      );
      endCredentialSetups(store, id, nowMs);
    }
    return expired.length;
  });
}

/**
 * The key the gateway knows a principal's streams by (`A2A_STREAM_CLIENT_HEADER`):
 * a digest, so no client id reaches the gateway.
 */
export function streamClientKeyOf(principal: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`a2a-stream-client:${principal}`))).slice(0, 32);
}

/**
 * End a client: its bearer, every credential binding, and every grant issued
 * to its principal, in one commit. Its tasks stay, for the owner's record.
 */
export function revokeA2AClient(
  store: A2AStore,
  grants: ServiceGrantRepository,
  clientId: string,
  nowMs: number,
): { ok: true; grants_revoked: number } | { ok: false; reason: 'not_found' | 'revoked' } {
  const row = getRow(store, clientId);
  if (row === null) return { ok: false, reason: 'not_found' };
  if (row.status !== 'active') return { ok: false, reason: 'revoked' };
  let revoked = 0;
  store.transaction(() => {
    store.db.execute(
      `UPDATE a2a_clients SET status = 'revoked', revoked_at = ? WHERE client_id = ?`,
      [nowMs, clientId],
    );
    store.db.execute(
      `UPDATE a2a_credential_bindings SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL`,
      [nowMs, clientId],
    );
    revoked = grants.revokeAllForGrantee(a2aPrincipal(clientId), Math.floor(nowMs / 1000));
    endCredentialSetups(store, clientId, nowMs);
  });
  return { ok: true, grants_revoked: revoked };
}

// ---------------------------------------------------------------- bearer

export type BearerAuth =
  | { ok: true; client: A2AClientView; principal: string }
  | { ok: false; reason: 'missing' | 'malformed' | 'unknown' | 'expired' | 'revoked' };

/**
 * Verify the `Authorization` value the gateway forwarded (§5.1). The token
 * is found by its hash, so its value is never compared byte by byte and
 * never stored. Stamps `last_used_at` at most once a minute.
 */
export function authenticateA2ABearer(store: A2AStore, authorization: unknown, nowMs: number): BearerAuth {
  if (typeof authorization !== 'string' || authorization.trim() === '') return { ok: false, reason: 'missing' };
  const match = /^bearer +(\S+)$/i.exec(authorization.trim());
  const token = match?.[1] ?? '';
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'malformed' };
  const rows = store.db.query('SELECT * FROM a2a_clients WHERE token_hash = ?', [tokenHash(token)]) as DBRow[];
  const row = rows[0] as unknown as A2AClientRow | undefined;
  if (row === undefined) return { ok: false, reason: 'unknown' };
  if (row.status !== 'active') return { ok: false, reason: 'revoked' };
  if (row.token_expires_at === null || row.token_expires_at <= nowMs) return { ok: false, reason: 'expired' };
  if (row.last_used_at === null || nowMs - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    store.db.execute('UPDATE a2a_clients SET last_used_at = ? WHERE client_id = ?', [nowMs, row.client_id]);
    row.last_used_at = nowMs;
  }
  return { ok: true, client: view(row), principal: a2aPrincipal(row.client_id) };
}

// ---------------------------------------------------------------- grants

export type GrantRefusal =
  | 'client_not_found'
  | 'client_revoked'
  | 'listing_not_found'
  | 'not_services_surface'
  | 'capability_not_configured'
  | 'expiry_malformed';

export type IssueGrantResult = { ok: true; grant: ServiceGrant } | { ok: false; reason: GrantRefusal };

/**
 * Issue a grant to a client for one capability on one listing (§5.2). Only a
 * `surface:'services'` listing: Talk services are granted through contacts,
 * never to an outside agent. The grant names the capability as the listing
 * configured it, which is the name ingress resolves a call to.
 */
export function issueA2AGrant(
  store: A2AStore,
  grants: ServiceGrantRepository,
  input: { client_id: string; service_rkey: string; capability: string; expires_at?: unknown },
  nowMs: number,
): IssueGrantResult {
  const client = getRow(store, input.client_id);
  if (client === null) return { ok: false, reason: 'client_not_found' };
  if (client.status !== 'active') return { ok: false, reason: 'client_revoked' };
  const config = getServiceConfig(input.service_rkey);
  if (config === null) return { ok: false, reason: 'listing_not_found' };
  if (effectiveSurface(config) !== 'services') return { ok: false, reason: 'not_services_surface' };
  const key = configuredCapabilityKey(config, input.capability);
  if (key === null) return { ok: false, reason: 'capability_not_configured' };
  const nowSec = Math.floor(nowMs / 1000);
  let expiresAt: number | undefined;
  if (input.expires_at !== undefined && input.expires_at !== null) {
    if (typeof input.expires_at !== 'number' || !Number.isSafeInteger(input.expires_at) || input.expires_at <= nowSec) {
      return { ok: false, reason: 'expiry_malformed' };
    }
    expiresAt = input.expires_at;
  }
  const grant: ServiceGrant = {
    grantId: `ag_${bytesToHex(randomBytes(16))}`,
    granteeDid: a2aPrincipal(input.client_id),
    serviceRkey: input.service_rkey,
    capability: key,
    grantType: 'standing',
    ...(expiresAt === undefined ? {} : { expiresAt }),
    createdAt: nowSec,
  };
  grants.create(grant);
  return { ok: true, grant };
}

/** The grants issued to a client, newest first. */
export function listA2AGrants(grants: ServiceGrantRepository, clientId: string): ServiceGrant[] {
  return grants.listByGrantee(a2aPrincipal(clientId));
}

/** Revoke one grant, only if it was issued to an A2A client. */
export function revokeA2AGrant(grants: ServiceGrantRepository, grantId: string, nowMs: number): boolean {
  const grant = grants.getById(grantId);
  if (grant === null || clientIdOfPrincipal(grant.granteeDid) === null) return false;
  return grants.revoke(grantId, Math.floor(nowMs / 1000));
}

// ---------------------------------------------------------------- did

export type DidRequestAuth =
  | { ok: true; client: A2AClientView; principal: string }
  | { ok: false; reason: 'unknown' | 'signature' };

/**
 * Verify a DID-signed request the gateway forwarded (§5.1): the DID must be
 * an active client's bound DID, and the signature, over
 * `didRequestSigningInput` for the client's own request addressed to this
 * node (`nodeDid`), must verify under the key that signed its binding,
 * inside the time window, with a nonce this DID never used (`a2aNonceGuard`,
 * on disk). A request signed for another node fails here even when the same
 * DID is a client there too. The nonce is spent only once the signature is
 * proven. Stamps `last_used_at` as the bearer path does.
 */
export function authenticateA2ADidRequest(
  store: A2AStore,
  request: SignedRequestParts,
  nowMs: number,
  nodeDid: string,
): DidRequestAuth {
  if (request.did === undefined) return { ok: false, reason: 'unknown' };
  const rows = store.db.query("SELECT * FROM a2a_clients WHERE bound_did = ? AND status = 'active'", [
    request.did,
  ]) as DBRow[];
  const row = rows[0] as unknown as A2AClientRow | undefined;
  if (row === undefined || row.bound_key === null) return { ok: false, reason: 'unknown' };
  let key: Uint8Array;
  try {
    key = multibaseToPublicKey(row.bound_key);
  } catch {
    return { ok: false, reason: 'unknown' };
  }
  const check = checkRequestSignature(request, {
    nonces: a2aNonceGuard(store),
    resolvePublicKey: (did) => (did === row.bound_did ? key : null),
    signedText: (parts) =>
      didRequestSigningInput({ nodeDid, ...parts, bodySha256Hex: bytesToHex(sha256(parts.body)) }),
  });
  if (!check.ok) return { ok: false, reason: 'signature' };
  if (row.last_used_at === null || nowMs - row.last_used_at >= LAST_USED_RESOLUTION_MS) {
    store.db.execute('UPDATE a2a_clients SET last_used_at = ? WHERE client_id = ?', [nowMs, row.client_id]);
    row.last_used_at = nowMs;
  }
  return { ok: true, client: view(row), principal: a2aPrincipal(row.client_id) };
}
