/**
 * Ask-retrieval pre-flight planner.
 *
 * A single small-model LLM call that turns a free-form /ask question
 * into a structured retrieval plan:
 *
 *   - `personas[]`           — for each persona the question could touch,
 *                              the search queries the loop should pre-fetch
 *                              and a one-line "why" the planner picked it.
 *   - `people[]`             — names to resolve via the people-graph.
 *   - `needs_peerlens`       — true when vendor / product evaluation is
 *                              implied (PeerLens should be consulted —
 *                              Dina's verified-peer-review network).
 *   - `intent`               — one-line restatement of what the user is
 *                              really asking — useful in telemetry and as
 *                              a quote-able preamble in the [Retrieved
 *                              context] block.
 *
 * Why pre-flight rather than mid-loop tools: the agentic loop tools
 * already let the LLM search any persona, but the LLM only reaches for
 * a vault other than the one the question named when the cross-domain
 * connection is obvious. "What should I get Emma for her birthday"
 * mentions no money; without a separate planner pass the loop never
 * thinks to look in `finance`. The planner runs FIRST, sees the
 * question, the persona descriptions, and is explicitly trained to
 * ask: "what other vaults could change this answer?". Its output is
 * pre-fetched and dropped into the loop's user message as a
 * `[Retrieved context]` block, so the reasoning loop starts already
 * holding the budget note, not having to discover it.
 *
 * Fail-soft: parse errors / LLM errors return an empty plan — the loop
 * still runs with its existing tool surface and behaves exactly as it
 * did before. The planner is a recall booster, never a hard gate.
 *
 * Tied closely to `packages/brain/__tests__/integration/cross_domain_synthesis.test.ts`
 * — that suite is the empirical oracle for changes here.
 */

import { ASK_RETRIEVAL_PLAN, renderPrompt } from '../llm/prompts';

import type { LLMRouter } from '../llm/router_dispatch';

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

export interface PlannedPersonaSearch {
  /** Persona vault name. Must be one of the installed personas. */
  persona: string;
  /**
   * Search queries to run against that persona — usually 1, occasionally
   * 2 when the planner believes two distinct facts could be relevant
   * (e.g. "budget" + "Emma preferences"). Each query goes through the
   * same vault_search code path the agent uses.
   */
  queries: string[];
  /**
   * Short ("budget could constrain the gift choice") explanation —
   * surfaced in telemetry. The LLM tends to write better plans when
   * the schema asks it to justify each persona pick.
   */
  why: string;
}

export interface AskRetrievalPlan {
  /** Persona → searches the agentic loop should pre-fetch. */
  personas: PlannedPersonaSearch[];
  /**
   * People named in the question — fed into the people-graph
   * `find_person` resolver to map names to canonical identity
   * (relationship, surfaces). Lower-case-normalised by the planner.
   */
  people: string[];
  /**
   * True when the question is shopping / vendor / product evaluation
   * — signals the loop should also call `search_peerlens`. False for
   * purely informational asks ("what time is my meeting").
   */
  needs_peerlens: boolean;
  /** One-line restatement of the user's intent. */
  intent: string;
}

export interface InstalledPersona {
  /** Persona name (e.g. "finance"). */
  name: string;
  /**
   * One-line description of what data lives in this persona. The planner
   * uses this verbatim to decide which personas to target. Omit when no
   * description is configured; the planner falls back to the name alone.
   */
  description?: string;
}

export interface PlanAskRetrievalOptions {
  /**
   * LLM call surface — `(systemPrompt, userPrompt) => content`. Same
   * shape `reminder_planner` etc. expect. The planner runs as
   * `taskType: 'intent_classification'` (lightweight tier) in the
   * caller that builds this callable.
   */
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>;
  /** Installed personas — used to render the prompt's persona menu. */
  personas: readonly InstalledPersona[];
  /** ISO date string for grounding "today". Defaults to host time. */
  today?: string;
}

// ---------------------------------------------------------------
// Plan construction helpers
// ---------------------------------------------------------------

const EMPTY_PLAN: AskRetrievalPlan = {
  personas: [],
  people: [],
  needs_peerlens: false,
  intent: '',
};

/** Read-only handle to the empty plan — convenient default for callers. */
export function emptyAskRetrievalPlan(): AskRetrievalPlan {
  return {
    personas: [],
    people: [],
    needs_peerlens: false,
    intent: '',
  };
}

// ---------------------------------------------------------------
// Planner entry point
// ---------------------------------------------------------------

/**
 * Run the pre-flight planner. Always resolves — never throws. On any
 * upstream failure (LLM error, JSON-shape mismatch, planner forgot a
 * persona) the empty plan is returned and the loop proceeds without
 * the recall boost.
 */
