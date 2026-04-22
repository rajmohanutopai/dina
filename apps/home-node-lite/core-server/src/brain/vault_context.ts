/**
 * Vault-context assembler (GAP.md row #30 closure — M1 blocker).
 *
 * When Brain receives an `/api/v1/reason` request it must hand the
 * LLM a context package: the query, the persona, relevant recent
 * vault items, the active working-memory ToC, relevant contacts,
 * and a few structured hints (tier, silence-first priority, subject).
 *
 * This primitive is the PURE assembler: inputs are already-fetched
 * data, output is a deterministic structured object. No IO, no
 * LLM call — tests exercise it without mocking CoreClient.
 *
 * **Why a dedicated primitive**: the reason-handler orchestrator
 * (task 5.15) is an IO layer. Context assembly — what to include,
 * in what order, what to truncate — is policy. Splitting them
 * means the policy is testable offline + swappable without
 * touching the handler.
 *
 * **Budget management**: the LLM prompt has a token ceiling.
 * `assembleVaultContext` enforces it with a `maxChars` budget
 * (chars as a cheap approximation for tokens). Priority order when
 * cutting:
 *
 *   1. Query + persona headers — always included.
 *   2. Active working-memory ToC entries — capped at `topicLimit`.
 *   3. Subject attribution — single line.
 *   4. Contacts mentioned — top-N by relevance.
 *   5. Recent vault items — the largest block; most truncation
 *      happens here. Trimmed oldest-first until total fits budget.
 *   6. Content sensitivity tier — one line appended.
 *
 * **Output shape**: `{sections: ContextSection[], meta}` where each
 * section has a header + body. The handler composes sections into
 * the final prompt string (or hands them to a template engine).
 *
 * **Non-goals**: this module does NOT call vault search or the LLM
 * or a contact resolver. Upstream handlers gather data; this
 * primitive composes.
 *
 * Source: GAP.md (task 5.46 follow-up) — M1 memory-flows gate.
 */

import type { Topic } from './topic_extractor';
import type { Subject } from './subject_attributor';
import type { Tier } from './tier_classifier';

export interface VaultContextItem {
  /** Stable id — echoed back so the LLM can cite sources. */
  id: string;
  /** Short summary the assembler renders. */
  summary: string;
  /** Optional body — trimmed per `maxItemBodyChars`. */
  body?: string;
  /** Unix seconds. */
  timestamp: number;
  /** Free-form type tag from VaultItem. */
  type: string;
  /** Free-form source tag. */
  source: string;
}

export interface VaultContextContact {
  /** Stable contact id. */
  id: string;
  /** Display name rendered in the context. */
  name: string;
  /** Optional relationship label — "manager", "spouse", etc. */
  relation?: string;
  /** Short summary of why this contact is relevant. */
  note?: string;
}

export interface AssembleVaultContextInput {
  /** Persona the query runs under. */
  persona: string;
  /** The user's query verbatim. */
  query: string;
  /** Recent vault items (already searched / ranked by caller). */
  recentItems?: ReadonlyArray<VaultContextItem>;
  /** Active ToC topics (already decayed / ranked). */
  topics?: ReadonlyArray<Pick<Topic, 'label' | 'salience'>>;
  /** Contacts relevant to the query. */
  contacts?: ReadonlyArray<VaultContextContact>;
  /** Subject attribution if already computed. */
  subject?: Subject;
  /** Content tier if already computed. */
  tier?: Tier;
}

export interface AssembleVaultContextOptions {
  /** Hard char budget for the whole assembled context. Default 4000. */
  maxChars?: number;
  /** Max topics to render. Default 8. */
  topicLimit?: number;
  /** Max contacts to render. Default 5. */
  contactLimit?: number;
  /** Max recent items to render (pre-truncation). Default 10. */
  itemLimit?: number;
  /** Max chars per vault item body. Default 400. */
  maxItemBodyChars?: number;
}

export interface ContextSection {
  /** Stable label used for debugging + template routing. */
  kind:
    | 'persona'
    | 'query'
    | 'subject'
    | 'tier'
    | 'topics'
    | 'contacts'
    | 'recent_items';
  /** Human-readable heading (e.g. "Recent items"). */
  heading: string;
  /** Rendered body; empty string when the section has no content. */
  body: string;
  /** Char count — sum pinned in meta. */
  chars: number;
}

export interface AssembledContext {
  sections: ContextSection[];
  meta: {
    /** Persona name echoed for downstream routing. */
    persona: string;
    /** Subject attribution echoed. */
    subject: Subject | undefined;
    /** Tier echoed (callers gate cloud LLM on it). */
    tier: Tier | undefined;
    /** Total char count across all sections. */
    totalChars: number;
    /** Number of recent items actually included (pre-truncation). */
    itemsIncluded: number;
    /** Number of recent items dropped due to budget. */
    itemsDropped: number;
    /** True when the budget was hit + content dropped. */
    truncated: boolean;
  };
}

export const DEFAULT_MAX_CHARS = 4000;
export const DEFAULT_TOPIC_LIMIT = 8;
export const DEFAULT_CONTACT_LIMIT = 5;
export const DEFAULT_ITEM_LIMIT = 10;
export const DEFAULT_MAX_ITEM_BODY_CHARS = 400;

/**
 * Assemble a prompt-context package. Deterministic: same input →
 * same output. No randomness, no clock reads, no IO.
 */
