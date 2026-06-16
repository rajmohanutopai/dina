/**
 * Explicit composer-lane enforcement (docs/COMPOSER_MODES_DESIGN.md 6.5-6.6).
 *
 * The SINGLE source of truth for forcing a composer mode's external lane, used
 * by BOTH ask paths so they cannot drift:
 *   - the legacy direct handler `reasoning/ask_handler.ts::makeAgenticAskHandler`
 *   - the PRODUCTION coordinator path
 *     `composition/ask_coordinator.ts::buildAgenticExecuteFn` (what mobile + HNL
 *     actually run via `createCoordinatorAskHandler`).
 *
 * Enforcement is three layers — none advisory:
 *   1. system-prompt lane block (imperative routing instructions)
 *   2. tool-policy allowlist (the loop physically cannot call off-lane tools,
 *      but enrichment tools stay in EVERY lane — invariant 6.6)
 *   3. result-validation gate: the answer MUST come from the lane or be a clean
 *      no-result / outage reply, never general knowledge.
 *
 * The gate distinguishes ABSENCE (the network was reached and had nothing) from
 * an OUTAGE (the network could not be reached) so an infra problem never reads
 * to the user as "there is no service / no review for that".
 */

import type { IntentSource } from './intent_classifier';
import type { ToolRegistry } from './tool_registry';

// ── Tool lanes ──────────────────────────────────────────────────────────────
// Enrichment tools are in EVERY lane: a mode picks the EXTERNAL lane, it never
// disables personal-context enrichment (invariant 6.6). Unknown/unregistered
// names are skipped by `ToolRegistry.subset`, so an un-wired host is fine.
export const ENRICHMENT_TOOLS = [
  'vault_search',
  'browse_vault',
  'get_full_content',
  'find_person',
  'list_personas',
] as const;

export const SERVICES_LANE_TOOLS = [
  'search_capabilities',
  'search_provider_services',
  'query_service',
  'geocode',
  'find_preferred_provider',
  ...ENRICHMENT_TOOLS,
] as const;

export const REVIEWS_LANE_TOOLS = ['search_peerlens', 'geocode', ...ENRICHMENT_TOOLS] as const;

// ── Canned lane answers ─────────────────────────────────────────────────────
/** No provider exists for what the user asked (the network was reached). */
export const NO_SERVICE_ANSWER = "I couldn't find a Dina service that can answer that yet.";
/** The services network could not be reached (infra problem, not absence). */
export const SERVICES_OUTAGE_ANSWER =
  "I couldn't reach the services network just now, so I can't answer that from a service yet. Please try again in a moment.";
/** No reviews exist for the subject (the network was reached). */
export const NO_REVIEWS_ANSWER = "I don't have any network reviews for that yet.";
/** The review network could not be reached (infra problem, not absence). */
export const REVIEWS_OUTAGE_ANSWER =
  "I couldn't reach the review network just now, so I can't pull reviews for that yet. Please try again in a moment.";

// ── Routing blocks (system-prompt lane instructions) ────────────────────────
/**
 * Provider-services routing guidance. Imperative for the forced Services lane;
 * also appended (advisorily) by the classifier hint when sources include
 * provider_services. Exported so tests can assert against stable strings.
 */
export const PROVIDER_SERVICES_ROUTING_BLOCK = `Provider-services routing — pick the right path on your FIRST tool call. Do NOT waste turns on search_vault when the question is about external live state (ETA, appointment status, stock price, etc.) — the vault does not hold that data.

Path 1: the user's OWN providers and OWN records ("my dentist", "is my appointment confirmed", "where is my order/delivery", "my lawyer", "my accountant"). Anything about the user's EXISTING appointment, order, delivery, or account is subject-scoped: it lives with a provider the user already has a relationship with, and such capabilities are deliberately NOT generically discoverable. Call find_preferred_provider(category) FIRST. Categories are lowercase single tokens: dental, legal, tax, medical, automotive, plumbing, electrical, etc. If it returns candidates, pass the contact_did + a matching capability to query_service.

Path 2: finding a NEW public-facing service ("bus 42 to Castro", "nearest clinic", "find me a plumber quote"). There is no "my X" relationship here. Skip find_preferred_provider. DISCOVER the capability — do NOT guess a capability string. Call search_capabilities(intent) with the user's question; it returns every GENERICALLY-DISCOVERABLE canonical capability that has a provider, each with a description. Subject-scoped capabilities (appointment/order/delivery status, homework, device status) are intentionally absent from that list — if the question is about the user's own records, use Path 1 instead. The list is NOT pre-filtered to your intent — read the descriptions and pick ONLY the capability that genuinely matches. Then geocode (if a place is mentioned) + search_provider_services(capability, lat, lng, q) + query_service. Only after BOTH search_capabilities has no genuine match AND find_preferred_provider has no candidates should you tell the user there is no Dina service for that yet — do NOT pick an unrelated capability, do NOT invent one, do NOT search blind.

Fall-through works BOTH ways: if Path 1 returns no candidates for a find-me-a-provider question, continue with search_capabilities; if a Path 2 question turns out to be about the user's own appointment/order/delivery, try find_preferred_provider before giving the no-service answer.`;

