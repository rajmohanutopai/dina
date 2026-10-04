/**
 * Lane 1 remote agents (design §5.3, §5.5, §6.1): register by card URL, keep
 * the pin current, bind skills, and decide when an agent may be called.
 *
 * Registration fetches the LIVE card under the outbound policy (never a
 * directory copy), parses it strictly, checks its shape, picks the first
 * JSON-RPC interface that speaks A2A 1.0 at an acceptable URL, verifies any
 * signatures against keys fetched from their `jku`, and pins the result
 * (`cardPinHash`). The agent starts as a `candidate`; the owner binds skills
 * and activates it. A re-fetch whose pin differs marks it `changed`, which
 * voids every binding (bindings key on the pin) and every outstanding
 * permit (dispatch re-checks the pin); the owner re-binds and re-activates.
 *
 * The card is never authority (A2A-I1): nothing here lets a card choose
 * what Dina sends, only what the owner may choose among.
 *
 * A `none` credential cannot be created for a card that declares security
 * requirements; such a card's agent takes a real credential (credentials.ts).
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_NAME_MAX_CODE_POINTS,
  MAX_ID_LENGTH,
  a2aDisplayText,
  canonicalize,
  cardPinHash,
  checkRequestedVersion,
  isPlainObject,
  parseStrictJson,
  validateAgentCardShape,
  verifyAgentCardSignatures,
  type JsonObject,
} from '@dina/a2a';

import { createJkuVerifier, type KeyResolutionNote, type KeySetFetch } from './card_keys';
import { credentialFitsCard, forgetCachedToken } from './credentials';
import { sha256HexOfText } from './digest';
import { A2A_FETCH_LIMITS, a2aFetch, checkOutboundUrl } from './host_transport';
import { newA2AId } from './ids';
import { validateSkillBinding } from './skill_bindings';
import {
  type A2AStore,
  type RemoteAgentRow,
  type RemoteCredentialRow,
  type SignatureState,
  type SkillBindingRow,
} from './store';


export { a2aDisplayText } from '@dina/a2a';

export interface RemoteAgentDeps {
  store: A2AStore;
  nowMs?: () => number;
  /** Key-set fetcher for signature checks; the outbound policy by default. */
  fetchKeySet?: (url: string) => Promise<KeySetFetch>;
}


export interface PinnedCard {
  card: JsonObject;
  cardText: string;
  cardHash: string;
  name: string;
  endpoint: string;
  endpointTenant: string;
  schemesJson: string;
  signatureState: SignatureState;
  signatureDetail: string;
  requiresCredential: boolean;
}

export type CardFetchOutcome = { ok: true; pinned: PinnedCard } | { ok: false; reason: string };

function cardRequiresCredential(card: JsonObject): boolean {
  const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
  if (nonEmpty(card.securityRequirements)) return true;
  return Array.isArray(card.skills) && card.skills.some((s) => isPlainObject(s) && nonEmpty(s.securityRequirements));
}

function signatureSummary(state: SignatureState, notes: KeyResolutionNote[]): string {
  if (state === 'unsigned') return 'The card carries no signature.';
  const verified = notes.filter((n) => n.outcome === 'verified');
  if (verified.length > 0) {
    return `Signed by key ${a2aDisplayText(verified[0]?.kid, 80)} from ${a2aDisplayText(verified[0]?.jku ?? '', 300)}. A signature shows the card is unchanged since that key signed it; it does not show who holds the key.`;
  }
  const why = notes.map((n) => n.outcome);
  if (why.length === 0) return 'The card carries signatures Dina could not read.';
  if (why.every((o) => o === 'no_jku')) return 'The card is signed, but names no key set Dina can fetch.';
  if (why.includes('bad_signature')) return 'A signature does not match the card.';
  return 'The card is signed, but its key could not be found.';
}

