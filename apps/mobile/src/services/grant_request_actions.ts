/**
 * Contact Services — owner actions for the `ask_to_enable` Talk prompt.
 *
 * Core's `service.grant_request` handler decides REACH (closeness policy) at
 * D2D ingress, but for a MEDIUM (friend) contact the actual yes is an OWNER
 * decision surfaced as a one-time prompt in the Talk thread (spec §2/§5.2).
 * "Allow" mints the grant + delivers the `service.offer` through the EXISTING
 * provider path (`POST /v1/service/offer` via `coreClient.issueServiceOffer`)
 * — the same route `auto_grant` takes — so the closeness policy stays the
 * single source of reach while the human keeps the final yes.
 *
 * "Not now" simply dismisses the card; no grant, no row, no signal back to the
 * contact (matching the soft-reject discipline — a refusal must not leak).
 */

import { getBootedNode } from '../hooks/useNodeBootstrap';

import { recordPromptGranted } from './grant_decision_log';

export interface AllowGrantRequestArgs {
  /** The contact who asked (the grant's grantee + the offer's to_did). */
  requesterDID: string;
  /** The local `surface:'talk'` listing rkey to grant against. */
  rkey: string;
  /** The capability the contact asked to use. */
  capability: string;
}

/**
 * Issue the grant the owner approved. Resolves to the minted grant id (so the
 * card can confirm); throws when the node isn't booted or Core rejects (e.g.
 * the contact was removed in the meantime → 403). The caller surfaces the
 * failure inline.
 */
export async function allowGrantRequest(
  args: AllowGrantRequestArgs,
): Promise<{ grantId: string }> {
  const node = getBootedNode();
  if (node === null) {
    throw new Error('Dina is still starting — try again in a moment.');
  }
  const { grantId } = await node.coreClient.issueServiceOffer({
    toDID: args.requesterDID,
    rkey: args.rkey,
    capability: args.capability,
  });
  // Owner-private log: the owner approved → record `granted` (the prompt path's
  // terminal "yes"). Best-effort and only after the grant actually minted, so
  // the Activity "Requests" view stops showing "You were asked" once allowed.
  recordPromptGranted(args.requesterDID, args.capability);
  return { grantId };
}