export async function planAskRetrieval(
  question: string,
  opts: PlanAskRetrievalOptions,
): Promise<AskRetrievalPlan> {
  const trimmed = (question ?? '').trim();
  if (trimmed === '') return emptyAskRetrievalPlan();

  const personaMenu = renderPersonaMenu(opts.personas);
  const today = opts.today ?? formatToday();
  const userPrompt = renderPrompt(ASK_RETRIEVAL_PLAN, {
    personas_menu: personaMenu,
    today,
    question: trimmed,
  });

  let raw = '';
  try {
    raw = await opts.llmCall('', userPrompt);
  } catch {
    return emptyAskRetrievalPlan();
  }
  return parseAskRetrievalPlan(raw, opts.personas);
}

/**
 * Build the `llmCall` callable from an `LLMRouter`. Same pattern as
 * `buildReminderQueryExpander` in `composition/agentic_ask.ts` — kept
 * here to avoid a circular import with the host pipeline file.
 *
 * Fail-soft: any router error returns `''`, which `parseAskRetrievalPlan`
 * turns into an empty plan.
 */
export function buildAskRetrievalPlannerCall(
  router: LLMRouter,
): (system: string, prompt: string) => Promise<string> {
  return async (system: string, prompt: string): Promise<string> => {
    try {
      const response = await router.chat({
        taskType: 'intent_classification',
        messages: [{ role: 'user', content: prompt }],
        ...(system !== '' ? { systemPrompt: system } : {}),
        temperature: 0.1,
        maxTokens: 512,
        responseSchema: ASK_RETRIEVAL_PLAN_RESPONSE_SCHEMA,
      });
      return response.content;
    } catch {
      return '';
    }
  };
}

// ---------------------------------------------------------------
// Parser — tolerant of fenced markdown + drift from the schema
// ---------------------------------------------------------------

/**
 * Parse the LLM's JSON response into a typed `AskRetrievalPlan`.
 *
 * Permissive: tolerates ```json fences + leading prose. Drops persona
 * picks that name a vault the user doesn't have (the planner doesn't
 * always respect the menu under load). Returns the empty plan rather
 * than throwing on any malformed shape.
 *
 * Exported for `__tests__/composition/ask_retrieval_planner.test.ts` —
 * the parse path has its own contract tests.
 */
export function parseAskRetrievalPlan(
  raw: string,
  installed: readonly InstalledPersona[],
): AskRetrievalPlan {
  if (typeof raw !== 'string' || raw.trim() === '') return emptyAskRetrievalPlan();

  const stripped = raw.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return emptyAskRetrievalPlan();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return emptyAskRetrievalPlan();
  }
  if (parsed === null || typeof parsed !== 'object') return emptyAskRetrievalPlan();
  const obj = parsed as Record<string, unknown>;

  const installedNames = new Set(installed.map((p) => p.name));
  const personas = extractPersonas(obj.personas, installedNames);
  const people = extractStringList(obj.people, 20).map((n) => n.trim()).filter(Boolean);
  // Accept the new `needs_peerlens` key; tolerate the legacy
  // `needs_trust_network` key in case an older model checkpoint still
  // emits the renamed field (handles in-flight upgrades).
  const needs_peerlens =
    typeof obj.needs_peerlens === 'boolean'
      ? obj.needs_peerlens
      : typeof obj.needs_trust_network === 'boolean'
        ? obj.needs_trust_network
        : false;
  const intent = typeof obj.intent === 'string' ? obj.intent.trim() : '';

  return { personas, people, needs_peerlens, intent };
}

function extractPersonas(
  raw: unknown,
  installedNames: Set<string>,
): PlannedPersonaSearch[] {
  if (!Array.isArray(raw)) return [];
  const out: PlannedPersonaSearch[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const persona = typeof rec.persona === 'string' ? rec.persona.trim() : '';
    if (persona === '') continue;
    // Drop persona picks that name a vault the user doesn't actually have.
    if (!installedNames.has(persona)) continue;
    if (seen.has(persona)) continue;
    const queries = extractStringList(rec.queries, 4)
      .map((q) => q.trim())
      .filter((q) => q.length > 0);
    if (queries.length === 0) continue;
    const why = typeof rec.why === 'string' ? rec.why.trim() : '';
    out.push({ persona, queries, why });
    seen.add(persona);
    if (out.length >= 8) break;
  }
  return out;
}

function extractStringList(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 120) continue;
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function renderPersonaMenu(personas: readonly InstalledPersona[]): string {
  if (personas.length === 0) return '(no personas installed)';
  return personas
    .map((p) =>
      p.description && p.description.length > 0
        ? `- ${p.name}: ${p.description}`
        : `- ${p.name}`,
    )
    .join('\n');
}

