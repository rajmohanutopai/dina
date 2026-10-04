/**
 * Outbound proposal (design §6.2): Brain proposes a message to a bound skill
 * of an active remote agent; Core builds exactly what would be sent, stages
 * the operation, and mints the consent card. Nothing is sent until the owner
 * approves that card.
 *
 *  - A proposal belongs to a live owner turn in its conversation (step 0).
 *  - The projection is the A2A message's parts, cleaned (invisible
 *    characters removed, NFC) so what the owner reads is what goes out, and
 *    scrubbed: every PII match becomes a placeholder such as `[EMAIL_1]`,
 *    numbered across the whole message. Nothing scrubbed leaves (plan D7).
 *  - Brain may claim that parts of the text are whole messages the owner
 *    sent, or whole vault items released into the conversation; Core proves
 *    each from its log or refuses the proposal (step 2, `provenance.ts`).
 *    Unproven text is `unverified` and `may_contain_sensitive`; private-vault
 *    sources and taint are `restricted_source`.
 *  - An original is kept only for a single provable source, sealed (A2A-I9).
 *  - The consent payload is A2A-I10's field set plus the proven sources; its
 *    RFC 8785 sha256 keys the card, the permit and the dispatch.
 *  - Staging, originals, the card, and the card's child row commit together.
 */

import {
  A2A_LIMITS,
  DINA_A2A_EXTENSION_URI,
  FORBIDDEN_MEMBER_NAME,
  isPlainObject,
  parseStrictJson,
  type JsonObject,
  type JsonValue,
} from '@dina/a2a';

import { isMirrorableDetail, isMirrorableTitle } from '../approval/mirror_text';
import { sealForPersonaPurpose } from '../persona/orchestrator';
import { detectPII } from '../pii/patterns';
import { parseReleaseSession } from '../vault/release';
import { WorkflowTaskKind, WorkflowTaskPriority, WorkflowTaskState } from '../workflow/domain';

import { credentialScopeOf } from './credentials';
import { canonicalDigest } from './digest';
import { ENTITY_MAX_LIFE_MS, ENTITY_SEAL_PURPOSE, entityAad } from './entities';
import { a2aConsentKey, a2aConsentTaskId, newA2AId } from './ids';
import {
  resolveProvenance,
  restrictedReads,
  singleSourceOf,
  type SpanSource,
} from './provenance';
import { cleanForProvenance } from './provenance_text';
import { getA2AReleaseLog } from './release_log';
import { a2aDisplayText, liveRemoteBindings, pinnedRemoteSkills } from './remote_agents';

import type { A2ARuntime } from './runtime';
import type { EntityRow, OutboundActionClass, RemoteAgentRow, RemoteCredentialRow, SkillBindingRow } from './store';

export const A2A_DELEGATION_CONSENT_TYPE = 'a2a_delegation_consent';
export const A2A_DISPATCH_PAYLOAD_TYPE = 'a2a_dispatch';
/** The owner principal of every outbound operation. */
export const OUTBOUND_PRINCIPAL = 'owner';
export const CONSENT_TTL_MS = 15 * 60_000;
export const MAX_PENDING_PER_AGENT = 10;
export const MAX_PENDING_TOTAL = 50;
/**
 * Proposals Brain may raise per rolling hour, whatever became of them: the
 * pending caps alone would let a looping or compromised Brain raise a fresh
 * card the moment the owner clears one.
 */
export const MAX_PROPOSALS_PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;
/** A data part sits at depth 4 in the consent payload and 5 in the request; keep both under the cap. */
const DATA_MAX_DEPTH = A2A_LIMITS.maxJsonDepth - 5;

export type OutgoingPart = { text: string } | { data: JsonObject };

export type ConsentLabel = 'may_contain_sensitive' | 'placeholders' | 'restricted_source' | 'unverified';

/** A part of the message Core proved the source of (§6.2 step 2), in the form that is sent. */
export interface ProvenanceEntry {
  quote: string;
  from: 'owner' | 'vault';
  /** The vault the quote came from, for `vault`. */
  persona?: string;
}

/**
 * Design A2A-I10: what the owner approves, field for field — plus the
 * provenance Core proved, so the owner approves the sources as shown.
 */
