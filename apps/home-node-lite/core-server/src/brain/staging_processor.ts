/**
 * Staging processor (GAP.md row #22 closure — M1 blocker, last M1 gap).
 *
 * Content Brain ingests (email, calendar, D2D messages, web fetches)
 * first lands in the **staging pipeline**. Staging decides:
 *
 *   - Is this item **safe to store**? (tier, signals)
 *   - Which **persona** should own it? (persona selection — out of
 *     scope for this primitive; the caller supplies candidate personas
 *     and staging narrows).
 *   - What **enrichment** accompanies it? (topics, subject, contacts)
 *   - What's the **disposition**: `accept` / `review` / `reject`?
 *
 * This primitive is the **classification + decision half** of the
 * pipeline. The IO half (claim a staging task from Core, store the
 * vault item, mark the task resolved) is a separate orchestrator —
 * it calls this decision function and then acts on the result.
 *
 * **Composes**:
 *   - `classifyTier` (tier_classifier.ts) → sensitivity tier
 *   - `detectSensitiveSignals` (sensitive_signals.ts) → signal list
 *   - `extractTopics` (topic_extractor.ts) → topic hints
 *   - `attributeSubject` (subject_attributor.ts) → subject inference
 *
 * **Decision rules** (first match wins):
 *
 *   1. `tier === 'local_only'` → `reject` — credentials / keys never
 *      get staged.
 *   2. Tier-persona mismatch (sensitive content into a default
 *      persona, or elevated content into no-persona context) →
 *      `review` — operator approves the routing.
 *   3. `contactsMissing` (subject attributed to unknown contact) →
 *      `review` — may be a new contact the user wants to add.
 *   4. Default → `accept` with the enriched metadata attached.
 *
 * **Caller-injected extras**:
 *   - `personaAllowedTiers` — what tiers each persona permits.
 *   - `knownContactIds` — subject contact IDs the caller recognises.
 *   - `reviewThresholds` — confidence levels that tip `accept` to
 *     `review` when the signal is ambiguous.
 *
 * **Never throws** — structured outcomes everywhere. Deterministic:
 * same input → same decision.
 *
 * Source: GAP.md (task 5.46 follow-up) — last M1 ingestion gate.
 */

import type { SensitiveSignal } from './sensitive_signals';
import { detectSensitiveSignals } from './sensitive_signals';
import type { Subject } from './subject_attributor';
import { attributeSubject, type Contact } from './subject_attributor';
import { classifyTier, type Tier, tierAtLeast } from './tier_classifier';
import { extractTopics, type Topic } from './topic_extractor';

export type StagingDisposition = 'accept' | 'review' | 'reject';

/** Where the content originated — drives downstream routing. */
export type StagingSource =
  | 'email'
  | 'calendar'
  | 'd2d_message'
  | 'web'
  | 'manual'
  | 'agent';

export interface StagingInput {
  /** Opaque id the staging task carries. Echoed in the outcome. */
  taskId: string;
  /** Free-form text to classify + enrich. */
  text: string;
  /** Origin channel. */
  source: StagingSource;
  /** Unix seconds. Echoed in the outcome for audit. */
  receivedAt: number;
  /** Candidate persona the caller proposes. */
  proposedPersona: string;
  /** Contacts the caller knows about — feeds subject attribution. */
  contacts?: ReadonlyArray<Contact>;
}

export interface StagingOptions {
  /**
   * Per-persona max tier allowed. A persona marked `{p: 'elevated'}`
   * will route `sensitive` content to `review` instead of storing.
   * Defaults to `general` for any persona not listed.
   */
  personaAllowedTiers?: Readonly<Record<string, Tier>>;
  /**
   * Contact IDs the caller considers known. Subject attributions to
   * unknown contact IDs surface as `review` with `reason: 'unknown_contact'`.
   */
  knownContactIds?: ReadonlyArray<string>;
  /** Minimum topic salience retained in the outcome. Default 0.1. */
  minTopicSalience?: number;
  /** Max topics carried in the outcome. Default 5. */
  maxTopics?: number;
}

export interface StagingDecision {
  /** Echoes `StagingInput.taskId`. */
  taskId: string;
  /** Terminal disposition. */
  disposition: StagingDisposition;
  /** Short machine-readable reason the decision was made. */
  reason: StagingDecisionReason;
  /** Echo of receivedAt for audit. */
  receivedAt: number;
  /** Enrichment fields populated regardless of disposition. */
  enrichment: {
    tier: Tier;
    signals: SensitiveSignal[];
    topics: Topic[];
    subject: Subject;
    targetPersona: string | null;
  };
}

export type StagingDecisionReason =
  | 'accept_default_persona_fit'
  | 'accept_tier_matches_persona'
  | 'review_tier_exceeds_persona'
  | 'review_unknown_contact'
  | 'reject_local_only'
  | 'reject_empty_text'
  | 'reject_invalid_input';

