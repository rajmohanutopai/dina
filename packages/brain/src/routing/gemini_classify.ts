/**
 * Gemini-backed persona classifier — TS port of Python's
 * `brain/src/service/persona_selector.py::_llm_select` + `_parse_response`.
 *
 * The Python version passes 100/100 scenarios in
 * `tests/prompt/test_persona_classification.py` against real Gemini.
 * This file keeps the prompt, user-message shape, schema, and parsing
 * contract byte-identical so the two stacks stay behaviourally equivalent.
 *
 * Flow:
 *   1. Build the user message as a JSON blob (today, available_personas
 *      with tier + description, item_context, optional mentioned_contacts,
 *      optional attribution_candidates).
 *   2. Call the provider with the PERSONA_CLASSIFY system prompt +
 *      PERSONA_CLASSIFY_RESPONSE_SCHEMA so Gemini returns strict JSON.
 *   3. Parse: validate `primary` is in the known-personas list, filter
 *      `secondary` to valid names only (excluding primary), bound
 *      confidence to [0, 1], carry has_event + event_hint + corrections.
 *   4. Fall back to `{primary: 'general', confidence: 0.3}` on parse
 *      failure so callers never have to handle thrown exceptions.
 */

import {
  PERSONA_CLASSIFY,
  PERSONA_CLASSIFY_RESPONSE_SCHEMA,
} from '../llm/prompts';
import type { ChatOptions, LLMProvider } from '../llm/adapters/provider';
import { getProviderTiers, type ProviderName } from '../llm/provider_config';
import type {
  ClassificationInput,
  MentionedContact,
  AttributionCandidate,
} from './domain';
import type { PersonaSelectorProvider } from './persona_selector';

/**
 * Installed-persona descriptor the classifier surfaces to the LLM.
 * Mirrors Python's `registry.description(name)` + `registry.tier(name)`
 * output — we always send `{name, tier}` and attach `description`
 * when the registry has one (most persona managers set a default like
 * "General personal information, …").
 */
export interface InstalledPersona {
  name: string;
  tier?: string;
  description?: string;
}

/**
 * Rich classifier return shape — extends `PersonaSelectorProvider`'s
 * original `{persona, confidence, reason}` so downstream callers get
 * the full Python-parity envelope: primary + secondary[] + has_event
 * + event_hint + attribution_corrections. `persona` stays populated
 * (aliased to `primary`) so existing call sites that read `.persona`
 * keep working without a grep-and-rewrite.
 */
export interface RichClassificationResult {
  persona: string;
  primary: string;
  secondary: string[];
  confidence: number;
  reason: string;
  has_event: boolean;
  event_hint: string;
  attribution_corrections: Array<{ id: number; corrected_bucket?: string; reason?: string }>;
}

const CLASSIFY_TEMPERATURE = 0.1;
// 2048 is a conservative ceiling — the classification envelope fits in
// ~100 JSON tokens, but `gemini-2.5-flash` + `responseSchema` was
// observed truncating mid-field at 512 on schema-heavy prompts
// (multi-field required, secondary[], attribution_corrections[]). Bumping
// leaves headroom without changing cost meaningfully (we pay per output
// token actually emitted).
const CLASSIFY_MAX_TOKENS = 2048;

/**
 * Options common to both classifier factories.
 */
export interface ClassifierOptions {
  /** Override the installed-personas lookup (test injection). */
  resolveInstalledPersonas?: (names: string[]) => InstalledPersona[];
  /**
   * Which provider this classifier runs against. Used by
   * `getProviderTiers()` to pick the `lite` model for classification
   * — matches Python's LLMRouter tier routing where
   * `task_type="classification"` resolves to the lite tier.
   *
   * Defaults to `'gemini'`. Pass the matching provider name when
   * reusing this factory for openai/claude/openrouter.
   */
  providerName?: ProviderName;
  /**
   * Explicit model override. Takes precedence over the auto-picked
   * `lite` tier. Set this for dev cost tuning or to pin a specific
   * model; leave unset in production so the tier system wins.
   */
  model?: string;
}

/**
 * Create the production Gemini-backed persona selector. Returns a
 * `PersonaSelectorProvider` that also carries the rich shape on the
 * same object — callers that want the full envelope cast the result
 * to `RichClassificationResult`.
 *
 * The classifier auto-picks the provider's `lite` tier so every
 * `/remember` call doesn't burn pro-class reasoning tokens — matches
 * Python's `LLMRouter.route(task_type="classification")`. For
 * Gemini that means `gemini-3.1-flash-lite-preview`; the provider
 * instance's `defaultModel` (typically `gemini-3.1-pro-preview` for
 * the agentic `/ask` path) is left alone.
 */
