/**
 * Task 5.37 — tiered content enrichment.
 *
 * Generates L0 / L1 summaries for vault items before publication:
 *
 *   **L0** (one line) — "what it is, who from, when". Deterministic
 *     from metadata whenever possible; falls back to a LLM prompt
 *     when metadata is sparse.
 *   **L1** (one paragraph) — key facts, names, dates, numbers.
 *     Preserves provenance. Always LLM-generated.
 *   **L2** — the original content (already stored as `bodyText`).
 *
 * **Embedding**: regenerated from `L1` when enrichment completes.
 * L1 is a cleaner embedding anchor than raw L2 — L2 contains
 * boilerplate (signatures, headers, footer promotion) that noise
 * the embedding space.
 *
 * **Why not just use the LLM to do both L0 + L1 in one call**:
 *   - L0 for a "Calendar invite from Alice for 3pm Friday" case is
 *     100% mechanical — date + sender + type. Spending an LLM call
 *     on it is wasteful + introduces non-determinism.
 *   - For items where metadata is weak (raw paste, note body), the
 *     LLM produces both L0 + L1 in one call with the full prompt.
 *
 * **Pure primitive** with injected IO:
 *   - `llmCallFn` — summarisation call.
 *   - `embedFn` — embedding generator.
 *   - `scrubFn` — optional PII scrubber applied before sending to
 *     cloud LLM. Matches the Python reference's `entity_vault`
 *     integration: the scrubbed text feeds the prompt; the vault
 *     stores the ORIGINAL unscrubbed data.
 *
 * **Never throws** — every failure path returns a rejection reason.
 * Callers treat enrichment as best-effort: a failure leaves the
 * item in staging, next sweep retries.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 5e task 5.37.
 */

export const ENRICHMENT_PROMPT_VERSION = 1;

export interface EnrichmentItem {
  /** Item id (e.g. staging or vault id). Propagated to the result for tracing. */
  id?: string;
  /** Raw body text (L2 equivalent). Primary LLM input when non-empty. */
  bodyText?: string;
  /** Short caller-supplied summary, used when `bodyText` is empty. */
  summary?: string;
  /** Sender (email address, contact did, …). Shown in L0. */
  sender?: string;
  /** "verified" | "unverified" | "" — may downgrade L1 rigour. */
  senderTrust?: string;
  /** "high" | "medium" | "low" | "" — surfaced in L0 when low. */
  confidence?: string;
  /** Item type (email, note, calendar_event, …). Drives L0 prefix. */
  type?: string;
  /** Source name (gmail, d2d, …). NOT PII; passed through untouched. */
  source?: string;
  /** Unix-seconds timestamp of capture. 0 = unknown. */
  timestamp?: number;
}

export interface EnrichedItem {
  contentL0: string;
  contentL1: string;
  embedding: number[];
  enrichmentStatus: 'complete';
  enrichmentVersion: number;
}

export type EnrichmentOutcome =
  | { ok: true; enriched: EnrichedItem }
  | { ok: false; reason: 'no_input' }
  | { ok: false; reason: 'scrub_failed'; error: string }
  | { ok: false; reason: 'llm_failed'; error: string }
  | { ok: false; reason: 'llm_empty' }
  | { ok: false; reason: 'embed_failed'; error: string };

/** LLM call: takes the enrichment prompt + returns a string. */
export type EnrichmentLlmFn = (prompt: string) => Promise<{ content: string }>;

/** Embedding generator: text → float vector. */
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * Optional PII scrubber. Returns the scrubbed form safe to send to
 * a cloud LLM. Throws on scrub failure (fail-closed).
 */
export type ScrubFn = (text: string) => Promise<string>;

export interface EnrichmentOptions {
  llmCallFn: EnrichmentLlmFn;
  embedFn: EmbedFn;
  /** Optional — when present, body + summary + sender are scrubbed pre-LLM. */
  scrubFn?: ScrubFn;
  /** Diagnostic hook. */
  onEvent?: (event: EnrichmentEvent) => void;
}

export type EnrichmentFailureReason =
  | 'no_input'
  | 'scrub_failed'
  | 'llm_failed'
  | 'llm_empty'
  | 'embed_failed';

export type EnrichmentEvent =
  | { kind: 'l0_deterministic'; id: string }
  | { kind: 'l1_generated'; id: string; chars: number }
  | { kind: 'embedded'; id: string; dims: number }
  | { kind: 'failed'; id: string; reason: EnrichmentFailureReason };

