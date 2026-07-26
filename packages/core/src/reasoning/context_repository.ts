/**
 * Encrypted-at-rest projection and context-ticket persistence.
 *
 * The identity database is SQLCipher-backed on both mobile and Home Node.
 * Workflow payloads hold only these opaque ids and hashes; raw prompts and
 * minimized vault context stay in this store for a short, explicit lifetime.
 */

import { canonicalJson } from '@dina/protocol';

import { isReasoningSensitivity, reasoningHash, type ReasoningSensitivity } from './domain';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type ReasoningProjectionKind = 'input' | 'context';

/**
 * Completed work may need Core-owned commit replay after its model deadline.
 * Keep unrevoked projections for one bounded recovery window; successful,
 * cancelled, or otherwise revoked work remains eligible for immediate purge.
 */
export const REASONING_PROJECTION_RECOVERY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface ReasoningProjection {
  projectionId: string;
  taskId: string;
  kind: ReasoningProjectionKind;
  ownerDid: string;
  purpose: string;
  sensitivity: ReasoningSensitivity;
  content: unknown;
  contentHash: string;
  scrubbed: boolean;
  allowedEvidenceIds: string[];
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}

export interface ReasoningContextTicket {
  ticketId: string;
  taskId: string;
  claimId: string;
  backendId: string;
  principalDid: string;
  /** Exact Core host session for connected-host claims; null for managed workers. */
  authenticatedSessionId: string | null;
  ownerDid: string;
  purpose: string;
  policyVersion: number;
  inputProjectionId: string;
  contextProjectionId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
  revokedAtMs: number | null;
}

export interface ReasoningContextRepository {
  createProjection(projection: ReasoningProjection): void;
  getProjection(projectionId: string): ReasoningProjection | null;
  deleteProjection(projectionId: string): boolean;
  revokeProjectionsForTask(taskId: string, nowMs?: number): number;
  createTicket(ticket: ReasoningContextTicket): void;
  getTicket(ticketId: string): ReasoningContextTicket | null;
  listTicketsForTask(taskId: string): ReasoningContextTicket[];
  extendTicket(ticketId: string, claimId: string, expiresAtMs: number): boolean;
  consumeTicket(ticketId: string, claimId: string, nowMs?: number): boolean;
  revokeTicket(ticketId: string, nowMs?: number): boolean;
  revokeTicketsForTask(taskId: string, exceptClaimId?: string, nowMs?: number): number;
  revokeTicketsForPrincipal(principalDid: string, nowMs?: number): number;
  revokeTicketsForSession(authenticatedSessionId: string, nowMs?: number): number;
  sweep(nowMs?: number): number;
}

function validDid(value: unknown): value is string {
  return typeof value === 'string' && /^did:[^:\s]+:\S+$/.test(value) && value.length <= 512;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
}

function validOptionalTimestamp(value: number | null): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function validateProjection(projection: ReasoningProjection): void {
  if (
    !validId(projection.projectionId) ||
    !validId(projection.taskId) ||
    (projection.kind !== 'input' && projection.kind !== 'context') ||
    !validDid(projection.ownerDid) ||
    projection.purpose.length < 1 ||
    projection.purpose.length > 512 ||
    !isReasoningSensitivity(projection.sensitivity) ||
    !/^[0-9a-f]{64}$/.test(projection.contentHash) ||
    reasoningHash(projection.content) !== projection.contentHash ||
    !Array.isArray(projection.allowedEvidenceIds) ||
    projection.allowedEvidenceIds.length > 256 ||
    projection.allowedEvidenceIds.some((id) => !validId(id)) ||
    !Number.isSafeInteger(projection.createdAtMs) ||
    !Number.isSafeInteger(projection.expiresAtMs) ||
    projection.expiresAtMs <= projection.createdAtMs ||
    !validOptionalTimestamp(projection.revokedAtMs)
  ) {
    throw new Error('invalid reasoning projection');
  }
}

