/**
 * Intent classifier (WM-BRAIN-02).
 *
 * A small, fast LLM call that runs BEFORE the reasoning agent. Given a
 * user query, it reads the working-memory Table of Contents and emits
 * a structured routing hint:
 *
 *   sources            — which substrates the reasoning agent should
 *                        consult (vault / trust_network /
 *                        provider_services / general_knowledge).
 *   relevant_personas  — the personas whose vault context is worth
 *                        loading first.
 *   toc_evidence       — what the classifier matched to reach its
 *                        decision (entity / theme matches, per-persona
 *                        topic lists, live-capability annotations).
 *   temporal           — whether the question is static knowledge,
 *                        asking for live state, or comparing options.
 *   reasoning_hint     — a one-sentence nudge the reasoning agent can
 *                        read to frame its prompt.
 *
 * Never raises. On ANY failure (ToC fetch error, LLM timeout, JSON
 * parse fail, schema mismatch) it returns `IntentClassifier.default()`
 * so the reasoning agent still runs — just without the boost.
 *
 * Design doc §6.5 (two-axis routing), §9 (classifier placement +
 * output schema), §9.1 (source semantics), §9.2 (output shape).
 * Port of `brain/src/service/intent_classifier.py`.
 */

import type { TocEntry } from '../../../core/src/memory/domain';
import { extractJSON } from '../llm/output_parser';

/** One of the four substrates the reasoning agent can consult. */
export const INTENT_SOURCES = [
  'vault',
  'trust_network',
  'provider_services',
  'general_knowledge',
] as const;
export type IntentSource = (typeof INTENT_SOURCES)[number];

/** Temporal stance of the query. Empty string = not classified. */
export const INTENT_TEMPORAL = ['static', 'live_state', 'comparative', ''] as const;
export type IntentTemporal = (typeof INTENT_TEMPORAL)[number];

/**
 * What the classifier matched against the ToC on the way to its
 * decision.
 *
 * PC-BRAIN-04 retired `live_capabilities_available` here — capability
 * bindings moved from ToC memory to the Contact row (`preferredFor`).
 * The reasoning agent resolves a category-to-provider mapping at
 * query time via the `find_preferred_provider` tool (PC-BRAIN-07),
 * so there is no pre-stamped hint carried through the classifier.
 */
export interface TocEvidence {
  entity_matches?: string[];
  theme_matches?: string[];
  persona_context?: Record<string, string[]>;
}

/** The classifier's output — read by the reasoning agent (WM-BRAIN-04). */
export interface IntentClassification {
  sources: IntentSource[];
  relevant_personas: string[];
  toc_evidence: TocEvidence;
  temporal: IntentTemporal;
  reasoning_hint: string;
}

/** LLM surface — `(system, prompt) => completion`. Matches the same
 *  seam used by `TopicExtractor` and the enrichment pipeline. */
export type IntentClassifierLLM = (system: string, prompt: string) => Promise<string>;

/**
 * System prompt — port of `intent_classifier.py::_SYSTEM_PROMPT`. The
 * schema enumeration is load-bearing: the classifier is expected to
 * emit exactly the literals the coercion step recognises. DO NOT
 * paraphrase or re-order the `sources` / `temporal` enums.
 */
export const INTENT_CLASSIFIER_SYSTEM_PROMPT = `You are the Intent Classifier for Dina, a personal sovereign AI.

You receive:
  - A Table of Contents (ToC) summarising what the user has captured in
    their working memory, grouped by persona.
  - A free-text user query.

You output a bare JSON object routing the query for the downstream
reasoning agent. DO NOT answer the query. DO NOT include prose,
markdown, or code fences — ONLY the JSON object.

Output schema (every key required):

  {
    "sources": [ ... one or more of:
        "vault"              — the user's own captured data
        "trust_network"      — messages / posts from the user's contacts
        "provider_services"  — live services on the Dina network
                               (bus ETAs, appointment status, etc.)
        "general_knowledge"  — facts the LLM itself knows
    ],
    "relevant_personas": [ persona names from the ToC whose data is
                           worth loading; empty array is allowed ],
    "toc_evidence": {
      "entity_matches": [ ToC entities that matched the query ],
      "theme_matches":  [ ToC themes that matched the query ],
      "persona_context": { persona: [topic, topic, ...] }
    },
    "temporal": one of:
        "static"       — answerable from stored / general knowledge
        "live_state"   — requires a fresh external lookup NOW
        "comparative"  — trading off two or more options
        ""             — cannot tell
    ,
    "reasoning_hint": "<one short sentence the reasoning agent can read
                       to frame its plan — never more than ~25 words>"
  }

Rules:
  - If the query is purely informational ("what is X"), prefer sources =
    ["vault","general_knowledge"].
  - If the query is about an established service relationship ("my
    dentist", "my lawyer", "my accountant", etc.), include
    "provider_services" in sources — the downstream agent will look
    up the user's preferred contact for that category via its own
    tool; you don't need to resolve the specific provider here.
  - Empty or unclear queries → sources = ["vault"], everything else
    empty / "".
  - Return ONLY the JSON object.`;

/** Ordering of the class's "conservative fallback" — built once, frozen
 *  so callers can't mutate the default and affect future calls. */
const DEFAULT_CLASSIFICATION: Readonly<IntentClassification> = Object.freeze({
  sources: ['vault'] as IntentSource[],
  relevant_personas: [] as string[],
  toc_evidence: {} as TocEvidence,
  temporal: '' as IntentTemporal,
  reasoning_hint: '',
});

