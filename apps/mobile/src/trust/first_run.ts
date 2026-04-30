/**
 * Trust Network first-run modal — copy + dismissal flag (TN-MOB-027).
 *
 * The first time a user opens the Trust tab, we surface a one-shot
 * modal that:
 *   1. Names what the Trust Network is in one breath.
 *   2. Discloses the V1 pseudonymity caveat — namespaces share a DID
 *      document, so a network observer correlating signature-key ids
 *      across records can tell which namespace a record came from.
 *      The modal copy reflects this honestly per plan §2 row 11 + §13.10.
 *   3. Carries a single dismissal CTA. After dismissal the modal
 *      doesn't fire again — the persistent banner in
 *      Settings → "About Trust Network" stays the long-term home for
 *      the same disclosure (per plan §2 row 46 — banner lives in BOTH
 *      Settings (always) AND first-run modal (once)).
 *
 * Persistence:
 *
 *   - Per plan §2 row 46, the dismissal artifact is stored in the
 *     keystore as `trust_first_run_dismissed_at`. The keystore is
 *     used (rather than the KV store) because it survives every other
 *     wipe path — the user shouldn't see the modal a second time
 *     after a vault re-init that the KV store wouldn't survive.
 *   - The stored value is the dismissal timestamp (ms-since-epoch).
 *     A bare boolean would be sufficient for the gate, but the
 *     timestamp is cheap to keep and lets future analytics + ops tools
 *     see "when did this user first dismiss" without bumping the
 *     keystore schema. Reads coerce a corrupt value back to "not
 *     dismissed" rather than throwing — a corrupted keystore row is
 *     not worth losing the modal-once invariant over (the modal would
 *     show again, the next dismissal overwrites the bad row, normal
 *     flow resumes).
 *
 * This module is React-free. The screen layer (`apps/mobile/app/trust/`)
 * is the consumer: it reads `isFirstRunModalDismissed()` on mount and
 * calls `markFirstRunModalDismissed()` from the modal's "Got it"
 * handler. Keeping it React-free means we test the dismissal gate
 * under plain Jest without any RN renderer.
 */

import { getSecret, setSecret, deleteSecret } from '@dina/adapters-expo';

/**
 * Keystore service name. Stable across versions — changing it would
 * un-dismiss the modal for every existing user.
 */
const FIRST_RUN_KEYSTORE_SERVICE = 'dina.trust.first_run_dismissed_at';

// ─── Modal copy ───────────────────────────────────────────────────────────

/**
 * The exact strings the modal renders. Centralised so a copy review can
 * happen in one place instead of buried inside JSX, and so unit tests
 * can pin the disclosure language (regression-guarding the
 * pseudonymity caveat against a well-meaning trim).
 */
export interface FirstRunModalCopy {
  readonly title: string;
  readonly body: readonly string[];
  /** The single dismissal CTA. Phrased as acceptance, not commitment. */
  readonly dismissLabel: string;
}

/**
 * Copy for the first-run modal. The body is split into paragraphs so
 * the consumer can render them with consistent inter-paragraph
 * spacing without re-parsing newlines.
 *
 * Frozen so any caller that mutates it crashes loudly instead of
 * silently editing the source of truth for every other render site.
 */
export const FIRST_RUN_MODAL_COPY: FirstRunModalCopy = Object.freeze({
  title: 'Trust Network',
  body: Object.freeze([
    'Trust scores are built from reviews by people you know — and reviews by people they know.',
    "You can publish reviews under separate namespaces (e.g. one for products, one for places). They keep your reviews compartmentalised at first glance.",
    "But these namespaces aren't anonymous: anyone reading your DID document can see how many you have, and a sophisticated observer correlating signatures over time can tell them apart. We'll close that gap in a future version.",
  ]),
  dismissLabel: 'Got it',
});

// ─── Dismissal flag ───────────────────────────────────────────────────────

/**
 * Has the first-run modal been dismissed? Returns `true` once
 * `markFirstRunModalDismissed` has run on this device, else `false`.
 *
 * Treats a corrupt keystore row (non-numeric / negative / NaN) as
 * "not dismissed" so we always recover into a known-good state — the
 * worst case is the modal shows once more, which is recoverable.
 */
export async function isFirstRunModalDismissed(): Promise<boolean> {
  return (await readDismissalTimestamp()) !== null;
}

/**
 * Record dismissal. Idempotent — re-dismissing overwrites the prior
 * timestamp (which is fine; "first dismissal" semantics are the gate,
 * not an audit trail).
 *
 * `now` is injectable for deterministic tests; production callers
 * should leave it unset and let it default to `Date.now()`.
 */
export async function markFirstRunModalDismissed(now?: number): Promise<void> {
  const ts = now ?? Date.now();
  if (!Number.isFinite(ts) || ts < 0) {
    throw new Error(
      `markFirstRunModalDismissed: timestamp must be a non-negative finite number, got ${String(ts)}`,
    );
  }
  await setSecret(FIRST_RUN_KEYSTORE_SERVICE, String(ts));
}

/**
 * The timestamp (ms-since-epoch) at which the modal was dismissed,
 * or `null` if it hasn't been. Useful for ops/analytics surfaces;
 * the gate itself uses `isFirstRunModalDismissed`.
 */
export async function getFirstRunDismissedAt(): Promise<number | null> {
  return readDismissalTimestamp();
}

/**
 * Clear the dismissal flag. Used by:
 *   - Settings → "Reset onboarding" (if/when that lands as an
 *     escape hatch for users who want the disclosure refresh).
 *   - Test setup. Production code must NOT call this on every boot
 *     or the modal becomes a recurring nag.
 */
export async function clearFirstRunDismissal(): Promise<void> {
  await deleteSecret(FIRST_RUN_KEYSTORE_SERVICE);
}

// ─── Internal ─────────────────────────────────────────────────────────────

async function readDismissalTimestamp(): Promise<number | null> {
  const raw = await getSecret(FIRST_RUN_KEYSTORE_SERVICE);
  if (raw === null || raw === '') return null;
  const ts = Number.parseInt(raw, 10);
  if (!Number.isFinite(ts) || ts < 0) return null;
  return ts;
}