/** Fetch, parse, check, verify and pin a card. Shared by registration and re-verification. */
export async function fetchAndPinCard(
  cardUrl: string,
  fetchSet?: (url: string) => Promise<KeySetFetch>,
): Promise<CardFetchOutcome> {
  const url = checkOutboundUrl(cardUrl);
  if (!url.ok) return { ok: false, reason: `card_url_${url.reason}` };
  const response = await a2aFetch({ method: 'GET', url: cardUrl, headers: {}, ...A2A_FETCH_LIMITS.card });
  if (!response.ok) return { ok: false, reason: `card_fetch_${response.error}` };
  if (response.status !== 200) return { ok: false, reason: `card_fetch_status_${response.status}` };
  const parsed = parseStrictJson(response.body);
  if (!parsed.ok) return { ok: false, reason: `card_json_${parsed.reason}` };
  const shape = validateAgentCardShape(parsed.value);
  if (shape !== null) return { ok: false, reason: shape };
  const card = parsed.value as JsonObject;

  let endpoint: string | null = null;
  let endpointTenant = '';
  for (const iface of card.supportedInterfaces as JsonObject[]) {
    if (iface.protocolBinding !== 'JSONRPC') continue;
    if (!checkRequestedVersion(String(iface.protocolVersion)).ok) continue;
    if (typeof iface.url !== 'string') continue;
    const checked = checkOutboundUrl(iface.url);
    if (!checked.ok) continue;
    // Its parsed form: a character that hides or reorders text, written into
    // the path, is percent-encoded there, so the owner sees what is called.
    endpoint = checked.url.href;
    endpointTenant = typeof iface.tenant === 'string' ? iface.tenant : '';
    break;
  }
  if (endpoint === null) return { ok: false, reason: 'card_no_jsonrpc_1_0_interface' };

  const notes: KeyResolutionNote[] = [];
  const report = await verifyAgentCardSignatures(card, createJkuVerifier(notes, fetchSet));
  let cardHash: string;
  try {
    cardHash = cardPinHash(card, report.verifiedSigners, sha256);
  } catch {
    return { ok: false, reason: 'card_not_canonical' };
  }
  const name = a2aDisplayText(card.name, A2A_NAME_MAX_CODE_POINTS);
  return {
    ok: true,
    pinned: {
      card,
      cardText: response.body,
      cardHash,
      name: name === '' ? 'Unnamed agent' : name,
      endpoint,
      endpointTenant,
      schemesJson: canonicalize({
        securitySchemes: card.securitySchemes ?? {},
        securityRequirements: card.securityRequirements ?? [],
      }),
      signatureState: report.state,
      signatureDetail: signatureSummary(report.state, notes),
      requiresCredential: cardRequiresCredential(card),
    },
  };
}

export type RegisterOutcome =
  | { ok: true; agent: RemoteAgentRow }
  | { ok: false; reason: string; existingAgentId?: string };

export async function registerRemoteAgent(
  deps: RemoteAgentDeps,
  cardUrl: string,
): Promise<RegisterOutcome> {
  const existing = deps.store.getLiveAgentByUrl(cardUrl);
  if (existing !== null) return { ok: false, reason: 'already_registered', existingAgentId: existing.agent_id };
  const fetched = await fetchAndPinCard(cardUrl, deps.fetchKeySet);
  if (!fetched.ok) return fetched;
  const p = fetched.pinned;
  const now = (deps.nowMs ?? Date.now)();
  const row: RemoteAgentRow = {
    agent_id: newA2AId(),
    name: p.name,
    card_url: cardUrl,
    card_json: p.cardText,
    card_hash: p.cardHash,
    endpoint: p.endpoint,
    endpoint_tenant: p.endpointTenant,
    auth_endpoints_json: null,
    schemes_json: p.schemesJson,
    signature_state: p.signatureState,
    signature_detail: p.signatureDetail,
    status: 'candidate',
    approved_at: null,
    last_verified_at: now,
    created_at: now,
    updated_at: now,
  };
  try {
    deps.store.insertAgent(row);
  } catch (err) {
    // The live-URL unique index refused it: another registration of the same
    // URL won the race. Judge by what is stored, never by the error's text;
    // with no live winner the failure is real.
    const winner = deps.store.getLiveAgentByUrl(cardUrl);
    if (winner === null) throw err;
    return { ok: false, reason: 'already_registered', existingAgentId: winner.agent_id };
  }
  return { ok: true, agent: row };
}

export type VerifyOutcome =
  | { ok: true; changed: boolean; agent: RemoteAgentRow }
  | { ok: false; reason: string };

