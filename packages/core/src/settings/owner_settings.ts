/**
 * Owner settings shared by both hosts (REAL_LIFE_FIXES_2 §0).
 *
 * - Guard modes: the reply guards Brain runs (§3 action claims, §6.2
 *   regulated sentences) start in `report` (log what they would change) and
 *   move to `enforce` by owner setting. Kept in Core so the phone and the
 *   server read the same value; Brain can read, never write.
 * - The owner's time zone: every date Dina shows or reasons about uses it.
 *   The phone writes it at boot from the device, the web app on owner
 *   sign-in; the host zone is the fallback.
 *
 * Stored in the identity database's key-value table.
 */

import { kvGet, kvSet } from '../kv/store';

const NS = 'owner_settings';

export type GuardMode = 'report' | 'enforce';

export interface GuardModes {
  action_claims: GuardMode;
  regulated: GuardMode;
}

const GUARD_KEYS: readonly (keyof GuardModes)[] = ['action_claims', 'regulated'];

export async function getGuardModes(): Promise<GuardModes> {
  const out: GuardModes = { action_claims: 'report', regulated: 'report' };
  for (const key of GUARD_KEYS) {
    const v = await kvGet(`guard_mode:${key}`, NS);
    if (v === 'enforce' || v === 'report') out[key] = v;
  }
  return out;
}

/** Set some guard modes; unknown keys or values are refused. */
export async function setGuardModes(update: Record<string, unknown>): Promise<GuardModes | string> {
  for (const [key, value] of Object.entries(update)) {
    if (!(GUARD_KEYS as readonly string[]).includes(key)) return `unknown guard: ${key}`;
    if (value !== 'report' && value !== 'enforce') return `mode must be report or enforce: ${key}`;
  }
  for (const [key, value] of Object.entries(update)) await kvSet(`guard_mode:${key}`, String(value), NS);
  return getGuardModes();
}

/** True when `zone` is an IANA time zone this runtime knows. */
export function isValidTimeZone(zone: string): boolean {
  if (zone === '' || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The owner's time zone, or the host's when none is set. */
export async function getOwnerTimeZone(): Promise<{ timezone: string; source: 'owner' | 'host' }> {
  const v = await kvGet('timezone', NS);
  if (v !== null && isValidTimeZone(v)) return { timezone: v, source: 'owner' };
  return { timezone: hostTimeZone(), source: 'host' };
}

export async function setOwnerTimeZone(zone: string): Promise<boolean> {
  if (!isValidTimeZone(zone)) return false;
  await kvSet('timezone', zone, NS);
  return true;
}
