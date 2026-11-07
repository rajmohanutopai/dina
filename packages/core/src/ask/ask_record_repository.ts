/**
 * Durable ask records (FIXES F11): what Brain needs to pick an ask back up
 * after a restart.
 *
 * Brain's ask registry kept every record in memory, so an ask waiting on the
 * owner's approval was gone after a restart, and the owner's yes did nothing.
 * Brain now writes the record through to Core, which keeps it here.
 *
 * WHAT IS KEPT, AND WHAT IS NOT. The question, who asked, the status, the
 * approval it waits on and the routing hints. Never the paused loop state and
 * never the answer: both hold tool results read from the owner's personas,
 * and this table lives in identity.sqlite, outside every persona's own
 * encrypted file. The question already sits beside the owner's chat in the
 * same database. A record restored without paused state resumes by running
 * the question again (Pattern B in Brain's resumer).
 *
 * Only live records are kept: Brain deletes a record when it ends.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type StoredAskStatus = 'in_flight' | 'pending_approval';

export interface StoredAskRecord {
  id: string;
  question: string;
  requesterDid: string;
  sessionId?: string;
  askAuthority?: string;
  status: StoredAskStatus;
  createdAtMs: number;
  updatedAtMs: number;
  deadlineMs: number;
  forcedSources?: string[];
  conversation?: string;
  approvalId?: string;
}

export interface AskRecordRepository {
  /** Insert or replace the record with this id. */
  put(record: StoredAskRecord): void;
  list(): StoredAskRecord[];
  /** True when a row was removed. */
  delete(id: string): boolean;
}

const COLUMNS =
  'id, question, requester_did, session_id, ask_authority, status, created_at, updated_at, ' +
  'deadline_at, forced_sources_json, conversation, approval_id';

function fromRow(r: DBRow): StoredAskRecord | null {
  const status = String(r.status);
  if (status !== 'in_flight' && status !== 'pending_approval') return null;
  const opt = (v: unknown): string | undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;
  let forced: string[] | undefined;
  const forcedJson = opt(r.forced_sources_json);
  if (forcedJson !== undefined) {
    try {
      const parsed: unknown = JSON.parse(forcedJson);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) forced = parsed;
    } catch {
      forced = undefined; // a hint only; the ask runs without it
    }
  }
  const sessionId = opt(r.session_id);
  const askAuthority = opt(r.ask_authority);
  const conversation = opt(r.conversation);
  const approvalId = opt(r.approval_id);
  return {
    id: String(r.id),
    question: String(r.question),
    requesterDid: String(r.requester_did),
    status,
    createdAtMs: Number(r.created_at),
    updatedAtMs: Number(r.updated_at),
    deadlineMs: Number(r.deadline_at),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(askAuthority !== undefined ? { askAuthority } : {}),
    ...(forced !== undefined ? { forcedSources: forced } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
    ...(approvalId !== undefined ? { approvalId } : {}),
  };
}

export class SQLiteAskRecordRepository implements AskRecordRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(record: StoredAskRecord): void {
    this.db.execute(
      `INSERT OR REPLACE INTO ask_records (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.question,
        record.requesterDid,
        record.sessionId ?? '',
        record.askAuthority ?? '',
        record.status,
        record.createdAtMs,
        record.updatedAtMs,
        record.deadlineMs,
        record.forcedSources !== undefined ? JSON.stringify(record.forcedSources) : '',
        record.conversation ?? '',
        record.approvalId ?? '',
      ],
    );
  }

  list(): StoredAskRecord[] {
    return this.db
      .query(`SELECT ${COLUMNS} FROM ask_records ORDER BY created_at ASC`)
      .map(fromRow)
      .filter((r): r is StoredAskRecord => r !== null);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM ask_records WHERE id = ?', [id]) > 0;
  }
}

export class InMemoryAskRecordRepository implements AskRecordRepository {
  private readonly rows = new Map<string, StoredAskRecord>();

  put(record: StoredAskRecord): void {
    this.rows.set(record.id, { ...record });
  }

  list(): StoredAskRecord[] {
    return [...this.rows.values()]
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((r) => ({ ...r }));
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }
}

let repo: AskRecordRepository | null = null;
export function setAskRecordRepository(r: AskRecordRepository | null): void {
  repo = r;
}
export function getAskRecordRepository(): AskRecordRepository | null {
  return repo;
}

/**
 * Read a wire body (snake_case) into a record. Takes the listed fields only,
 * so a paused state or an answer in the body is dropped, not stored. Null
 * when a required field is missing or the status is not a live one.
 */
export function wireToStoredAskRecord(body: unknown): StoredAskRecord | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const id = str(b.id);
  const question = typeof b.question === 'string' ? b.question : undefined;
  const requesterDid = str(b.requester_did);
  const status = b.status;
  const createdAtMs = num(b.created_at_ms);
  const updatedAtMs = num(b.updated_at_ms);
  const deadlineMs = num(b.deadline_ms);
  if (
    id === undefined ||
    question === undefined ||
    requesterDid === undefined ||
    (status !== 'in_flight' && status !== 'pending_approval') ||
    createdAtMs === undefined ||
    updatedAtMs === undefined ||
    deadlineMs === undefined
  ) {
    return null;
  }
  const forced = Array.isArray(b.forced_sources)
    ? b.forced_sources.filter((s): s is string => typeof s === 'string')
    : undefined;
  const sessionId = str(b.session_id);
  const askAuthority = str(b.ask_authority);
  const conversation = str(b.conversation);
  const approvalId = str(b.approval_id);
  return {
    id,
    question,
    requesterDid,
    status,
    createdAtMs,
    updatedAtMs,
    deadlineMs,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(askAuthority !== undefined ? { askAuthority } : {}),
    ...(forced !== undefined ? { forcedSources: forced } : {}),
    ...(conversation !== undefined ? { conversation } : {}),
    ...(approvalId !== undefined ? { approvalId } : {}),
  };
}

export function storedAskRecordToWire(r: StoredAskRecord): Record<string, unknown> {
  return {
    id: r.id,
    question: r.question,
    requester_did: r.requesterDid,
    status: r.status,
    created_at_ms: r.createdAtMs,
    updated_at_ms: r.updatedAtMs,
    deadline_ms: r.deadlineMs,
    ...(r.sessionId !== undefined ? { session_id: r.sessionId } : {}),
    ...(r.askAuthority !== undefined ? { ask_authority: r.askAuthority } : {}),
    ...(r.forcedSources !== undefined ? { forced_sources: r.forcedSources } : {}),
    ...(r.conversation !== undefined ? { conversation: r.conversation } : {}),
    ...(r.approvalId !== undefined ? { approval_id: r.approvalId } : {}),
  };
}