function formatToday(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------
// Response schema — Gemini's `responseSchema` parameter
// ---------------------------------------------------------------

/**
 * JSON Schema fed to the model as `responseSchema`. Forces a
 * well-typed plan when the underlying provider supports structured
 * output (Gemini, OpenAI, OpenRouter). Other providers ignore it and
 * the parser handles the looser response.
 *
 * Exported so tests can assert against a single shared shape and so
 * future contract tests can pin it.
 */
export const ASK_RETRIEVAL_PLAN_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    personas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          persona: { type: 'string' },
          queries: {
            type: 'array',
            items: { type: 'string' },
          },
          why: { type: 'string' },
        },
        required: ['persona', 'queries'],
      },
    },
    people: {
      type: 'array',
      items: { type: 'string' },
    },
    needs_peerlens: { type: 'boolean' },
    intent: { type: 'string' },
  },
  required: ['personas', 'people', 'needs_peerlens', 'intent'],
};

// ---------------------------------------------------------------
// Pre-flight retrieval executor + context-block formatter
// ---------------------------------------------------------------

/**
 * Pluggable backend for executing the plan. The host wires functions
 * that route through whatever vault / people surface it owns
 * (in-process repo for mobile, HTTP `CoreClient` for the lite
 * brain-server). Keeping it injectable avoids dragging the entire
 * vault assembly module into this file.
 */
export interface AskRetrievalFetchers {
  /**
   * Vault search per (persona, query). Mirror the agentic-loop
   * `executeToolSearch` shape: return the top-N items as
   * `{id, content_l0, body?, persona}`.
   */
  vaultSearch: (persona: string, query: string) => Promise<readonly RetrievedVaultItem[]>;
  /**
   * People-graph lookup. Optional — when omitted the plan's `people`
   * field is rendered as a list without resolution.
   */
  findPerson?: (name: string) => Promise<readonly RetrievedPersonMatch[]>;
}

export interface RetrievedVaultItem {
  id: string;
  content_l0: string;
  /** Optional — populated for the top-1 result in each search. */
  body?: string;
  /**
   * Persona the item came from. Filled in by the fetcher so the
   * formatter can group by vault.
   */
  persona: string;
}

export interface RetrievedPersonMatch {
  canonicalName: string;
  relationshipHint?: string;
  /** Short representation of the person's surfaces ("Emma, my daughter"). */
  surfaceSummary?: string;
}

export interface PreFlightRetrievalResult {
  plan: AskRetrievalPlan;
  /**
   * The formatted "[Retrieved context]" block ready to prepend to the
   * user message. Empty string when the plan produced no hits.
   */
  block: string;
  /** Per-persona hit counts for telemetry. */
  hits: Record<string, number>;
}

/**
 * Execute the plan against the supplied backends in parallel and
 * format the result as a context block.
 *
 * Per-call failures (one persona search throws, one person lookup
 * 404s) collapse to empty results for that branch — the rest of the
 * block is still emitted. The overall function never throws.
 */
export interface RunPreFlightOptions {
  /**
   * Persona pre-fetch filter. Returns `false` for personas the caller
   * may NOT pre-fetch without approval (sensitive/locked tiers for an
   * external agent). Filtered personas are dropped before fetching so
   * their content is never pre-fetched ungated — the agentic loop's
   * on-demand `vault_search` tool gates them instead. Omit ⇒ allow all
   * (the owner-on-app path, or callers without a guard).
   */
  personaAllowed?: (persona: string) => boolean | Promise<boolean>;
}

