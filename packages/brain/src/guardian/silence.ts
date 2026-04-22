/**
 * Guardian loop — silence classification.
 *
 * Three priority tiers:
 *   1 (fiduciary) — interrupt: security alert, health critical, payment due
 *   2 (solicited) — notify: reminder, search result
 *   3 (engagement) — briefing: social, promo, RSS, podcast
 *
 * Default when ambiguous: Tier 3 (Silence First — don't interrupt).
 *
 * DND mode: downgrades solicited (Tier 2) to engagement (Tier 3).
 * Fiduciary (Tier 1) is NEVER downgraded — Law 1 (fiduciary duty) overrides DND.
 *
 * Stale content: items older than 24h are classified below Tier 3
 * (returned as Tier 3 but with reduced confidence for briefing prioritization).
 *
 * Source: brain/tests/test_guardian.py
 */

export type PriorityTier = 1 | 2 | 3;

export interface ClassificationResult {
  tier: PriorityTier;
  reason: string;
  confidence: number;
  method: 'deterministic' | 'llm';
}

// ---------------------------------------------------------------
// Pattern constants
// ---------------------------------------------------------------

const FIDUCIARY_KEYWORD_PATTERN =
  /cancel|security alert|breach|unusual login|overdrawn|lab result|diagnosis|emergency/i;

const FIDUCIARY_SOURCE_PATTERN = /^(security|health_system|bank|emergency)$/i;

const SOLICITED_TYPE_SET = new Set(['reminder', 'search_result']);

const ENGAGEMENT_TYPE_SET = new Set([
  'notification',
  'promo',
  'social',
  'rss',
  'podcast',
  'background_sync',
]);

/**
 * Marketing/promo sources — phishing guard.
 * "Cancel your account!" from a promo email should NOT be elevated to Tier 1.
 * Python: "marketing urgency is NOT fiduciary."
 */
const MARKETING_SOURCES = new Set(['promo', 'marketing', 'newsletter', 'social']);

/**
 * Health elevation keywords — health-related items from trusted sources
 * get Tier 1 even without explicit fiduciary keywords.
 */
const HEALTH_ELEVATION_PATTERN =
  /blood\s*(?:sugar|pressure|test)|cholesterol|a1c|medication|prescription|insulin|hemoglobin|pathology|radiology/i;

import { GUARDIAN_STALE_THRESHOLD_MS, ESCALATION_THRESHOLD as ESC_THRESHOLD } from '../constants';
import { SILENCE_CLASSIFY } from '../llm/prompts';
import { scrubPII } from '../../../core/src/pii/patterns';

const STALE_THRESHOLD_MS = GUARDIAN_STALE_THRESHOLD_MS;

// ---------------------------------------------------------------
// Injectable LLM classifier
// ---------------------------------------------------------------

/** LLM call function: (system, prompt) → response string. */
export type SilenceLLMCallFn = (system: string, prompt: string) => Promise<string>;

let llmCallFn: SilenceLLMCallFn | null = null;

/** Register an LLM provider for silence classification refinement. */
export function registerSilenceClassifier(fn: SilenceLLMCallFn): void {
  llmCallFn = fn;
}

/** Reset LLM classifier (for testing). */
export function resetSilenceClassifier(): void {
  llmCallFn = null;
}

// ---------------------------------------------------------------
// DND state
// ---------------------------------------------------------------

let dndEnabled = false;

/** Enable DND mode — downgrades solicited to engagement. */
export function enableDND(): void {
  dndEnabled = true;
}

/** Disable DND mode. */
export function disableDND(): void {
  dndEnabled = false;
}

/** Check if DND mode is active. */
export function isDNDEnabled(): boolean {
  return dndEnabled;
}

/** Reset DND state (for testing). */
export function resetDNDState(): void {
  dndEnabled = false;
}

// ---------------------------------------------------------------
// Escalation tracking — repeated engagement from same source → fiduciary
// ---------------------------------------------------------------

