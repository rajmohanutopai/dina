/**
 * A counterparty's trade details (§5.D) — NATIVE.
 *
 * The paper identity a filing prints (legal name, registrations, billing
 * address) and the channels a rail would message (phone, e-mail). On a phone
 * the directory and the people graph are in-process, so read and write them
 * directly; the web variant goes through Core's contact route, where the
 * authoritative store lives.
 *
 * The validation lives in the DOMAIN either way — this module never judges a
 * GSTIN itself, it relays the findings so the screen can show them.
 */

import {
  checkContactChannels,
  checkPaperIdentity,
  getContactChannels,
  getPaperIdentity,
  setContactChannels,
  setPaperIdentity,
  type PostalAddress,
  type TaxRegistration,
  type TradeIdentityFinding,
} from '@dina/core';

export interface TradeDetails {
  legalName: string;
  registrations: TaxRegistration[];
  billingAddress: PostalAddress | null;
  phone: string | null;
  email: string | null;
}

export async function loadTradeDetails(did: string): Promise<TradeDetails> {
  const identity = getPaperIdentity(did);
  const channels = getContactChannels(did);
  return Promise.resolve({ ...identity, ...channels });
}

/**
 * Save every field, all or nothing. The paper identity and the channels live
 * in two stores, so BOTH are judged before EITHER is written: the owner is
 * shown everything wrong with what they typed at once, and a screen that says
 * "not saved" means nothing was.
 */
export async function saveTradeDetails(
  did: string,
  details: Omit<TradeDetails, 'legalName'> & { legalName: string },
): Promise<TradeIdentityFinding[]> {
  const identity = {
    legalName: details.legalName,
    registrations: details.registrations,
    billingAddress: details.billingAddress,
  };
  const channels = { phone: details.phone, email: details.email };
  const findings = [...checkPaperIdentity(did, identity), ...checkContactChannels(did, channels)];
  if (findings.length > 0) return Promise.resolve(findings);
  setPaperIdentity(did, identity);
  setContactChannels(did, channels);
  return Promise.resolve([]);
}
