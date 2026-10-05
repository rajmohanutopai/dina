/**
 * What the owner reads about linked accounts at merchants (UCP plan §3.17):
 * Core's reasons in plain words. Fixed text; the merchant's name is its host.
 */

import type { UcpLinkCallback, UcpLinkOwnerView } from '@dina/core';

/** Why Dina will not start a link at `host`. */
export function startRefusalText(reason: string, host: string): string {
  switch (reason) {
    case 'merchant_unreachable':
      return `Dina could not reach ${host}. Try again later.`;
    case 'not_offered':
      return `${host} does not offer account linking.`;
    case 'nothing_to_link':
      return `There is nothing more at ${host} for Dina to link.`;
    case 'discovery_failed':
      return `Dina could not read ${host}’s sign-in setup. Try again later.`;
    case 'no_callback':
      return 'This Dina cannot take the shop’s answer yet. Turn on shopping first.';
    case 'issuer_mismatch':
    case 'endpoints_invalid':
      return `${host}’s sign-in setup does not hold together, so Dina will not use it.`;
    case 'no_s256':
    case 'no_iss_parameter':
    case 'no_public_client':
      return `${host}’s sign-in lacks what Dina needs to link safely.`;
    case 'no_revocation':
      return `${host} gives Dina no way to cancel its access later, so Dina will not link there.`;
    case 'scope_mismatch':
      return `${host}’s sign-in does not offer what Dina would ask for.`;
    case 'scope_refused':
      return `${host} asks for the right to cancel or return orders, which Dina never holds.`;
    case 'url_too_long':
      return `${host}’s sign-in address is too long to send to your phone.`;
    case 'no_workflow':
      return 'Dina cannot send the sign-in to your phone now. Try again shortly.';
    case 'no_phone':
      return 'Pair your phone as your server’s node to link accounts there.';
    default:
      return `Dina could not start linking at ${host}.`;
  }
}

/** What happened to a callback the app caught. */
export function callbackText(out: UcpLinkCallback): string {
  if (out.linked) return `Your account at ${out.merchant_host} is linked.`;
  if ('held' in out) return 'Your Dina server finishes this link. It shows there in a few seconds.';
  switch (out.reason) {
    case 'denied':
      return 'You said no at the shop, so nothing was linked.';
    case 'unknown_state':
      return 'This sign-in was already used or has expired. Linked accounts shows whether your account is linked.';
    case 'discarded':
      return 'This answer did not come from the shop it was meant for, so Dina did not use it.';
    case 'not_held':
      return 'Too many links are waiting. Try again in a few minutes.';
    case 'token_refused':
    case 'token_unreachable':
      return 'The shop did not finish the link. Try again.';
    case 'cancelled':
      return 'You unlinked this shop while the link was being made, so nothing was linked.';
    default:
      return 'Nothing was linked.';
  }
}

/** Why an attempt ended without a link (`failed` in Linked accounts). */
export function attemptText(outcome: string, host: string): string {
  switch (outcome) {
    case 'denied':
      return `Linking at ${host} did not finish: you said no at the shop.`;
    case 'discarded':
      return `Linking at ${host} did not finish: the answer did not come from the shop it was meant for.`;
    case 'token_unreachable':
      return `Linking at ${host} did not finish: Dina could not reach the shop. Try again.`;
    case 'cancelled':
      return `Linking at ${host} did not finish: you unlinked it meanwhile.`;
    default:
      return `Linking at ${host} did not finish. Try again.`;
  }
}

/** A link's state in a word or two. */
export function linkStateText(link: UcpLinkOwnerView): string {
  if (link.state === 'needs_relink') return 'Needs linking again';
  if (link.state === 'revoking') return 'Unlinking';
  return 'Linked';
}
