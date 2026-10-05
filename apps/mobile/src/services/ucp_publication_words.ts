/**
 * The owner's words for UCP publication and the shopping key (UCP plan §3.5,
 * §4.8; U7), from Core's view. Pure, so each case is tested without a screen.
 */

import type { UcpPublicationView } from '@dina/core';

const STATUS: Record<UcpPublicationView['status'], string> = {
  served: 'Shops can find your shopping profile.',
  stale: 'Your shopping profile is being updated.',
  unreachable: 'The profile host could not be reached. Dina keeps trying.',
  refused: 'The profile host refused the last update.',
  stood_down: 'Another of your devices handles shopping.',
  off: 'Shopping is off: shops cannot find your profile.',
  stopping: 'Turning shopping off. Dina keeps trying until the host confirms.',
};

/** A time as the owner reads it, in their own clock. */
function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Why the host refused, or what could not be reached, in the owner's words. */
const DETAIL: Record<string, string> = {
  host: 'The profile host did not answer.',
  profile: 'Your profile could not be fetched to check it.',
  contended: 'Another change kept landing first.',
  label_owned: 'This shopping name belongs to another Dina.',
  retired_key: 'A key it lists was retired.',
  generation: 'The key number was not above the last one.',
  document_keys: 'The profile and its keys did not match.',
  invalid: 'The host could not check this Dina’s signature.',
  stale_revision: 'Another change kept landing first.',
  superseded:
    'Another device took shopping after you pressed this, so it was not applied. Press again if you still want it.',
};

/** The host's refusal or fault, in words; null when there is none or it is not one Dina knows. */
export function publicationDetailText(view: UcpPublicationView): string | null {
  return view.detail === null ? null : (DETAIL[view.detail] ?? null);
}

/** The status line. */
export function publicationStatusText(view: UcpPublicationView): string {
  // A refusal is said as one: nothing is being retried.
  if (view.status === 'refused') {
    if (view.pending_control === 'retire')
      return 'The profile host refused to retire your key. Try again.';
    if (view.pending_control === 'pause')
      return 'The profile host refused to turn shopping off: your profile is still served. Try again.';
    return STATUS.refused;
  }
  if (view.compromise_pending)
    return 'Replacing your shopping key. Dina keeps trying until the host confirms.';
  if (view.pending_control === 'activate')
    return 'Shopping will use this device once the profile host answers. Dina keeps trying.';
  return STATUS[view.status];
}

/** Whether the view is still moving (worth reading again shortly). */
export function publicationSettling(view: UcpPublicationView): boolean {
  return (
    view.status === 'stale' ||
    view.status === 'stopping' ||
    view.status === 'unreachable' ||
    view.compromise_pending ||
    view.rotation_requested ||
    (view.key?.next !== null && view.key?.next !== undefined)
  );
}

/** What the key ring says: the key in use, a rotation under way, old keys still listed. */
export function shoppingKeyText(view: UcpPublicationView): string[] {
  const key = view.key;
  if (key === null)
    return view.rotation_requested
      ? ['A new key will be set up on the next update.']
      : // Shops cannot check Dina's requests until the profile is published: searches wait too.
        ['No shopping key yet: one is set up when your profile is first published.'];
  const lines = [`Key in use: number ${key.generation}.`];
  if (key.next !== null)
    lines.push(
      key.next.signs_from === null
        ? `New key ${key.next.generation} is listed; Dina is checking the host serves it.`
        : `New key ${key.next.generation} signs from ${when(key.next.signs_from)}, once shops have seen it.`,
    );
  else if (view.rotation_requested) lines.push('A new key will be set up on the next update.');
  for (const r of key.retiring)
    lines.push(`Old key ${r.generation} stays listed until ${when(r.until)}.`);
  return lines;
}

/** Which of the owner's actions make sense now. */
export function publicationActions(view: UcpPublicationView): {
  activate: boolean;
  turnOff: boolean;
  rotate: boolean;
  compromised: boolean;
} {
  const here = view.role === 'active';
  // After a refusal the owner may try the same control again.
  const refusedPause = view.status === 'refused' && view.pending_control === 'pause';
  return {
    activate: (!here || !view.enabled) && view.pending_control !== 'activate',
    // While a replacement is pending the owner may still want everything off (it stays off once
    // the key is replaced); a turn-off already pending is not offered twice.
    turnOff:
      (view.enabled || refusedPause) &&
      view.status !== 'off' &&
      (view.status !== 'stopping' || view.compromise_pending),
    rotate:
      here &&
      view.enabled &&
      view.key !== null &&
      view.key.next === null &&
      !view.rotation_requested,
    compromised: !view.compromise_pending || view.status === 'refused',
  };
}
