/**
 * Contact-service grant policy — the pure decision for what to do with an
 * UN-GRANTED request to a relationship (`surface: 'talk'`) service
 * (docs/CONTACT_SERVICES_ARCHITECTURE.md §5.1 / §5.2).
 *
 * This is policy ONLY — it never authorizes anything. Authorization is always
 * a `service_grants` row checked at D2D ingress (grant-table single-source).
 * This function decides whether a grant should be *materialized* (and how),
 * given the requester's closeness and whether the owner enabled the service
 * for the closeness-default flow.
 *
 * Decisions:
 *   - `auto_grant`    → write an explicit grant row now, then offer it back.
 *   - `ask_to_enable` → surface a one-time "allow this contact?" prompt; a yes
 *                       writes the explicit grant row.
 *   - `soft_reject`   → refuse silently, no prompt to the owner, no row. The
 *                       contact never had it on offer (avoids the "denied is a
 *                       bad look" leak).
 *
 * DESIGN DECISION (spec-ambiguous): `defaultOfferable` is the **master gate**
 * for the whole closeness-default flow, not merely a guard on auto-grant. A
 * service the owner has NOT marked default-offerable yields `soft_reject` for
 * every tier — it is a manual-grant-only service (the owner hand-issues
 * `/v1/service/offer`). This is the strict reading of §5.1 ("auto-grant
 * requires BOTH default-offerable AND tier") and the safest: a service never
 * auto-grants OR prompts unless the owner opted it into the flow. See
 * implementation-notes.html for the rationale.
 */

import type { Closeness } from '../contacts/closeness';

export type ContactServiceGrantDecision = 'auto_grant' | 'ask_to_enable' | 'soft_reject';

export function decideContactServiceGrant(args: {
  closeness: Closeness;
  /** Did the owner mark this service offerable through the closeness-default flow? */
  defaultOfferable: boolean;
}): ContactServiceGrantDecision {
  // Master gate: not in the default flow → manual-grant-only, refuse silently.
  if (!args.defaultOfferable) return 'soft_reject';

  switch (args.closeness) {
    case 'close':
      return 'auto_grant';
    case 'medium':
      return 'ask_to_enable';
    case 'distant':
    case 'unknown':
      return 'soft_reject';
  }
}