/**
 * Ranked-Reviews (PeerLens) routing guidance for the forced Reviews lane.
 * Imperative: the verdict must come from the review network or be a clean
 * "no reviews", never general knowledge.
 */
export const PEERLENS_ROUTING_BLOCK = `EXPLICIT MODE: Reviews. The user chose the Ranked Reviews lane.
You MUST answer from the review network: call search_peerlens for the product, place, business, or service in the question and base your verdict on what it returns. If search_peerlens returns no reviews, say plainly there are no network reviews for it yet — do NOT invent a review, a rating, or a recommendation, and do NOT answer from general knowledge.
You MAY use vault/context tools to personalize (the user's preferences, budget, constraints) to choose WHICH subject to look up and how to frame the answer, but the verdict comes from the reviews.`;

// ── Lane predicates ─────────────────────────────────────────────────────────
export function isServicesLane(forcedSources?: readonly IntentSource[]): boolean {
  return forcedSources?.includes('provider_services') === true;
}

export function isReviewsLane(forcedSources?: readonly IntentSource[]): boolean {
  return forcedSources?.includes('peerlens') === true;
}

/** True when a forced lane is in effect (Services or Reviews). */
export function isForcedLane(forcedSources?: readonly IntentSource[]): boolean {
  return isServicesLane(forcedSources) || isReviewsLane(forcedSources);
}

/**
 * Render the imperative lane block for a forced source. Composer modes only
 * force provider_services / peerlens today; any other source returns '' (no
 * block) rather than throwing — the caller appends nothing.
 */
export function formatForcedLaneBlock(sources: readonly IntentSource[]): string {
  if (sources.includes('provider_services')) {
    return [
      'EXPLICIT MODE: Services. The user chose the Services lane.',
      'You MUST resolve this through a public service: discover the capability and query a provider, or report that no Dina service exists for it. Do NOT answer from general knowledge or the vault alone.',
      'You MAY use vault/context tools to SHAPE the query (location, the user’s preferred provider, their details), but the ANSWER must come from a service.',
      '',
      PROVIDER_SERVICES_ROUTING_BLOCK,
    ].join('\n');
  }
  if (sources.includes('peerlens')) {
    return PEERLENS_ROUTING_BLOCK;
  }
  return '';
}

/**
 * Append the forced-lane block to a system prompt. No-op when no lane is forced
 * (the caller's classifier path / base prompt is unchanged).
 */
export function applyForcedLanePrompt(
  systemPrompt: string,
  forcedSources?: readonly IntentSource[],
): string {
  if (!isForcedLane(forcedSources)) return systemPrompt;
  const block = formatForcedLaneBlock(forcedSources as readonly IntentSource[]);
  return block === '' ? systemPrompt : `${systemPrompt}\n\n${block}`;
}

/**
 * Scope a tool registry to the forced lane's allowlist (+ enrichment). Returns
 * the registry UNCHANGED when no lane is forced (Ask keeps the full registry).
 */
export function scopeToolsForLane(
  tools: ToolRegistry,
  forcedSources?: readonly IntentSource[],
): ToolRegistry {
  if (isServicesLane(forcedSources)) return tools.subset(SERVICES_LANE_TOOLS);
  if (isReviewsLane(forcedSources)) return tools.subset(REVIEWS_LANE_TOOLS);
  return tools;
}

// ── Result-validation gate ──────────────────────────────────────────────────

/** Minimal structural view of an agentic-loop tool call the gate inspects. */
export interface LaneToolCallView {
  name: string;
  outcome: { success: boolean; result?: unknown; error?: string };
}

/**
 * Evidence a single `search_peerlens` result carries:
 *   - `backed`  — real attestations (subject total > 0 OR search results > 0)
 *   - `empty`   — the network was reached but had nothing for the subject
 *   - `outage`  — an AppView call failed (the network could not be reached)
 */
export type PeerlensEvidence = 'backed' | 'empty' | 'outage';

/**
 * Classify one `search_peerlens` tool result. P2a: presence of a `subject` /
 * `search` key is NOT evidence — there must be real data. P2b: a `failed` flag
 * or a failure `note` (set when an AppView call throws) is an OUTAGE, not
 * absence.
 */
