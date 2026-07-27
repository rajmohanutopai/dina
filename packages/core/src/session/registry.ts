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

import { isOwnerAuthority, type AuthorityOrigin } from '../agent/gating_policy';

import type { SessionRepository } from './repository';

export const DEFAULT_LEASE_MS = 15 * 60 * 1000; // 15 min — matches §15 Codex reap default
export const SESSION_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_IN_MEMORY_SESSION_TOMBSTONES = 2_048;
const MAX_DURABLE_SESSION_TOMBSTONES = 4_096;

export type EndReason = 'explicit' | 'lease_lapsed' | 'authority_revoked';

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
  endReason: EndReason | null;
  /**
   * Core-bound task provenance. Null means no non-owner task is currently
   * attached; it does not itself prove owner presence.
   */
  authorityOrigin: AuthorityOrigin | null;
}

export interface StartSessionInput {
  agentDid: string;
  hostSessionId: string;
  leaseMs?: number;
  /**
   * Optional origin stamped by a trusted Core adapter when creating a session.
   * Public session routes never copy this from request bodies.
   */
  authorityOrigin?: AuthorityOrigin;
}

export type SessionValidation =
  | { ok: true; session: SessionRecord }
  | { ok: false; reason: 'not_found' | 'principal_mismatch' | 'ended' | 'lease_lapsed' };

