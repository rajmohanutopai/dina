/**
 * `draft_review` tool — LLM-driven trigger for the inline review-draft
 * card flow. Replaces the earlier regex-based intent pre-empt
 * (`parseReviewDraftIntent`) with a tool the agentic loop's LLM picks
 * when the user asks to compose / publish / write a review of a
 * subject. No scenario enumeration, no English-only assumptions —
 * the LLM generalises from the description.
 *
 * **Why a tool, not a separate intent classifier output.** The
 * existing `IntentClassifier` emits substrate routing
 * (vault / trust_network / provider_services / general_knowledge),
 * not actions. Actions belong in the tool registry: the agent picks
 * which tool to call from the natural-language query, the same way
 * it picks `search_vault` vs `query_service` vs `geocode`. This is
 * the same shape main-Dina (`brain/src/service/intent_classifier.py`
 * + reasoning agent tools) uses.
 *
 * **Loyalty Law.** The tool starts a draft — it does not publish.
 * The user reads, edits, and publishes from the inline card via an
 * explicit Publish button. Brain stays orchestration-only; the actual
 * lifecycle card creation + LLM draft inference run in the host (the
 * mobile app today; any other surface that wires `setReviewDraftStarter`
 * tomorrow).
 *
 * **Brain doesn't import mobile types.** The host registers a
 * `ReviewDraftStarter` closure at boot. The tool reads it from the
 * module-global registry on every call. When no starter is wired
 * (e.g. server-side bot, demo stack without UI) the tool returns a
 * polite no-op so the agent can fall back to other strategies.
 */

import type { AgentTool } from './tool_registry';

/**
 * Closure the host wires to actually start the draft. Mobile binds this
 * to `startReviewDraft` (which queries the vault, runs the LLM
 * inferer, posts the lifecycle card into the chat thread). The
 * brain's tool execute() just calls into it.
 */
export type ReviewDraftStarter = (subjectPhrase: string) => Promise<{ draftId: string }>;

let activeStarter: ReviewDraftStarter | null = null;

/**
 * Wire the host's draft starter. Mobile calls this once at boot. Tests
 * call it before each spec and clear it afterwards. Multiple calls
 * replace the previous starter (last-writer-wins) — there's no
 * scenario where two hosts share a brain.
 */
export function setReviewDraftStarter(starter: ReviewDraftStarter | null): void {
  activeStarter = starter;
}

export function getReviewDraftStarter(): ReviewDraftStarter | null {
  return activeStarter;
}

const DRAFT_REVIEW_DESCRIPTION = [
  'Start a draft review of a subject the user wants to review.',
  'Use this when the user asks to write, draft, publish, or compose a review or opinion of a specific named subject (a product, place, organisation, content piece, etc.).',
  'Do NOT use this for queries that ask about EXISTING reviews ("what reviews exist for X", "what do people say about X") — those are search queries, not draft requests.',
  'The tool starts the draft only; it does NOT publish. The user reviews and publishes from an inline card.',
  'Pass the subject the user named, trimmed of conversational tails like "I bought" or "I have". The host inferer picks up vault context for the rest.',
].join(' ');

const DRAFT_REVIEW_PARAMETERS = {
  type: 'object',
  properties: {
    subject_phrase: {
      type: 'string',
      description:
        "The subject the user wants to review — e.g. 'Aeron chair', 'The Bear restaurant on 5th', 'iPhone 17 Pro'. Trim leading articles and conversational tails.",
    },
  },
  required: ['subject_phrase'],
} as const;

export interface DraftReviewToolResult {
  ok: boolean;
  draftId?: string;
  reason?: string;
  message?: string;
}

/**
 * Build the `draft_review` tool. The factory takes no dependencies —
 * the starter is read from the module-global registry on every
 * `execute()` so a host that registers / clears at boundaries (tests,
 * multi-tenant servers) sees the right closure.
 */
export function createDraftReviewTool(): AgentTool {
  return {
    name: 'draft_review',
    description: DRAFT_REVIEW_DESCRIPTION,
    parameters: DRAFT_REVIEW_PARAMETERS as unknown as Record<string, unknown>,
    async execute(args: Record<string, unknown>): Promise<DraftReviewToolResult> {
      const phrase = typeof args.subject_phrase === 'string' ? args.subject_phrase.trim() : '';
      if (phrase.length === 0) {
        return { ok: false, reason: 'subject_phrase is required and must be non-empty' };
      }
      const starter = getReviewDraftStarter();
      if (starter === null) {
        // Host hasn't wired the starter (server-side bot, headless
        // demo). Fail soft — the agent can fall back to suggesting
        // the user open the form manually.
        return {
          ok: false,
          reason: 'review-draft starter is not wired in this host',
        };
      }
      try {
        const result = await starter(phrase);
        return {
          ok: true,
          draftId: result.draftId,
          message:
            `Drafted a review of "${phrase}" in the chat as an editable card. ` +
            'Tell the user briefly that the draft is ready for them to read and publish — do not repeat the draft contents in your reply (they are visible in the card).',
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'starter threw';
        return { ok: false, reason };
      }
    },
  };
}
