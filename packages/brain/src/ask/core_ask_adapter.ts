/**
 * Ask records kept in Core, so an ask waiting on approval survives a restart
 * (FIXES F11). Brain never touches SQLite; it writes through `CoreClient`.
 *
 * The full record stays in memory for this run, paused loop state included,
 * so an approval that lands before a restart resumes at the bail point
 * (Pattern A, no new model call). Core keeps only the safe fields: never the
 * paused state and never the answer, which hold persona content
 * (`@dina/core` `ask/ask_record_repository.ts`). After a restart a record
 * comes back without paused state, and the resumer runs the question again
 * (Pattern B) once the owner approves.
 *
 * Core holds live records only: one that ends is deleted there. A failed write
 * is logged and the ask goes on; durability is lost for that ask, nothing else.
 */

import type { AskPersistenceAdapter, AskRecord } from './ask_registry';
import type { IntentSource } from '../reasoning/intent_classifier';
import type { CoreClient, StoredAskRecord } from '@dina/core';

type AskRecordStore = Pick<CoreClient, 'askRecordPut' | 'askRecordList' | 'askRecordDelete'>;

/** True when `core` can keep ask records (test doubles may not). */
export function canKeepAskRecords(core: unknown): core is AskRecordStore {
  const c = core as Partial<AskRecordStore> | null;
  return (
    c !== null &&
    typeof c?.askRecordPut === 'function' &&
    typeof c.askRecordList === 'function' &&
    typeof c.askRecordDelete === 'function'
  );
}

function toStored(r: AskRecord): StoredAskRecord | null {
  if (r.status !== 'in_flight' && r.status !== 'pending_approval') return null;
  return {
    id: r.id,
    question: r.question,
    requesterDid: r.requesterDid,
    status: r.status,
    createdAtMs: r.createdAtMs,
    updatedAtMs: r.updatedAtMs,
    deadlineMs: r.deadlineMs,
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.askAuthority !== undefined ? { askAuthority: r.askAuthority } : {}),
    ...(r.forcedSources !== undefined ? { forcedSources: [...r.forcedSources] } : {}),
    ...(r.conversation !== undefined ? { conversation: r.conversation } : {}),
    ...(r.approvalId !== undefined ? { approvalId: r.approvalId } : {}),
  };
}

function fromStored(s: StoredAskRecord): AskRecord {
  return {
    id: s.id,
    question: s.question,
    requesterDid: s.requesterDid,
    status: s.status,
    createdAtMs: s.createdAtMs,
    updatedAtMs: s.updatedAtMs,
    deadlineMs: s.deadlineMs,
    ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
    ...(s.askAuthority !== undefined ? { askAuthority: s.askAuthority } : {}),
    ...(s.forcedSources !== undefined
      ? { forcedSources: s.forcedSources as readonly IntentSource[] }
      : {}),
    ...(s.conversation !== undefined ? { conversation: s.conversation } : {}),
    ...(s.approvalId !== undefined ? { approvalId: s.approvalId } : {}),
  };
}

function clone(r: AskRecord): AskRecord {
  return {
    ...r,
    ...(r.forcedSources !== undefined ? { forcedSources: [...r.forcedSources] } : {}),
  };
}

export class CoreAskAdapter implements AskPersistenceAdapter {
  private readonly rows = new Map<string, AskRecord>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly core: AskRecordStore,
    private readonly log: (entry: Record<string, unknown>) => void = () => undefined,
  ) {}

  /** Pull Core's records in once. A record already in memory wins. */
  private load(): Promise<void> {
    if (this.loaded === null) {
      this.loaded = this.core
        .askRecordList()
        .then((stored) => {
          for (const s of stored) if (!this.rows.has(s.id)) this.rows.set(s.id, fromStored(s));
          this.log({ event: 'ask_records.restored', count: stored.length });
        })
        .catch((err: unknown) => {
          this.loaded = null; // try again on the next read
          this.log({ event: 'ask_records.restore_failed', error: describe(err) });
        });
    }
    return this.loaded;
  }

  private async writeThrough(record: AskRecord): Promise<void> {
    const stored = toStored(record);
    try {
      if (stored !== null) await this.core.askRecordPut(stored);
      else await this.core.askRecordDelete(record.id);
    } catch (err) {
      this.log({ event: 'ask_records.write_failed', status: record.status, error: describe(err) });
    }
  }

  async insert(record: AskRecord): Promise<void> {
    await this.load();
    if (this.rows.has(record.id)) {
      throw new Error(`CoreAskAdapter.insert: duplicate id ${JSON.stringify(record.id)}`);
    }
    this.rows.set(record.id, clone(record));
    await this.writeThrough(record);
  }

  async update(record: AskRecord): Promise<void> {
    await this.load();
    if (!this.rows.has(record.id)) {
      throw new Error(`CoreAskAdapter.update: unknown id ${JSON.stringify(record.id)}`);
    }
    this.rows.set(record.id, clone(record));
    await this.writeThrough(record);
  }

  async loadAll(): Promise<AskRecord[]> {
    await this.load();
    return [...this.rows.values()].map(clone);
  }

  async get(id: string): Promise<AskRecord | null> {
    await this.load();
    const row = this.rows.get(id);
    return row === undefined ? null : clone(row);
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const removed = this.rows.delete(id);
    try {
      await this.core.askRecordDelete(id);
    } catch (err) {
      this.log({ event: 'ask_records.delete_failed', error: describe(err) });
    }
    return removed;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
