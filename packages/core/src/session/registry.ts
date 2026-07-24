/**
 * Item 6 — durable session registry (Plugin Developer Surface §15, DPD-008/F5).
 *
 * Sessions were no-op stubs (`session.ts`), so "end revokes grants + closes
 * vaults" was false. This registry makes a session a real, authenticated,
 * DID-bound object:
 *
 *   • bound to the authenticated caller DID — `get`/`renew`/`end` require the
 *     SAME DID, so agent A can never touch agent B's session (cross-agent
 *     isolation, the primary threat — holds even with an unsigned session id
 *     because the id alone is useless without the matching authenticated DID);
 *   • rejects unknown / ended / lease-expired sessions;
 *   • revokes session grants on end (via an injected `onEnd` hook, so the
 *     registry stays decoupled from the grant store);
 *   • lease + heartbeat — `start` mints a bounded lease each signed call renews;
 *     a reconciliation sweep ends any session whose lease lapsed (reaps a
 *     vanished Codex thread that has no `SessionEnd` hook).
 *
 * `start` is idempotent on `(agentDid, hostSessionId)` so repeated host-hook
 * calls and reconnects reuse one Core session. MCP clients can share it when
 * they know the same host id; otherwise their explicitly started session is a
 * separate, independently revocable scope.
 *
 * The in-memory Map is authoritative for reads within a process, with an
 * injectable clock. Item D wires an OPTIONAL durable `SessionRepository`: each
 * mutation writes through to SQLite, and `reconcile()` reloads live sessions on
 * boot (reaping any whose lease lapsed while Core was down), so an agent's
 * session survives a restart. Durable lifecycle writes are fail-closed: Core
 * never reports a start/renew/end that SQLite did not record. The
 * session-bootstrap op is the one op exempt from prior-session validation
 * (§15) — enforced by the caller.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import type { SessionRepository } from './repository';

export const DEFAULT_LEASE_MS = 15 * 60 * 1000; // 15 min — matches §15 Codex reap default

export interface SessionRecord {
  sessionId: string;
  agentDid: string;
  /** Host (Claude Code / Codex) session id this Core session is bound to. */
  hostSessionId: string;
  createdAtMs: number;
  /** Last heartbeat; the lease is measured from here. */
  lastSeenAtMs: number;
  leaseExpiresAtMs: number;
  endedAtMs: number | null;
  /** Why it ended — for the audit trail. */
  endReason: 'explicit' | 'lease_lapsed' | null;
}

export interface StartSessionInput {
  agentDid: string;
  hostSessionId: string;
  leaseMs?: number;
}

export type EndReason = 'explicit' | 'lease_lapsed';

export type SessionValidation =
  | { ok: true; session: SessionRecord }
  | { ok: false; reason: 'not_found' | 'principal_mismatch' | 'ended' | 'lease_lapsed' };

/** Called when a session ends — the composition root wires grant revocation. */
export type SessionEndHook = (session: SessionRecord, reason: EndReason) => void;