export interface ConsentPayload {
  remote_agent_id: string;
  card_hash: string;
  endpoint: string;
  skill: string;
  action_class: OutboundActionClass;
  credential_ref: string;
  credential_revision: number;
  labels: ConsentLabel[];
  projection: { parts: OutgoingPart[] };
  provenance: ProvenanceEntry[];
}

/** The authority a permit is minted under, re-checked in the dispatch transaction (design §6.3). */
export interface OutboundSnapshot {
  card_hash: string;
  endpoint: string;
  endpoint_tenant: string;
  skill: string;
  binding_revision: number;
  action_class: OutboundActionClass;
  credential_ref: string;
  credential_revision: number;
  /** The binding's pinned result schema (canonical JSON) at consent, or null for the default envelope. */
  result_schema_json: string | null;
  consent_hash: string;
  approval_task_id: string;
}

export interface ConsentCardDisplay {
  agent_name: string;
  card_url: string;
  endpoint: string;
  signature_state: string;
  signature_detail: string;
  skill_name: string;
  credential: string;
  labels: string[];
  placeholders: { type: string; count: number }[];
  /** One plain sentence per proven quote. */
  sources: string[];
  /** Private vaults the message draws on, or the conversation read (`restricted_source`). */
  restricted_personas: string[];
  effect: string;
}

export interface DelegationConsentCard {
  type: typeof A2A_DELEGATION_CONSENT_TYPE;
  operation_id: string;
  consent_hash: string;
  consent: ConsentPayload;
  display: ConsentCardDisplay;
}

const LABEL_TEXT: Readonly<Record<ConsentLabel, string>> = {
  unverified:
    'Dina cannot prove where some of this text came from. Your reading of it is the only check for those parts.',
  may_contain_sensitive:
    'It may contain health, money or other private details. Read all of it before you approve.',
  restricted_source:
    'It draws on a vault you keep private, or this conversation read one. Approving sends that on.',
  placeholders:
    'Personal details were replaced with placeholders such as [EMAIL_1]. The agent never sees the originals.',
};

function effectNote(actionClass: OutboundActionClass): string {
  const resend =
    'If the connection drops after sending, Dina will not send it again, and the result may stay unknown.';
  return actionClass === 'read' || actionClass === 'quote'
    ? `The agent is asked for information. ${resend}`
    : `The agent may change something on its side. ${resend}`;
}

class ProjectionRefusal extends Error {}

/** A scrubbed text and where its placeholders stand in for the original. */
interface ScrubMap {
  out: string;
  /** Replaced stretches of the original, sorted: `[start, end)` became `token` at `outStart`. */
  replaced: { start: number; end: number; outStart: number; token: string }[];
}

/**
 * The scrubbed form of `[start, end)` of the original, or null when the
 * boundary cuts through a replaced detail (part of it would show).
 */
function scrubbedSlice(map: ScrubMap, start: number, end: number): string | null {
  const toOut = (pos: number): number | null => {
    let shift = 0;
    for (const r of map.replaced) {
      if (pos <= r.start) break;
      if (pos < r.end) return null; // inside a replaced detail
      shift += r.token.length - (r.end - r.start);
    }
    return pos + shift;
  };
  const from = toOut(start);
  const to = toOut(end);
  return from === null || to === null ? null : map.out.slice(from, to);
}

/** The shape of a placeholder this scrubber makes: `[EMAIL_1]`, `[CREDIT_CARD_2]`. */
const PLACEHOLDER_SHAPE = /\[[A-Z][A-Z0-9_]*_\d+\]/;

/**
 * One placeholder per distinct value, numbered per type across the whole
 * message. Input that already holds a placeholder-shaped token is refused:
 * the owner could not tell it from a real placeholder, and the card's
 * counts would be wrong.
 */
class PlaceholderScrubber {
  private readonly counts = new Map<string, number>();
  private readonly tokens = new Map<string, string>();

  scrub(text: string): string {
    return this.scrubMapped(text).out;
  }

