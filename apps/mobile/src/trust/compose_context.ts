/**
 * Compose-context — LLM-driven prefill for the trust write/edit form.
 *
 * Given a SubjectRef + the vault items the user has about that
 * subject, ask the local LLM to classify the user's primary use cases
 * (from a closed vocabulary) and the freshness bucket. Returns the
 * structured result for the runner to merge into form state.
 *
 * **No regex.** The prior heuristic-with-regex implementation was a
 * placeholder; classification needs semantic understanding ("I tried
 * gaming on this but hated it" → NOT a gaming match), which only an
 * LLM gives reliably. This module uses the user's BYOK provider via
 * `createLLMProvider` and Gemini/OpenAI structured-output mode. The
 * vocabulary stays closed at the seam (LLM output is filtered against
 * the same vocabulary the prompt used), so unknown tags never reach
 * form state.
 *
 * **Loyalty Law-clean.** Vault items live in the keystore and are
 * passed to the LLM in-process. Mobile owns the LLM key (BYOK) so the
 * call goes from user-keystore → user-LLM-account → user-mobile, with
 * NO Dina-operated cloud server in the path. AppView is never called.
 *
 * **Closed-vocabulary discipline.** The prompt enumerates the
 * vocabulary IDs verbatim. The structured-output schema constrains
 * the response. Mobile filters the result against the vocabulary as
 * defense-in-depth — even if the LLM ignored the schema (bad model /
 * provider regression), unknown tags drop on the floor before they
 * reach form state.
 *
 * **Behaviour when LLM is absent.** If no provider is configured, the
 * function returns an empty result (no values, no sources). The form
 * opens at its baseline — same UX as a vault with no relevant items.
 * Quiet failure; no error toast.
 */

import type {
  ChatMessage,
  ChatOptions,
  LLMProvider,
} from '@dina/brain/src/llm/adapters/provider';
import type { Sentiment } from '@dina/protocol';

import type { LastUsedBucket } from './write_form_data';
import { BODY_MAX_LENGTH, HEADLINE_MAX_LENGTH, SENTIMENT_OPTIONS } from './write_form_data';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ComposeVaultItem {
  /** Stable identifier — used for source-attribution counts. */
  readonly id: string;
  /** Free-text body the LLM reads (concatenated from headline + summary + body). */
  readonly body: string;
  /** ms-since-epoch — used for last_used_bucket boundary calculation client-side. */
  readonly timestamp: number;
}

export interface ComposeContextValues {
  readonly use_cases?: readonly string[];
  readonly last_used_bucket?: LastUsedBucket;
  /**
   * Drafted sentiment — only present when the runner asked for a full
   * draft (`draftFreeform: true`) AND the vault content clearly leans
   * one way. Form-only callers ignore this; the chat-driven
   * `/ask write a review of …` flow reads it to seed the inline
   * draft card.
   */
  readonly sentiment?: Sentiment;
  /**
   * Drafted headline (≤ HEADLINE_MAX_LENGTH chars). Same gate as
   * `sentiment` — only emitted under `draftFreeform: true`. Quietly
   * dropped if the LLM exceeds the length cap rather than returning
   * a partial / truncated headline.
   */
  readonly headline?: string;
  /**
   * Drafted body (≤ BODY_MAX_LENGTH chars). Same gate as `sentiment`
   * / `headline`. Free-text — the user is expected to read and edit
   * before the explicit Publish step (Loyalty Law: Dina never
   * auto-publishes content the user signs).
   */
  readonly body?: string;
  // alternatives: deferred — same LLM upgrade lands it next iteration.
}

export interface ComposeSourceMeta {
  readonly use_cases?: {
    readonly vault_item_count: number;
  };
  readonly last_used_bucket?: {
    readonly vault_item_count: number;
  };
  readonly sentiment?: {
    readonly vault_item_count: number;
  };
  readonly headline?: {
    readonly vault_item_count: number;
  };
  readonly body?: {
    readonly vault_item_count: number;
  };
}

export interface ComposeContextResult {
  readonly values: ComposeContextValues;
  readonly sources: ComposeSourceMeta;
}

