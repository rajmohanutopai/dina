/**
 * What this node has seen of each service provider (REAL_LIFE_FIXES §9).
 *
 * A record in an index proves nothing about whether its provider is up.
 * Following client-side outlier ejection (Envoy: consecutive failures, a
 * growing ejection time, a cap on how much can be ejected), Core remembers
 * per provider DID whether its service queries were answered or expired:
 *
 *   - An expiry counts only when this node handed the query off with its
 *     relay link up, so a local outage ejects nobody.
 *   - Three counted expiries in a row eject the provider for 30 minutes,
 *     doubling each time, up to 24 hours.
 *   - When an ejection ends, the next query is a probe: one answer restores
 *     the provider; one more counted expiry ejects it again at once.
 *   - One answered query clears the count.
 *
 * Callers rank with `providerStanding`; capping how much of a candidate set
 * may be ejected is the ranker's job (it knows the set). The record lives in
 * memory and is written through to the KV store, so it survives a restart.
 */

import { kvGet, kvSet } from '../kv/store';
import { isConnected } from '../relay/msgbox_ws';

export const EJECT_AFTER_EXPIRIES = 3;
export const BASE_EJECTION_MS = 30 * 60 * 1000;
export const MAX_EJECTION_MS = 24 * 60 * 60 * 1000;

interface Standing {
  fails: number;
  ejections: number;
  ejectedUntil: number;
  probe: boolean;
}

const KV_NAMESPACE = 'provider_outcome';
const cache = new Map<string, Standing>();
let linkUp: () => boolean = () => {
  try {
    return isConnected();
  } catch {
    return false;
  }
};

/** Test seam: how the record learns whether the relay link is up. */
export function setProviderLinkProbe(fn: (() => boolean) | null): void {
  linkUp =
    fn ??
    (() => {
      try {
        return isConnected();
      } catch {
        return false;
      }
    });
}

function fresh(): Standing {
  return { fails: 0, ejections: 0, ejectedUntil: 0, probe: false };
}

function persist(did: string, s: Standing): void {
  void kvSet(did, JSON.stringify(s), KV_NAMESPACE).catch(() => {
    /* the in-memory record still holds */
  });
}

/** Load a provider's stored record into memory (once). */
export async function loadProviderStanding(did: string): Promise<void> {
  if (cache.has(did)) return;
  try {
    const raw = await kvGet(did, KV_NAMESPACE);
    if (raw !== null) {
      const p = JSON.parse(raw) as Partial<Standing>;
      cache.set(did, { ...fresh(), ...p });
    }
  } catch {
    /* unreadable → treated as fresh */
  }
}

/** Was the provider ejected at `now`? (Read side for ranking.) */
export function providerStanding(did: string, now: number = Date.now()): { ejected: boolean; until: number } {
  const s = cache.get(did);
  if (s === undefined) return { ejected: false, until: 0 };
  return { ejected: s.ejectedUntil > now, until: s.ejectedUntil };
}

/**
 * Record one service-query outcome for `did`. `handedOff` says the query
 * left this node (the send succeeded); an expiry counts only then, and only
 * with the relay link up.
 */
export function recordProviderOutcome(
  did: string,
  outcome: 'answered' | 'expired' | 'error',
  opts: { handedOff: boolean; now?: number },
): void {
  if (did === '') return;
  const now = opts.now ?? Date.now();
  const s = { ...(cache.get(did) ?? fresh()) };
  if (outcome === 'answered' || outcome === 'error') {
    // The provider is alive: an error reply is still a reply.
    s.fails = 0;
    s.ejections = 0;
    s.ejectedUntil = 0;
    s.probe = false;
  } else {
    if (!opts.handedOff || !linkUp()) return;
    s.fails += 1;
    const probeFailed = s.probe && s.ejectedUntil <= now;
    if (probeFailed || s.fails >= EJECT_AFTER_EXPIRIES) {
      const span = Math.min(BASE_EJECTION_MS * 2 ** s.ejections, MAX_EJECTION_MS);
      s.ejectedUntil = now + span;
      s.ejections += 1;
      s.fails = 0;
      s.probe = true;
    }
  }
  cache.set(did, s);
  persist(did, s);
}

/** Test reset. */
export function resetProviderOutcomes(): void {
  cache.clear();
}
