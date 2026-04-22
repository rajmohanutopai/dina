/**
 * Topic extraction (WM-BRAIN-01).
 *
 * Single-LLM-call extraction of entities + themes from each enriched
 * vault item. Runs downstream of the enrichment pipeline and feeds the
 * working-memory Table of Contents (`topic_salience` rows).
 *
 *   entities: proper nouns the user cares about (people, clinics,
 *             routes, companies). Rendered as "Dr Carl", "bus 42".
 *   themes:   lowercase common-noun phrases 2–5 words
 *             ("tax planning", "knee rehab"). Capture topic clusters
 *             without pinning them to a specific entity.
 *
 * PII flow:
 *   1. Scrub(summary + content) — `[EMAIL_0]`, `[PHONE_1]`, etc.
 *   2. LLM sees only scrubbed text.
 *   3. Rehydrate each returned entity/theme so the ToC never stores
 *      placeholder tokens.
 *
 * Fail-open: on any exception (scrub failure, LLM timeout, JSON parse
 * error) returns `{ entities: [], themes: [] }`. The ToC silently
 * misses this item — never drops or pollutes the memory store.
 *
 * Port of `brain/src/service/topic_extractor.py`. Design doc §6 (topics)
 * and §7 (attribution).
 */

import { EntityVault } from '../pii/entity_vault';
import { extractJSON, sanitiseList } from '../llm/output_parser';

/** Content fields fed to the extractor. */
export interface TopicExtractorInput {
  summary?: string;
  content_l0?: string;
  content_l1?: string;
  body?: string;
}

/** Result shape — two parallel topic lists. */
export interface TopicExtractionResult {
  entities: string[];
  themes: string[];
}

/**
 * LLM call surface — the extractor is a pure client over an injectable
 * `(systemPrompt, userPrompt) => completion` function. Matches the same
 * seam the enrichment pipeline uses so tests can share fake LLM fns.
 */
export type TopicExtractorLLM = (system: string, prompt: string) => Promise<string>;

/** Maximum chars fed to the LLM. Mirrors Python limits. */
const SUMMARY_CAP = 500;
const CONTENT_CAP = 2000;

/** Hard caps on the sanitised output — keep prompts cheap downstream. */
const MAX_ENTITIES = 6;
const MAX_THEMES = 4;

/**
 * System prompt — kept aligned with
 * `brain/src/service/topic_extractor.py::_PROMPT_TEMPLATE`.
 * Rewriting risks drift: the JSON-only rule + entity/theme definition
 * + the exclusion list are load-bearing for downstream sanitisation.
 *
 * GAP-PROMPT-01: main-dina's prompt includes explicit exclusions for
 * (a) pronouns (he/she/they/it/you/we/I) because they'd get captured
 * as "entities" by naive proper-noun detection, and (b) generic
 * role / type words ("doctor", "patient", "driver", "company")
 * because they're themes pretending to be entities — a provider-
 * specific "Dr Carl" should survive, "the doctor" should not. The
 * fixture test in `topic_extractor.test.ts` pins the prompt so a
 * silent rewrite can't erode these rules.
 */
export const TOPIC_EXTRACTOR_SYSTEM_PROMPT = `You extract working-memory topics from a personal note.

Return a bare JSON object with two lists:

  entities  — named proper nouns the user cares about (people, doctors,
              clinics, bus routes, companies, products). Keep original
              casing. Max 6 items.
  themes    — lowercase common-noun phrases 2–5 words long describing a
              topic cluster ("tax planning", "knee rehab", "saturday
              workouts"). Never proper nouns. Max 4 items.

Rules:
  - Skip boilerplate, greetings, signatures, legal footers.
  - If the note is trivial (e.g. one-word reactions, "ok thanks"),
    return empty arrays — DO NOT invent topics.
  - NEVER include pronouns (he, she, they, it, you, we, I, me, us,
    him, her, them) as entities. Pronouns are not topics.
  - NEVER include generic role/type words ("doctor", "patient",
    "driver", "nurse", "company", "client", "person", "manager",
    "team") as entities. Only named specific referents count — prefer
    "Dr Carl" over "doctor", "Bus 42" over "bus".
  - Dates and times (e.g. "tomorrow", "March 5", "next Thursday") are
    not topics — they get captured elsewhere. Exclude them from both
    lists.
  - NEVER include placeholder tokens like [EMAIL_0] or [PHONE_1] even
    if you see them in the input.
  - Return ONLY the JSON object, no prose, no markdown.`;

export class TopicExtractor {
  private readonly llm: TopicExtractorLLM;
  private readonly createVault: () => EntityVault;

  constructor(opts: {
    llm: TopicExtractorLLM;
    /**
     * Optional factory — override for tests, or to reuse a shared vault
     * across items in a batch. When omitted, each call creates a fresh
     * `EntityVault` so the scrub/rehydrate cycle is isolated per-item.
     */
    createVault?: () => EntityVault;
  }) {
    this.llm = opts.llm;
    this.createVault = opts.createVault ?? (() => new EntityVault());
  }

  async extract(item: TopicExtractorInput): Promise<TopicExtractionResult> {
    const summary = stringOrEmpty(item.summary, item.content_l0).slice(0, SUMMARY_CAP);
    const content = stringOrEmpty(item.content_l1, item.body).slice(0, CONTENT_CAP);
    if (summary === '' && content === '') {
      return empty();
    }

    // Scrub PII before sending to the LLM. A scrub exception is
    // exceedingly rare but we fail open — never hand raw PII to cloud.
    let vault: EntityVault;
    let scrubbedSummary: string;
    let scrubbedContent: string;
    try {
      vault = this.createVault();
      scrubbedSummary = vault.scrub(summary);
      scrubbedContent = vault.scrub(content);
    } catch {
      return empty();
    }

    const userPrompt = buildUserPrompt(scrubbedSummary, scrubbedContent);

    let raw: string;
    try {
      raw = await this.llm(TOPIC_EXTRACTOR_SYSTEM_PROMPT, userPrompt);
    } catch {
      return empty();
    }

    const parsed = extractJSON(raw);
    if (parsed === null) return empty();

    const rehydratedEntities = rehydrateAll(vault, parsed.entities);
    const rehydratedThemes = rehydrateAll(vault, parsed.themes);

    return {
      entities: sanitiseList(rehydratedEntities, MAX_ENTITIES),
      themes: sanitiseList(rehydratedThemes, MAX_THEMES),
    };
  }
}

function empty(): TopicExtractionResult {
  return { entities: [], themes: [] };
}

function stringOrEmpty(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c;
  }
  return '';
}

function buildUserPrompt(summary: string, content: string): string {
  return [
    summary !== '' ? `Summary:\n${summary}` : '',
    content !== '' ? `Content:\n${content}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n\n');
}

/**
 * Rehydrate PII tokens in each candidate string. Non-strings are passed
 * through unchanged so `sanitiseList` can drop them; the length-80 cap
 * in `sanitiseList` also catches any pathological rehydration that
 * balloons the string.
 */
function rehydrateAll(vault: EntityVault, raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => (typeof v === 'string' ? vault.rehydrate(v) : v));
}