export function createGeminiClassifier(
  provider: LLMProvider,
  options: ClassifierOptions = {},
): PersonaSelectorProvider {
  const resolve = options.resolveInstalledPersonas ?? defaultResolveInstalledPersonas;
  const classifyModel = options.model ?? getProviderTiers(options.providerName ?? 'gemini').lite;

  return async (input: ClassificationInput, availablePersonas: string[]) => {
    const installed = resolve(availablePersonas);
    const userMessage = buildClassificationUserMessage(input, installed);

    const chatOptions: ChatOptions = {
      model: classifyModel,
      temperature: CLASSIFY_TEMPERATURE,
      maxTokens: CLASSIFY_MAX_TOKENS,
      responseSchema: PERSONA_CLASSIFY_RESPONSE_SCHEMA,
    };

    const response = await provider.chat(
      [
        { role: 'system', content: PERSONA_CLASSIFY },
        { role: 'user', content: userMessage },
      ],
      chatOptions,
    );

    return parseClassificationResponse(response.content, availablePersonas);
  };
}

/**
 * Free-form variant — no native structured output. Relies on prompt
 * alone to coax JSON. Retained for provider adapters that lack a
 * `responseSchema` surface. Same parse contract as the Gemini variant.
 */
export function createGenericClassifier(
  provider: LLMProvider,
  options: ClassifierOptions = {},
): PersonaSelectorProvider {
  const resolve = options.resolveInstalledPersonas ?? defaultResolveInstalledPersonas;
  const classifyModel = options.model ?? getProviderTiers(options.providerName ?? 'gemini').lite;

  return async (input: ClassificationInput, availablePersonas: string[]) => {
    const installed = resolve(availablePersonas);
    const userMessage = buildClassificationUserMessage(input, installed);

    const response = await provider.chat(
      [
        { role: 'system', content: PERSONA_CLASSIFY },
        { role: 'user', content: userMessage },
      ],
      {
        model: classifyModel,
        temperature: CLASSIFY_TEMPERATURE,
        maxTokens: CLASSIFY_MAX_TOKENS,
      },
    );

    return parseClassificationResponse(response.content, availablePersonas);
  };
}

// ---------------------------------------------------------------------------
// User-message assembly — JSON blob, verbatim shape from Python
// ---------------------------------------------------------------------------

/**
 * Build the user-message JSON blob. Keys + truncation lengths match
 * Python's `persona_selector.py::_llm_select` so both stacks hand the
 * model the same view of the item.
 */
export function buildClassificationUserMessage(
  input: ClassificationInput,
  installed: InstalledPersona[],
): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  const personaList = installed.map((p) => {
    const entry: Record<string, string> = {
      name: p.name,
      tier: p.tier ?? 'default',
    };
    if (p.description !== undefined && p.description !== '') {
      entry.description = p.description;
    }
    return entry;
  });

  const itemContext: Record<string, unknown> = {
    item_type: input.type ?? '',
    source: input.source ?? '',
    sender: input.sender ?? '',
    summary: (input.subject ?? '').slice(0, 200),
    body_preview: (input.body ?? '').slice(0, 300),
  };

  if (input.mentionedContacts && input.mentionedContacts.length > 0) {
    itemContext.mentioned_contacts = serializeMentionedContacts(input.mentionedContacts);
  }

  if (input.attributionCandidates && input.attributionCandidates.length > 0) {
    itemContext.attribution_candidates = input.attributionCandidates;
  }

  const payload = {
    today,
    available_personas: personaList,
    ...itemContext,
  };

  return JSON.stringify(payload, null, 2);
}

/** Python sends `mentioned_contacts` as a plain list of dicts — do the
 *  same here, preserving the exact field names the prompt references
 *  (`name`, `relationship`, `data_responsibility`). */
function serializeMentionedContacts(contacts: MentionedContact[]): Array<Record<string, string>> {
  return contacts.map((c) => {
    const out: Record<string, string> = { name: c.name };
    if (c.relationship !== undefined) out.relationship = c.relationship;
    if (c.data_responsibility !== undefined) out.data_responsibility = c.data_responsibility;
    return out;
  });
}

// ---------------------------------------------------------------------------
// Response parsing — validates + filters + bounds-checks
// ---------------------------------------------------------------------------

/**
 * Parse the Gemini response and project it onto `PersonaSelectorProvider`'s
 * contract (which also carries the rich fields at runtime for callers
 * that cast). Fall-back shape matches Python's `None`-on-failure path —
 * a low-confidence 'general' so the drain still has somewhere to route.
 */
