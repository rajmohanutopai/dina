/**
 * Task 5.32 — domain sensitivity classifier.
 *
 * Controls how aggressively the PII scrubber (Phase 4j) runs by
 * labelling each piece of user text with a `Sensitivity` level:
 *
 *   GENERAL      — low-risk. Default scrub intensity.
 *   ELEVATED     — meaningful exposure if leaked (work docs, legal
 *                  notes). Redact PII + keep generic terms.
 *   SENSITIVE    — health / financial records. Aggressive redaction;
 *                  cloud LLMs blocked for some personas.
 *   LOCAL_ONLY   — never leaves the device (e.g. mental-health notes).
 *
 * **Four-layer pipeline** (highest confidence wins; ties broken by
 * higher sensitivity):
 *
 *   Layer 1: **Persona override** — `/health` → SENSITIVE,
 *            `/financial` → ELEVATED. Short-circuits when
 *            confidence=0.95 AND result is SENSITIVE/LOCAL_ONLY
 *            (nothing a later layer could add).
 *   Layer 2: **Keyword signals** — weighted domain keywords. Strong
 *            health/finance terms (ssn, diagnosis) compound toward
 *            SENSITIVE; weaker terms (doctor, payment) toward
 *            ELEVATED.
 *   Layer 3: **Vault context** — optional metadata about the source
 *            of the text. A vault item tagged `source: "hospital"`
 *            forces SENSITIVE regardless of keywords.
 *   Layer 4: **LLM fallback** — optional hook called only when the
 *            deterministic layers find nothing (confidence < 0.5).
 *            Injectable so tests can cover the layer without an
 *            LLM dependency.
 *
 * **Pure + deterministic** when no LLM is wired. Injectable clock
 * is unnecessary because no time-based decisions live here.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.32.
 */

export type Sensitivity = 'general' | 'elevated' | 'sensitive' | 'local_only';

export type Domain = 'general' | 'health' | 'financial' | 'legal' | 'work';

export interface Classification {
  sensitivity: Sensitivity;
  domain: Domain;
  /** Short human-readable rationale, safe for logs. */
  reason: string;
  /** 0..1; higher = more certain. */
  confidence: number;
  /** Which layer produced this classification (for telemetry + debug). */
  layer: 'persona' | 'keyword' | 'vault' | 'llm' | 'default';
}

export interface VaultContext {
  /** Origin of the vault item (e.g. `"hospital"`, `"bank"`). */
  source?: string;
  /** Type of vault item (e.g. `"medical_record"`, `"lab_result"`). */
  type?: string;
}

/** Async LLM call. Resolves with a domain hint string. */
export type DomainLlmCallFn = (text: string) => Promise<{
  domain: Domain;
  sensitivity: Sensitivity;
  reason?: string;
}>;

export interface DomainClassifierOptions {
  /** Optional LLM fallback — only called when layers 1–3 are inconclusive. */
  llmCallFn?: DomainLlmCallFn;
  /**
   * Minimum confidence that shortcuts the LLM layer. Defaults to 0.5.
   * If deterministic layers produce ≥ threshold, LLM is skipped.
   */
  llmConfidenceThreshold?: number;
  /**
   * Persona registry adapter — `tier(name)` returns the current tier
   * for a persona, or `null` if unknown. When present, tier→sensitivity
   * takes precedence over the static persona map (dynamic per-user
   * configuration beats hardcoded defaults).
   */
  personaRegistry?: { tier(persona: string): string | null };
}

export const DEFAULT_LLM_CONFIDENCE_THRESHOLD = 0.5;

// ── Static persona → (sensitivity, domain) map ─────────────────────────

const PERSONA_MAP: ReadonlyMap<
  string,
  { sensitivity: Sensitivity; domain: Domain; reason: string }
> = new Map([
  ['health', { sensitivity: 'sensitive', domain: 'health', reason: 'health persona override' }],
  ['medical', { sensitivity: 'sensitive', domain: 'health', reason: 'medical persona override' }],
  ['financial', { sensitivity: 'elevated', domain: 'financial', reason: 'financial persona override' }],
  ['finance', { sensitivity: 'elevated', domain: 'financial', reason: 'financial persona override' }],
  ['legal', { sensitivity: 'elevated', domain: 'legal', reason: 'legal persona override' }],
  ['work', { sensitivity: 'elevated', domain: 'work', reason: 'work persona override' }],
  ['general', { sensitivity: 'general', domain: 'general', reason: 'general persona' }],
  ['personal', { sensitivity: 'general', domain: 'general', reason: 'personal → general' }],
  ['social', { sensitivity: 'general', domain: 'general', reason: 'social → general' }],
]);

const TIER_SENSITIVITY: ReadonlyMap<string, Sensitivity> = new Map([
  ['sensitive', 'sensitive'],
  ['locked', 'sensitive'],
  ['standard', 'elevated'],
  ['default', 'general'],
]);

// ── Keyword signals ────────────────────────────────────────────────────