export const DEFAULT_MIN_TOPIC_SALIENCE = 0.1;
export const DEFAULT_MAX_TOPICS = 5;

/**
 * Classify + decide. Pure function — no IO, no clock reads.
 */
export function processStagingInput(
  input: StagingInput,
  opts: StagingOptions = {},
): StagingDecision {
  const validation = validate(input);
  if (validation !== null) {
    return emptyDecision(input, validation, null);
  }
  if (input.text.trim() === '') {
    return emptyDecision(input, 'reject_empty_text', null);
  }

  const personaAllowedTiers = opts.personaAllowedTiers ?? {};
  const knownContactIds = new Set(opts.knownContactIds ?? []);
  const minSalience = opts.minTopicSalience ?? DEFAULT_MIN_TOPIC_SALIENCE;
  const maxTopics = opts.maxTopics ?? DEFAULT_MAX_TOPICS;

  // 1. Classify + enrich in parallel (all pure).
  const tierResult = classifyTier(input.text);
  const signals = detectSensitiveSignals(input.text);
  const topics = extractTopics(input.text, { maxTopics: maxTopics * 2 })
    .filter((t) => t.salience >= minSalience)
    .slice(0, maxTopics);
  const attribution = attributeSubject(
    input.text,
    input.contacts ? { contacts: input.contacts } : {},
  );

  const enrichment: StagingDecision['enrichment'] = {
    tier: tierResult.tier,
    signals,
    topics,
    subject: attribution.subject,
    targetPersona: input.proposedPersona,
  };

  // 2. Rule 1: local_only → reject.
  if (tierResult.tier === 'local_only') {
    return {
      taskId: input.taskId,
      disposition: 'reject',
      reason: 'reject_local_only',
      receivedAt: input.receivedAt,
      enrichment: { ...enrichment, targetPersona: null },
    };
  }

  // 3. Rule 2: tier exceeds persona's allowed maximum.
  const personaAllows = personaAllowedTiers[input.proposedPersona] ?? 'general';
  if (tierAtLeast(tierResult.tier, nextStricter(personaAllows))) {
    return {
      taskId: input.taskId,
      disposition: 'review',
      reason: 'review_tier_exceeds_persona',
      receivedAt: input.receivedAt,
      enrichment,
    };
  }

  // 4. Rule 3: subject attributed to unknown contact.
  if (
    attribution.subject.kind === 'contact' &&
    knownContactIds.size > 0 &&
    !knownContactIds.has(attribution.subject.contactId)
  ) {
    return {
      taskId: input.taskId,
      disposition: 'review',
      reason: 'review_unknown_contact',
      receivedAt: input.receivedAt,
      enrichment,
    };
  }

  // 5. Default accept.
  return {
    taskId: input.taskId,
    disposition: 'accept',
    reason:
      tierResult.tier === 'general'
        ? 'accept_default_persona_fit'
        : 'accept_tier_matches_persona',
    receivedAt: input.receivedAt,
    enrichment,
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(input: StagingInput): StagingDecisionReason | null {
  if (!input || typeof input !== 'object') return 'reject_invalid_input';
  if (typeof input.taskId !== 'string' || input.taskId === '') return 'reject_invalid_input';
  if (typeof input.text !== 'string') return 'reject_invalid_input';
  if (
    input.source !== 'email' &&
    input.source !== 'calendar' &&
    input.source !== 'd2d_message' &&
    input.source !== 'web' &&
    input.source !== 'manual' &&
    input.source !== 'agent'
  ) return 'reject_invalid_input';
  if (typeof input.proposedPersona !== 'string' || input.proposedPersona === '') {
    return 'reject_invalid_input';
  }
  if (!Number.isFinite(input.receivedAt)) return 'reject_invalid_input';
  return null;
}

function emptyDecision(
  input: StagingInput,
  reason: StagingDecisionReason,
  subject: Subject | null,
): StagingDecision {
  return {
    taskId: typeof input?.taskId === 'string' ? input.taskId : '',
    disposition: 'reject',
    reason,
    receivedAt: typeof input?.receivedAt === 'number' ? input.receivedAt : 0,
    enrichment: {
      tier: 'general',
      signals: [],
      topics: [],
      subject: subject ?? { kind: 'unknown' },
      targetPersona: null,
    },
  };
}

/**
 * Given a tier, return the tier one step stricter. Used to express
 * "persona allows UP TO this tier" — content strictly above the
 * next-stricter tier must go to review. Maps:
 *   general → elevated, elevated → sensitive, sensitive → local_only,
 *   local_only → local_only (no stricter tier exists).
 */
function nextStricter(t: Tier): Tier {
  switch (t) {
    case 'general':    return 'elevated';
    case 'elevated':   return 'sensitive';
    case 'sensitive':  return 'local_only';
    case 'local_only': return 'local_only';
  }
}
