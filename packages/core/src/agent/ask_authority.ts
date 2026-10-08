/**
 * Agent ask authority (REAL_LIFE_FIXES §0.1 B).
 *
 * When Core accepts an ask from a paired device or agent (`/api/v1/ask`), it
 * records WHO is asking: the authenticated requester DID and live session.
 * Brain receives only the record's id and must present it on every Core call
 * it makes for that ask (vault reads, previews, ToC, persona checks). Core
 * then applies that requester's persona access on the read itself, so agent
 * reads are enforced by Core, not by Brain's goodwill.
 *
 * The id travels inside signed request data (query string or JSON body), so
 * stripping or swapping it breaks the request signature. A compromised Brain
 * could still omit it and read as the owner's analyst; that is the existing
 * bound in CLAUDE.md ("a compromised Brain can only reach open personas").
 *
 * Records live in Core's memory for the ask's lifetime. A Core restart drops
 * them; Brain's reads for those asks then fail closed.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { getSessionRegistryIfConfigured } from '../session/registry';

export interface AskAuthority {
  id: string;
  /** Authenticated requester (agent or paired device) — never a body field. */
  requesterDid: string;
  /** Live agent session the ask runs in; null for a session-less device. */
  sessionId: string | null;
  /** Brain's ask id, bound once Brain accepts the ask. */
  askId: string | null;
  expiresAt: number;
}

/** Ask records outlive any ask's deadline; the reaper drops them after. */
export const DEFAULT_ASK_AUTHORITY_TTL_MS = 60 * 60 * 1000;
const MAX_RECORDS = 10_000;

const records = new Map<string, AskAuthority>();

function reap(now: number): void {
  for (const [id, r] of records) if (r.expiresAt <= now) records.delete(id);
}

/** Record a new ask's authority. The requester DID must be the authenticated caller. */
export function mintAskAuthority(input: {
  requesterDid: string;
  sessionId?: string | null;
  ttlMs?: number;
  now?: number;
}): AskAuthority {
  const now = input.now ?? Date.now();
  reap(now);
  if (records.size >= MAX_RECORDS) {
    // Oldest first: Map keeps insertion order.
    const oldest = records.keys().next();
    if (!oldest.done) records.delete(oldest.value);
  }
  const record: AskAuthority = {
    id: `aa-${bytesToHex(randomBytes(16))}`,
    requesterDid: input.requesterDid,
    sessionId: input.sessionId !== undefined && input.sessionId !== '' ? input.sessionId : null,
    askId: null,
    expiresAt: now + (input.ttlMs ?? DEFAULT_ASK_AUTHORITY_TTL_MS),
  };
  records.set(record.id, record);
  return { ...record };
}

/** Bind Brain's ask id to a record (first bind wins). */
export function bindAskAuthority(id: string, askId: string): void {
  const r = records.get(id);
  if (r !== undefined && r.askId === null && askId !== '') r.askId = askId;
}

/**
 * The live record for `id`, or null when unknown, expired, or its agent
 * session has ended. Callers deny on null: there is no fallback to owner
 * access.
 */
export function resolveAskAuthority(id: string, now: number = Date.now()): AskAuthority | null {
  if (typeof id !== 'string' || id === '') return null;
  const r = records.get(id);
  if (r === undefined) return null;
  if (r.expiresAt <= now) {
    records.delete(id);
    return null;
  }
  if (r.sessionId !== null) {
    const sessions = getSessionRegistryIfConfigured();
    if (sessions !== null && !sessions.validate(r.sessionId, r.requesterDid).ok) {
      records.delete(id);
      return null;
    }
  }
  return { ...r };
}

/** Drop a record (the ask finished). Idempotent. */
export function closeAskAuthority(id: string): void {
  records.delete(id);
}

/** Test reset. */
export function resetAskAuthorities(): void {
  records.clear();
}