/** Health terms that *by themselves* warrant SENSITIVE (e.g. diagnoses). */
const HEALTH_STRONG = [
  'diagnosis', 'diagnosed', 'prescription', 'prescribed', 'hiv',
  'cancer', 'tumor', 'tumour', 'chemotherapy', 'surgery', 'lab result',
  'blood test', 'mri', 'x-ray', 'biopsy', 'depression', 'anxiety disorder',
  'medication', 'medical record', 'health insurance',
];
/** Weaker health context — contributes to ELEVATED but not SENSITIVE. */
const HEALTH_WEAK = [
  'doctor', 'hospital', 'clinic', 'nurse', 'appointment', 'checkup',
  'pharmacy', 'therapist', 'dentist', 'vaccine', 'shot', 'pain',
];
/** Financial strong terms — bank accounts, SSN, etc. */
const FINANCE_STRONG = [
  'ssn', 'social security', 'account number', 'routing number',
  'credit card', 'debit card', 'cvv', 'pin', 'net worth',
  'bank balance', 'tax return', 'w-2', '1099',
];
/** Weaker financial context. */
const FINANCE_WEAK = [
  'bank', 'payment', 'invoice', 'mortgage', 'loan', 'investment',
  'portfolio', 'broker', 'dividend', 'salary', 'paycheck',
];
/** Legal-domain terms — contracts, litigation. */
const LEGAL_STRONG = [
  'lawsuit', 'litigation', 'plaintiff', 'defendant', 'subpoena',
  'deposition', 'settlement', 'contract', 'nda', 'indictment',
  'custody', 'divorce decree', 'estate planning',
];

/**
 * Escape a string so it can be embedded in a regex literal. The
 * keyword lists contain dots, dashes, and spaces — `w-2`, `social
 * security`, `x-ray` — so we can't just concatenate into a regex.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count word-boundary matches of each keyword in `text`. Using word
 * boundaries matters: "pin" is in FINANCE_STRONG and naive substring
 * matching would flag "opinion" + "pinpoint" + "typing" as financial
 * keywords. Whitespace, punctuation, and start/end-of-text count as
 * boundaries. Case-insensitive.
 */
function countMatches(text: string, keywords: readonly string[]): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (const kw of keywords) {
    if (kw.length === 0) continue;
    // Build a case-insensitive regex with (?:^|\W) and (?:\W|$) as
    // boundaries. We can't use \b because some keywords contain
    // dashes (`x-ray`, `w-2`) — \b after a dash wouldn't match.
    const re = new RegExp(`(?:^|\\W)${escapeRegex(kw)}(?:\\W|$)`, 'gi');
    const matches = text.match(re);
    if (matches) n += matches.length;
  }
  return n;
}

function keywordClassify(text: string): Classification | null {
  const healthStrong = countMatches(text, HEALTH_STRONG);
  const healthWeak = countMatches(text, HEALTH_WEAK);
  const financeStrong = countMatches(text, FINANCE_STRONG);
  const financeWeak = countMatches(text, FINANCE_WEAK);
  const legalStrong = countMatches(text, LEGAL_STRONG);

  const healthScore = healthStrong * 0.3 + healthWeak * 0.1;
  const financeScore = financeStrong * 0.3 + financeWeak * 0.1;
  const legalScore = legalStrong * 0.3;

  let best: { score: number; domain: Domain; sensitivity: Sensitivity } = {
    score: 0,
    domain: 'general',
    sensitivity: 'general',
  };
  if (healthScore > best.score) {
    best = {
      score: healthScore,
      domain: 'health',
      sensitivity: healthStrong > 0 ? 'sensitive' : 'elevated',
    };
  }
  if (financeScore > best.score) {
    best = {
      score: financeScore,
      domain: 'financial',
      sensitivity: financeStrong > 0 ? 'sensitive' : 'elevated',
    };
  }
  if (legalScore > best.score) {
    best = { score: legalScore, domain: 'legal', sensitivity: 'sensitive' };
  }

  if (best.score < 0.1) return null;

  const confidence = Math.min(best.score, 1.0);
  return {
    sensitivity: best.sensitivity,
    domain: best.domain,
    reason: `keyword signals: ${best.domain} (score=${best.score.toFixed(2)})`,
    confidence,
    layer: 'keyword',
  };
}

function vaultContextClassify(ctx: VaultContext): Classification | null {
  const source = (ctx.source ?? '').toLowerCase();
  const type = (ctx.type ?? '').toLowerCase();
  const HEALTH_SOURCES = new Set(['health_system', 'medical', 'hospital', 'clinic']);
  const FINANCE_SOURCES = new Set(['bank', 'financial', 'tax']);
  const HEALTH_TYPES = new Set(['medical_record', 'lab_result', 'prescription']);

  if (HEALTH_SOURCES.has(source)) {
    return {
      sensitivity: 'sensitive',
      domain: 'health',
      reason: `vault source is "${source}"`,
      confidence: 0.9,
      layer: 'vault',
    };
  }
  if (FINANCE_SOURCES.has(source)) {
    return {
      sensitivity: 'sensitive',
      domain: 'financial',
      reason: `vault source is "${source}"`,
      confidence: 0.9,
      layer: 'vault',
    };
  }
  if (HEALTH_TYPES.has(type)) {
    return {
      sensitivity: 'sensitive',
      domain: 'health',
      reason: `vault item type is "${type}"`,
      confidence: 0.9,
      layer: 'vault',
    };
  }
  return null;
}