function validateTicket(ticket: ReasoningContextTicket): void {
  if (
    !validId(ticket.ticketId) ||
    !validId(ticket.taskId) ||
    !validId(ticket.claimId) ||
    !validId(ticket.backendId) ||
    !validDid(ticket.principalDid) ||
    (ticket.authenticatedSessionId !== null && !validId(ticket.authenticatedSessionId)) ||
    !validDid(ticket.ownerDid) ||
    ticket.purpose.length < 1 ||
    ticket.purpose.length > 512 ||
    !Number.isSafeInteger(ticket.policyVersion) ||
    ticket.policyVersion < 1 ||
    !validId(ticket.inputProjectionId) ||
    (ticket.contextProjectionId !== null && !validId(ticket.contextProjectionId)) ||
    !Number.isSafeInteger(ticket.createdAtMs) ||
    !Number.isSafeInteger(ticket.expiresAtMs) ||
    ticket.expiresAtMs <= ticket.createdAtMs ||
    !validOptionalTimestamp(ticket.consumedAtMs) ||
    !validOptionalTimestamp(ticket.revokedAtMs)
  ) {
    throw new Error('invalid reasoning context ticket');
  }
}

function parseEvidence(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((id) => !validId(id))) return null;
    return [...new Set(parsed)];
  } catch {
    return null;
  }
}

function rowToProjection(row: DBRow): ReasoningProjection | null {
  const evidence = parseEvidence(row.allowed_evidence_ids_json);
  let content: unknown;
  try {
    content = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : null;
  } catch {
    return null;
  }
  const projection: ReasoningProjection = {
    projectionId: String(row.projection_id ?? ''),
    taskId: String(row.task_id ?? ''),
    kind: row.kind as ReasoningProjectionKind,
    ownerDid: String(row.owner_did ?? ''),
    purpose: String(row.purpose ?? ''),
    sensitivity: row.sensitivity as ReasoningSensitivity,
    content,
    contentHash: String(row.content_hash ?? ''),
    scrubbed: Number(row.scrubbed) === 1,
    allowedEvidenceIds: evidence ?? [],
    createdAtMs: Number(row.created_at),
    expiresAtMs: Number(row.expires_at),
    revokedAtMs: row.revoked_at == null ? null : Number(row.revoked_at),
  };
  try {
    validateProjection(projection);
    if (evidence === null) return null;
    return projection;
  } catch {
    return null;
  }
}

function rowToTicket(row: DBRow): ReasoningContextTicket | null {
  const ticket: ReasoningContextTicket = {
    ticketId: String(row.ticket_id ?? ''),
    taskId: String(row.task_id ?? ''),
    claimId: String(row.claim_id ?? ''),
    backendId: String(row.backend_id ?? ''),
    principalDid: String(row.principal_did ?? ''),
    authenticatedSessionId: row.session_id == null ? null : String(row.session_id),
    ownerDid: String(row.owner_did ?? ''),
    purpose: String(row.purpose ?? ''),
    policyVersion: Number(row.policy_version),
    inputProjectionId: String(row.input_projection_id ?? ''),
    contextProjectionId:
      row.context_projection_id == null ? null : String(row.context_projection_id),
    createdAtMs: Number(row.created_at),
    expiresAtMs: Number(row.expires_at),
    consumedAtMs: row.consumed_at == null ? null : Number(row.consumed_at),
    revokedAtMs: row.revoked_at == null ? null : Number(row.revoked_at),
  };
  try {
    validateTicket(ticket);
    return ticket;
  } catch {
    return null;
  }
}

const PROJECTION_COLS = [
  'projection_id',
  'task_id',
  'kind',
  'owner_did',
  'purpose',
  'sensitivity',
  'content_json',
  'content_hash',
  'scrubbed',
  'allowed_evidence_ids_json',
  'created_at',
  'expires_at',
  'revoked_at',
].join(', ');

