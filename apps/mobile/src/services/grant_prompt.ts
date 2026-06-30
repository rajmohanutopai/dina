/**
 * Contact Services `ask_to_enable` prompt — persistence + idempotency helpers.
 *
 * The prompt card is a one-time "Allow <contact> to use your <service>?" gate
 * (spec §5.2). It must survive an app restart correctly:
 *
 *   - IDEMPOTENT POST. The de-dup key is `(requesterDID, capability)`. Before
 *     posting we scan the contact's thread for an existing prompt for that key
 *     (in ANY state — pending OR terminal). If one exists we skip, so a
 *     restart (which resets any in-memory Set) + the requester's normal
 *     `service.grant_request` retry never STACKS a second card next to the
 *     rehydrated one.
 *   - PERSISTED RESOLUTION. "Not now" / "Allow" patch the card's lifecycle to a
 *     TERMINAL `status` (`dismissed` / `allowed`) and persist it (the thread
 *     store's `updateMessageMetadataById` writes through to disk). So a
 *     declined `(requester, capability)` rehydrates RESOLVED — the owner is not
 *     re-prompted for something they already declined, and the idempotency
 *     scan treats it as handled.
 *
 * Invariants kept: the lifecycle carries ONLY the transport-authenticated
 * `requesterDID` + the LOCALLY-resolved `rkey` + `capability` (no wire DIDs —
 * §10), and "Not now" makes NO backend call (§2 no-leak). Issuing the grant on
 * "Allow" is the card's job via `allowGrantRequest`; this module only owns the
 * chat-thread lifecycle.
 */

import {
  addMessage,
  getThread,
  hydrateThread,
  updateMessageMetadataById,
  type ChatMessage,
} from '@dina/brain/chat';

import { recordPromptShown } from './grant_decision_log';

/** Terminal/active states of a grant-request prompt card. */
export type GrantPromptStatus = 'pending' | 'allowed' | 'dismissed';

/** The raw-metadata lifecycle a grant-request prompt carries (mobile-only —
 *  not part of brain's typed `MessageLifecycle` union, like `quarantine_request`). */
export interface GrantRequestPromptLifecycle {
  kind: 'grant_request_prompt';
  requesterDID: string;
  capability: string;
  rkey: string;
  /** Absent on legacy rows ⇒ treated as `pending`. */
  status?: GrantPromptStatus;
}

/**
 * Validate + read the grant-prompt lifecycle off a chat message. Returns null
 * for any message that isn't a well-formed prompt (malformed rows fall through
 * to a plain bubble rather than rendering an empty card).
 */
export function readGrantPromptLifecycle(m: ChatMessage): GrantRequestPromptLifecycle | null {
  const lc = m.metadata?.lifecycle as
    | { kind?: unknown; requesterDID?: unknown; capability?: unknown; rkey?: unknown; status?: unknown }
    | undefined;
  if (!lc || lc.kind !== 'grant_request_prompt') return null;
  if (typeof lc.requesterDID !== 'string' || lc.requesterDID.length === 0) return null;
  if (typeof lc.capability !== 'string' || lc.capability.length === 0) return null;
  if (typeof lc.rkey !== 'string' || lc.rkey.length === 0) return null;
  const status =
    lc.status === 'allowed' || lc.status === 'dismissed' || lc.status === 'pending'
      ? lc.status
      : 'pending';
  return {
    kind: 'grant_request_prompt',
    requesterDID: lc.requesterDID,
    capability: lc.capability,
    rkey: lc.rkey,
    status,
  };
}

/**
 * Find the existing grant-prompt card for `(requesterDID, capability[, rkey])` in
 * the contact's thread, regardless of state. Returns null when none exists. The
 * thread is keyed by the requester DID (the Talk thread with that contact).
 *
 * When `rkey` is given it is part of the match key: a prompt for a DIFFERENT
 * listing (rkey) of the same capability does NOT count as a duplicate, so an old
 * terminal prompt for one talk listing can't suppress a fresh prompt for a newly
 * bound one. Omitting `rkey` keeps the looser (requester, capability) match for
 * callers that only need "any prompt for this capability".
 */
