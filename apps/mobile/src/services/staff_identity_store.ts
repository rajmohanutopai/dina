/**
 * Staff-mode identity persistence — the STAFF PHONE fork
 * (TRADE_FIRST_STRATEGY §6.3).
 *
 * A staff phone is not a Home Node: it never provisions a vault or a
 * master seed. It holds ONE thing — a `StaffIdentity` (device key +
 * the business node's DID, relay, and signing key) — minted by
 * `pairStaffDevice` and reloaded every launch to rebuild the sealed
 * relay transport. Kept in its OWN keychain service so a staff phone
 * and an owner phone can never collide, and so leaving a business is
 * one `clearStaffIdentity()`.
 *
 * A load failure surfaces as `null` (run the join flow), never an
 * exception — a corrupt record must not trap the clerk on a dead
 * screen. Mirrors `wrapped_seed_store.ts`.
 */

import { getGenericPassword, resetGenericPassword, setGenericPassword } from './keychain';

import type { StaffIdentity } from '@dina/core';


const STAFF_SERVICE = 'com.dina.staff-identity';

interface StoredStaffIdentity {
  v: 1;
  deviceDid: string;
  devicePrivateKeyHex: string;
  homenodeDid: string;
  homenodeSigningPubHex: string;
  msgboxUrl: string;
  deviceName: string;
}

function isHex(s: unknown, len?: number): s is string {
  return typeof s === 'string' && /^[0-9a-f]*$/.test(s) && (len === undefined || s.length === len);
}

export async function saveStaffIdentity(identity: StaffIdentity): Promise<void> {
  const record: StoredStaffIdentity = { v: 1, ...identity };
  await setGenericPassword('staff', JSON.stringify(record), { service: STAFF_SERVICE });
}

export async function loadStaffIdentity(): Promise<StaffIdentity | null> {
  let raw: string;
  try {
    const result = await getGenericPassword({ service: STAFF_SERVICE });
    if (result === false || result.password === '') return null;
    raw = result.password;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.deviceDid !== 'string' || !p.deviceDid.startsWith('did:')) return null;
  if (!isHex(p.devicePrivateKeyHex, 64)) return null;
  if (typeof p.homenodeDid !== 'string' || !p.homenodeDid.startsWith('did:')) return null;
  if (!isHex(p.homenodeSigningPubHex, 64)) return null;
  if (typeof p.msgboxUrl !== 'string' || p.msgboxUrl === '') return null;
  return {
    deviceDid: p.deviceDid,
    devicePrivateKeyHex: p.devicePrivateKeyHex,
    homenodeDid: p.homenodeDid,
    homenodeSigningPubHex: p.homenodeSigningPubHex,
    msgboxUrl: p.msgboxUrl,
    deviceName: typeof p.deviceName === 'string' ? p.deviceName : '',
  };
}

/** Leave the business — one call, everything the phone knew is gone. */
export async function clearStaffIdentity(): Promise<void> {
  await resetGenericPassword({ service: STAFF_SERVICE });
}