export function classifyPeerlensResult(result: unknown): PeerlensEvidence {
  if (result === null || typeof result !== 'object') return 'empty';
  const r = result as {
    subject?: { attestationSummary?: { total?: unknown } | null } | null;
    search?: { results?: unknown } | null;
    note?: unknown;
    failed?: unknown;
  };
  const subjectTotal = r.subject?.attestationSummary?.total;
  const hasSubjectEvidence = typeof subjectTotal === 'number' && subjectTotal > 0;
  const hasSearchEvidence = Array.isArray(r.search?.results) && r.search.results.length > 0;
  if (hasSubjectEvidence || hasSearchEvidence) return 'backed';
  // The tool sets `failed` / `note` ONLY when an AppView call throws — that is
  // an outage, not "no reviews exist".
  if (r.failed === true || typeof r.note === 'string') return 'outage';
  return 'empty';
}

/**
 * True iff a peerlens result actually consulted the network with real data.
 * Kept for back-compat (the legacy gate / tests import it); now means
 * `classifyPeerlensResult === 'backed'` (P2a — real evidence required).
 */
export function isPeerlensBacked(result: unknown): boolean {
  return classifyPeerlensResult(result) === 'backed';
}

/** Aggregate Reviews-lane evidence across all `search_peerlens` calls. */
function aggregateReviewsEvidence(toolCalls: readonly LaneToolCallView[]): PeerlensEvidence | 'none' {
  let sawOutage = false;
  let sawEmpty = false;
  for (const c of toolCalls) {
    if (c.name !== 'search_peerlens') continue;
    if (!c.outcome.success) {
      // The tool itself catches AppView errors and returns a note, so a hard
      // failure here is rarer (e.g. bad args) — still treat as outage, not
      // absence.
      sawOutage = true;
      continue;
    }
    const cls = classifyPeerlensResult(c.outcome.result);
    if (cls === 'backed') return 'backed';
    if (cls === 'outage') sawOutage = true;
    else sawEmpty = true;
  }
  if (sawOutage) return 'outage';
  if (sawEmpty) return 'empty';
  return 'none';
}

/** Discovery/query errors that mean ABSENCE (network reached, nothing found). */
function isServiceAbsenceError(error: string): boolean {
  return /AppView responded 400|no_candidate|no live providers|zero live providers/i.test(error);
}

/**
 * True when the Services lane hit an OUTAGE rather than absence:
 *   - a discovery call (search_capabilities / search_provider_services) failed
 *     for a reason other than absence (timeout / 500 / network — P2c), OR
 *   - a `query_service` DISPATCH failed (the provider was found but the request
 *     couldn't be delivered) — that's "found one but the request failed", not
 *     "no service exists", so it must read as an outage not no-service.
 * Reached only when serviceQueryCount === 0 (no SUCCESSFUL dispatch).
 */
function serviceLaneHadOutage(toolCalls: readonly LaneToolCallView[]): boolean {
  for (const c of toolCalls) {
    const isDiscovery =
      c.name === 'search_capabilities' || c.name === 'search_provider_services';
    const isDispatch = c.name === 'query_service';
    if (!isDiscovery && !isDispatch) continue;
    if (c.outcome.success) continue;
    // A failed dispatch is always an outage; a failed discovery is an outage
    // unless the error is the "nothing found" (absence) signal.
    if (isDiscovery && isServiceAbsenceError(c.outcome.error ?? '')) continue;
    return true;
  }
  return false;
}

/**
 * The hard gate. Given the lane + the loop's outcome, return the answer that may
 * be shown — replacing any off-lane free text with a clean no-result / outage
 * reply. No-op when no lane is forced.
 *
 * Services: valid only if a service query was DISPATCHED (serviceQueryCount > 0).
 * Otherwise the loop answered off-lane → outage reply if discovery failed to
 * reach the network, else the no-service reply (the missing_capability card, if
 * any, is surfaced separately by the caller).
 *
 * Reviews: valid only if a `search_peerlens` came back BACKED. Otherwise →
 * outage reply if any peerlens call failed to reach the network, else the
 * no-reviews reply.
 */
export function enforceForcedLaneAnswer(input: {
  forcedSources?: readonly IntentSource[];
  answer: string;
  serviceQueryCount: number;
  toolCalls: readonly LaneToolCallView[];
}): string {
  const { forcedSources, answer, serviceQueryCount, toolCalls } = input;
  if (isServicesLane(forcedSources)) {
    if (serviceQueryCount > 0) return answer;
    return serviceLaneHadOutage(toolCalls) ? SERVICES_OUTAGE_ANSWER : NO_SERVICE_ANSWER;
  }
  if (isReviewsLane(forcedSources)) {
    const evidence = aggregateReviewsEvidence(toolCalls);
    if (evidence === 'backed') return answer;
    if (evidence === 'outage') return REVIEWS_OUTAGE_ANSWER;
    return NO_REVIEWS_ANSWER;
  }
  return answer;
}