// ─── LLM call ──────────────────────────────────────────────────────────

const VALID_BUCKETS: readonly LastUsedBucket[] = [
  'today',
  'past_week',
  'past_month',
  'past_6_months',
  'past_year',
  'over_a_year',
];

/** Schema for the prefill-only call (chips + last-used bucket). */
const PREFILL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    use_cases: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 3,
      description:
        'Up to 3 use-case tags chosen from the provided closed list. ' +
        'Omit entirely if the vault context does not support any use case.',
    },
    last_used_bucket: {
      type: 'string',
      enum: VALID_BUCKETS as unknown as string[],
      description:
        'When the user last used the subject, classified into one of the listed buckets. ' +
        'Omit entirely if the vault context does not indicate any recent use.',
    },
  },
} as const;

/**
 * Schema for the full-draft call — adds sentiment / headline / body.
 *
 * Used by the `/ask write a review of <X>` chat flow (one extra LLM
 * turn) and not by the form-prefill flow (which sticks to the lean
 * `PREFILL_RESPONSE_SCHEMA`). The draft fields are *optional* in the
 * schema: the LLM is instructed to omit anything that isn't clearly
 * supported by the vault content, and the parser drops malformed /
 * over-length values (defense-in-depth — `headline` truncations are
 * a recurring smell on `gemini-3.1-flash-lite-preview`, so we drop
 * over-length rather than silently truncate).
 */
const DRAFT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    ...PREFILL_RESPONSE_SCHEMA.properties,
    sentiment: {
      type: 'string',
      enum: SENTIMENT_OPTIONS as unknown as string[],
      description:
        "The user's apparent stance on the subject. Choose only when the vault content " +
        'clearly leans one way; omit when the signal is mixed or absent.',
    },
    headline: {
      type: 'string',
      description:
        `One-line summary of the user's review (≤ ${HEADLINE_MAX_LENGTH} chars). ` +
        'Plain sentence — no quotation marks, no surrounding punctuation. Omit if ' +
        'the vault content is too thin to draft a non-generic headline.',
    },
    body: {
      type: 'string',
      description:
        `Optional 2–4 sentence body the user can edit (≤ ${BODY_MAX_LENGTH} chars). ` +
        'Stay tight to facts visible in the vault items — context, use case, what ' +
        'works / what does not. Omit if there is not enough material to write more ' +
        'than a generic statement.',
    },
  },
} as const;

const SYSTEM_PROMPT_PREFILL = [
  'You are summarising what a user already knows about a subject so they can review it.',
  'You are reading the user\'s OWN vault — emails, calendar, messages, transactions about this subject.',
  'Be conservative: only emit values directly supported by the context.',
  'Never invent facts. If the context is ambiguous (e.g. "I tried gaming on this but hated it"), ' +
    'do NOT classify "gaming" as a use case.',
  'If a field cannot be determined, omit it from the response.',
].join(' ');

const SYSTEM_PROMPT_DRAFT = [
  'You are drafting a review the user will read and edit before publishing.',
  'You are reading the user\'s OWN vault — their own notes, emails, transactions about this subject.',
  'Write in the FIRST PERSON ("I sit in this chair every day…"), as if the user is writing.',
  'Stay strictly within facts visible in the vault items. NEVER invent details.',
  'If a field cannot be filled honestly, OMIT it — the user will fill it in. A blank ' +
    'field is better than a fabricated one. Half-written drafts are fine; hallucinations are not.',
  'Headline: one short sentence, no quotation marks. Body: 2–4 short sentences, plain prose, no markdown.',
].join(' ');