export type SessionAuthorityBinding =
  | { ok: true; session: SessionRecord }
  | {
      ok: false;
      reason: 'not_found' | 'principal_mismatch' | 'ended' | 'lease_lapsed' | 'authority_conflict';
    };

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
    try {
      this.repo.pruneEnded?.(
        this.now() - SESSION_TOMBSTONE_RETENTION_MS,
        MAX_DURABLE_SESSION_TOMBSTONES,
      );
    } catch {
      // Retention is maintenance, not an authorization input. Boot must still
      // load and reap the durable live sessions; another pass can retry.
    }
    this.byId.clear();
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

    // Reuse the one live Core session for this principal + host session
    // (F-04), even while it carries a non-owner authority reservation. A host
    // must not escape that reservation by calling session-start again.
    for (const s of this.byId.values()) {
      if (
        s.agentDid === input.agentDid &&
        s.hostSessionId === input.hostSessionId &&
        s.endedAtMs === null &&
        t < s.leaseExpiresAtMs
      ) {
        const requestedOrigin = input.authorityOrigin ?? null;
        if (
          requestedOrigin !== null &&
          s.authorityOrigin !== null &&
          !sameAuthorityOrigin(s.authorityOrigin, requestedOrigin)
        ) {
          throw new Error('session: host session already carries another authority origin');
        }
        const renewed = {
          ...s,
          lastSeenAtMs: t,
          leaseExpiresAtMs: t + lease,
          authorityOrigin: s.authorityOrigin ?? requestedOrigin,
        };
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
      authorityOrigin: input.authorityOrigin ?? null,
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
  renew(
    sessionId: string,
    agentDid: string,
    leaseMs: number = DEFAULT_LEASE_MS,
  ): SessionValidation {
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

  /**
   * End every live session for one authenticated principal.
   *
   * Device/backend revocation is principal-wide authority revocation. Merely
   * revoking context tickets is insufficient because re-pairing the same key
   * recreates the same DID and could make a pre-revocation session usable
   * again. Each tombstone is persisted before its cleanup hook runs.
   *
   * Cleanup is best-effort across all matching sessions: one failed durable
   * write or hook must not prevent later sessions from being cut. `ok: false`
   * tells the durable revocation caller to retry the cascade.
   */
  endAllForPrincipal(agentDid: string): { ended: number; ok: boolean } {
    const sessions = [...this.byId.values()].filter(
      (session) => session.agentDid === agentDid && session.endedAtMs === null,
    );
    let ended = 0;
    let ok = true;
    for (const session of sessions) {
      try {
        this.finish(session, 'authority_revoked');
        ended += 1;
      } catch {
        // `finish` publishes the tombstone before invoking cleanup. Count a
        // committed tombstone even when a cleanup hook failed, but still report
        // the cascade as incomplete so callers retry ancillary cleanup.
        if (this.byId.get(session.sessionId)?.endedAtMs !== null) ended += 1;
        ok = false;
      }
    }
    return { ended, ok };
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.byId.get(sessionId);
  }

  /**
   * True only when this exact live session may act under the requested origin.
   *
   * An ordinary owner session has no bound non-owner origin. Once Core binds a
   * service/contact/delegation origin, the session may act only for that exact
   * task provenance until it is cleared.
   */
  authorizesAuthorityOrigin(sessionId: string, agentDid: string, origin: AuthorityOrigin): boolean {
    const validation = this.validate(sessionId, agentDid);
    if (!validation.ok) return false;
    return isOwnerAuthority(origin)
      ? validation.session.authorityOrigin === null
      : sameAuthorityOrigin(validation.session.authorityOrigin, origin);
  }

  /** Whether any live session for this principal carries the exact origin. */
  hasSessionAuthorizing(agentDid: string, origin: AuthorityOrigin): boolean {
    return this.listActive(agentDid).some((session) =>
      isOwnerAuthority(origin)
        ? session.authorityOrigin === null
        : sameAuthorityOrigin(session.authorityOrigin, origin),
    );
  }

  /**
   * Attach a non-owner task origin to a live session.
   *
   * Owner authority cannot be manufactured through this method. Foreground
   * owner status is resolved separately from an owner-selected agent binding.
   */
  bindNonOwnerAuthorityOrigin(
    sessionId: string,
    agentDid: string,
    origin: AuthorityOrigin,
  ): SessionAuthorityBinding {
    if (isOwnerAuthority(origin)) {
      throw new Error('session: owner authority cannot be bound as task context');
    }
    const v = this.validate(sessionId, agentDid);
    if (!v.ok) return v;
    if (v.session.authorityOrigin !== null) {
      return sameAuthorityOrigin(v.session.authorityOrigin, origin)
        ? v
        : { ok: false, reason: 'authority_conflict' };
    }
    const updated = { ...v.session, authorityOrigin: { ...origin } };
    this.persist(updated);
    this.byId.set(sessionId, updated);
    return { ok: true, session: updated };
  }

  /**
   * Reserve a live session for one exact authority origin.
   *
   * Owner work may use only an unreserved session. Non-owner work atomically
   * binds an unreserved session, or reuses an identical reservation after a
   * process/transport retry. It can never overwrite another task's origin.
   */
  activateAuthorityOrigin(sessionId: string, agentDid: string, origin: AuthorityOrigin): boolean {
    if (isOwnerAuthority(origin)) {
      return this.authorizesAuthorityOrigin(sessionId, agentDid, origin);
    }
    return this.bindNonOwnerAuthorityOrigin(sessionId, agentDid, origin).ok;
  }

  /**
   * Clear only the exact task context the caller expects to own. Comparing the
   * complete origin, rather than only a correlation id, prevents a stale
   * completion from clearing a newer task's non-owner safety floor.
   */
  clearAuthorityOrigin(
    sessionId: string,
    agentDid: string,
    origin: AuthorityOrigin,
  ): SessionValidation {
    const v = this.validate(sessionId, agentDid);
    if (!v.ok) return v;
    if (!sameAuthorityOrigin(v.session.authorityOrigin, origin)) {
      return v;
    }
    const updated = { ...v.session, authorityOrigin: null };
    this.persist(updated);
    this.byId.set(sessionId, updated);
    return { ok: true, session: updated };
  }

  /**
   * Whether a live session can accept this work without overwriting another
   * task. Used only for routing eligibility; claim still performs the durable
   * activation CAS.
   */
  hasSessionAvailableForAuthority(agentDid: string, origin: AuthorityOrigin): boolean {
    return this.listActive(agentDid).some((session) =>
      isOwnerAuthority(origin)
        ? session.authorityOrigin === null
        : session.authorityOrigin === null || sameAuthorityOrigin(session.authorityOrigin, origin),
    );
  }

  /**
   * Whether this authenticated principal is currently executing any non-owner
   * work.
   *
   * The floor is principal-wide for shared agent façades and host tool gates.
   * Otherwise a compromised host could reserve one session for a service task,
   * mint/use a second session, and regain owner-level facade access while the
   * non-owner task was still active.
   */
  hasActiveNonOwnerAuthority(agentDid: string): boolean {
    return this.listActive(agentDid).some((session) => session.authorityOrigin !== null);
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
    try {
      this.onEnd(ended, reason);
    } finally {
      this.pruneEndedTombstones();
    }
    return ended;
  }

  private pruneEndedTombstones(): void {
    const cutoff = this.now() - SESSION_TOMBSTONE_RETENTION_MS;
    const ended = [...this.byId.values()]
      .filter((session) => session.endedAtMs !== null)
      .sort(
        (left, right) =>
          (right.endedAtMs ?? 0) - (left.endedAtMs ?? 0) ||
          right.sessionId.localeCompare(left.sessionId),
      );
    for (const [index, session] of ended.entries()) {
      if ((session.endedAtMs ?? 0) < cutoff || index >= MAX_IN_MEMORY_SESSION_TOMBSTONES) {
        this.byId.delete(session.sessionId);
      }
    }
    try {
      this.repo?.pruneEnded?.(cutoff, MAX_DURABLE_SESSION_TOMBSTONES);
    } catch {
      // The end tombstone is already durable. Retention maintenance can retry
      // on the next end or boot without changing the authorization result.
    }
  }
}

function sameAuthorityOrigin(left: AuthorityOrigin | null, right: AuthorityOrigin | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.ownerDid === right.ownerDid &&
    left.requesterDid === right.requesterDid &&
    left.ingress === right.ingress &&
    left.correlationId === right.correlationId &&
    left.authenticatedAtMs === right.authenticatedAtMs &&
    left.evidenceHash === right.evidenceHash
  );
}

// ─── Module-global registry (matches the codebase's service-global pattern) ───

let registry: SessionRegistry | null = null;

/** The process session registry; auto-provisions an in-memory one on first use. */
export function getSessionRegistry(): SessionRegistry {
  if (registry === null) registry = new SessionRegistry();
  return registry;
}

/** Return the installed registry without manufacturing authority during teardown. */
export function getSessionRegistryIfConfigured(): SessionRegistry | null {
  return registry;
}

/** Install a registry (e.g. with a grant-revoking `onEnd`) at bootstrap. */
export function setSessionRegistry(r: SessionRegistry | null): void {
  registry = r;
}