const TICKET_COLS = [
  'ticket_id',
  'task_id',
  'claim_id',
  'backend_id',
  'principal_did',
  'session_id',
  'owner_did',
  'purpose',
  'policy_version',
  'input_projection_id',
  'context_projection_id',
  'created_at',
  'expires_at',
  'consumed_at',
  'revoked_at',
].join(', ');

export class SQLiteReasoningContextRepository implements ReasoningContextRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  createProjection(projection: ReasoningProjection): void {
    validateProjection(projection);
    this.db.execute(
      `INSERT INTO reasoning_projections (${PROJECTION_COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projection.projectionId,
        projection.taskId,
        projection.kind,
        projection.ownerDid,
        projection.purpose,
        projection.sensitivity,
        canonicalJson(projection.content),
        projection.contentHash,
        projection.scrubbed ? 1 : 0,
        JSON.stringify([...new Set(projection.allowedEvidenceIds)].sort()),
        projection.createdAtMs,
        projection.expiresAtMs,
        projection.revokedAtMs,
      ],
    );
  }

  getProjection(projectionId: string): ReasoningProjection | null {
    const row = this.db.query(
      `SELECT ${PROJECTION_COLS} FROM reasoning_projections
       WHERE projection_id = ? LIMIT 1`,
      [projectionId],
    )[0];
    return row ? rowToProjection(row) : null;
  }

  deleteProjection(projectionId: string): boolean {
    return (
      this.db.run(`DELETE FROM reasoning_projections WHERE projection_id = ?`, [projectionId]) === 1
    );
  }

  revokeProjectionsForTask(taskId: string, nowMs: number = Date.now()): number {
    return this.db.run(
      `UPDATE reasoning_projections SET revoked_at = ?
       WHERE task_id = ? AND revoked_at IS NULL`,
      [nowMs, taskId],
    );
  }

  createTicket(ticket: ReasoningContextTicket): void {
    validateTicket(ticket);
    this.db.execute(
      `INSERT INTO reasoning_context_tickets (${TICKET_COLS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ticket.ticketId,
        ticket.taskId,
        ticket.claimId,
        ticket.backendId,
        ticket.principalDid,
        ticket.authenticatedSessionId,
        ticket.ownerDid,
        ticket.purpose,
        ticket.policyVersion,
        ticket.inputProjectionId,
        ticket.contextProjectionId,
        ticket.createdAtMs,
        ticket.expiresAtMs,
        ticket.consumedAtMs,
        ticket.revokedAtMs,
      ],
    );
  }

  getTicket(ticketId: string): ReasoningContextTicket | null {
    const row = this.db.query(
      `SELECT ${TICKET_COLS} FROM reasoning_context_tickets
       WHERE ticket_id = ? LIMIT 1`,
      [ticketId],
    )[0];
    return row ? rowToTicket(row) : null;
  }

  listTicketsForTask(taskId: string): ReasoningContextTicket[] {
    if (!validId(taskId)) throw new Error('invalid reasoning ticket task');
    return this.db
      .query(
        `SELECT ${TICKET_COLS} FROM reasoning_context_tickets
         WHERE task_id = ? ORDER BY created_at ASC, ticket_id ASC`,
        [taskId],
      )
      .map(rowToTicket)
      .filter((ticket): ticket is ReasoningContextTicket => ticket !== null);
  }

  extendTicket(ticketId: string, claimId: string, expiresAtMs: number): boolean {
    return (
      this.db.run(
        `UPDATE reasoning_context_tickets SET expires_at = ?
         WHERE ticket_id = ? AND claim_id = ?
           AND consumed_at IS NULL AND revoked_at IS NULL`,
        [expiresAtMs, ticketId, claimId],
      ) === 1
    );
  }