  /**
   * Scrub, and say where: every replaced stretch of `text` with the
   * placeholder that took its place, so a part of the text can be found in
   * the scrubbed form by offset (never re-scrubbed out of context).
   */
  scrubMapped(text: string): ScrubMap {
    if (PLACEHOLDER_SHAPE.test(text)) throw new ProjectionRefusal('placeholder_in_input');
    const matches = detectPII(text).sort((a, b) => a.start - b.start);
    const replaced: ScrubMap['replaced'] = [];
    let out = '';
    let at = 0;
    for (const m of matches) {
      if (m.start < at) continue; // detectPII resolves overlaps; stay safe anyway
      const key = `${m.type}\u0000${m.value}`;
      let token = this.tokens.get(key);
      if (token === undefined) {
        const n = (this.counts.get(m.type) ?? 0) + 1;
        this.counts.set(m.type, n);
        token = `[${m.type}_${n}]`;
        this.tokens.set(key, token);
      }
      out += text.slice(at, m.start);
      replaced.push({ start: m.start, end: m.end, outStart: out.length, token });
      out += token;
      at = m.end;
    }
    return { out: out + text.slice(at), replaced };
  }

  /** Every value replaced, with its placeholder. */
  entries(): { token: string; type: string; value: string }[] {
    return [...this.tokens.entries()].map(([key, token]) => {
      const sep = key.indexOf('\u0000');
      return { token, type: key.slice(0, sep), value: key.slice(sep + 1) };
    });
  }

  summary(): { type: string; count: number }[] {
    return [...this.counts.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  }
}

/**
 * Clean and scrub every string of a data value, keys included; keys sorted so
 * numbering is deterministic. A number is judged by its decimal text, so a
 * phone or card number sent as a JSON number becomes its placeholder (a
 * string) like the same digits in text would.
 */
function cleanData(value: unknown, depth: number, scrubber: PlaceholderScrubber, keepSkill?: string): JsonValue {
  if (depth > DATA_MAX_DEPTH) throw new ProjectionRefusal('data_too_deep');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ProjectionRefusal('data_not_json');
    const asText = String(value);
    const scrubbed = scrubber.scrub(asText);
    return scrubbed === asText ? value : scrubbed;
  }
  if (typeof value === 'string') return scrubber.scrub(cleanForProvenance(value));
  if (Array.isArray(value)) return value.map((v) => cleanData(v, depth + 1, scrubber));
  if (isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const cleanKey = scrubber.scrub(cleanForProvenance(key));
      if (cleanKey === FORBIDDEN_MEMBER_NAME) throw new ProjectionRefusal('data_forbidden_key');
      if (Object.prototype.hasOwnProperty.call(out, cleanKey)) throw new ProjectionRefusal('data_key_collision');
      const member = value[key];
      // The envelope's skill, when it is the bound skill: the remote card's own word, sent back as written.
      // `keepSkill` is given for the top-level object only, and never passed down.
      if (key === 'skill' && typeof member === 'string' && keepSkill !== undefined && cleanForProvenance(member) === keepSkill) {
        out[cleanKey] = keepSkill;
        continue;
      }
      out[cleanKey] = cleanData(member, depth + 1, scrubber);
    }
    return out;
  }
  throw new ProjectionRefusal('data_not_json');
}

export type ProjectionOutcome =
  | { ok: true; parts: OutgoingPart[]; placeholders: { type: string; count: number }[] }
  | { ok: false; reason: string };

/**
 * What would be sent: a text part, a data part, or both, cleaned (invisible
 * characters removed, NFC — the form provenance is proven on) and scrubbed.
 */
export function buildOutgoingProjection(input: { text?: unknown; data?: unknown }): ProjectionOutcome {
  const out = projectWith(input, new PlaceholderScrubber());
  return out.ok ? { ok: true, parts: out.parts, placeholders: out.placeholders } : out;
}

/** A projection, plus where its text part's placeholders stand and the data part as sent. */
type MappedProjection =
  | { ok: true; parts: OutgoingPart[]; placeholders: { type: string; count: number }[]; textMap: ScrubMap | null; dataJson: string }
  | { ok: false; reason: string };

/**
 * `boundSkill`: the skill id the proposal is bound to, as the remote's pinned
 * card writes it. A data part's own `skill` member equal to it is left
 * unscrubbed (a capability@rkey id reads like a UPI address); it names the
 * remote's skill, holds nothing of the owner's, and the remote needs it as
 * written.
 */
