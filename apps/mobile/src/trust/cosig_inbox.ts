/**
 * Cosig inbox row data layer (TN-MOB-040).
 *
 * Per plan §10:
 *
 *   > An inbound `trust.cosig.request` lands in the unified inbox
 *   > (`apps/mobile/app/notifications.tsx`) as `kind: 'approval'`
 *   > with `subKind: 'trust_cosig'`. Title:
 *   > `"Sancho asked you to co-sign their review"`. Tap deep-links to
 *   > the source attestation in `app/trust/[subjectId]` with an
 *   > Endorse / Decline action sheet pinned to the bottom.
 *
 * This module owns the **derivation** — given a wire `CosigRequest`
 * + the recipient's local action state + the current clock, return
 * what the inbox row should render. Concretely:
 *
 *   - Display **state** (pending / accepted / declined / expired) —
 *     pending and not-past-`expiresAt` are the actionable rows;
 *     anything else is a closed entry.
 *   - **Title** text. "Sancho asked you to co-sign their review" when
 *     the sender's display name is known; "Someone asked you to
 *     co-sign their review" as a graceful fallback (the d2d
 *     envelope carries a DID, not a name — the screen layer resolves
 *     the contact lookup and passes the result here).
 *   - **Body preview** — the request's optional `reason` field, or
 *     null when the requester didn't include one.
 *   - **Available actions** — `['endorse', 'decline']` when pending;
 *     empty when the row is closed (auto-expired or already actioned).
 *   - **Deep-link target** — `/trust/<subjectId>` per the plan; the
 *     screen layer reads `attestationUri` separately if it needs
 *     the exact record (e.g. to scroll to it).
 *   - **Time-until-expiry** in ms — negative when expired. Lets the
 *     row render "expires in 2d 3h" subtitles without re-parsing.
 *
 * Pure function. No state. The screen wires it to the inbox store
 * + the d2d-send primitives (`@dina/protocol/d2d/cosig`'s
 * `COSIG_ACCEPT_TYPE` / `COSIG_REJECT_TYPE` builders) — those are
 * actions, not derivations, so they live elsewhere.
 *
 * Why a separate module rather than folding into the inbox handler:
 * the inbox renderer + the action sheet + the deep-link router all
 * read the same slice of derived data. One pure function feeds all
 * three; without it, each call site re-implements the title /
 * action / state / deep-link rules and they drift.
 */

import type { CosigRequest } from '@dina/protocol';

import { buildAttestationDeepLink } from './inbox_deep_link';

// ─── Public types ─────────────────────────────────────────────────────────

/** What the recipient has already done with the request, locally. */
export type RecipientLocalState = 'pending' | 'accepted' | 'declined';

/**
 * Display state — combines `recipientLocalState` with the expiry
 * clock. `expired` overrides `pending`: a row past `expiresAt`
 * with no recipient action is closed, not still actionable.
 *
 * `accepted` and `declined` are NOT overridden by expiry — once the
 * recipient has acted, that's the row's terminal state regardless
 * of when the original `expiresAt` falls.
 */
export type CosigInboxRowState = 'pending' | 'accepted' | 'declined' | 'expired';

export type CosigInboxAction = 'endorse' | 'decline';

export interface CosigInboxRowDisplay {
  readonly state: CosigInboxRowState;
  readonly title: string;
  /** The request's optional `reason`, trimmed, or `null` when absent. */
  readonly bodyPreview: string | null;
  /** Available actions in the current state — `[]` for closed rows. */
  readonly actions: readonly CosigInboxAction[];
  /**
   * Where a tap should route. `app/trust/[subjectId]?attestation=...`
   * per plan §10 — the subject detail screen with an `attestation`
   * query anchor pointing at the source attestation, so the screen
   * can scroll to it / highlight it / pin the action sheet over it.
   * Composed by `inbox_deep_link.buildAttestationDeepLink` (TN-MOB-041).
   */
  readonly deepLink: string;
  /**
   * Milliseconds remaining until the original request expires.
   * Negative when expiry is already in the past. The screen renders
   * "expires in 2d 3h" subtitles — formatting is its concern, not
   * this module's.
   */
  readonly msUntilExpiry: number;
}