function buildUserPrompt(opts: {
  subjectName: string;
  category: string | null;
  vocabulary: readonly string[];
  items: readonly ComposeVaultItem[];
  nowISO: string;
  draftFreeform: boolean;
}): string {
  const { subjectName, category, vocabulary, items, nowISO, draftFreeform } = opts;
  const itemBlock = items
    .slice(0, 20) // cap so the prompt fits a reasonable token budget
    .map((it, i) => {
      const date = Number.isFinite(it.timestamp) && it.timestamp > 0
        ? new Date(it.timestamp).toISOString().slice(0, 10)
        : 'unknown';
      // Trim each item body so a single chatty email doesn't dominate
      // the budget. The full text is in the vault if the user wants
      // detail; for classification 600 chars per item is enough.
      const body = (it.body ?? '').slice(0, 600).replace(/\s+/g, ' ').trim();
      return `[${i + 1}] (${date}) ${body}`;
    })
    .join('\n');
  const vocabBlock = vocabulary.map((v) => `- ${v}`).join('\n');
  const categoryLine = category !== null ? `\nCategory: ${category}` : '';
  const draftBlock = draftFreeform
    ? [
        '',
        'Also draft a review the user can read and edit:',
        `- sentiment: one of ${SENTIMENT_OPTIONS.join(' / ')}, only if the vault leans clearly`,
        `- headline: one short sentence in first person (≤ ${HEADLINE_MAX_LENGTH} chars)`,
        `- body: 2–4 short sentences in first person (≤ ${BODY_MAX_LENGTH} chars)`,
        'Omit any draft field that would require invention. The user will fill it in.',
      ].join('\n')
    : '';
  return [
    `Subject: ${subjectName}${categoryLine}`,
    `Today: ${nowISO}`,
    '',
    'Use-case vocabulary (return only IDs from this list):',
    vocabBlock,
    '',
    'Last-used buckets (return one of these IDs, or omit):',
    VALID_BUCKETS.map((b) => `- ${b}`).join('\n'),
    draftBlock,
    '',
    `Vault items mentioning the subject (${items.length} total, first 20 shown):`,
    itemBlock || '(none)',
  ].join('\n');
}

// ─── Public API ────────────────────────────────────────────────────────

export interface InferComposeContextOptions {
  readonly llm: LLMProvider | null;
  readonly subjectName: string;
  readonly category: string | null;
  readonly items: readonly ComposeVaultItem[];
  readonly vocabulary: readonly string[];
  readonly nowMs: number;
  readonly signal?: AbortSignal;
  /**
   * Ask the LLM to also draft sentiment / headline / body, not just
   * the structured prefill chips. The chat-driven `/ask write a
   * review of <X>` flow sets this `true`; the form-prefill flow
   * leaves it `false` (default) so it stays a lean classification
   * call.
   */
  readonly draftFreeform?: boolean;
}

const EMPTY_RESULT: ComposeContextResult = { values: {}, sources: {} };

/**
 * Run the LLM-driven compose-context inference. Returns
 * `{values: {}, sources: {}}` on any of: no provider configured,
 * empty inputs, LLM error, malformed LLM response. Quiet failure —
 * the form just opens without prefill.
 */