export class IntentClassifier {
  private readonly llm: IntentClassifierLLM;
  private readonly tocFetcher: () => Promise<TocEntry[]>;

  constructor(opts: { llm: IntentClassifierLLM; tocFetcher: () => Promise<TocEntry[]> }) {
    this.llm = opts.llm;
    this.tocFetcher = opts.tocFetcher;
  }

  /**
   * Conservative fallback — used when any step fails AND exported as a
   * static so callers (e.g. integration tests, a stubbed out pipeline)
   * can reference the same shape without constructing the classifier.
   */
  static default(): IntentClassification {
    return cloneDefault();
  }

  async classify(query: string): Promise<IntentClassification> {
    // Empty query → conservative default WITHOUT calling the LLM.
    if (typeof query !== 'string' || query.trim() === '') {
      return cloneDefault();
    }

    let toc: TocEntry[];
    try {
      toc = await this.tocFetcher();
    } catch {
      return cloneDefault();
    }
    const tocBlock = renderTocForPrompt(Array.isArray(toc) ? toc : []);

    const userPrompt = `Table of Contents:\n${tocBlock}\n\nQuery:\n${query.trim()}`;

    let raw: string;
    try {
      raw = await this.llm(INTENT_CLASSIFIER_SYSTEM_PROMPT, userPrompt);
    } catch {
      return cloneDefault();
    }

    return parseIntentClassification(raw);
  }
}

/**
 * Render the ToC as the block fed to the classifier prompt. Pure +
 * exported so the Test-02 suite can pin its exact behaviour.
 *
 *   <persona>: topic1, topic2 [live: <cap> via <did>], topic3
 *
 * Empty ToC → the sentinel string so the classifier knows nothing has
 * been captured yet (matches Python's `_render_toc_for_prompt`).
 */
export function renderTocForPrompt(entries: TocEntry[]): string {
  if (entries.length === 0) {
    return '(empty — user has not captured any topics yet)';
  }
  // Capability routing flows through `find_preferred_provider`
  // (PC-BRAIN-07) which reads contact preferences — the renderer
  // only surfaces topic names, not any per-topic capability metadata.
  const byPersona = new Map<string, string[]>();
  for (const e of entries) {
    const persona = e.persona && e.persona !== '' ? e.persona : 'general';
    const bucket = byPersona.get(persona);
    if (bucket === undefined) {
      byPersona.set(persona, [e.topic]);
    } else {
      bucket.push(e.topic);
    }
  }
  const lines: string[] = [];
  for (const [persona, topics] of byPersona) {
    lines.push(`${persona}: ${topics.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Parse + coerce an LLM response into `IntentClassification`. Pure +
 * exported for test coverage. Any deviation from the schema is
 * silently corrected toward the conservative default — this function
 * NEVER throws.
 */
export function parseIntentClassification(raw: string): IntentClassification {
  const obj = extractJSON(raw);
  if (obj === null) return cloneDefault();

  const sources = coerceSources(obj.sources);
  const temporal = coerceTemporal(obj.temporal);
  const toc_evidence = coerceTocEvidence(obj.toc_evidence);
  const relevant_personas = coerceStringList(obj.relevant_personas);
  const reasoning_hint = typeof obj.reasoning_hint === 'string' ? obj.reasoning_hint : '';

  return { sources, relevant_personas, toc_evidence, temporal, reasoning_hint };
}

function coerceSources(raw: unknown): IntentSource[] {
  if (!Array.isArray(raw)) return ['vault'];
  const valid = new Set<string>(INTENT_SOURCES);
  const out: IntentSource[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    if (!valid.has(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v as IntentSource);
  }
  // Fallback when the model returned only unknown literals (or empty).
  return out.length === 0 ? ['vault'] : out;
}

function coerceTemporal(raw: unknown): IntentTemporal {
  if (typeof raw !== 'string') return '';
  const valid = new Set<string>(INTENT_TEMPORAL);
  return valid.has(raw) ? (raw as IntentTemporal) : '';
}

function coerceTocEvidence(raw: unknown): TocEvidence {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const out: TocEvidence = {};
  if (Array.isArray(src.entity_matches)) {
    out.entity_matches = coerceStringList(src.entity_matches);
  }
  if (Array.isArray(src.theme_matches)) {
    out.theme_matches = coerceStringList(src.theme_matches);
  }
  if (src.persona_context !== undefined && isPlainObject(src.persona_context)) {
    const ctx: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(src.persona_context)) {
      if (Array.isArray(v)) ctx[k] = coerceStringList(v);
    }
    if (Object.keys(ctx).length > 0) {
      out.persona_context = ctx;
    }
  }
  // Fields not listed above are silently dropped — the output
  // shape is strict (see `TocEvidence`). Capability routing is
  // resolved by the reasoning agent at tool time via
  // `find_preferred_provider` (contact preferences), not carried
  // on the classifier output.
  return out;
}

function coerceStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function cloneDefault(): IntentClassification {
  return {
    sources: [...DEFAULT_CLASSIFICATION.sources],
    relevant_personas: [...DEFAULT_CLASSIFICATION.relevant_personas],
    toc_evidence: {},
    temporal: DEFAULT_CLASSIFICATION.temporal,
    reasoning_hint: DEFAULT_CLASSIFICATION.reasoning_hint,
  };
}
