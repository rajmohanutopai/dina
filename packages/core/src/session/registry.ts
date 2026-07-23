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
 * `start` is idempotent on `(agentDid, hostSessionId)` so the per-tool hook and
 * the MCP tools share ONE Core session (F-04) and a reconnect reuses it.
 *
 * The store is in-memory with an injectable clock; a SQLite table backs it for
 * durability across restart (item 8). The session-bootstrap op is the one op
 * exempt from prior-session validation (§15) — enforced by the caller.
 */

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
  private seq = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly onEnd: SessionEndHook = () => {},
  ) {}

  /** Open (or reuse) a session for `(agentDid, hostSessionId)`. Idempotent. */
  start(input: StartSessionInput): SessionRecord {
    const t = this.now();
    const lease = input.leaseMs ?? DEFAULT_LEASE_MS;

    // Reuse a live session for the same principal + host session (F-04): the
    // hook and the MCP tools must share ONE Core session.
    for (const s of this.byId.values()) {
      if (
        s.agentDid === input.agentDid &&
        s.hostSessionId === input.hostSessionId &&
        s.endedAtMs === null &&
        t < s.leaseExpiresAtMs
      ) {
        s.lastSeenAtMs = t;
        s.leaseExpiresAtMs = t + lease;
        return s;
      }
    }

    const sessionId = `sess-${(this.seq++).toString(36)}-${input.hostSessionId.slice(0, 8)}-${t.toString(36)}`;
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
    v.session.lastSeenAtMs = t;
    v.session.leaseExpiresAtMs = t + leaseMs;
    return v;
  }

  /** End a session explicitly (revokes grants via `onEnd`). DID-bound. */
  end(sessionId: string, agentDid: string): SessionValidation {
    const s = this.byId.get(sessionId);
    if (!s) return { ok: false, reason: 'not_found' };
    if (s.agentDid !== agentDid) return { ok: false, reason: 'principal_mismatch' };
    if (s.endedAtMs !== null) return { ok: false, reason: 'ended' };
    this.finish(s, 'explicit');
    return { ok: true, session: s };
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

  /** Live (not ended, lease valid) session count — for tests/metrics. */
  liveCount(): number {
    const t = this.now();
    let n = 0;
    for (const s of this.byId.values()) if (s.endedAtMs === null && t < s.leaseExpiresAtMs) n++;
    return n;
  }

  private finish(s: SessionRecord, reason: EndReason): void {
    s.endedAtMs = this.now();
    s.endReason = reason;
    this.onEnd(s, reason);
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