function projectWith(
  input: { text?: unknown; data?: unknown },
  scrubber: PlaceholderScrubber,
  boundSkill?: string,
): MappedProjection {
  const parts: OutgoingPart[] = [];
  let textMap: ScrubMap | null = null;
  let dataJson = '';
  try {
    if (input.text !== undefined) {
      if (typeof input.text !== 'string') return { ok: false, reason: 'text_not_string' };
      textMap = scrubber.scrubMapped(cleanForProvenance(input.text));
      const text = textMap.out;
      if ([...text].length > A2A_LIMITS.maxTextCodePoints) return { ok: false, reason: 'text_too_long' };
      if (text.trim() !== '') parts.push({ text });
    }
    if (input.data !== undefined) {
      if (!isPlainObject(input.data)) return { ok: false, reason: 'data_not_object' };
      const data = cleanData(input.data, 0, scrubber, boundSkill) as JsonObject;
      dataJson = JSON.stringify(data);
      parts.push({ data });
    }
  } catch (err) {
    if (err instanceof ProjectionRefusal) return { ok: false, reason: err.message };
    throw err;
  }
  if (parts.length === 0) return { ok: false, reason: 'empty_message' };
  if (new TextEncoder().encode(JSON.stringify(parts)).length > A2A_LIMITS.maxPayloadBytes) {
    return { ok: false, reason: 'message_too_large' };
  }
  return { ok: true, parts, placeholders: scrubber.summary(), textMap, dataJson };
}

export interface ProposalInput {
  agentId: string;
  skill: string;
  text?: unknown;
  data?: unknown;
  /** The conversation the result returns to (A2A-I7). */
  replyTo?: string;
  /** The conversation the proposal is made in: it must hold a live owner turn (§6.2 step 0). */
  releaseSession?: unknown;
  /** Where Brain says parts of `text` came from; Core proves each or refuses (§6.2 step 2). */
  sources?: unknown;
}

/** A proposal must follow an owner turn this recent in its conversation (§6.2 step 0). */
export const OWNER_TURN_LIVE_MS = 30 * 60_000;

export type ProposalOutcome =
  | {
      ok: true;
      operationId: string;
      approvalTaskId: string;
      consentHash: string;
      expiresAtMs: number;
      projection: { parts: OutgoingPart[] };
      labels: ConsentLabel[];
    }
  | { ok: false; reason: string };

/** The live authority a proposal or a dispatch would act under, or why there is none. */
export function currentAuthority(
  runtime: A2ARuntime,
  agentId: string,
  skill: string,
):
  | { ok: true; agent: RemoteAgentRow; binding: SkillBindingRow; credential: RemoteCredentialRow }
  | { ok: false; reason: string } {
  const agent = runtime.store.getAgent(agentId);
  if (agent === null) return { ok: false, reason: 'agent_not_found' };
  if (agent.status !== 'active') return { ok: false, reason: `agent_${agent.status}` };
  const binding = liveRemoteBindings(runtime.store, agent).find((b) => b.skill === skill);
  if (binding === undefined) return { ok: false, reason: 'skill_not_bound' };
  const credential = runtime.store.getCredential(binding.credential_ref);
  if (credential === null || credential.status !== 'active') return { ok: false, reason: 'credential_revoked' };
  return { ok: true, agent, binding, credential };
}

function bounded(text: string, max: number): string {
  return a2aDisplayText(text, max);
}

/**
 * What the card says about the credential: its scope as the owner set it,
 * and that the agent may act with everything the credential allows (§1.3).
 */
function credentialSentence(credential: RemoteCredentialRow): string {
  const scope = credentialScopeOf(credential);
  if (scope === null) return `A credential Dina cannot describe (revision ${credential.revision}).`;
  if (scope.kind === 'none') return 'No credential. The agent receives no secret from Dina.';
  const all = 'Whatever that credential allows at the agent, the agent can do with this request.';
  const revision = `revision ${credential.revision}`;
  if (scope.kind === 'api_key') return `An API key in the ${bounded(scope.header, 64)} header (${revision}). ${all}`;
  if (scope.kind === 'bearer') return `A bearer token (${revision}). ${all}`;
  const scopes = scope.scopes.length > 0 ? scope.scopes.map((x) => bounded(x, 60)).join(', ') : 'no named scopes';
  return `An OAuth client that gets tokens from ${bounded(new URL(scope.token_url).host, 120)} for ${scopes} (${revision}). ${all}`;
}

