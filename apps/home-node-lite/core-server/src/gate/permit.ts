/**
 * Item 3d — payload-bound single-use permit (Plugin Developer Surface §12.1/§12.6).
 *
 * When Core decides a coding action may proceed — SAFE fast-path, or after the
 * owner approves a MODERATE/HIGH one — it mints a PERMIT bound to a hash of the
 * exact tool payload (tool name + input). The permit is:
 *
 *   • payload-bound — it authorises THIS call, not a class of calls. If the
 *     agent alters the payload after approval (a bait-and-switch), the hash no
 *     longer matches and the call re-gates.
 *   • single-use — consumed on first use; a second attempt fails, so one
 *     approval can never authorise repeated executions.
 *   • principal-bound — tied to the agent DID + session that was gated.
 *   • time-bound — expires, so a stale approval can't be redeemed much later.
 *
 * This is the state half of the gate. The classifiers (3b/3c) decide the risk;
 * the permit records that a specific decision was made and lets exactly one
 * matching execution redeem it.
 */

import { createHash } from 'node:crypto';

import type { RiskLevel } from '@dina/core';

export interface ToolPayload {
  tool: string;
  input: unknown;
}

export interface MintInput {
  action: string;
  risk: RiskLevel;
  payload: ToolPayload;
  agentDid: string;
  sessionId: string;
  /** How the decision was reached — for the audit trail. */
  decision: 'auto' | 'approved';
  /** Time-to-live in ms. Defaults to 5 minutes. */
  ttlMs?: number;
}

export interface PermitRecord {
  permitId: string;
  action: string;
  risk: RiskLevel;
  payloadHash: string;
  agentDid: string;
  sessionId: string;
  decision: 'auto' | 'approved';
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
}

export interface ConsumeInput {
  agentDid: string;
  sessionId: string;
  payload: ToolPayload;
  /** Optional: redeem a specific permit id (else the newest match is used). */
  permitId?: string;
}

export type ConsumeResult =
  | { ok: true; permit: PermitRecord }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_consumed'
        | 'expired'
        | 'payload_mismatch'
        | 'principal_mismatch';
    };

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Deterministic JSON: object keys sorted recursively so the hash is stable. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** SHA-256 (hex) of the canonicalised tool payload. */
export function hashPayload(payload: ToolPayload): string {
  const canonical = stableStringify({ tool: payload.tool, input: payload.input ?? null });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * In-memory permit registry. Item 8 (audit/durable state) can back this with a
 * table; the interface stays the same. `now` is injectable for tests.
 */
export class PermitStore {
  private readonly permits = new Map<string, PermitRecord>();
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  mint(input: MintInput): PermitRecord {
    const createdAtMs = this.now();
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
    // Deterministic, unguessable-enough id from a monotonic seq + payload hash +
    // time. Not a security token on its own — redemption also checks the hash
    // and principal — so a counter-based id is fine and keeps tests reproducible.
    const permitId = `permit_${(this.seq++).toString(36)}_${hashPayload(input.payload).slice(0, 12)}`;
    const record: PermitRecord = {
      permitId,
      action: input.action,
      risk: input.risk,
      payloadHash: hashPayload(input.payload),
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      decision: input.decision,
      createdAtMs,
      expiresAtMs: createdAtMs + ttl,
      consumedAtMs: null,
    };
    this.permits.set(permitId, record);
    return record;
  }

  /**
   * Mint an APPROVED permit bound to a pre-computed payload hash — the owner-
   * approval path (Item B). The approval card never carries the raw tool input
   * (§20), so on approval we cannot re-hash it; the hash was captured when the
   * card was created and travels through the workflow payload. Principal-,
   * time-, and single-use-bound exactly like `mint`.
   */
  mintApprovedFromHash(input: {
    action: string;
    risk: RiskLevel;
    payloadHash: string;
    agentDid: string;
    sessionId: string;
    ttlMs?: number;
  }): PermitRecord {
    const createdAtMs = this.now();
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
    const permitId = `permit_${(this.seq++).toString(36)}_${input.payloadHash.slice(0, 12)}`;
    const record: PermitRecord = {
      permitId,
      action: input.action,
      risk: input.risk,
      payloadHash: input.payloadHash,
      agentDid: input.agentDid,
      sessionId: input.sessionId,
      decision: 'approved',
      createdAtMs,
      expiresAtMs: createdAtMs + ttl,
      consumedAtMs: null,
    };
    this.permits.set(permitId, record);
    return record;
  }

  /**
   * Redeem a permit for an execution. Single-use + payload-bound +
   * principal-bound + time-bound; on success the permit is marked consumed.
   */
  consume(input: ConsumeInput): ConsumeResult {
    const wantHash = hashPayload(input.payload);
    const t = this.now();

    const candidate = input.permitId
      ? this.permits.get(input.permitId)
      : this.newestMatch(input.agentDid, input.sessionId, wantHash);

    if (!candidate) return { ok: false, reason: 'not_found' };
    // Principal binding is checked before payload/consumed state so a caller
    // can never probe another principal's permit lifecycle.
    if (candidate.agentDid !== input.agentDid || candidate.sessionId !== input.sessionId)
      return { ok: false, reason: 'principal_mismatch' };
    if (candidate.payloadHash !== wantHash) return { ok: false, reason: 'payload_mismatch' };
    if (candidate.consumedAtMs !== null) return { ok: false, reason: 'already_consumed' };
    if (t >= candidate.expiresAtMs) return { ok: false, reason: 'expired' };

    candidate.consumedAtMs = t;
    return { ok: true, permit: candidate };
  }

  get(permitId: string): PermitRecord | undefined {
    return this.permits.get(permitId);
  }

  /** Drop consumed/expired permits; returns the count removed. */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [id, p] of this.permits) {
      if (p.consumedAtMs !== null || t >= p.expiresAtMs) {
        this.permits.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.permits.size;
  }

  /** Revoke every transient permit for one authenticated agent binding. */
  revokeForAgent(agentDid: string): number {
    let removed = 0;
    for (const [id, permit] of this.permits) {
      if (permit.agentDid === agentDid) {
        this.permits.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Newest un-consumed, un-expired permit matching principal + payload. */
  private newestMatch(
    agentDid: string,
    sessionId: string,
    payloadHash: string,
  ): PermitRecord | undefined {
    const t = this.now();
    let best: PermitRecord | undefined;
    for (const p of this.permits.values()) {
      if (
        p.agentDid === agentDid &&
        p.sessionId === sessionId &&
        p.payloadHash === payloadHash &&
        p.consumedAtMs === null &&
        t < p.expiresAtMs &&
        (best === undefined || p.createdAtMs > best.createdAtMs)
      ) {
        best = p;
      }
    }
    return best;
  }
}