export class SessionRegistry {
  private readonly byId = new Map<string, SessionRecord>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly onEnd: SessionEndHook = () => {
      /* default: no grant-revocation hook wired */
    },
    /** Item D — optional durable backing; when present, mutations write through. */
    private readonly repo: SessionRepository | null = null,
  ) {}

  /**
   * Item D — boot reconciliation: reload every not-ended session from the
   * durable store into the in-memory Map, then reap any whose lease lapsed while
   * Core was down (so a stale session can't be reused/validated post-restart).
   * Idempotent; a no-op when no repo is wired. Returns the reaped count.
   */
  reconcile(): number {
    if (this.repo === null) return 0;
    for (const s of this.repo.loadActive()) {
      // Trust the durable row; the in-memory Map is rebuilt from it.
      this.byId.set(s.sessionId, { ...s });
    }
    return this.reapExpired();
  }

  /**
   * Persist before publishing a lifecycle mutation to the in-memory map.
   *
   * In particular, swallowing an end-tombstone failure can resurrect the old
   * active row after restart. A storage error therefore aborts the mutation and
   * reaches the route as a masked 500; the caller may retry, while the previous
   * session state remains authoritative.
   */
  private persist(s: SessionRecord): void {
    if (this.repo === null) return;
    this.repo.upsert(s);
  }

  /** Open (or reuse) a session for `(agentDid, hostSessionId)`. Idempotent. */
  start(input: StartSessionInput): SessionRecord {
    const t = this.now();
    const lease = input.leaseMs ?? DEFAULT_LEASE_MS;

    // Reuse a live session for the same principal + host session (F-04).
    for (const s of this.byId.values()) {
      if (
        s.agentDid === input.agentDid &&
        s.hostSessionId === input.hostSessionId &&
        s.endedAtMs === null &&
        t < s.leaseExpiresAtMs
      ) {
        const renewed = { ...s, lastSeenAtMs: t, leaseExpiresAtMs: t + lease };
        this.persist(renewed);
        this.byId.set(renewed.sessionId, renewed);
        return renewed;
      }
    }

    // Item D — a cryptographically-random id (128 bits). The registry is
    // DID-bound (the id alone is useless without the matching authenticated
    // DID), but a random id also avoids leaking the host session id / a
    // monotonic counter / the mint timestamp, and can't be guessed to probe
    // session lifecycle.
    const sessionId = `sess-${bytesToHex(randomBytes(16))}`;
    const record: SessionRecord = {
      sessionId,
      agentDid: input.agentDid,
      hostSessionId: input.hostSessionId,
      createdAtMs: t,
      lastSeenAtMs: t,
      leaseExpiresAtMs: t + lease,
      endedAtMs: null,
      endReason: null,
    };
    this.persist(record);
    this.byId.set(sessionId, record);
    return record;
  }

  /** Validate a session for a signed call — DID-bound, not ended, lease live. */
  validate(sessionId: string, agentDid: string): SessionValidation {
    const s = this.byId.get(sessionId);
    if (!s) return { ok: false, reason: 'not_found' };
    // Principal binding first — never reveal another principal's lifecycle.
    if (s.agentDid !== agentDid) return { ok: false, reason: 'principal_mismatch' };
    if (s.endedAtMs !== null) return { ok: false, reason: 'ended' };
    if (this.now() >= s.leaseExpiresAtMs) {
      this.finish(s, 'lease_lapsed');
      return { ok: false, reason: 'lease_lapsed' };
    }
    return { ok: true, session: s };
  }

  /** Heartbeat — extend the lease on a valid signed call. */
  renew(sessionId: string, agentDid: string, leaseMs: number = DEFAULT_LEASE_MS): SessionValidation {
    const v = this.validate(sessionId, agentDid);
    if (!v.ok) return v;
    const t = this.now();
    const renewed = {
      ...v.session,
      lastSeenAtMs: t,
      leaseExpiresAtMs: t + leaseMs,
    };
    this.persist(renewed);
    this.byId.set(renewed.sessionId, renewed);
    return { ok: true, session: renewed };
  }

  /** End a session explicitly (revokes grants via `onEnd`). DID-bound. */
  end(sessionId: string, agentDid: string): SessionValidation {
    const s = this.byId.get(sessionId);
    if (!s) return { ok: false, reason: 'not_found' };
    if (s.agentDid !== agentDid) return { ok: false, reason: 'principal_mismatch' };
    if (s.endedAtMs !== null) return { ok: false, reason: 'ended' };
    const ended = this.finish(s, 'explicit');
    return { ok: true, session: ended };
  }

  /** Reconciliation sweep — end every session whose lease has lapsed. */
  reapExpired(): number {
    const t = this.now();
    let reaped = 0;
    for (const s of this.byId.values()) {
      if (s.endedAtMs === null && t >= s.leaseExpiresAtMs) {
        this.finish(s, 'lease_lapsed');
        reaped++;
      }
    }
    return reaped;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.byId.get(sessionId);
  }

  /** Active sessions visible to one authenticated principal only. */
  listActive(agentDid: string): SessionRecord[] {
    this.reapExpired();
    const active: SessionRecord[] = [];
    for (const s of this.byId.values()) {
      if (s.agentDid === agentDid && s.endedAtMs === null) active.push({ ...s });
    }
    return active.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /** Live (not ended, lease valid) session count — for tests/metrics. */
  liveCount(): number {
    const t = this.now();
    let n = 0;
    for (const s of this.byId.values()) if (s.endedAtMs === null && t < s.leaseExpiresAtMs) n++;
    return n;
  }

  private finish(s: SessionRecord, reason: EndReason): SessionRecord {
    const ended: SessionRecord = {
      ...s,
      endedAtMs: this.now(),
      endReason: reason,
    };
    // Persist the tombstone BEFORE the onEnd side-effects so a durable record of
    // the end exists even if a hook throws.
    this.persist(ended);
    this.byId.set(ended.sessionId, ended);
    this.onEnd(ended, reason);
    return ended;
  }
}

// ─── Module-global registry (matches the codebase's service-global pattern) ───

let registry: SessionRegistry | null = null;

/** The process session registry; auto-provisions an in-memory one on first use. */
export function getSessionRegistry(): SessionRegistry {
  if (registry === null) registry = new SessionRegistry();
  return registry;
}

/** Install a registry (e.g. with a grant-revoking `onEnd`) at bootstrap. */
export function setSessionRegistry(r: SessionRegistry | null): void {
  registry = r;
}