/** The plain sentence a card shows for one proven quote. */
function sourceSentence(entry: ProvenanceEntry): string {
  const quote = `\u201c${bounded(entry.quote, 200)}\u201d`;
  return entry.from === 'owner'
    ? `${quote} is a message you sent in this conversation, word for word.`
    : `${quote} is the full text of an item in your ${bounded(entry.persona ?? '', 40)} vault, saved before this conversation.`;
}

/**
 * Seal one original under its single source (A2A-I9); null when it cannot be
 * sealed. A vault original is sealed under a key derived from its persona's
 * DEK for this purpose alone, bound to its operation and placeholder; the
 * owner's own words stay in the identity file, under its SQLCipher key.
 */
function sealOriginal(
  source: SpanSource,
  value: string,
  operationId: string,
  placeholder: string,
): Pick<EntityRow, 'seal' | 'persona' | 'sealed'> | null {
  const bytes = new TextEncoder().encode(value);
  if (source.kind === 'owner') return { seal: 'identity_db', persona: null, sealed: bytes };
  const sealed = sealForPersonaPurpose(source.persona, ENTITY_SEAL_PURPOSE, entityAad(operationId, placeholder), bytes);
  return sealed === null ? null : { seal: 'persona_dek', persona: source.persona, sealed };
}

/** Whether a pinned card declares Dina's invocation extension: its data parts are Dina envelopes. */
function speaksDina(cardJson: string): boolean {
  const card = parseStrictJson(cardJson);
  if (!card.ok || !isPlainObject(card.value) || !isPlainObject(card.value.capabilities)) return false;
  const extensions = card.value.capabilities.extensions;
  return Array.isArray(extensions) && extensions.some((e) => isPlainObject(e) && e.uri === DINA_A2A_EXTENSION_URI);
}

