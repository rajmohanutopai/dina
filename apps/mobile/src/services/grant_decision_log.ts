/**
 * Owner-private decision-log writers for the Contact Services PROMPT lifecycle
 * (CONTACT_SERVICES_ARCHITECTURE.md §2/§10).
 *
 * Split of responsibility: Core logs what IT terminally decides at D2D ingress
 * (auto_grant → `granted`, soft_reject → `auto_declined`, error). The
 * `ask_to_enable` path is different — Core only DECIDES to ask; the actual yes/no
 * is an OWNER decision surfaced as a one-time card on the phone. So the prompt's
 * real lifecycle is logged HERE, from the mobile surface that owns it:
 *
 *   - `prompt_shown`      — the card was DURABLY posted (not merely decided).
 *   - `granted`           — the owner tapped Allow and the grant was minted.
 *   - `prompt_timed_out`  — the owner tapped "Not now" (dismissed/expired).
 *
 * The mobile app runs Core in-process, so this owner-private LOCAL log is the
 * owner's own device writing the owner's own log — written directly to the repo,
 * never crossing a trust boundary, never sent to the requester. Best-effort: the
 * log is advisory and must never break the prompt UX, so every write is guarded.
 */

import {
  getServiceDecisionRepository,
  type ServiceDecisionOutcome,
} from '@dina/core/storage';

function record(
  requesterDid: string,
  capability: string,
  decision: ServiceDecisionOutcome,
  reason: string,
): void {
  try {
    getServiceDecisionRepository()?.record({
      requesterDid,
      capability,
      decision,
      reason,
      createdAt: Math.floor(Date.now() / 1000),
    });
  } catch {
    /* owner-private log is advisory — swallow */
  }
}

/** The one-time allow prompt was durably posted into the contact's Talk thread. */
export function recordPromptShown(
  requesterDid: string,
  capability: string,
  closeness: string,
): void {
  record(requesterDid, capability, 'prompt_shown', `closeness=${closeness}`);
}

/** The owner tapped Allow → the grant was minted + the offer delivered. */
export function recordPromptGranted(requesterDid: string, capability: string): void {
  record(requesterDid, capability, 'granted', 'owner_allowed');
}

/** The owner tapped "Not now" (or the prompt expired) → no grant, no leak. */
export function recordPromptDismissed(requesterDid: string, capability: string): void {
  record(requesterDid, capability, 'prompt_timed_out', 'owner_dismissed');
}