export function assembleVaultContext(
  input: AssembleVaultContextInput,
  opts: AssembleVaultContextOptions = {},
): AssembledContext {
  validateInput(input);
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const topicLimit = opts.topicLimit ?? DEFAULT_TOPIC_LIMIT;
  const contactLimit = opts.contactLimit ?? DEFAULT_CONTACT_LIMIT;
  const itemLimit = opts.itemLimit ?? DEFAULT_ITEM_LIMIT;
  const maxItemBodyChars = opts.maxItemBodyChars ?? DEFAULT_MAX_ITEM_BODY_CHARS;

  const sections: ContextSection[] = [];

  // Always-included header sections — never dropped.
  sections.push(makeSection('persona', 'Active persona', input.persona.trim()));
  sections.push(makeSection('query', 'User query', input.query.trim()));

  if (input.subject) {
    sections.push(
      makeSection('subject', 'Subject', renderSubject(input.subject)),
    );
  }

  if (input.tier) {
    sections.push(makeSection('tier', 'Content tier', input.tier));
  }

  if (input.topics && input.topics.length > 0) {
    const rendered = renderTopics(input.topics, topicLimit);
    if (rendered !== '') {
      sections.push(makeSection('topics', 'Active topics', rendered));
    }
  }

  if (input.contacts && input.contacts.length > 0) {
    const rendered = renderContacts(input.contacts, contactLimit);
    if (rendered !== '') {
      sections.push(makeSection('contacts', 'Contacts', rendered));
    }
  }

  // Recent items section is the main budget consumer.
  const rawItems = (input.recentItems ?? []).slice(0, itemLimit);
  const itemsSection = makeSection(
    'recent_items',
    'Recent items',
    rawItems.map((i) => renderItem(i, maxItemBodyChars)).join('\n\n'),
  );
  const { fittingItems, fittingBody } = fitItemsToBudget(
    rawItems,
    maxItemBodyChars,
    sumChars(sections),
    maxChars,
  );
  itemsSection.body = fittingBody;
  itemsSection.chars = fittingBody.length;
  sections.push(itemsSection);

  const totalChars = sumChars(sections);
  return {
    sections,
    meta: {
      persona: input.persona,
      subject: input.subject,
      tier: input.tier,
      totalChars,
      itemsIncluded: fittingItems,
      itemsDropped: rawItems.length - fittingItems,
      truncated: rawItems.length > fittingItems,
    },
  };
}

/**
 * Render an assembled context into a single prompt string — the
 * canonical format an LLM adapter consumes. Pure string concatenation;
 * callers that want a different format inspect `sections` directly.
 */
export function renderContextAsPrompt(ctx: AssembledContext): string {
  return ctx.sections
    .filter((s) => s.body !== '')
    .map((s) => `## ${s.heading}\n${s.body}`)
    .join('\n\n');
}

// ── Internals ──────────────────────────────────────────────────────────

function validateInput(input: AssembleVaultContextInput): void {
  if (typeof input !== 'object' || input === null) {
    throw new TypeError('assembleVaultContext: input is required');
  }
  if (typeof input.persona !== 'string' || input.persona.trim() === '') {
    throw new TypeError('assembleVaultContext: persona must be non-empty string');
  }
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    throw new TypeError('assembleVaultContext: query must be non-empty string');
  }
}

function makeSection(
  kind: ContextSection['kind'],
  heading: string,
  body: string,
): ContextSection {
  return { kind, heading, body, chars: body.length };
}

function renderSubject(subject: Subject): string {
  switch (subject.kind) {
    case 'self':     return 'self (the user)';
    case 'group':    return 'group (family/team)';
    case 'unknown':  return 'unknown';
    case 'contact':  return `contact:${subject.contactId}`;
  }
}

function renderTopics(
  topics: ReadonlyArray<Pick<Topic, 'label' | 'salience'>>,
  limit: number,
): string {
  const sorted = [...topics]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, limit);
  return sorted
    .map((t) => `- ${t.label} (${t.salience.toFixed(2)})`)
    .join('\n');
}

function renderContacts(
  contacts: ReadonlyArray<VaultContextContact>,
  limit: number,
): string {
  return contacts
    .slice(0, limit)
    .map((c) => {
      const rel = c.relation ? ` (${c.relation})` : '';
      const note = c.note ? ` — ${c.note}` : '';
      return `- ${c.name}${rel}${note}`;
    })
    .join('\n');
}

function renderItem(
  item: VaultContextItem,
  maxBodyChars: number,
): string {
  const header = `[${item.id}] ${item.type}/${item.source} · ${isoDate(item.timestamp)}`;
  const summary = item.summary.trim();
  const body = item.body
    ? truncate(item.body.trim(), maxBodyChars)
    : '';
  return [header, summary, body].filter((s) => s !== '').join('\n');
}

function isoDate(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return 'unknown-time';
  return new Date(unixSeconds * 1000).toISOString();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

function sumChars(sections: ReadonlyArray<ContextSection>): number {
  let sum = 0;
  for (const s of sections) sum += s.chars;
  return sum;
}

/**
 * Fit as many items as possible into `maxChars - headerChars`.
 * Items are included in order; dropping starts from the tail.
 */
function fitItemsToBudget(
  items: ReadonlyArray<VaultContextItem>,
  maxBodyChars: number,
  headerChars: number,
  maxChars: number,
): { fittingItems: number; fittingBody: string } {
  const budget = Math.max(0, maxChars - headerChars);
  const rendered = items.map((i) => renderItem(i, maxBodyChars));
  const separator = '\n\n';
  let total = 0;
  const included: string[] = [];
  for (const block of rendered) {
    const add = (included.length === 0 ? 0 : separator.length) + block.length;
    if (total + add > budget) break;
    total += add;
    included.push(block);
  }
  return {
    fittingItems: included.length,
    fittingBody: included.join(separator),
  };
}