export function proposeDelegation(runtime: A2ARuntime, input: ProposalInput): ProposalOutcome {
  const authority = currentAuthority(runtime, input.agentId, input.skill);
  if (!authority.ok) return authority;
  const { agent, binding, credential } = authority;

  // Step 0: a proposal belongs to a live owner turn in its conversation.
  const log = getA2AReleaseLog();
  if (log === null) return { ok: false, reason: 'a2a_unavailable' };
  const releaseSession = parseReleaseSession(input.releaseSession);
  const turn = releaseSession === null ? null : log.latestUtterance(releaseSession);
  if (releaseSession === null || turn === null || runtime.nowMs() - turn.recorded_at > OWNER_TURN_LIVE_MS) {
    return { ok: false, reason: 'no_owner_turn' };
  }

  // The hourly cap counts refusals too, so a refused claim is no free oracle.
  const hourAgo = runtime.nowMs() - HOUR_MS;
  if (
    runtime.store.countOutboundCreatedAfter(hourAgo) + runtime.store.countProposalRefusalsAfter(hourAgo) >=
    MAX_PROPOSALS_PER_HOUR
  ) {
    return { ok: false, reason: 'too_many_recent' };
  }
  const refuse = (reason: string): ProposalOutcome => {
    runtime.store.noteProposalRefusal(runtime.nowMs(), HOUR_MS);
    return { ok: false, reason };
  };

  // A Dina remote runs the skill its envelope names: that must be the skill the owner bound,
  // exactly as the card writes it.
  const dina = speaksDina(agent.card_json);
  if (dina && isPlainObject(input.data) && Object.prototype.hasOwnProperty.call(input.data, 'skill')) {
    if (input.data.skill !== binding.skill) return refuse('envelope_skill_not_bound');
  }
  const scrubber = new PlaceholderScrubber();
  const projection = projectWith(input, scrubber, binding.skill);
  if (!projection.ok) return refuse(projection.reason);
  // And the envelope as it will go out: cleaning removes invisible characters from keys too,
  // so another key (`sk\u200Bill`) can become `skill` only now. What the remote reads is checked.
  if (dina) {
    const sent = projection.parts.find((p): p is { data: JsonObject } => 'data' in p)?.data;
    if (sent !== undefined && Object.prototype.hasOwnProperty.call(sent, 'skill') && sent.skill !== binding.skill) {
      return refuse('envelope_skill_not_bound');
    }
  }

  // Step 2: provenance, proven by Core from its own log or refused.
  if (input.sources !== undefined && typeof input.text !== 'string') return refuse('source_not_in_message');
  const resolved =
    typeof input.text === 'string'
      ? resolveProvenance(log, releaseSession, input.text, input.sources)
      : null;
  if (resolved !== null && 'refused' in resolved) return refuse(resolved.refused);
  const pending = runtime.store.listTasksInStates('outbound', ['pending_decision']);
  if (pending.length >= MAX_PENDING_TOTAL) return { ok: false, reason: 'too_many_pending' };
  if (pending.filter((t) => t.remote_agent_id === agent.agent_id).length >= MAX_PENDING_PER_AGENT) {
    return { ok: false, reason: 'too_many_pending' };
  }

  // A data part is never proven; nor is any text no proven quote covers.
  const derived = input.data !== undefined || resolved === null || resolved.derived;
  const spans = resolved?.spans ?? [];
  // Restricted: a proven quote from a private vault, or derived text in a
  // conversation that read one (it inherits the read set's taint).
  const restrictedPersonas = [
    ...new Set([
      ...spans.flatMap((sp) => (sp.source.kind === 'vault' && sp.source.restricted ? [sp.source.persona] : [])),
      ...(derived ? restrictedReads(log, releaseSession) : []),
    ]),
  ].sort();
  const labels: ConsentLabel[] = [];
  if (derived) labels.push('may_contain_sensitive', 'unverified');
  if (restrictedPersonas.length > 0) labels.push('restricted_source');
  if (projection.placeholders.length > 0) labels.push('placeholders');
  labels.sort();

  // The quotes as they are sent: cut from the scrubbed message by offset,
  // never scrubbed again out of context. A quote that splits a personal
  // detail would show part of it, so it is refused.
  const provenance: ProvenanceEntry[] = [];
  for (const span of spans) {
    const quote = projection.textMap === null ? null : scrubbedSlice(projection.textMap, span.start, span.end);
    if (quote === null) return refuse('source_cuts_personal_detail');
    provenance.push({
      quote,
      from: span.source.kind,
      ...(span.source.kind === 'vault' ? { persona: span.source.persona } : {}),
    });
  }

  const consent: ConsentPayload = {
    remote_agent_id: agent.agent_id,
    card_hash: agent.card_hash,
    endpoint: agent.endpoint,
    skill: binding.skill,
    action_class: binding.action_class,
    credential_ref: credential.credential_ref,
    credential_revision: credential.revision,
    labels,
    projection: { parts: projection.parts },
    provenance,
  };
  const consentHash = canonicalDigest(consent);
  const skillName = pinnedRemoteSkills(agent).find((sk) => sk.id === binding.skill)?.name ?? binding.skill;
  const now = runtime.nowMs();
  const operationId = newA2AId();
  const approvalTaskId = a2aConsentTaskId(operationId);
  const expiresAtMs = now + CONSENT_TTL_MS;
  const card: DelegationConsentCard = {
    type: A2A_DELEGATION_CONSENT_TYPE,
    operation_id: operationId,
    consent_hash: consentHash,
    consent,
    display: {
      agent_name: agent.name,
      card_url: agent.card_url,
      endpoint: agent.endpoint,
      signature_state: agent.signature_state,
      signature_detail: agent.signature_detail,
      skill_name: skillName,
      credential: credentialSentence(credential),
      labels: labels.map((l) => LABEL_TEXT[l]),
      placeholders: projection.placeholders,
      sources: provenance.map(sourceSentence),
      restricted_personas: restrictedPersonas,
      effect: effectNote(binding.action_class),
    },
  };
  const snapshot: Omit<OutboundSnapshot, 'approval_task_id'> = {
    card_hash: agent.card_hash,
    endpoint: agent.endpoint,
    endpoint_tenant: agent.endpoint_tenant,
    skill: binding.skill,
    binding_revision: binding.revision,
    action_class: binding.action_class,
    credential_ref: credential.credential_ref,
    credential_revision: credential.revision,
    result_schema_json: binding.result_schema_json,
    consent_hash: consentHash,
  };

  // Originals kept only for a single provable source (A2A-I9): a value that
  // also sits in the (never proven) data part keeps none.
  const originals =
    resolved === null
      ? []
      : scrubber.entries().flatMap(({ token, value }) => {
          if (projection.dataJson.includes(token)) return [];
          const source = singleSourceOf(resolved, value);
          const sealed = source === null ? null : sealOriginal(source, value, operationId, token);
          return sealed === null ? [] : [{ placeholder: token, ...sealed }];
        });

  runtime.store.transaction(() => {
    const op = runtime.store.insertTask({
      external_id: operationId,
      direction: 'outbound',
      principal: OUTBOUND_PRINCIPAL,
      internal_id: approvalTaskId,
      context_id: null,
      state: 'pending_decision',
      reason_code: null,
      result_json: null,
      result_quarantine: null,
      quarantine_digest: null,
      guard_receipt_id: null,
      message_id: null,
      request_hash: consentHash,
      card_hash: agent.card_hash,
      submission_phase: null,
      effect_phase: null,
      continuation_generation: 0,
      input_required_json: null,
      snapshot_json: JSON.stringify(snapshot),
      consent_json: JSON.stringify(consent),
      reply_to: input.replyTo ?? null,
      release_session_id: releaseSession,
      remote_agent_id: agent.agent_id,
      remote_task_id: null,
      remote_context_id: null,
      status_updated_at: now,
      created_at: now,
    });
    for (const original of originals) {
      runtime.store.insertEntity({ operation_ref: op.id, created_at: now, expires_at: now + ENTITY_MAX_LIFE_MS, ...original });
    }
    runtime.workflow.create({
      id: approvalTaskId,
      kind: WorkflowTaskKind.Approval,
      description: `Send to ${bounded(agent.name, 60)}: ${bounded(skillName, 60)}`,
      payload: JSON.stringify(card),
      expiresAtSec: Math.floor(expiresAtMs / 1000),
      correlationId: A2A_DELEGATION_CONSENT_TYPE,
      priority: WorkflowTaskPriority.UserBlocking,
      origin: 'system',
      idempotencyKey: a2aConsentKey(operationId),
      initialState: WorkflowTaskState.PendingApproval,
    });
    runtime.store.insertChild({
      child_task_id: approvalTaskId,
      operation_ref: op.id,
      generation: 0,
      role: 'approval',
      created_at: now,
    });
  });
  return {
    ok: true,
    operationId,
    approvalTaskId,
    consentHash,
    expiresAtMs,
    projection: consent.projection,
    labels,
  };
}