/** Escalation threshold: after N engagement events from the same source, escalate to fiduciary. */
const ESCALATION_THRESHOLD = ESC_THRESHOLD;

/** Source → recent engagement event count. */
const escalationCounts = new Map<string, number>();

/** Record an engagement event for escalation tracking. Returns current count. */
export function recordEngagementEvent(source: string): number {
  const count = (escalationCounts.get(source) ?? 0) + 1;
  escalationCounts.set(source, count);
  return count;
}

/** Check if a source has exceeded the escalation threshold. */
export function isEscalated(source: string): boolean {
  return (escalationCounts.get(source) ?? 0) >= ESCALATION_THRESHOLD;
}

/** Reset escalation state (for testing). */
export function resetEscalationState(): void {
  escalationCounts.clear();
}

// ---------------------------------------------------------------
// User preference overrides — per-source tier override
// ---------------------------------------------------------------

/** Map of source → user-specified tier override. */
const userOverrides = new Map<string, PriorityTier>();

/** Set a user override for a specific source. */
export function setUserOverride(source: string, tier: PriorityTier): void {
  userOverrides.set(source, tier);
}

/** Remove a user override for a specific source. */
export function removeUserOverride(source: string): void {
  userOverrides.delete(source);
}

/** Check if a source has a user override. */
export function getUserOverride(source: string): PriorityTier | null {
  return userOverrides.get(source) ?? null;
}

/** Reset all user overrides (for testing). */
export function resetUserOverrides(): void {
  userOverrides.clear();
}

// ---------------------------------------------------------------
// Quiet hours — time-of-day auto-downgrade
// ---------------------------------------------------------------

/** Default quiet hours: 22:00–07:00. */
let quietHoursStart = 22;
let quietHoursEnd = 7;
let quietHoursEnabled = false;

/** Injectable clock for testing. Returns current hour (0-23). */
let clockFn: () => number = () => new Date().getHours();

/** Enable quiet hours with optional custom window. */
export function enableQuietHours(startHour?: number, endHour?: number): void {
  quietHoursEnabled = true;
  if (startHour !== undefined) quietHoursStart = startHour;
  if (endHour !== undefined) quietHoursEnd = endHour;
}

/** Disable quiet hours. */
export function disableQuietHours(): void {
  quietHoursEnabled = false;
}

/** Check if quiet hours are currently active. */
export function isInQuietHours(hour?: number): boolean {
  if (!quietHoursEnabled) return false;
  const h = hour ?? clockFn();

  // Handle wrap-around (e.g., 22:00 → 07:00)
  if (quietHoursStart > quietHoursEnd) {
    return h >= quietHoursStart || h < quietHoursEnd;
  }
  return h >= quietHoursStart && h < quietHoursEnd;
}

/** Set the clock function (for testing). */
export function setClockFn(fn: () => number): void {
  clockFn = fn;
}

/** Reset quiet hours state (for testing). */
export function resetQuietHoursState(): void {
  quietHoursEnabled = false;
  quietHoursStart = 22;
  quietHoursEnd = 7;
  clockFn = () => new Date().getHours();
}

// ---------------------------------------------------------------
// Event batching — dedup similar events within time window
// ---------------------------------------------------------------

/** Batch window in ms. Events within this window are deduped. */
const BATCH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** Recent event fingerprints: key → timestamp of last seen. */
const recentEvents = new Map<string, number>();

/**
 * Build a fingerprint for event deduplication.
 * Uses source + type as the grouping key.
 */
export function eventFingerprint(event: Record<string, unknown>): string {
  const source = String(event.source || '');
  const type = String(event.type || '');
  return `${source}:${type}`;
}

/**
 * Check if this event is a duplicate of a recent one.
 * If it's a duplicate (same fingerprint within batch window), returns true.
 * Always records the event for future dedup checks.
 */
