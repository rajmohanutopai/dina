/**
 * Chat-driven review draft — the `/ask write a review of <X>` flow.
 *
 * Pattern: user types `/ask write a review of Aeron chair` (or variants
 * — see `parseReviewDraftIntent`). Mobile pre-empts the agentic loop,
 * fans out across every open persona vault, runs the
 * `inferComposeContext` LLM call in `draftFreeform: true` mode, then
 * posts a `'review_draft'` lifecycle message into the chat thread.
 *
 * **Why mobile owns this, not Brain.** The BYOK LLM key + persona DEKs
 * live on the device; brain stays a pure thread-and-text orchestrator.
 * Posting the lifecycle through brain's `addLifecycleMessage` keeps the
 * thread state authoritative without leaking mobile concerns into
 * brain.
 *
 * **Loyalty Law.** The card never auto-publishes. The user reads it,
 * edits in place (sentiment / headline / body / draft details), and
 * taps Publish — same explicit gate as the form-driven review path.
 */

import { queryVault } from '@dina/core/src/vault/crud';
import { listPersonas, isPersonaOpen } from '@dina/core/src/persona/service';
import {
  addLifecycleMessage,
  updateReviewDraftLifecycle,
  type ReviewDraftLifecycle,
  type ReviewDraftStatus,
} from '@dina/brain/src/chat/thread';
import type { LLMProvider } from '@dina/brain/src/llm/adapters/provider';

import { loadActiveProvider } from '../ai/active_provider';
import { createLLMProvider } from '../ai/provider';
import {
  inferComposeContext,
  type ComposeContextResult,
  type ComposeVaultItem,
} from './compose_context';
import { detectSubjectType } from './subject_type_detect';
import {
  emptyWriteFormState,
  useCasesForCategory,
  type SubjectKind,
  type WriteFormState,
} from './write_form_data';

// ─── Intent parsing ────────────────────────────────────────────────────

/**
 * Match patterns the chat layer recognises as a review-draft intent.
 * Designed lenient — every variant the user is likely to type without
 * hand-holding. Captures the subject phrase in group 1.
 *
 * Examples that match:
 *   "/ask write a review of Aeron chair"
 *   "/ask draft a review of Aeron Chairs"
 *   "/ask publish a review of Aeron chair I bought"
 *   "/ask review the Aeron chair"
 *   "/ask create a review of Aeron"
 *   "write a review of Aeron"            (no /ask prefix)
 *
 * Examples that don't match (fall through to agentic /ask):
 *   "/ask what reviews exist for Aeron"
 *   "/ask is the Aeron chair worth it"
 *
 * The regex stays anchored at the start so ambiguous mid-sentence
 * patterns don't accidentally trigger.
 */
// Two patterns. The first covers verb-led phrasing
// ("write a review of X"); the second covers the bare "review (of) X"
// shorthand. Splitting them avoids a single mega-regex where the
// optional groups stack badly when the user types
// "review of the X" — the verb branch would otherwise consume "review"
// without consuming the trailing "of", leaving "of the X" in the
// capture.
const INTENT_REGEX_VERB =
  /^\s*(?:\/ask\s+)?(?:please\s+)?(?:write|draft|publish|create|compose|start)\s+(?:(?:a|the|an|my)\s+)?review(?:\s+(?:of|for|on|about))?\s+(.+?)\s*$/i;
const INTENT_REGEX_BARE =
  /^\s*(?:\/ask\s+)?(?:please\s+)?review\s+(?:(?:of|for|on|about)\s+)?(?:(?:a|the|an|my)\s+)?(.+?)\s*$/i;

const NON_INTENT_LEADERS = /^\s*(?:\/ask\s+)?(?:what|when|where|which|who|why|how|is|are|do|does|can|could|will|would|should|find|search|show|list|tell\s+me)\b/i;

export interface ReviewDraftIntent {
  /** True if the input looks like "write a review of <X>". */
  readonly matched: boolean;
  /** Subject phrase the user named, trimmed of leading articles + the
   *  noise-word "I bought" tail that doesn't belong in a SubjectRef. */
  readonly subjectPhrase: string;
}

/**
 * Decide whether `text` is asking for a review draft. Return `matched:
 * true` + the cleaned subject phrase when so. The chat caller routes to
 * the draft flow on a positive match and falls through to the regular
 * `handleChat` path otherwise.
 */