export interface CosigInboxInput {
  readonly request: CosigRequest;
  /**
   * Display name of the requester (resolved by the contact-lookup
   * layer). `null` / undefined falls back to a generic phrasing —
   * we never render a raw DID as the title because that's user-
   * hostile.
   */
  readonly senderName?: string | null;
  /**
   * Subject id derived from `request.attestationUri`. The screen
   * already does this resolution to render the row's icon + title;
   * passing it in avoids re-parsing here.
   */
  readonly subjectId: string;
  /** Recipient's local-state ledger value (persisted by the inbox store). */
  readonly recipientLocalState: RecipientLocalState;
  /** Current wall-clock — injectable for deterministic tests. */
  readonly nowMs: number;
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Frozen action sets — one per branch in the state→actions table.
 * Module-level constants so each `buildCosigInboxRow` call returns a
 * shared reference (cheap allocation; cheap React identity check).
 */
const PENDING_ACTIONS: readonly CosigInboxAction[] = Object.freeze(['endorse', 'decline']);
const NO_ACTIONS: readonly CosigInboxAction[] = Object.freeze([]);

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Build the render-ready display data for one cosig inbox row.
 *
 * State selection:
 *   - recipientLocalState === 'accepted' → 'accepted' (terminal,
 *     ignores expiry — once you've cosigned, you've cosigned)
 *   - recipientLocalState === 'declined' → 'declined' (same)
 *   - recipientLocalState === 'pending' AND nowMs < expiresAt
 *     → 'pending'
 *   - recipientLocalState === 'pending' AND nowMs ≥ expiresAt
 *     → 'expired'
 *
 * Throws on a malformed `expiresAt` rather than coercing to "always
 * expired" — that would be a silent data-corruption story. The
 * screen layer should catch + render an error row instead.
 */
export function buildCosigInboxRow(input: CosigInboxInput): CosigInboxRowDisplay {
  const expiresAtMs = parseISOMs(input.request.expiresAt);
  const msUntilExpiry = expiresAtMs - input.nowMs;
  const state = classifyState(input.recipientLocalState, msUntilExpiry);

  return {
    state,
    title: buildTitle(input.senderName ?? null),
    bodyPreview: buildBodyPreview(input.request.reason),
    actions: state === 'pending' ? PENDING_ACTIONS : NO_ACTIONS,
    deepLink: buildAttestationDeepLink({
      subjectId: input.subjectId,
      attestationUri: input.request.attestationUri,
    }),
    msUntilExpiry,
  };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function classifyState(
  recipientLocalState: RecipientLocalState,
  msUntilExpiry: number,
): CosigInboxRowState {
  if (recipientLocalState === 'accepted') return 'accepted';
  if (recipientLocalState === 'declined') return 'declined';
  // 'pending' from here.
  return msUntilExpiry > 0 ? 'pending' : 'expired';
}

function buildTitle(senderName: string | null): string {
  // The plan-§10 verbatim shape is "Sancho asked you to co-sign
  // their review" — interpolating the resolved display name. When
  // the resolver couldn't produce one (transient state at boot,
  // contact gone), fall back to "Someone" rather than rendering a
  // DID. "Someone" is intentionally vague but never user-hostile.
  const trimmed = senderName?.trim() ?? '';
  const who = trimmed.length > 0 ? trimmed : 'Someone';
  return `${who} asked you to co-sign their review`;
}

function buildBodyPreview(reason: string | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse an ISO-8601 datetime to ms-since-epoch. Throws on malformed
 * input — see docstring above for why we don't coerce to NaN.
 */
function parseISOMs(iso: string): number {
  if (typeof iso !== 'string' || iso.length === 0) {
    throw new Error('buildCosigInboxRow: request.expiresAt must be an ISO-8601 string');
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(
      `buildCosigInboxRow: request.expiresAt is not a valid ISO-8601 datetime: "${iso}"`,
    );
  }
  return ms;
}