export function isDuplicateEvent(event: Record<string, unknown>, now?: number): boolean {
  const fp = eventFingerprint(event);
  const currentTime = now ?? Date.now();
  const lastSeen = recentEvents.get(fp);

  // Record this occurrence
  recentEvents.set(fp, currentTime);

  if (lastSeen === undefined) return false;
  return currentTime - lastSeen < BATCH_WINDOW_MS;
}

/** Get the count of tracked event fingerprints. */
export function batchedEventCount(): number {
  return recentEvents.size;
}

/** Purge expired fingerprints (older than batch window). */
export function purgeExpiredFingerprints(now?: number): number {
  const currentTime = now ?? Date.now();
  let purged = 0;
  for (const [fp, ts] of recentEvents.entries()) {
    if (currentTime - ts >= BATCH_WINDOW_MS) {
      recentEvents.delete(fp);
      purged++;
    }
  }
  return purged;
}

/** Reset batching state (for testing). */
export function resetBatchingState(): void {
  recentEvents.clear();
}

// ---------------------------------------------------------------
// LLM refinement
// ---------------------------------------------------------------

/**
 * Refine a deterministic classification result with LLM when:
 *   1. LLM provider is registered
 *   2. Deterministic confidence is below 0.85 (ambiguous cases)
 *   3. Marketing phishing guard doesn't apply (never trust LLM to override safety guard)
 *
 * The LLM result is bounded by safety rules:
 *   - Cannot LOWER a fiduciary (Tier 1) result — Law 1 override
 *   - Cannot RAISE marketing source content to fiduciary — phishing guard
 *   - Confidence must be above 0.5 to be accepted
 */