/** Re-fetch the live card. A different pin marks the agent `changed`. */
export async function reverifyRemoteAgent(deps: RemoteAgentDeps, agentId: string): Promise<VerifyOutcome> {
  const agent = deps.store.getAgent(agentId);
  if (agent === null) return { ok: false, reason: 'not_found' };
  if (agent.status === 'revoked') return { ok: false, reason: 'revoked' };
  const fetched = await fetchAndPinCard(agent.card_url, deps.fetchKeySet);
  if (!fetched.ok) return fetched;
  const now = (deps.nowMs ?? Date.now)();
  const p = fetched.pinned;
  if (p.cardHash === agent.card_hash) {
    deps.store.touchAgentVerified(agentId, now);
  } else if (
    !deps.store.repinChangedCard(
      agentId,
      {
        name: p.name,
        card_json: p.cardText,
        card_hash: p.cardHash,
        endpoint: p.endpoint,
        endpoint_tenant: p.endpointTenant,
        schemes_json: p.schemesJson,
        signature_state: p.signatureState,
        signature_detail: p.signatureDetail,
      },
      now,
    )
  ) {
    return { ok: false, reason: 'revoked' };
  }
  const fresh = deps.store.getAgent(agentId);
  if (fresh === null) return { ok: false, reason: 'not_found' };
  return { ok: true, changed: p.cardHash !== agent.card_hash, agent: fresh };
}

/**
 * Remove an agent: its status, and in the same commit every credential it
 * held, their material and any token minted from them. A removed agent
 * leaves no secret behind.
 */
export function revokeRemoteAgent(deps: RemoteAgentDeps, agentId: string): boolean {
  const now = (deps.nowMs ?? Date.now)();
  return deps.store.transaction(() => {
    if (!deps.store.setAgentStatus(agentId, ['candidate', 'active', 'changed'], 'revoked', now)) return false;
    for (const credential of deps.store.listCredentials(agentId)) {
      deps.store.revokeCredential(credential.credential_ref, now);
      deps.store.deleteCredentialSecret(credential.credential_ref);
      forgetCachedToken(credential.credential_ref);
    }
    return true;
  });
}

/**
 * The pinned card's skills, as the owner sees them. An id is the key a
 * binding, the consent card and Brain all name a skill by, so it is shown as
 * written or not at all: a skill whose id holds a character that hides or
 * reorders text, a control, or loose whitespace is not offered, and cannot
 * be bound.
 */
export function pinnedRemoteSkills(agent: RemoteAgentRow): { id: string; name: string; description: string; tags: string[] }[] {
  const parsed = parseStrictJson(agent.card_json);
  if (!parsed.ok || !isPlainObject(parsed.value) || !Array.isArray(parsed.value.skills)) return [];
  const plainId = (id: unknown): id is string => typeof id === 'string' && id !== '' && a2aDisplayText(id, MAX_ID_LENGTH) === id;
  return parsed.value.skills.filter((s): s is JsonObject => isPlainObject(s) && plainId(s.id)).map((s) => ({
    id: s.id as string,
    name: a2aDisplayText(s.name, A2A_NAME_MAX_CODE_POINTS),
    description: a2aDisplayText(s.description),
    tags: Array.isArray(s.tags) ? s.tags.map((t) => a2aDisplayText(t, 60)).filter((t) => t !== '') : [],
  }));
}

function cardRequiresCredentialRow(agent: RemoteAgentRow): boolean {
  const parsed = parseStrictJson(agent.card_json);
  return parsed.ok && isPlainObject(parsed.value) && cardRequiresCredential(parsed.value as JsonObject);
}

/** The `none` credential's scope: nothing is delegated, so there is nothing to scope. */
const NONE_SCOPE_JSON = canonicalize({ kind: 'none' });

export type CredentialOutcome = { ok: true; credential: RemoteCredentialRow } | { ok: false; reason: string };

/**
 * A versioned "no credential" reference (design §5.3), refused for a card
 * that declares security requirements: such an agent takes a real
 * credential (`createRemoteCredential`).
 */