export function findGrantPrompt(
  requesterDID: string,
  capability: string,
  rkey?: string,
): ChatMessage | null {
  for (const msg of getThread(requesterDID)) {
    const lc = readGrantPromptLifecycle(msg);
    if (
      lc !== null &&
      lc.requesterDID === requesterDID &&
      lc.capability === capability &&
      (rkey === undefined || lc.rkey === rkey)
    ) {
      return msg;
    }
  }
  return null;
}

/**
 * Post the prompt card ONCE per `(requesterDID, capability)`. Idempotent across
 * restarts: HYDRATES the contact's thread from the repo first (peer threads
 * hydrate lazily — a `service.grant_request` retry that arrives before the peer
 * chat is opened would otherwise scan an EMPTY in-memory thread, miss the
 * persisted prompt, and STACK a duplicate even though a dismissed/allowed card
 * exists on disk), then scans and skips if any prompt for that key already
 * exists (pending or terminal). Returns the posted message, the EXISTING one
 * when skipped, or null on a degenerate input.
 *
 * Async because hydration is async; the boot subscriber fires it
 * fire-and-forget (it's a UI fan-out, not on the receive hot path).
 */
export async function postGrantPromptOnce(
  requesterDID: string,
  capability: string,
  rkey: string,
  closeness = 'unknown',
): Promise<ChatMessage | null> {
  if (requesterDID === '' || capability === '' || rkey === '') return null;
  // Hydration race fix (P2-4): pull the persisted thread in before the scan so
  // a prior (possibly terminal) prompt is visible even when the peer chat was
  // never opened this session. Best-effort: a no-op without a repo, a merge
  // otherwise (never clobbers live entries).
  try {
    await hydrateThread(requesterDID);
  } catch {
    /* fall through to the in-memory scan */
  }
  // Dedupe on (requester, capability, rkey): a retry for the SAME listing reuses
  // the card, but a different talk listing (rkey) for the same capability is a
  // distinct prompt and must not be suppressed by an old terminal one.
  const existing = findGrantPrompt(requesterDID, capability, rkey);
  if (existing !== null) return existing;
  const lifecycle: GrantRequestPromptLifecycle = {
    kind: 'grant_request_prompt',
    requesterDID,
    capability,
    rkey,
    status: 'pending',
  };
  const posted = addMessage(
    requesterDID,
    'dina',
    `A contact asked to use your ${capability} service.`,
    {
      metadata: {
        source: 'd2d',
        senderDID: requesterDID,
        lifecycle: lifecycle as unknown as Record<string, unknown>,
      },
    },
  );
  // Owner-private log: a `prompt_shown` row is written ONLY here — when the card
  // has been POSTED into the thread (and exactly once, since the idempotency scan
  // above returns early for a retry). This is far more honest than Core's old
  // optimistic write (Core only DECIDED to ask). Note the chat layer persists the
  // message fire-and-forget, so "posted" means "added to the live thread + a
  // write enqueued" — not a confirmed durable write; the log is advisory.
  recordPromptShown(requesterDID, capability, closeness);
  return posted;
}

/**
 * Patch a prompt card to a TERMINAL state + persist it. The card rehydrates
 * resolved after a restart and the idempotency scan treats it as handled.
 * `messageId` is the card's id (the card knows its own row). Returns the
 * patched message or null when the row is gone / not a prompt.
 */
export function resolveGrantPrompt(
  requesterDID: string,
  messageId: string,
  status: 'allowed' | 'dismissed',
): ChatMessage | null {
  const thread = getThread(requesterDID);
  const old = thread.find((m) => m.id === messageId);
  if (old === undefined) return null;
  const lc = readGrantPromptLifecycle(old);
  if (lc === null) return null;
  const nextLifecycle: GrantRequestPromptLifecycle = { ...lc, status };
  return updateMessageMetadataById(requesterDID, messageId, {
    lifecycle: nextLifecycle as unknown as Record<string, unknown>,
  });
}