  consumeTicket(ticketId: string, claimId: string, nowMs: number = Date.now()): boolean {
    return (
      this.db.run(
        `UPDATE reasoning_context_tickets SET consumed_at = ?
         WHERE ticket_id = ? AND claim_id = ?
           AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        [nowMs, ticketId, claimId, nowMs],
      ) === 1
    );
  }

  revokeTicket(ticketId: string, nowMs: number = Date.now()): boolean {
    return (
      this.db.run(
        `UPDATE reasoning_context_tickets SET revoked_at = ?
         WHERE ticket_id = ? AND revoked_at IS NULL`,
        [nowMs, ticketId],
      ) === 1
    );
  }

  revokeTicketsForTask(taskId: string, exceptClaimId?: string, nowMs: number = Date.now()): number {
    return this.db.run(
      `UPDATE reasoning_context_tickets SET revoked_at = ?
       WHERE task_id = ? AND revoked_at IS NULL
         ${exceptClaimId ? 'AND claim_id != ?' : ''}`,
      exceptClaimId ? [nowMs, taskId, exceptClaimId] : [nowMs, taskId],
    );
  }

  revokeTicketsForPrincipal(principalDid: string, nowMs: number = Date.now()): number {
    if (!validDid(principalDid)) throw new Error('invalid reasoning ticket principal');
    return this.db.run(
      `UPDATE reasoning_context_tickets SET revoked_at = ?
       WHERE principal_did = ? AND revoked_at IS NULL`,
      [nowMs, principalDid],
    );
  }

  revokeTicketsForSession(authenticatedSessionId: string, nowMs: number = Date.now()): number {
    if (!validId(authenticatedSessionId)) throw new Error('invalid reasoning ticket session');
    return this.db.run(
      `UPDATE reasoning_context_tickets SET revoked_at = ?
       WHERE session_id = ? AND revoked_at IS NULL`,
      [nowMs, authenticatedSessionId],
    );
  }

  sweep(nowMs: number = Date.now()): number {
    let removed = 0;
    this.db.transaction(() => {
      removed += this.db.run(
        `DELETE FROM reasoning_context_tickets
         WHERE expires_at <= ? OR consumed_at IS NOT NULL OR revoked_at IS NOT NULL`,
        [nowMs],
      );
      removed += this.db.run(
        `DELETE FROM reasoning_projections
         WHERE (expires_at <= ? OR revoked_at IS NOT NULL)
           AND NOT EXISTS (
             SELECT 1 FROM reasoning_context_tickets
             WHERE input_projection_id = reasoning_projections.projection_id
                OR context_projection_id = reasoning_projections.projection_id
           )`,
        [nowMs - REASONING_PROJECTION_RECOVERY_RETENTION_MS],
      );
    });
    return removed;
  }
}

export class InMemoryReasoningContextRepository implements ReasoningContextRepository {
  private readonly projections = new Map<string, ReasoningProjection>();
  private readonly tickets = new Map<string, ReasoningContextTicket>();

  createProjection(projection: ReasoningProjection): void {
    validateProjection(projection);
    if (this.projections.has(projection.projectionId)) throw new Error('duplicate projection');
    this.projections.set(projection.projectionId, cloneJson(projection));
  }

  getProjection(projectionId: string): ReasoningProjection | null {
    const row = this.projections.get(projectionId);
    return row ? cloneJson(row) : null;
  }

  deleteProjection(projectionId: string): boolean {
    return this.projections.delete(projectionId);
  }

  revokeProjectionsForTask(taskId: string, nowMs: number = Date.now()): number {
    let changed = 0;
    for (const row of this.projections.values()) {
      if (row.taskId === taskId && row.revokedAtMs === null) {
        row.revokedAtMs = nowMs;
        changed += 1;
      }
    }
    return changed;
  }

  createTicket(ticket: ReasoningContextTicket): void {
    validateTicket(ticket);
    if (this.tickets.has(ticket.ticketId)) throw new Error('duplicate context ticket');
    this.tickets.set(ticket.ticketId, { ...ticket });
  }

  getTicket(ticketId: string): ReasoningContextTicket | null {
    const row = this.tickets.get(ticketId);
    return row ? { ...row } : null;
  }

  listTicketsForTask(taskId: string): ReasoningContextTicket[] {
    if (!validId(taskId)) throw new Error('invalid reasoning ticket task');
    return [...this.tickets.values()]
      .filter((ticket) => ticket.taskId === taskId)
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs || left.ticketId.localeCompare(right.ticketId),
      )
      .map((ticket) => ({ ...ticket }));
  }

  extendTicket(ticketId: string, claimId: string, expiresAtMs: number): boolean {
    const row = this.tickets.get(ticketId);
    if (
      row === undefined ||
      row.claimId !== claimId ||
      row.consumedAtMs !== null ||
      row.revokedAtMs !== null
    ) {
      return false;
    }
    row.expiresAtMs = expiresAtMs;
    return true;
  }

  consumeTicket(ticketId: string, claimId: string, nowMs: number = Date.now()): boolean {
    const row = this.tickets.get(ticketId);
    if (
      row === undefined ||
      row.claimId !== claimId ||
      row.consumedAtMs !== null ||
      row.revokedAtMs !== null ||
      row.expiresAtMs <= nowMs
    ) {
      return false;
    }
    row.consumedAtMs = nowMs;
    return true;
  }

  revokeTicket(ticketId: string, nowMs: number = Date.now()): boolean {
    const row = this.tickets.get(ticketId);
    if (row === undefined || row.revokedAtMs !== null) return false;
    row.revokedAtMs = nowMs;
    return true;
  }

  revokeTicketsForTask(taskId: string, exceptClaimId?: string, nowMs: number = Date.now()): number {
    let changed = 0;
    for (const row of this.tickets.values()) {
      if (row.taskId === taskId && row.claimId !== exceptClaimId && row.revokedAtMs === null) {
        row.revokedAtMs = nowMs;
        changed += 1;
      }
    }
    return changed;
  }

  revokeTicketsForPrincipal(principalDid: string, nowMs: number = Date.now()): number {
    if (!validDid(principalDid)) throw new Error('invalid reasoning ticket principal');
    let changed = 0;
    for (const row of this.tickets.values()) {
      if (row.principalDid === principalDid && row.revokedAtMs === null) {
        row.revokedAtMs = nowMs;
        changed += 1;
      }
    }
    return changed;
  }

  revokeTicketsForSession(authenticatedSessionId: string, nowMs: number = Date.now()): number {
    if (!validId(authenticatedSessionId)) throw new Error('invalid reasoning ticket session');
    let changed = 0;
    for (const row of this.tickets.values()) {
      if (row.authenticatedSessionId === authenticatedSessionId && row.revokedAtMs === null) {
        row.revokedAtMs = nowMs;
        changed += 1;
      }
    }
    return changed;
  }

  sweep(nowMs: number = Date.now()): number {
    let removed = 0;
    for (const [id, row] of this.tickets) {
      if (row.expiresAtMs <= nowMs || row.consumedAtMs !== null || row.revokedAtMs !== null) {
        this.tickets.delete(id);
        removed += 1;
      }
    }
    for (const [id, row] of this.projections) {
      const referenced = [...this.tickets.values()].some(
        (ticket) => ticket.inputProjectionId === id || ticket.contextProjectionId === id,
      );
      if (
        !referenced &&
        (row.revokedAtMs !== null ||
          row.expiresAtMs + REASONING_PROJECTION_RECOVERY_RETENTION_MS <= nowMs)
      ) {
        this.projections.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

let repository: ReasoningContextRepository | null = null;

export function setReasoningContextRepository(next: ReasoningContextRepository | null): void {
  repository = next;
}

export function getReasoningContextRepository(): ReasoningContextRepository | null {
  return repository;
}