export async function inferComposeContext(
  opts: InferComposeContextOptions,
): Promise<ComposeContextResult> {
  if (
    opts.llm === null ||
    opts.items.length === 0 ||
    opts.vocabulary.length === 0 ||
    opts.subjectName.trim().length === 0
  ) {
    return EMPTY_RESULT;
  }
  const draftFreeform = opts.draftFreeform === true;
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: buildUserPrompt({
        subjectName: opts.subjectName,
        category: opts.category,
        vocabulary: opts.vocabulary,
        items: opts.items,
        nowISO: new Date(opts.nowMs).toISOString(),
        draftFreeform,
      }),
    },
  ];
  const chatOpts: ChatOptions = {
    systemPrompt: draftFreeform ? SYSTEM_PROMPT_DRAFT : SYSTEM_PROMPT_PREFILL,
    responseSchema: (draftFreeform
      ? DRAFT_RESPONSE_SCHEMA
      : PREFILL_RESPONSE_SCHEMA) as unknown as Record<string, unknown>,
    // Slightly looser sampling when we're drafting prose; the
    // classification path stays at 0.1.
    temperature: draftFreeform ? 0.4 : 0.1,
    // Headline + body push the response well past the lean 256 cap.
    maxTokens: draftFreeform ? 1024 : 256,
  };
  if (opts.signal !== undefined) chatOpts.signal = opts.signal;

  let raw: string;
  try {
    const resp = await opts.llm.chat(messages, chatOpts);
    raw = resp.content;
  } catch {
    return EMPTY_RESULT;
  }

  const parsed = parseLLMResponse(raw);
  if (parsed === null) return EMPTY_RESULT;

  // Filter against the closed vocabulary — defense in depth.
  const useCasesFiltered = filterUseCases(parsed.use_cases, opts.vocabulary);
  const bucketFiltered = filterLastUsed(parsed.last_used_bucket);

  const values: {
    use_cases?: readonly string[];
    last_used_bucket?: LastUsedBucket;
    sentiment?: Sentiment;
    headline?: string;
    body?: string;
  } = {};
  const sources: ComposeSourceMeta = {};
  const sourcesMut = sources as {
    use_cases?: { vault_item_count: number };
    last_used_bucket?: { vault_item_count: number };
    sentiment?: { vault_item_count: number };
    headline?: { vault_item_count: number };
    body?: { vault_item_count: number };
  };
  if (useCasesFiltered.length > 0) {
    values.use_cases = useCasesFiltered;
    sourcesMut.use_cases = { vault_item_count: opts.items.length };
  }
  if (bucketFiltered !== null) {
    values.last_used_bucket = bucketFiltered;
    sourcesMut.last_used_bucket = { vault_item_count: opts.items.length };
  }
  if (draftFreeform) {
    const sentiment = filterSentiment(parsed.sentiment);
    if (sentiment !== null) {
      values.sentiment = sentiment;
      sourcesMut.sentiment = { vault_item_count: opts.items.length };
    }
    const headline = filterHeadline(parsed.headline);
    if (headline !== null) {
      values.headline = headline;
      sourcesMut.headline = { vault_item_count: opts.items.length };
    }
    const body = filterBody(parsed.body);
    if (body !== null) {
      values.body = body;
      sourcesMut.body = { vault_item_count: opts.items.length };
    }
  }
  return { values, sources };
}

// ─── Internal: LLM response parsing ────────────────────────────────────

interface LLMResponseShape {
  use_cases?: unknown;
  last_used_bucket?: unknown;
  sentiment?: unknown;
  headline?: unknown;
  body?: unknown;
}

/** Parse the LLM's content as JSON. Tolerant: accepts JSON with or
 *  without surrounding markdown fences; returns null on any error. */
function parseLLMResponse(raw: string): LLMResponseShape | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Strip ```json ... ``` fences if the model wrapped output.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced !== null ? (fenced[1] ?? '') : trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as LLMResponseShape;
  } catch {
    return null;
  }
}

function filterUseCases(
  raw: unknown,
  vocabulary: readonly string[],
): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<string>(vocabulary);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of raw) {
    if (typeof tag !== 'string') continue;
    if (!allowed.has(tag)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= 3) break;
  }
  return out;
}

function filterLastUsed(raw: unknown): LastUsedBucket | null {
  if (typeof raw !== 'string') return null;
  if ((VALID_BUCKETS as readonly string[]).includes(raw)) {
    return raw as LastUsedBucket;
  }
  return null;
}

function filterSentiment(raw: unknown): Sentiment | null {
  if (typeof raw !== 'string') return null;
  if ((SENTIMENT_OPTIONS as readonly string[]).includes(raw)) {
    return raw as Sentiment;
  }
  return null;
}

/**
 * Headline must be a non-empty trimmed string within the form's hard
 * cap. We DROP overlong headlines rather than truncate — a half-cut
 * sentence is worse UX than the user filling in a blank, and the
 * length cap is the only smell we can reliably detect for a malformed
 * draft (the model may exceed it occasionally on flash-lite).
 */
function filterHeadline(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > HEADLINE_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * Body is more permissive than headline: trim, drop if empty / over
 * the body cap. We keep newlines (the form's body input is multi-line)
 * but normalise three-or-more newlines down to two to keep the draft
 * tight.
 */
function filterBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length > BODY_MAX_LENGTH) return null;
  return collapsed;
}