export function createNoneCredential(deps: RemoteAgentDeps, agentId: string): CredentialOutcome {
  const agent = deps.store.getAgent(agentId);
  if (agent === null) return { ok: false, reason: 'not_found' };
  if (agent.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (cardRequiresCredentialRow(agent)) return { ok: false, reason: 'credential_required_by_card' };
  const now = (deps.nowMs ?? Date.now)();
  return deps.store.transaction(() => {
    const row: RemoteCredentialRow = {
      credential_ref: newA2AId(),
      remote_agent_id: agentId,
      kind: 'none',
      audience: null,
      scope_json: NONE_SCOPE_JSON,
      scope_hash: sha256HexOfText(NONE_SCOPE_JSON),
      revision: deps.store.maxCredentialRevision(agentId) + 1,
      status: 'active',
      created_at: now,
      revoked_at: null,
    };
    deps.store.insertCredential(row);
    return { ok: true, credential: row } as const;
  });
}

/** Revoke a credential reference; its material, and any token minted from it, go with it. */
export function revokeRemoteCredential(deps: RemoteAgentDeps, credentialRef: string): boolean {
  const now = (deps.nowMs ?? Date.now)();
  return deps.store.transaction(() => {
    const revoked = deps.store.revokeCredential(credentialRef, now);
    deps.store.deleteCredentialSecret(credentialRef);
    forgetCachedToken(credentialRef);
    return revoked;
  });
}

export interface BindSkillInput {
  skill: string;
  actionClass: string;
  credentialRef: string;
  resultSchema?: unknown;
}

export type BindOutcome = { ok: true; binding: SkillBindingRow } | { ok: false; reason: string };

/** Bind one skill of the agent's CURRENT pinned card (design §5.5). */
export function bindRemoteSkill(deps: RemoteAgentDeps, agentId: string, input: BindSkillInput): BindOutcome {
  const agent = deps.store.getAgent(agentId);
  if (agent === null) return { ok: false, reason: 'not_found' };
  if (agent.status === 'revoked') return { ok: false, reason: 'revoked' };
  if (!pinnedRemoteSkills(agent).some((s) => s.id === input.skill)) return { ok: false, reason: 'skill_not_on_card' };
  const credential = deps.store.getCredential(input.credentialRef);
  if (credential === null || credential.remote_agent_id !== agentId) return { ok: false, reason: 'credential_not_found' };
  if (credential.status !== 'active') return { ok: false, reason: 'credential_revoked' };
  if (credential.kind === 'none' && cardRequiresCredentialRow(agent)) {
    return { ok: false, reason: 'credential_required_by_card' };
  }
  if (!credentialFitsCard(credential, agent.schemes_json)) return { ok: false, reason: 'credential_not_on_card' };
  const check = validateSkillBinding({
    remoteAgentId: agentId,
    cardHash: agent.card_hash,
    skill: input.skill,
    actionClass: input.actionClass,
    credentialRef: input.credentialRef,
    ...(input.resultSchema !== undefined ? { resultSchema: input.resultSchema } : {}),
  });
  if (!check.ok) return check;
  const binding = deps.store.upsertBinding(
    {
      remote_agent_id: agentId,
      card_hash: agent.card_hash,
      skill: input.skill,
      action_class: check.binding.actionClass,
      result_schema_json:
        check.binding.resultSchema === undefined ? null : canonicalize(check.binding.resultSchema),
      credential_ref: input.credentialRef,
    },
    (deps.nowMs ?? Date.now)(),
  );
  return { ok: true, binding };
}

export function unbindRemoteSkill(deps: RemoteAgentDeps, agentId: string, skill: string): boolean {
  const agent = deps.store.getAgent(agentId);
  if (agent === null) return false;
  return deps.store.revokeBinding(agentId, agent.card_hash, skill, (deps.nowMs ?? Date.now)());
}

/** Live bindings on the agent's current pin. */
export function liveRemoteBindings(store: A2AStore, agent: RemoteAgentRow): SkillBindingRow[] {
  return store.listBindings(agent.agent_id, agent.card_hash).filter((b) => b.revoked_at === null);
}

/**
 * Activate a candidate or a changed agent. The owner has reviewed the card
 * and bound at least one skill of its current pin.
 */
export function activateRemoteAgent(deps: RemoteAgentDeps, agentId: string): { ok: true } | { ok: false; reason: string } {
  const agent = deps.store.getAgent(agentId);
  if (agent === null) return { ok: false, reason: 'not_found' };
  if (agent.status !== 'candidate' && agent.status !== 'changed') {
    return { ok: false, reason: agent.status === 'active' ? 'already_active' : 'revoked' };
  }
  if (liveRemoteBindings(deps.store, agent).length === 0) return { ok: false, reason: 'no_bound_skill' };
  return deps.store.setAgentStatus(agentId, [agent.status], 'active', (deps.nowMs ?? Date.now)())
    ? { ok: true }
    : { ok: false, reason: 'raced' };
}
