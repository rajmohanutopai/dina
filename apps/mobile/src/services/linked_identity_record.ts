/**
 * Linked external AT Protocol identity.
 *
 * When a user links an existing Bluesky / AT Protocol account, Dina does
 * NOT take it over: it keeps its own `did:plc` (see `identity_record.ts`)
 * and stores the external identity here as a *reference* only — for
 * recognition, trust, attribution, and discovery.
 *
 * Dina never writes to the linked account's repo, never updates its PLC
 * document, never adds keys, never publishes records as them, and never
 * needs their PDS/app password. Resolution (`@handle → did:plc`) is
 * read-only. A future opt-in `com.dinakernel.identity.link` sidecar
 * record can declare the link publicly, but that is a separate, explicit
 * step — not part of onboarding.
 */

import * as Keychain from './keychain';

const SERVICE = 'dina.linked_atproto_identity';
const USERNAME = 'dina_linked_atproto';

export interface LinkedAtprotoIdentity {
  /** The linked account's did:plc (resolved from its handle). */
  did: string;
  /** The handle at link time (may go stale; the did is the stable key). */
  handle: string | null;
  /** The linked account's PDS URL (their PDS, not Dina's). */
  pdsUrl: string;
  /** ISO-8601 timestamp of when the link was recorded. */
  linkedAt: string;
  /**
   * `true` when control of the DID was PROVEN via ATProto OAuth (the
   * token `sub` matched the resolved DID). `false` for a read-only
   * resolve-only link (handle→did lookup, no proof of control).
   */
  verified: boolean;
}

/** Load the linked identity, or `null` when none is linked. */
export async function loadLinkedAtprotoIdentity(): Promise<LinkedAtprotoIdentity | null> {
  const row = await Keychain.getGenericPassword({ service: SERVICE });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.password) as Partial<LinkedAtprotoIdentity>;
    if (typeof parsed.did !== 'string' || !parsed.did.startsWith('did:')) return null;
    return {
      did: parsed.did,
      handle: typeof parsed.handle === 'string' ? parsed.handle : null,
      pdsUrl: typeof parsed.pdsUrl === 'string' ? parsed.pdsUrl : '',
      linkedAt: typeof parsed.linkedAt === 'string' ? parsed.linkedAt : '',
      verified: parsed.verified === true,
    };
  } catch {
    return null;
  }
}

/**
 * Persist a linked external identity. `did` MUST be a `did:…` string;
 * the link is keyed on the did (handles are mutable). Pass `linkedAt`
 * (ISO string) from the caller — the module avoids `new Date()` so it
 * stays deterministic in tests.
 */
export async function saveLinkedAtprotoIdentity(rec: LinkedAtprotoIdentity): Promise<void> {
  if (!rec.did || !rec.did.startsWith('did:')) {
    throw new Error('saveLinkedAtprotoIdentity: did must be a non-empty "did:…" string');
  }
  await Keychain.setGenericPassword(USERNAME, JSON.stringify(rec), { service: SERVICE });
}

/** Clear the linked identity — used on unlink / identity reset. */
export async function clearLinkedAtprotoIdentity(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}