/** Parse a stored consent card; null when the payload is not one. */
export function parseDelegationConsentCard(payload: string): DelegationConsentCard | null {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(value) || value.type !== A2A_DELEGATION_CONSENT_TYPE) return null;
  if (typeof value.operation_id !== 'string' || typeof value.consent_hash !== 'string') return null;
  if (!isPlainObject(value.consent) || !isPlainObject(value.display)) return null;
  return value as unknown as DelegationConsentCard;
}

/**
 * The consent card as the paired phone shows it (plan §3.20: the server runs
 * Lane 1, the phone decides its cards), or null when the full message cannot
 * be shown there. The phone must show every byte that would be sent, so a
 * message too long for a mirrored card, or carrying a character the mirror
 * refuses, is decided on the server's console only.
 */
export function delegationConsentMirror(
  card: DelegationConsentCard,
): { title: string; detail: string } | null {
  const d = card.display;
  const title = `Send to ${a2aDisplayText(d.agent_name, 60)}: ${a2aDisplayText(d.skill_name, 60)}`;
  const message = card.consent.projection.parts
    .map((p) => ('text' in p ? p.text : JSON.stringify(p.data, null, 2)))
    .join('\n\n');
  const detail = [
    `To ${d.agent_name} at ${d.endpoint}`,
    d.credential,
    d.effect,
    ...d.labels,
    ...(d.placeholders.length > 0
      ? [`Replaced with placeholders: ${d.placeholders.map((x) => `${x.type} ×${x.count}`).join(', ')}`]
      : []),
    ...(Array.isArray(d.restricted_personas) && d.restricted_personas.length > 0
      ? [`Private vaults involved: ${d.restricted_personas.join(', ')}`]
      : []),
    ...(Array.isArray(d.sources) ? d.sources : []),
    'Exactly what will be sent:',
    message,
  ].join('\n');
  return isMirrorableTitle(title) && isMirrorableDetail(detail) ? { title, detail } : null;
}