const SENSITIVITY_RANK: Readonly<Record<Sensitivity, number>> = {
  local_only: 4,
  sensitive: 3,
  elevated: 2,
  general: 1,
};

export class DomainClassifier {
  private readonly llmCallFn?: DomainLlmCallFn;
  private readonly llmConfidenceThreshold: number;
  private readonly personaRegistry?: { tier(persona: string): string | null };

  constructor(opts: DomainClassifierOptions = {}) {
    if (opts.llmCallFn !== undefined) this.llmCallFn = opts.llmCallFn;
    this.llmConfidenceThreshold =
      opts.llmConfidenceThreshold ?? DEFAULT_LLM_CONFIDENCE_THRESHOLD;
    if (opts.personaRegistry !== undefined) this.personaRegistry = opts.personaRegistry;
  }

  /**
   * Classify `text` with optional `persona` + `vaultContext`. Never
   * throws. When the LLM fallback is wired, it's only called if the
   * deterministic layers produce a result with confidence below
   * `llmConfidenceThreshold`.
   */
  async classify(input: {
    text: string;
    persona?: string;
    vaultContext?: VaultContext;
  }): Promise<Classification> {
    const text = input.text ?? '';
    const candidates: Classification[] = [];

    // Layer 1: persona override.
    const personaResult = this.classifyByPersona(input.persona);
    if (personaResult) {
      candidates.push(personaResult);
      // Short-circuit on top-tier sensitivity — nothing else could raise it.
      if (
        personaResult.sensitivity === 'sensitive' ||
        personaResult.sensitivity === 'local_only'
      ) {
        return personaResult;
      }
    }

    // Layer 2: keywords.
    const keywordResult = keywordClassify(text);
    if (keywordResult) candidates.push(keywordResult);

    // Layer 3: vault context.
    if (input.vaultContext) {
      const vaultResult = vaultContextClassify(input.vaultContext);
      if (vaultResult) candidates.push(vaultResult);
    }

    const best = pickBest(candidates);
    if (best && best.confidence >= this.llmConfidenceThreshold) {
      return best;
    }

    // Layer 4: LLM fallback (optional).
    if (this.llmCallFn) {
      try {
        const raw = await this.llmCallFn(text);
        const coerced = coerceLlmResult(raw);
        if (coerced) {
          return coerced;
        }
      } catch {
        // LLM failure is non-fatal — fall through to best-or-default.
      }
    }

    return (
      best ?? {
        sensitivity: 'general',
        domain: 'general',
        reason: 'no signals detected — default general',
        confidence: 0.3,
        layer: 'default',
      }
    );
  }

  private classifyByPersona(persona: string | undefined): Classification | null {
    if (typeof persona !== 'string' || persona.length === 0) return null;
    const key = persona.trim().replace(/^\/+/, '').toLowerCase();
    if (key === '') return null;

    // Registry wins when present (dynamic per-user config).
    if (this.personaRegistry) {
      const tier = this.personaRegistry.tier(key);
      if (tier !== null) {
        const sensitivity = TIER_SENSITIVITY.get(tier) ?? 'general';
        return {
          sensitivity,
          domain: PERSONA_MAP.get(key)?.domain ?? 'general',
          reason: `${key} persona (tier=${tier})`,
          confidence: 0.95,
          layer: 'persona',
        };
      }
    }
    // Fallback to static map.
    const mapped = PERSONA_MAP.get(key);
    if (mapped) {
      return {
        sensitivity: mapped.sensitivity,
        domain: mapped.domain,
        reason: mapped.reason,
        confidence: 0.95,
        layer: 'persona',
      };
    }
    return null;
  }
}

// ── Internals ──────────────────────────────────────────────────────────

function pickBest(candidates: Classification[]): Classification | null {
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  for (const c of candidates.slice(1)) {
    if (c.confidence > best.confidence) best = c;
    else if (
      c.confidence === best.confidence &&
      SENSITIVITY_RANK[c.sensitivity] > SENSITIVITY_RANK[best.sensitivity]
    ) {
      best = c;
    }
  }
  return best;
}

const ALLOWED_SENSITIVITY: ReadonlySet<Sensitivity> = new Set([
  'general', 'elevated', 'sensitive', 'local_only',
]);
const ALLOWED_DOMAIN: ReadonlySet<Domain> = new Set([
  'general', 'health', 'financial', 'legal', 'work',
]);

function coerceLlmResult(raw: unknown): Classification | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Partial<{ domain: Domain; sensitivity: Sensitivity; reason: string }>;
  if (!r.sensitivity || !ALLOWED_SENSITIVITY.has(r.sensitivity)) return null;
  if (!r.domain || !ALLOWED_DOMAIN.has(r.domain)) return null;
  return {
    sensitivity: r.sensitivity,
    domain: r.domain,
    reason: typeof r.reason === 'string' && r.reason.length > 0 ? r.reason : 'LLM classification',
    confidence: 0.6,
    layer: 'llm',
  };
}