export async function runAskPreFlightRetrieval(
  plan: AskRetrievalPlan,
  fetchers: AskRetrievalFetchers,
  opts?: RunPreFlightOptions,
): Promise<PreFlightRetrievalResult> {
  if (plan.personas.length === 0 && plan.people.length === 0) {
    return { plan, block: '', hits: {} };
  }

  // Flatten the (persona, query) pairs so we can dispatch the whole
  // batch in one Promise.all and group by persona afterward.
  // F-AGENT-VAULT-GATE round-3: drop personas the caller may not
  // pre-fetch without approval. For an external agent this skips
  // sensitive/locked vaults so their content is never pre-fetched
  // ungated; the agent reaches them via the gated on-demand vault tool.
  const personaAllowed = opts?.personaAllowed;
  const picks: PlannedPersonaSearch[] = [];
  for (const pick of plan.personas) {
    if (personaAllowed === undefined || (await personaAllowed(pick.persona))) {
      picks.push(pick);
    }
  }

  const vaultTasks: { persona: string; query: string }[] = [];
  for (const pick of picks) {
    for (const q of pick.queries) {
      vaultTasks.push({ persona: pick.persona, query: q });
    }
  }

  const personTasks: string[] = [...plan.people];

  const [vaultResults, personResults] = await Promise.all([
    Promise.all(
      vaultTasks.map(async (t) => {
        try {
          return await fetchers.vaultSearch(t.persona, t.query);
        } catch {
          return [] as RetrievedVaultItem[];
        }
      }),
    ),
    fetchers.findPerson === undefined
      ? Promise.resolve([] as (readonly RetrievedPersonMatch[])[])
      : Promise.all(
          personTasks.map(async (name) => {
            try {
              return await fetchers.findPerson!(name);
            } catch {
              return [] as RetrievedPersonMatch[];
            }
          }),
        ),
  ]);

  const hits: Record<string, number> = {};
  const grouped = new Map<string, RetrievedVaultItem[]>();
  for (let i = 0; i < vaultTasks.length; i++) {
    const persona = vaultTasks[i].persona;
    const items = vaultResults[i] ?? [];
    hits[persona] = (hits[persona] ?? 0) + items.length;
    let bucket = grouped.get(persona);
    if (bucket === undefined) {
      bucket = [];
      grouped.set(persona, bucket);
    }
    for (const item of items) {
      // Dedupe by id within a persona so two queries that surface the
      // same row don't bloat the block.
      if (bucket.some((existing) => existing.id === item.id)) continue;
      bucket.push(item);
    }
  }

  const block = formatRetrievalContextBlock({
    plan,
    grouped,
    personMatches: personTasks.map((name, idx) => ({
      name,
      matches: personResults[idx] ?? [],
    })),
  });

  return { plan, block, hits };
}

interface FormatRetrievalContextBlockInput {
  plan: AskRetrievalPlan;
  grouped: Map<string, RetrievedVaultItem[]>;
  personMatches: { name: string; matches: readonly RetrievedPersonMatch[] }[];
}

/**
 * Render the retrieved context as a single block of plain text that
 * the host prepends to the user's /ask message. Pure for testability
 * — no I/O, no defaults beyond what the input carries.
 *
 * Format:
 *
 * ```
 * [Retrieved context for: "<intent>"]
 *
 * People:
 *   - Emma (daughter)
 *
 * Vault — finance:
 *   - Monthly toy budget: $25 — finances are tight this quarter
 * Vault — general:
 *   - Emma loves dinosaurs
 * ```
 *
 * Order: people first (identity grounds the rest), then vault items
 * grouped by persona. Within a persona, top hits first (the fetcher
 * already orders by relevance).
 */
export function formatRetrievalContextBlock(
  input: FormatRetrievalContextBlockInput,
): string {
  const lines: string[] = [];
  const intent = input.plan.intent.trim();
  if (intent !== '') {
    lines.push(`[Retrieved context for: "${intent}"]`);
  } else {
    lines.push('[Retrieved context]');
  }

  const peopleLines = formatPeopleLines(input.personMatches);
  if (peopleLines.length > 0) {
    lines.push('');
    lines.push('People:');
    lines.push(...peopleLines);
  }

  const vaultPersonas = [...input.grouped.keys()].sort();
  let vaultEmitted = false;
  for (const persona of vaultPersonas) {
    const items = input.grouped.get(persona) ?? [];
    if (items.length === 0) continue;
    if (!vaultEmitted) {
      lines.push('');
      vaultEmitted = true;
    }
    lines.push(`Vault — ${persona}:`);
    for (const item of items.slice(0, 5)) {
      const text = item.body ?? item.content_l0 ?? '';
      const summary = text.length > 240 ? `${text.slice(0, 240)}…` : text;
      lines.push(`  - ${summary}`);
    }
  }

  if (!vaultEmitted && peopleLines.length === 0) return '';
  lines.push('');
  lines.push(
    'This context was pre-fetched for you. Treat it like vault_search results — cite items by their content; still call tools if the question evolves.',
  );
  return lines.join('\n');
}

function formatPeopleLines(
  matches: { name: string; matches: readonly RetrievedPersonMatch[] }[],
): string[] {
  const out: string[] = [];
  for (const { name, matches: hits } of matches) {
    if (hits.length === 0) {
      // Unknown person — still surface the name; downstream tools can
      // decide whether to skip identity resolution.
      out.push(`  - ${name} (no match in people graph)`);
      continue;
    }
    for (const hit of hits) {
      const role =
        hit.relationshipHint && hit.relationshipHint.length > 0
          ? ` (${hit.relationshipHint})`
          : '';
      const surfaces = hit.surfaceSummary ? ` — ${hit.surfaceSummary}` : '';
      out.push(`  - ${hit.canonicalName}${role}${surfaces}`);
    }
  }
  return out;
}
