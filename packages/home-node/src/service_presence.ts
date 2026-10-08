/**
 * The node's presence writer (docs/REAL_LIFE_FIXES.md §14.4 A): one
 * node-wide, serial writer of `com.dinakernel.service.presence/self`.
 *
 * A listing on AppView outlives the node that published it. While the node
 * holds at least one published listing (public or unlisted; friends-only
 * listings never reach the repository), this writer renews a presence record
 * about once a day, and AppView judges liveness by when it received the
 * renewals. The record names the node's published listings as `{rkey, cid}`,
 * read from the node's own repository at write time, so the set is always
 * what the repository actually holds.
 *
 * Rules:
 *   - It writes only while the node can receive queries (`inboundUp`): a
 *     node that cannot answer does not claim to be alive. A run that finds
 *     the inbound path down is kept pending and runs on `nudge()` (the host
 *     calls it on reconnect).
 *   - Writes are serial; a `nudge()` during a run causes one more run after
 *     it, so the last write always reflects the latest listings.
 *   - Every write is a compare-and-swap against the CID this writer last
 *     saw. With no stored CID (first run, an upgrade, a restore onto a new
 *     device) it reads the record first; when a swap is lost (a crash after
 *     the PDS took a write but before the CID was stored) it reads the
 *     current CID and writes again. It never gets stuck on a stale CID.
 *   - Over `MAX_PUBLISHED_LISTINGS` listings it writes `complete: false` with
 *     an empty set and is judged by its renewals alone.
 *   - With no published listing it deletes the presence record.
 *
 * Its state (last success, last CID) lives in Core's KV store, so the "over
 * 22 h old" rule and the swap survive restarts.
 */

import {
  MAX_PUBLISHED_LISTINGS,
  presenceNonce,
  SERVICE_PRESENCE_COLLECTION,
  SERVICE_PRESENCE_RKEY,
  SERVICE_PRESENCE_VERSION,
  SERVICE_PROFILE_COLLECTION,
  type ServicePresenceRecord,
} from '@dina/protocol';

/** The repository operations the writer needs (the node's PDS client). */
export interface PresenceRepo {
  listRecords(collection: string): Promise<{ rkey: string; cid: string }[]>;
  getRecord(collection: string, rkey: string): Promise<{ cid: string } | null>;
  putRecord(
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
    options: { swapRecord: string | null },
  ): Promise<{ cid: string }>;
  deleteRecord(collection: string, rkey: string, options: { swapRecord: string }): Promise<void>;
}

/** Durable writer state (Core KV). */
export interface PresenceState {
  /** When the last write (or delete) succeeded, ms. */
  lastOkAt: number;
  /** CID of the presence record as last seen, or null when there is none. */
  cid: string | null;
}

export interface PresenceStateStore {
  get(): Promise<PresenceState | null>;
  set(state: PresenceState): Promise<void>;
}

export type PresenceOutcome =
  | { status: 'written'; cid: string; listings: number; complete: boolean }
  | { status: 'deleted' }
  | { status: 'none' }
  | { status: 'waiting_inbound' }
  | { status: 'failed'; error: string };

export interface ServicePresenceWriterOptions {
  repo: PresenceRepo;
  store: PresenceStateStore;
  /** True while the node can receive queries (MsgBox connected, where used). */
  inboundUp: () => boolean;
  randomBytes: (n: number) => Uint8Array;
  nowMs?: () => number;
  /** Renew when the last success is older than this. Default 22 h. */
  renewAfterMs?: number;
  /** Metadata-only diagnostics. */
  onOutcome?: (outcome: PresenceOutcome) => void;
}

export const PRESENCE_RENEW_AFTER_MS = 22 * 60 * 60 * 1000;
/** Lost swaps retried per run before giving up until the next one. */
const MAX_SWAP_ATTEMPTS = 3;

/** True when the PDS refused a write because the record changed under it. */
function isSwapLost(err: unknown): boolean {
  const e = err as { casLost?: unknown; xrpcError?: unknown };
  return e?.casLost === true || e?.xrpcError === 'InvalidSwap';
}

export class ServicePresenceWriter {
  private readonly repo: PresenceRepo;
  private readonly store: PresenceStateStore;
  private readonly inboundUp: () => boolean;
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly nowMs: () => number;
  private readonly renewAfterMs: number;
  private readonly onOutcome: (o: PresenceOutcome) => void;

  private running: Promise<PresenceOutcome> | null = null;
  private again = false;
  /** A run found the inbound path down; write as soon as it is back. */
  private waitingInbound = false;