export function parseClassificationResponse(
  content: string,
  availablePersonas: string[],
): { persona: string; confidence: number; reason: string } {
  const rich = parseClassificationResponseRich(content, availablePersonas);
  return {
    persona: rich.persona,
    confidence: rich.confidence,
    reason: rich.reason,
  };
}

/**
 * Rich parse — returns the full Python-parity envelope. Callers that
 * need `secondary[]` / `has_event` / `event_hint` / attribution
 * corrections should use this directly.
 */
export function parseClassificationResponseRich(
  content: string,
  availablePersonas: string[],
): RichClassificationResult {
  const fallback: RichClassificationResult = {
    persona: 'general',
    primary: 'general',
    secondary: [],
    confidence: 0.3,
    reason: 'Classification parse failed',
    has_event: false,
    event_hint: '',
    attribution_corrections: [],
  };

  if (content === undefined || content === null || content.trim().length === 0) {
    return fallback;
  }

  let cleaned = content.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return fallback;
  }

  const available = new Set(availablePersonas.map((p) => p.toLowerCase()));

  // Primary — Python reads `primary`. Accept legacy `persona` key as
  // a fallback for any caller still shipping the old shape during the
  // transition, but warn nowhere (silent accept) so logs don't fill up.
  const primaryRaw =
    typeof parsed.primary === 'string'
      ? parsed.primary
      : typeof parsed.persona === 'string'
        ? parsed.persona
        : '';
  const primary = primaryRaw.toLowerCase().trim();
  if (primary === '' || !available.has(primary)) {
    // Python returns `None` here; we synthesise a low-confidence 'general'
    // so the caller still has a routable persona. Matches the legacy
    // parser's behaviour for unknown-persona responses.
    return {
      ...fallback,
      reason:
        primary === ''
          ? 'Classifier did not emit a primary persona'
          : `LLM suggested "${primary}" which is not installed`,
    };
  }

  // Confidence bounds.
  const rawConfidence = Number(parsed.confidence ?? 0.5);
  if (!Number.isFinite(rawConfidence) || rawConfidence < 0 || rawConfidence > 1) {
    return fallback;
  }

  // Secondary — array of persona names. Filter to ones that are (a)
  // installed and (b) not the primary (Python does the same). Non-
  // array shapes degrade gracefully to empty — a string-valued
  // `secondary` from a legacy response counts as "no secondaries".
  const secondaryRaw = Array.isArray(parsed.secondary) ? parsed.secondary : [];
  const secondary: string[] = [];
  const seen = new Set<string>([primary]);
  for (const s of secondaryRaw) {
    if (typeof s !== 'string') continue;
    const name = s.toLowerCase().trim();
    if (name === '' || seen.has(name) || !available.has(name)) continue;
    secondary.push(name);
    seen.add(name);
  }

  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  const hasEvent = parsed.has_event === true;
  const eventHint = typeof parsed.event_hint === 'string' ? parsed.event_hint : '';

  const correctionsRaw = Array.isArray(parsed.attribution_corrections)
    ? parsed.attribution_corrections
    : [];
  const corrections: RichClassificationResult['attribution_corrections'] = [];
  for (const entry of correctionsRaw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'number') continue;
    corrections.push({
      id: record.id,
      corrected_bucket:
        typeof record.corrected_bucket === 'string' ? record.corrected_bucket : undefined,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    });
  }

  return {
    persona: primary,
    primary,
    secondary,
    confidence: rawConfidence,
    reason,
    has_event: hasEvent,
    event_hint: eventHint,
    attribution_corrections: corrections,
  };
}

// ---------------------------------------------------------------------------
// Default installed-persona resolver — reads Core's persona service
// ---------------------------------------------------------------------------

/**
 * Default resolver: looks up each available-persona name in Core's
 * persona registry so the LLM sees the same `{name, tier, description}`
 * triple Python sends. Safe to inject a different resolver via the
 * factory options when the test doesn't want the Core dep.
 */
function defaultResolveInstalledPersonas(names: string[]): InstalledPersona[] {
  // Deferred require to avoid a hard coupling from the classifier module
  // to Core's persona service — keeps this file importable in tests
  // that stub out the resolver.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const core = require('../../../core/src/persona/service') as {
    getPersona: (name: string) => { name: string; tier: string; description: string } | null;
  };
  return names.map((name) => {
    const state = core.getPersona(name);
    if (state === null) return { name };
    return {
      name: state.name,
      tier: state.tier,
      ...(state.description !== '' ? { description: state.description } : {}),
    };
  });
}
