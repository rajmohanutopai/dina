/**
 * Chat-driven review draft runner — used by the agentic `/ask` loop's
 * `draft_review` tool (registered in
 * `packages/brain/src/reasoning/draft_review_tool.ts`).
 *
 * The agent's LLM picks the tool when the user asks to write / draft /
 * publish a review of a subject. The tool calls `startReviewDraft`
 * (mobile, this module) which:
 *
 *   1. Posts a `'review_draft'` lifecycle card into the chat thread at
 *      `'drafting'` status — synchronous, so the user sees an
 *      acknowledgement immediately.
 *   2. Fans out across every currently-open persona vault, runs the
 *      `inferComposeContext` LLM call in `draftFreeform: true` mode,
 *      and patches the lifecycle to `'ready'` with the drafted
 *      sentiment / headline / body when the call settles.
 *
 * **Why mobile owns the runner, not Brain.** The BYOK LLM key +
 * persona DEKs live on the device; brain stays a thread-and-text
 * orchestrator + tool registry. Brain's tool factory is a thin
 * wrapper that calls into this runner via `setReviewDraftStarter`
 * (registered at mobile boot in `boot_capabilities.ts`).
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

// Intent detection used to live here as a regex pair. It was deleted
// once the agentic `/ask` loop's `draft_review` tool took over —
// the LLM picks the tool from the user's natural-language query,
// no scenario enumeration / hand-coded "if X do Y" rules. See
// `packages/brain/src/reasoning/draft_review_tool.ts`.

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