  constructor(options: ServicePresenceWriterOptions) {
    this.repo = options.repo;
    this.store = options.store;
    this.inboundUp = options.inboundUp;
    this.randomBytes = options.randomBytes;
    this.nowMs = options.nowMs ?? Date.now;
    this.renewAfterMs = options.renewAfterMs ?? PRESENCE_RENEW_AFTER_MS;
    this.onOutcome = options.onOutcome ?? (() => undefined);
  }

  /**
   * The listings changed, or the inbound path came back: write now. Serial;
   * a nudge during a run makes one more run after it.
   */
  nudge(): Promise<PresenceOutcome> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let outcome: PresenceOutcome;
      do {
        this.again = false;
        outcome = await this.runOnce();
        this.onOutcome(outcome);
      } while (this.again);
      return outcome;
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * The inbound path is up again (the host calls this on reconnect): write
   * at once if a run was waiting for it, else renew if due.
   */
  onInboundUp(): Promise<PresenceOutcome | null> {
    return this.waitingInbound ? this.nudge() : this.renewIfDue();
  }

  /**
   * Write only if a run is waiting for the inbound path; never a renewal.
   * The phone calls this on reconnect: its relay reconnects when the app
   * comes to the foreground, and a renewal there would tie the public
   * commit to the owner opening the app (§14.5).
   */
  flushWaiting(): Promise<PresenceOutcome | null> {
    return this.waitingInbound ? this.nudge() : Promise.resolve(null);
  }

  /** Renew if the last success is older than the renewal age. */
  async renewIfDue(): Promise<PresenceOutcome | null> {
    const state = await this.store.get().catch(() => null);
    if (state !== null && this.nowMs() - state.lastOkAt < this.renewAfterMs) return null;
    return this.nudge();
  }

  private async runOnce(): Promise<PresenceOutcome> {
    if (!this.inboundUp()) {
      this.waitingInbound = true;
      return { status: 'waiting_inbound' };
    }
    this.waitingInbound = false;
    try {
      const profiles = await this.repo.listRecords(SERVICE_PROFILE_COLLECTION);
      let cid = await this.knownCid();
      for (let attempt = 0; attempt < MAX_SWAP_ATTEMPTS; attempt += 1) {
        try {
          if (profiles.length === 0) {
            if (cid !== null) {
              await this.repo.deleteRecord(SERVICE_PRESENCE_COLLECTION, SERVICE_PRESENCE_RKEY, { swapRecord: cid });
            }
            await this.store.set({ lastOkAt: this.nowMs(), cid: null });
            return cid !== null ? { status: 'deleted' } : { status: 'none' };
          }
          const complete = profiles.length <= MAX_PUBLISHED_LISTINGS;
          const record: ServicePresenceRecord = {
            $type: SERVICE_PRESENCE_COLLECTION,
            v: SERVICE_PRESENCE_VERSION,
            n: presenceNonce(this.randomBytes),
            listings: complete ? profiles.map((p) => ({ rkey: p.rkey, cid: p.cid })) : [],
            complete,
          };
          const put = await this.repo.putRecord(
            SERVICE_PRESENCE_COLLECTION,
            SERVICE_PRESENCE_RKEY,
            record as unknown as Record<string, unknown>,
            { swapRecord: cid },
          );
          await this.store.set({ lastOkAt: this.nowMs(), cid: put.cid });
          return { status: 'written', cid: put.cid, listings: record.listings.length, complete };
        } catch (err) {
          if (!isSwapLost(err)) throw err;
          // The record is not what this writer last saw: adopt what is there.
          cid = (await this.repo.getRecord(SERVICE_PRESENCE_COLLECTION, SERVICE_PRESENCE_RKEY))?.cid ?? null;
        }
      }
      return { status: 'failed', error: 'swap kept failing' };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The stored CID, or (none stored) what the repository holds now. */
  private async knownCid(): Promise<string | null> {
    const state = await this.store.get().catch(() => null);
    if (state !== null) return state.cid;
    return (await this.repo.getRecord(SERVICE_PRESENCE_COLLECTION, SERVICE_PRESENCE_RKEY))?.cid ?? null;
  }
}

const PRESENCE_STATE_KEY = 'service_presence_state';

/** A state store over Core's KV (`kvGet` / `kvSet`), on either host. */
export function kvPresenceStateStore(kv: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}): PresenceStateStore {
  return {
    async get() {
      const raw = await kv.get(PRESENCE_STATE_KEY);
      if (raw === null) return null;
      try {
        const p = JSON.parse(raw) as Partial<PresenceState>;
        if (typeof p.lastOkAt !== 'number') return null;
        return { lastOkAt: p.lastOkAt, cid: typeof p.cid === 'string' ? p.cid : null };
      } catch {
        return null;
      }
    },
    async set(state) {
      await kv.set(PRESENCE_STATE_KEY, JSON.stringify(state));
    },
  };
}
