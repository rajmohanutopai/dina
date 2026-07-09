/**
 * Quarantine card actions — WEB.
 *
 * The thin-client can't touch Core's in-process quarantine store, so accept/
 * block POST to the brain-server's COMPOUND endpoints (each does the
 * quarantine half AND the contact-trust half server-side in one call). The
 * `quarantineId` isn't needed on the wire — Core keys the compound op on the
 * sender DID — but the signature matches the native peer.
 */

async function postQuarantineAction(action: 'accept' | 'block', senderDID: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/d2d/quarantine/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender_did: senderDID }),
    });
    if (!res.ok) return false;
    // A PARTIAL accept — Core re-quarantined messages that failed to re-stage —
    // is NOT a clean success: the sender is trusted but those messages weren't
    // delivered. Report false so the card stays unresolved (retryable) rather
    // than claiming "Showing their message". (`block` carries no
    // `requarantined`; `?? 0` keeps a successful block truthy.)
    const body = (await res.json().catch(() => ({}))) as { requarantined?: number };
    return (body.requarantined ?? 0) === 0;
  } catch {
    return false;
  }
}

export function acceptQuarantine(_quarantineId: string, senderDID: string): Promise<boolean> {
  return postQuarantineAction('accept', senderDID);
}

export function blockQuarantine(_quarantineId: string, senderDID: string): Promise<boolean> {
  return postQuarantineAction('block', senderDID);
}