/** Month names for the L0 date prefix. */
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export class EnrichmentService {
  private readonly llmCallFn: EnrichmentLlmFn;
  private readonly embedFn: EmbedFn;
  private readonly scrubFn?: ScrubFn;
  private readonly onEvent?: (event: EnrichmentEvent) => void;

  constructor(opts: EnrichmentOptions) {
    if (typeof opts.llmCallFn !== 'function') {
      throw new TypeError('EnrichmentService: llmCallFn is required');
    }
    if (typeof opts.embedFn !== 'function') {
      throw new TypeError('EnrichmentService: embedFn is required');
    }
    this.llmCallFn = opts.llmCallFn;
    this.embedFn = opts.embedFn;
    if (opts.scrubFn) this.scrubFn = opts.scrubFn;
    this.onEvent = opts.onEvent;
  }

  /**
   * Enrich `item` in-memory. Returns a structured outcome; never
   * throws. On success, the caller wires `enriched` back into the
   * staging record + commits to the vault.
   */
  async enrich(item: EnrichmentItem): Promise<EnrichmentOutcome> {
    const itemId = item.id ?? '';
    const body = typeof item.bodyText === 'string' ? item.bodyText : '';
    const summary = typeof item.summary === 'string' ? item.summary : '';
    if (body.trim() === '' && summary.trim() === '') {
      this.onEvent?.({ kind: 'failed', id: itemId, reason: 'no_input' });
      return { ok: false, reason: 'no_input' };
    }

    // L0: deterministic first.
    const l0 = generateL0Deterministic(item);
    this.onEvent?.({ kind: 'l0_deterministic', id: itemId });

    // L1 via LLM. Scrub PII fields before sending.
    let scrubbedBody = body;
    let scrubbedSummary = summary;
    let scrubbedSender =
      typeof item.sender === 'string' ? item.sender : '';
    if (this.scrubFn) {
      try {
        // Parallel scrub for minimum latency — inputs are independent.
        const [sb, ss, sd] = await Promise.all([
          body.length > 0 ? this.scrubFn(body) : Promise.resolve(body),
          summary.length > 0 ? this.scrubFn(summary) : Promise.resolve(summary),
          scrubbedSender.length > 0
            ? this.scrubFn(scrubbedSender)
            : Promise.resolve(scrubbedSender),
        ]);
        scrubbedBody = sb;
        scrubbedSummary = ss;
        scrubbedSender = sd;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.onEvent?.({ kind: 'failed', id: itemId, reason: 'scrub_failed' });
        return { ok: false, reason: 'scrub_failed', error: msg };
      }
    }
    const llmInput = scrubbedBody || scrubbedSummary;
    const prompt = buildPrompt(llmInput, scrubbedSummary, scrubbedSender, item);
    let rawContent: string;
    try {
      const resp = await this.llmCallFn(prompt);
      rawContent = typeof resp?.content === 'string' ? resp.content : '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'failed', id: itemId, reason: 'llm_failed' });
      return { ok: false, reason: 'llm_failed', error: msg };
    }
    const contentL1 = rawContent.trim();
    if (contentL1 === '') {
      this.onEvent?.({ kind: 'failed', id: itemId, reason: 'llm_empty' });
      return { ok: false, reason: 'llm_empty' };
    }
    this.onEvent?.({ kind: 'l1_generated', id: itemId, chars: contentL1.length });

    // Embedding from L1 (NOT from raw L2 — L1 is the clean anchor).
    let embedding: number[];
    try {
      embedding = await this.embedFn(contentL1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.onEvent?.({ kind: 'failed', id: itemId, reason: 'embed_failed' });
      return { ok: false, reason: 'embed_failed', error: msg };
    }
    if (!Array.isArray(embedding) || embedding.length === 0) {
      this.onEvent?.({ kind: 'failed', id: itemId, reason: 'embed_failed' });
      return { ok: false, reason: 'embed_failed', error: 'empty vector' };
    }
    this.onEvent?.({ kind: 'embedded', id: itemId, dims: embedding.length });

    return {
      ok: true,
      enriched: {
        contentL0: l0,
        contentL1,
        embedding,
        enrichmentStatus: 'complete',
        enrichmentVersion: ENRICHMENT_PROMPT_VERSION,
      },
    };
  }
}

// ── Internals ──────────────────────────────────────────────────────────

/**
 * Deterministic L0: "<Type> · from <sender> · <date>[ · low-confidence]".
 * Omits missing fields gracefully rather than emitting placeholders.
 * Exposed for tests so they can pin the contract without an LLM.
 */
export function generateL0Deterministic(item: EnrichmentItem): string {
  const parts: string[] = [];

  const typeWord = humanType(item.type);
  if (typeWord !== '') parts.push(typeWord);

  const sender = typeof item.sender === 'string' ? item.sender.trim() : '';
  if (sender !== '') parts.push(`from ${sender}`);

  const date = formatDate(item.timestamp);
  if (date !== '') parts.push(date);

  const trust =
    typeof item.senderTrust === 'string' ? item.senderTrust.trim() : '';
  const conf = typeof item.confidence === 'string' ? item.confidence.trim() : '';
  if (conf === 'low') parts.push('low confidence');
  if (trust === 'unverified') parts.push('unverified sender');

  // When metadata is completely absent, fall back to the summary.
  if (parts.length === 0) {
    const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
    return summary !== '' ? summary.slice(0, 200) : '(no summary available)';
  }

  return parts.join(' · ');
}

function humanType(type: string | undefined): string {
  if (typeof type !== 'string' || type.trim() === '') return '';
  // Replace underscores + title-case first letter.
  const clean = type.replace(/_/g, ' ').trim();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function formatDate(tsSeconds: number | undefined): string {
  if (
    typeof tsSeconds !== 'number' ||
    !Number.isFinite(tsSeconds) ||
    tsSeconds <= 0
  ) {
    return '';
  }
  const d = new Date(tsSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '';
  // "Mar 21, 2026"
  const m = MONTHS_SHORT[d.getUTCMonth()];
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  return `${m} ${day}, ${y}`;
}

/**
 * Build the enrichment prompt. Emits a simple, deterministic
 * template — production can replace with the full prompt from
 * `@dina/prompts` when those land.
 */
function buildPrompt(
  llmInput: string,
  summary: string,
  sender: string,
  item: EnrichmentItem,
): string {
  const lines: string[] = [
    'Summarise the following content into a single paragraph (L1).',
    'Preserve names, dates, numbers, and explicit commitments. Do NOT',
    'add facts that are not in the input. Keep under 400 characters.',
    '',
  ];
  if (sender !== '') lines.push(`Sender: ${sender}`);
  if (item.source) lines.push(`Source: ${item.source}`);
  if (summary !== '') lines.push(`Short summary: ${summary}`);
  lines.push('');
  lines.push('Content:');
  lines.push(llmInput);
  lines.push('');
  lines.push('L1:');
  return lines.join('\n');
}