export function parseReviewDraftIntent(text: string): ReviewDraftIntent {
  if (typeof text !== 'string') return { matched: false, subjectPhrase: '' };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { matched: false, subjectPhrase: '' };
  // Question / search words rule out review intent — the regex below
  // would otherwise false-positive on "review the latest emails" by
  // matching the leading "review" verb against the noun "the latest
  // emails".
  if (NON_INTENT_LEADERS.test(trimmed)) {
    return { matched: false, subjectPhrase: '' };
  }
  // Require the literal word "review" somewhere in the input — the
  // verb pattern alone ("write" / "draft") would otherwise trigger on
  // "write a note about my chair", which isn't a review.
  if (!/\breview\b/i.test(trimmed)) {
    return { matched: false, subjectPhrase: '' };
  }
  const m = trimmed.match(INTENT_REGEX_VERB) ?? trimmed.match(INTENT_REGEX_BARE);
  if (m === null) return { matched: false, subjectPhrase: '' };
  let phrase = (m[1] ?? '').trim();
  // Strip the common conversational tail "I bought / I have / I use
  // for X". These are signals for the LLM about HOW the user used the
  // subject, but they do NOT belong in `subject.name` (which has to
  // round-trip through AppView's lexicon validators). The LLM still
  // sees the original text via the vault items, so dropping these
  // here doesn't lose information.
  phrase = phrase
    .replace(/\s+(?:i|that\s+i|which\s+i)\s+(?:bought|have|use|got|own|tried|purchased|installed).*$/i, '')
    .trim();
  if (phrase.length === 0) return { matched: false, subjectPhrase: '' };
  return { matched: true, subjectPhrase: phrase };
}

// ─── Subject construction ──────────────────────────────────────────────

/**
 * Map the cleaned subject phrase to the `WriteFormState.subject` shape
 * the inline card + form expect. Default `kind` is `'product'`
 * (the most common review subject); the type-detector overrides only
 * when a clear hint is present (URL, DID, etc.). The user can change
 * it inline later.
 */
function buildSubject(phrase: string): NonNullable<WriteFormState['subject']> {
  const detection = detectSubjectType(phrase);
  const kind: SubjectKind =
    detection !== null ? (detection.type as SubjectKind) : 'product';
  return {
    kind,
    name: phrase,
    did: '',
    uri: '',
    identifier: '',
  };
}

// ─── Vault search ──────────────────────────────────────────────────────

/**
 * Fan out `queryVault` across every currently-open persona, dedup
 * results by id, and return the items the inferer needs. Same shape +
 * crypto-wall semantics as `useComposeContext` — closed personas
 * silently contribute nothing.
 */
function searchVault(subjectName: string): ComposeVaultItem[] {
  const personas = listPersonas()
    .filter((p) => isPersonaOpen(p.name))
    .map((p) => p.name);
  const out: ComposeVaultItem[] = [];
  const seen = new Set<string>();
  for (const persona of personas) {
    let items: ReturnType<typeof queryVault>;
    try {
      items = queryVault(persona, {
        mode: 'fts5',
        text: subjectName,
        limit: 50,
      });
    } catch {
      continue; // locked / missing persona — skip silently
    }
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push({
        id: it.id,
        body: [it.content_l0, it.content_l1, it.summary, it.body]
          .filter((s): s is string => typeof s === 'string' && s.length > 0)
          .join(' '),
        timestamp: it.timestamp,
      });
    }
  }
  return out;
}

// ─── Public API ────────────────────────────────────────────────────────

export interface StartReviewDraftOptions {
  /** Already-parsed subject phrase from `parseReviewDraftIntent`. */
  readonly subjectPhrase: string;
  /** Chat thread the user typed in — the lifecycle card lands here. */
  readonly threadId: string;
  /** Test injection — production resolves the BYOK provider on its own. */
  readonly llmProvider?: LLMProvider | null;
  /** Test injection — production uses `Date.now()` for the inferer
   *  freshness window. */
  readonly nowMs?: number;
  /**
   * Test injection — overrides the random draft id so specs can
   * assert the lifecycle reference deterministically. Production omits.
   */
  readonly draftIdOverride?: string;
}

export interface StartReviewDraftResult {
  /** Stable id the inline card uses to patch its own message in
   *  place. Also returned to the caller for telemetry / tests. */
  readonly draftId: string;
}

/**
 * Kick off a review draft. Posts the initial `drafting` lifecycle card
 * synchronously, then runs the inferer in the background and patches
 * the card to `ready` (with the drafted values) or `failed` when the
 * call finishes. Returns the `draftId` so the caller can wait for the
 * card if it needs to (tests do).
 */
export async function startReviewDraft(
  opts: StartReviewDraftOptions,
): Promise<StartReviewDraftResult> {
  const draftId = opts.draftIdOverride ?? newDraftId();
  const subject = buildSubject(opts.subjectPhrase);
  // Initial card — `drafting` state, no values yet. The renderer
  // shows a typing-dots placeholder.
  const initialLifecycle: ReviewDraftLifecycle = {
    kind: 'review_draft',
    status: 'drafting',
    draftId,
    subject: subject as unknown as Record<string, unknown>,
    values: null,
  };
  addLifecycleMessage(opts.threadId, `Drafting a review of ${subject.name}…`, initialLifecycle);

  // Run the inferer in the background. We don't await it — the chat
  // input returns to idle immediately so the user keeps control.
  void runDraftAndPatch({
    threadId: opts.threadId,
    draftId,
    subject,
    llmProvider: opts.llmProvider,
    nowMs: opts.nowMs ?? Date.now(),
  });

  return { draftId };
}