async function refineSilenceWithLLM(
  event: Record<string, unknown>,
  deterministicResult: ClassificationResult,
): Promise<ClassificationResult> {
  // Skip LLM if not registered
  if (!llmCallFn) return deterministicResult;

  // Skip if deterministic result is already high-confidence
  if (deterministicResult.confidence >= 0.85) return deterministicResult;

  // Never let LLM override a deterministic fiduciary classification
  if (deterministicResult.tier === 1) return deterministicResult;

  const source = String(event.source || '');
  const subject = String(event.subject || '');
  const body = String(event.body || '');
  const type = String(event.type || '');

  // PII scrub before sending to cloud LLM — prevents leaking emails, phones, etc.
  // Source and type are safe (system metadata), but subject and body may contain PII.
  const { scrubbed: scrubbedSubject } = scrubPII(subject);
  const { scrubbed: scrubbedBody } = scrubPII(body);

  // Build prompt from template with scrubbed fields
  const bodyPreview = scrubbedBody.length > 200 ? scrubbedBody.slice(0, 200) + '...' : scrubbedBody;
  const prompt = SILENCE_CLASSIFY.replace('{{source}}', source)
    .replace('{{type}}', type)
    .replace('{{subject}}', scrubbedSubject)
    .replace('{{body_preview}}', bodyPreview);

  try {
    const response = await llmCallFn(
      'You are a classifier for Dina, a personal sovereign AI assistant. Classify event urgency.',
      prompt,
    );
    const parsed = JSON.parse(response);

    const llmTier = Number(parsed.tier);
    const llmConfidence = Number(parsed.confidence ?? 0);

    // Validate LLM response — reject invalid tier, NaN, out-of-range confidence
    if (
      ![1, 2, 3].includes(llmTier) ||
      isNaN(llmConfidence) ||
      llmConfidence < 0.5 ||
      llmConfidence > 1.0
    ) {
      return deterministicResult; // Invalid LLM result — keep deterministic
    }

    // Safety guard: marketing source can NEVER be elevated to fiduciary by LLM
    if (llmTier === 1 && isMarketingSource(source)) {
      return deterministicResult;
    }

    return {
      tier: llmTier as PriorityTier,
      reason: String(parsed.reason ?? 'LLM classification'),
      confidence: llmConfidence,
      method: 'llm',
    };
  } catch {
    // LLM call failed — fall back to deterministic
    return deterministicResult;
  }
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Classify an event's priority tier.
 * Uses LLM when available, falls back to deterministic.
 * Applies DND downgrade after classification.
 */
export async function classifyPriority(
  event: Record<string, unknown>,
): Promise<ClassificationResult> {
  const source = String(event.source || '');

  // User preference override — always takes priority (except: user can't override TO fiduciary from safety perspective,
  // but CAN override downward or set a specific tier for a source)
  const override = getUserOverride(source);
  if (override !== null) {
    return {
      tier: override,
      reason: `User override for source "${source}"`,
      confidence: 1.0,
      method: 'deterministic',
    };
  }

  const deterministicResult = classifyDeterministic(event);

  // Escalation tracking runs on DETERMINISTIC result before LLM refinement
  // so that repeated engagement events from the same source are tracked
  // even if LLM would refine them to a different tier
  if (deterministicResult.tier === 3 && source) {
    recordEngagementEvent(source);
    if (isEscalated(source)) {
      return {
        tier: 1,
        reason: `Escalated: ${ESCALATION_THRESHOLD}+ engagement events from "${source}"`,
        confidence: 0.8,
        method: 'deterministic',
      };
    }
  }

  // Attempt LLM refinement when available and deterministic confidence is low
  const result = await refineSilenceWithLLM(event, deterministicResult);

  // DND mode: downgrade Tier 2 → Tier 3. Tier 1 is NEVER downgraded.
  if (dndEnabled && result.tier === 2) {
    return {
      tier: 3,
      reason: `DND active — downgraded from Tier 2 (${result.reason})`,
      confidence: result.confidence * 0.8,
      method: result.method,
    };
  }

  // Quiet hours: same as DND but automatic based on time-of-day.
  if (isInQuietHours() && result.tier === 2) {
    return {
      tier: 3,
      reason: `Quiet hours — downgraded from Tier 2 (${result.reason})`,
      confidence: result.confidence * 0.8,
      method: result.method,
    };
  }

  // Stale content demotion: items older than 24h get reduced confidence.
  // Tier 1 (fiduciary) NEVER demoted — Law 1 (fiduciary duty) overrides age.
  // Tier 2 (solicited) → demoted to Tier 3 when stale.
  // Tier 3 (engagement) → stays Tier 3, reduced confidence for sorting.
  const rawTimestamp = Number(event.timestamp || 0);
  // Normalize to milliseconds: if < 1e12, treat as Unix seconds → convert
  const timestampMs = rawTimestamp > 0 && rawTimestamp < 1e12 ? rawTimestamp * 1000 : rawTimestamp;
  if (timestampMs > 0) {
    const staleness = isStaleContent(timestampMs);
    if (staleness.stale && result.tier === 2) {
      return {
        tier: 3,
        reason: `Stale demotion — solicited content is ${Math.round(staleness.factor * 24)}h+ old (${result.reason})`,
        confidence: result.confidence * 0.5,
        method: result.method,
      };
    }
    if (staleness.stale && result.tier === 3) {
      return {
        ...result,
        confidence: result.confidence * 0.6,
        reason: `${result.reason} (stale: confidence reduced)`,
      };
    }
  }

  return result;
}

/**
 * Deterministic fallback: classify using regex keywords only.
 *
 * Priority order:
 *   1. Fiduciary source (bank, health_system, security, emergency)
 *   2. Fiduciary keyword — BUT marketing phishing guard: keywords
 *      from promo/marketing sources are NOT elevated to Tier 1
 *   3. Health elevation — health keywords from health_system source → Tier 1
 *   4. Solicited type (reminder, search_result)
 *   5. Engagement type (notification, promo, social, rss, podcast, background_sync)
 *   6. Default Tier 3 (Silence First)
 */
export function classifyDeterministic(event: Record<string, unknown>): ClassificationResult {
  const source = String(event.source || '');
  const subject = String(event.subject || '');
  const body = String(event.body || '');
  const type = String(event.type || '');
  const text = `${subject} ${body}`;

  // Tier 1: Fiduciary source — urgent, must interrupt
  if (isFiduciarySource(source)) {
    return {
      tier: 1,
      reason: `Fiduciary source: "${source}"`,
      confidence: 0.95,
      method: 'deterministic',
    };
  }

  // Tier 1: Fiduciary keywords — WITH marketing phishing guard
  // "cancel your account" from a promo email is NOT fiduciary.
  // Python: "marketing urgency is NOT fiduciary."
  if (matchesFiduciaryKeywords(text) && !isMarketingSource(source)) {
    return {
      tier: 1,
      reason: 'Fiduciary keyword detected in text',
      confidence: 0.85,
      method: 'deterministic',
    };
  }

  // Health elevation: health-related keywords from health source → Tier 1
  // Even without explicit fiduciary keywords like "lab result" or "diagnosis",
  // health-specific content from trusted health sources deserves urgency.
  if (matchesHealthElevation(text) && source === 'health_system') {
    return {
      tier: 1,
      reason: 'Health context elevation — health keyword from health_system source',
      confidence: 0.8,
      method: 'deterministic',
    };
  }

  // Tier 2: Solicited — user-requested content
  if (isSolicitedType(type)) {
    return {
      tier: 2,
      reason: `Solicited type: "${type}"`,
      confidence: 0.9,
      method: 'deterministic',
    };
  }

  // Tier 3: Engagement — known engagement types
  if (isEngagementType(type)) {
    return {
      tier: 3,
      reason: `Engagement type: "${type}"`,
      confidence: 0.9,
      method: 'deterministic',
    };
  }

  // Default: Tier 3 — Silence First
  return {
    tier: 3,
    reason: 'Silence First default — no urgent signal detected',
    confidence: 0.5,
    method: 'deterministic',
  };
}

/** Check if text matches fiduciary keywords. */
export function matchesFiduciaryKeywords(text: string): boolean {
  return FIDUCIARY_KEYWORD_PATTERN.test(text);
}

/** Check if a source is a fiduciary source. */
export function isFiduciarySource(source: string): boolean {
  return FIDUCIARY_SOURCE_PATTERN.test(source);
}

/** Check if an event type is solicited (user-requested). */
export function isSolicitedType(type: string): boolean {
  return SOLICITED_TYPE_SET.has(type);
}

/** Check if an event type is engagement (nice-to-know). */
export function isEngagementType(type: string): boolean {
  return ENGAGEMENT_TYPE_SET.has(type);
}

/** Check if a source is a marketing/promo source (phishing guard). */
export function isMarketingSource(source: string): boolean {
  return MARKETING_SOURCES.has(source.toLowerCase());
}

/** Check if text matches health elevation keywords. */
export function matchesHealthElevation(text: string): boolean {
  return HEALTH_ELEVATION_PATTERN.test(text);
}

/**
 * Check if content is stale (older than 24 hours).
 *
 * Stale content gets reduced confidence in briefing assembly,
 * making it less likely to be shown prominently.
 * Returns the staleness factor: 0.0 (fresh) to 1.0 (maximally stale).
 */
export function isStaleContent(
  timestampMs: number,
  now?: number,
): { stale: boolean; factor: number } {
  const currentTime = now ?? Date.now();
  const ageMs = currentTime - timestampMs;

  if (ageMs <= 0) return { stale: false, factor: 0 };
  if (ageMs < STALE_THRESHOLD_MS) return { stale: false, factor: ageMs / STALE_THRESHOLD_MS };

  // Stale — factor increases beyond 1.0 for very old content
  const factor = Math.min(ageMs / STALE_THRESHOLD_MS, 5.0);
  return { stale: true, factor };
}
