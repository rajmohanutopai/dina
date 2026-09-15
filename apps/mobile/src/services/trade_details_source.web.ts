/**
 * A counterparty's trade details (§5.D) — WEB.
 *
 * The thin client's in-process directory is empty (Core runs server-side), so
 * read and write through the brain's contact proxy. Core answers a refusal
 * with the same findings the domain produced, which the screen renders as it
 * does on native.
 */

import { updateContactBody } from '@dina/core';

import type { PostalAddress, TaxRegistration, TradeIdentityFinding } from '@dina/core';

export interface TradeDetails {
  legalName: string;
  registrations: TaxRegistration[];
  billingAddress: PostalAddress | null;
  phone: string | null;
  email: string | null;
}

export async function loadTradeDetails(did: string): Promise<TradeDetails> {
  const res = await fetch(`/api/v1/contacts/lookup?q=${encodeURIComponent(did)}`);
  if (!res.ok) {
    // A failed read must NOT render as an empty form over a contact whose
    // identity Core holds: the owner would "correct" blanks over real data.
    throw new Error(`contacts: lookup answered ${String(res.status)}`);
  }
  const body = (await res.json().catch(() => ({}))) as {
    contact?: { legalName?: string; registrations?: TaxRegistration[]; billingAddress?: PostalAddress };
  };
  const contact = body.contact ?? {};
  return {
    legalName: contact.legalName ?? '',
    registrations: contact.registrations ?? [],
    billingAddress: contact.billingAddress ?? null,
    // The contact policy carries no channels — those live in the people graph,
    // which this route does not read. The web surface therefore shows them
    // blank AND never sends them (see `saveTradeDetails`), so a save here
    // cannot clear a phone the owner never saw.
    phone: null,
    email: null,
  };
}

export async function saveTradeDetails(
  did: string,
  details: Omit<TradeDetails, 'legalName'> & { legalName: string },
): Promise<TradeIdentityFinding[]> {
  // ONE body builder, shared with both Core transports (§5.D, Iter 33): a
  // second spelling of a tri-state wire is a second thing to drift. The
  // channels are OMITTED — this surface could not read them, so it must not
  // claim to set them.
  const res = await fetch(`/api/v1/contacts/${encodeURIComponent(did)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      updateContactBody({
        legalName: details.legalName,
        registrations: details.registrations,
        billingAddress: details.billingAddress,
      }),
    ),
  });
  if (res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { findings?: TradeIdentityFinding[]; error?: string };
  if (body.findings !== undefined) return body.findings;
  // No findings to place beside a field: throw, so the screen shows it in its
  // own error slot rather than looking like nothing happened.
  throw new Error(body.error ?? `Core answered ${String(res.status)}`);
}