interface RunDraftAndPatchOptions {
  readonly threadId: string;
  readonly draftId: string;
  readonly subject: NonNullable<WriteFormState['subject']>;
  readonly llmProvider?: LLMProvider | null;
  readonly nowMs: number;
}

async function runDraftAndPatch(opts: RunDraftAndPatchOptions): Promise<void> {
  const items = searchVault(opts.subject.name);
  const llm =
    opts.llmProvider !== undefined ? opts.llmProvider : await defaultProvider();
  let result: ComposeContextResult;
  try {
    result = await inferComposeContext({
      llm,
      subjectName: opts.subject.name,
      category: null,
      items,
      vocabulary: useCasesForCategory(null),
      nowMs: opts.nowMs,
      draftFreeform: true,
    });
  } catch {
    patchToFailed(opts.threadId, opts.draftId, 'Draft inference failed.');
    return;
  }
  const draftValues = mergeDraftIntoFormState(opts.subject, result);
  patchToReady(opts.threadId, opts.draftId, draftValues);
}

/**
 * Build a `WriteFormState` skeleton seeded with the LLM's drafted
 * fields. Anything the LLM omitted stays at the form's default — the
 * user fills it in (or accepts the blank). The card renders editable
 * inputs for sentiment / headline / body and a chip summary for the
 * additional details that came back from the same call.
 */
export function mergeDraftIntoFormState(
  subject: NonNullable<WriteFormState['subject']>,
  result: ComposeContextResult,
): WriteFormState {
  const base = emptyWriteFormState();
  const values = result.values;
  return {
    ...base,
    subject,
    sentiment: values.sentiment ?? base.sentiment,
    headline:
      typeof values.headline === 'string' && values.headline.length > 0
        ? values.headline
        : base.headline,
    body:
      typeof values.body === 'string' && values.body.length > 0
        ? values.body
        : base.body,
    useCases:
      values.use_cases !== undefined && values.use_cases.length > 0
        ? [...values.use_cases]
        : base.useCases,
    lastUsedBucket: values.last_used_bucket ?? base.lastUsedBucket,
  };
}

function patchToReady(
  threadId: string,
  draftId: string,
  values: WriteFormState,
): void {
  const subjectName = values.subject?.name ?? 'this subject';
  updateReviewDraftLifecycle(
    threadId,
    draftId,
    {
      status: 'ready',
      values: values as unknown as Record<string, unknown>,
    },
    `Drafted a review of ${subjectName}. Read it, edit if needed, then Publish.`,
  );
}

function patchToFailed(threadId: string, draftId: string, error: string): void {
  updateReviewDraftLifecycle(
    threadId,
    draftId,
    { status: 'failed', error },
    `Couldn’t draft a review yet. Try opening the form to start fresh.`,
  );
}

/**
 * Patch a draft card to a new status — used by the inline card when
 * the user taps Discard / starts publishing / publish completes.
 * Re-exposed here so the card doesn't need to import `@dina/brain`
 * directly (keeps the brain import surface small in the trust module).
 */
export function setReviewDraftStatus(
  threadId: string,
  draftId: string,
  status: ReviewDraftStatus,
  extras: {
    values?: WriteFormState;
    attestation?: { uri: string; cid: string };
    error?: string;
    content?: string;
  } = {},
): void {
  const patch: Partial<Omit<ReviewDraftLifecycle, 'kind' | 'draftId'>> = { status };
  if (extras.values !== undefined) {
    patch.values = extras.values as unknown as Record<string, unknown>;
  }
  if (extras.attestation !== undefined) {
    patch.attestation = extras.attestation;
  }
  if (extras.error !== undefined) {
    patch.error = extras.error;
  }
  updateReviewDraftLifecycle(threadId, draftId, patch, extras.content);
}

async function defaultProvider(): Promise<LLMProvider | null> {
  try {
    const active = await loadActiveProvider();
    if (active === null) return null;
    return await createLLMProvider(active, { tier: 'lite' });
  } catch {
    return null;
  }
}

function newDraftId(): string {
  // 12 hex chars — ample for a per-session card identity, short enough
  // to be readable in logs / sources arrays.
  const bytes = new Uint8Array(6);
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.getRandomValues === 'function'
  ) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Last-resort fallback for non-crypto runtimes (test envs that
    // mock out globalThis.crypto). Math.random is not security-grade
    // but a card identity has no security boundary.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
