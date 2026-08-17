/**
 * The commerce epoch's repo (WS-2.4).
 *
 * The epoch record is the §16.2 restore fence, and its only real
 * requirement is that concurrent writers serialize: two nodes restoring
 * from one backup must not both publish epoch N+1. That property lives
 * entirely in the compare-and-swap, so the fake PDS here ENFORCES swap
 * semantics rather than accepting every write — a fake that always says
 * yes would let a broken publisher pass.
 */



import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { validateCommerceEpochRecord, type Sha256Fn } from '@dina/commerce-protocol';
import { stripRepoEnvelope } from '@dina/home-node';
import {
  IDENTITY_MIGRATIONS,
  InMemoryCommerceQuoteLedgerRepository,
  InMemoryCommerceReceiptRepository,
  QuoteFamilyStore,
  applyMigrations,
  isCommerceRestorePending,
  markCommerceRestorePending,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { wireCommerceEpoch } from '../src/commerce/wire_epoch';

const hash: Sha256Fn = (data) => sha256(data);
const BUSINESS_DID = 'did:plc:supplier5678';
const NOW = Date.parse('2026-08-07T10:00:00.000Z');

const silentLogger = { info: () => undefined, warn: () => undefined };

/**
 * A PDS that behaves like one: `putRecord` honours `swapRecord`, so a
 * stale writer is rejected with `InvalidSwap` exactly as the real server
 * would reject it.
 */
function fakePds() {
  const state: { record: Record<string, unknown> | null; cid: string } = { record: null, cid: '' };
  let counter = 0;
  const calls: { swapRecord: unknown }[] = [];
  /**
   * Runs ONCE, immediately after a read is served. `establishAfterRestore`
   * re-reads at the top of every attempt, so a competing write that lands
   * before that read is not a race at all — the reader simply sees the new
   * value. The only way to make a writer lose is to move the live record
   * AFTER it has read and BEFORE it publishes, which is what this hook is
   * for.
   */
  let afterRead: (() => Promise<void>) | null = null;
  const raceOnNextRead = (fn: () => Promise<void>): void => {
    afterRead = fn;
  };

  const fetchFn = (async (input: string, init?: { body?: unknown }): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (url.includes('com.atproto.server.createSession')) {
      return json({ accessJwt: 'jwt', did: BUSINESS_DID, handle: 'supplier.test' });
    }
    if (url.includes('com.atproto.repo.getRecord')) {
      const answer =
        state.record === null
          ? json({ error: 'RecordNotFound' }, 400)
          : json({ uri: 'at://x', cid: state.cid, value: state.record });
      if (afterRead !== null) {
        const hook = afterRead;
        afterRead = null;
        await hook();
      }
      return answer;
    }
    if (url.includes('com.atproto.repo.putRecord')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ swapRecord: body.swapRecord });
      const expected = body.swapRecord ?? null;
      const actual = state.record === null ? null : state.cid;
      if (expected !== actual) return json({ error: 'InvalidSwap' }, 400);
      counter += 1;
      // The real PDS stamps `$type` into every stored value, and every
      // later read serves it back. Omitting the stamp here hid a live bug:
      // the epoch digest revalidation included the injected field, so a
      // node refused its own record on every boot after the first. The
      // fake must stamp what the real one stamps.
      state.record = {
        $type: String(body.collection),
        ...(body.record as Record<string, unknown>),
      };
      state.cid = `cid-${counter}`;
      return json({ uri: 'at://x', cid: state.cid });
    }
    throw new Error(`unexpected call: ${url}`);
  }) as typeof globalThis.fetch;

  return { fetchFn, state, calls, raceOnNextRead };
}

/**
 * A real Tier-0 database: the fence decision is READ from it (the archive
 * import writes the marker there), so a stub would test a different system.
 */
function openDb(): { adapter: NodeSQLiteAdapter; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-'));
  const adapter = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  return {
    adapter,
    cleanup: () => {
      adapter.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let db: { adapter: NodeSQLiteAdapter; cleanup: () => void };

beforeEach(() => {
  db = openDb();
});
afterEach(() => db.cleanup());

function wire(fetchFn: typeof globalThis.fetch, businessDid = BUSINESS_DID) {
  const ledger = new InMemoryCommerceQuoteLedgerRepository();
  const receipts = new InMemoryCommerceReceiptRepository();
  return wireCommerceEpoch({
    adapter: db.adapter,
    pdsIdentity: {
      did: BUSINESS_DID,
      handle: 'supplier.test',
      password: 'app-password',
      pdsUrl: 'https://pds.test',
    } as never,
    businessDid,
    tx: (fn) => fn(),
    families: new QuoteFamilyStore({
      ledger,
      currentEpoch: () => '1',
      supplierDid: () => businessDid,
      now: () => NOW,
    }),
    receipts,
    logger: silentLogger,
    fetch: fetchFn,
    nowFn: () => NOW,
  });
}

describe('commerce epoch repo wiring', () => {
  it('publishes the genesis with a swap that requires absence', async () => {
    const pds = fakePds();
    const wired = wire(pds.fetchFn);

    const record = await wired.establish();
    expect(record?.epoch).toBe('1');
    expect(record?.reason).toBe('initial');
    // A genesis written WITHOUT `swapRecord: null` would silently
    // overwrite a live chain that this node simply failed to read.
    expect(pds.calls).toEqual([{ swapRecord: null }]);
    expect(wired.service.currentEpoch()).toBe('1');
  });

  it('publishes a record the protocol accepts once the repo envelope is off', async () => {
    const pds = fakePds();
    await wire(pds.fetchFn).establish();
    // What the repo stores carries the PDS's `$type` stamp; what the
    // protocol validates is the record under it. Validating the raw stored
    // value here is exactly the mistake the live reader made.
    expect(pds.state.record).not.toBeNull();
    expect(
      validateCommerceEpochRecord(stripRepoEnvelope(pds.state.record ?? {}), hash),
    ).toBeNull();
    expect(validateCommerceEpochRecord(pds.state.record, hash)).not.toBeNull();
  });

  it('adopts the live record instead of republishing', async () => {
    const pds = fakePds();
    await wire(pds.fetchFn).establish();
    const writesAfterGenesis = pds.calls.length;

    const second = wire(pds.fetchFn);
    const adopted = await second.establish();
    expect(adopted?.epoch).toBe('1');
    expect(pds.calls.length).toBe(writesAfterGenesis);
  });

  it('a restore increments the epoch, swapping on the record it read', async () => {
    const pds = fakePds();
    const wired = wire(pds.fetchFn);
    await wired.establish();
    const genesisCid = pds.state.cid;

    const restored = await wired.service.establishAfterRestore();
    expect(restored.epoch).toBe('2');
    expect(restored.reason).toBe('restore');
    // The swap names the CID we actually read, which is what makes a
    // second restorer lose rather than both believing they published 2.
    expect(pds.calls.at(-1)).toEqual({ swapRecord: genesisCid });
  });

  it('a restorer that loses the race re-reads and re-increments (§16.2)', async () => {
    const pds = fakePds();
    const first = wire(pds.fetchFn);
    await first.establish();
    const second = wire(pds.fetchFn);
    await second.establish();

    // The second node reads epoch 1 and is about to publish epoch 2. The
    // first node publishes epoch 2 in that window, so the second's swap
    // names a CID that is no longer live.
    pds.raceOnNextRead(async () => {
      await first.service.establishAfterRestore();
    });

    const late = await second.service.establishAfterRestore();
    // Exactly one epoch 2 exists, and the loser continued to 3 rather than
    // publishing a second, divergent 2.
    expect(late.epoch).toBe('3');
    expect((pds.state.record as { epoch?: string }).epoch).toBe('3');
    const rejected = pds.calls.filter((c) => c.swapRecord === 'cid-1');
    expect(rejected.length).toBe(2); // both nodes tried to replace the genesis
  });

  it('refuses to publish against a predecessor it did not read', async () => {
    // Two overlapping restores on ONE service interleave fetch and publish,
    // so the cached CID can belong to the OTHER call's read. Swapping on it
    // would replace the winner's epoch 2 with a second, divergent epoch 2 —
    // both chained to the genesis, both claiming the same generation.
    const pds = fakePds();
    const wired = wire(pds.fetchFn);
    await wired.establish();

    const settled = await Promise.allSettled([
      wired.service.establishAfterRestore(),
      wired.service.establishAfterRestore(),
    ]);

    const epochs: string[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') epochs.push(outcome.value.epoch);
    }
    // Whatever the interleaving: no two calls claim the same epoch, and the
    // live record is the highest one anybody published.
    expect(epochs.length).toBeGreaterThan(0);
    expect(new Set(epochs).size).toBe(epochs.length);
    const highest = epochs.reduce((max, e) => (BigInt(e) > BigInt(max) ? e : max), '1');
    expect((pds.state.record as { epoch: string }).epoch).toBe(highest);
  });

  it('refuses a record belonging to another business DID', async () => {
    const pds = fakePds();
    await wire(pds.fetchFn).establish();

    // Same repo, different acting identity: adopting this record would
    // stamp another business's epoch into everything this node signs.
    const foreign = wire(pds.fetchFn, 'did:plc:someoneelse111');
    expect(await foreign.establish()).toBeNull();
    expect(foreign.service.established).toBe(false);
  });

  it('an unreachable repo leaves commerce disabled rather than signing', async () => {
    const unreachable = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;
    const wired = wire(unreachable);

    expect(await wired.establish()).toBeNull();
    expect(wired.service.established).toBe(false);
    expect(() => wired.service.currentEpoch()).toThrow(/fail-closed/);
  });

  it('a corrupt live record is not mistaken for an absent one', async () => {
    const pds = fakePds();
    await wire(pds.fetchFn).establish();
    // Tamper so the digest no longer matches the body.
    (pds.state.record as { epoch: string }).epoch = '77';

    const wired = wire(pds.fetchFn);
    const writesBefore = pds.calls.length;
    expect(await wired.establish()).toBeNull();
    // The crucial part: it did not even ATTEMPT a write. Asserting only
    // that the record is unchanged would pass while treating the corrupt
    // record as absent, because the swap would reject the genesis anyway —
    // the CAS would be doing the work, not the validation.
    expect(pds.calls.length).toBe(writesBefore);
    expect((pds.state.record as { epoch?: string }).epoch).toBe('77');
  });
});

/**
 * §16.2 / WS-4.2 — the restore fence, decided at boot.
 *
 * The archive carries the commerce operational tables on purpose, including
 * the USE COUNTERS. A restored node that adopts the live epoch unchanged has
 * every restored quote head matching it, so capacity already spent is
 * spendable again — the resurrection the fence exists to prevent, arriving
 * through the front door rather than through a bug in the fence.
 */
describe('commerce restore fence at boot', () => {
  it('a normal boot ADOPTS the live epoch — no gratuitous increment', async () => {
    const pds = fakePds();
    await wire(pds.fetchFn).establish();
    expect((pds.state.record as { epoch: string }).epoch).toBe('1');

    const second = wire(pds.fetchFn);
    await second.establish();
    // Still 1. A boot that always incremented would void live capacity on
    // every restart, which is a different way to lose a supplier's business.
    expect((pds.state.record as { epoch: string }).epoch).toBe('1');
  });

  it('a boot after import INCREMENTS the epoch and clears the marker', async () => {
    const pds = fakePds();
    await wire(pds.fetchFn).establish();

    // What the archive import does, in its own transaction.
    markCommerceRestorePending(db.adapter, NOW);
    expect(isCommerceRestorePending(db.adapter)).toBe(true);

    const restored = wire(pds.fetchFn);
    const record = await restored.establish();

    expect(record?.epoch).toBe('2');
    expect(record?.reason).toBe('restore');
    // Restored quote heads carry epoch 1 and are now STALE against 2, so
    // their counters cannot be spent again.
    expect(isCommerceRestorePending(db.adapter)).toBe(false);
  });

  it('leaves the marker SET when the fence cannot complete', async () => {
    // The obligation outlives the failed attempt. Clearing it here would let
    // a later boot adopt the live epoch and trade on resurrected capacity —
    // silently, because by then nothing remembers a restore happened.
    markCommerceRestorePending(db.adapter, NOW);
    const unreachable = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;

    expect(await wire(unreachable).establish()).toBeNull();
    expect(isCommerceRestorePending(db.adapter)).toBe(true);
  });

  it('retries the fence on the NEXT boot after a failure', async () => {
    markCommerceRestorePending(db.adapter, NOW);
    const unreachable = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;
    await wire(unreachable).establish();

    // Repo comes back. This boot must still fence, not adopt.
    const pds = fakePds();
    const record = await wire(pds.fetchFn).establish();
    // No live record existed, so the fence publishes the genesis; the point
    // is that the marker was consumed by a fence, not skipped.
    expect(record).not.toBeNull();
    expect(isCommerceRestorePending(db.adapter)).toBe(false);
  });

  it('an unreadable kv_store is read as "fence owed"', async () => {
    // Fail closed. "No marker found" is the answer that resurrects capacity,
    // and a database we cannot query is not evidence this node is safe to
    // trade from.
    db.adapter.execute('DROP TABLE kv_store');
    expect(isCommerceRestorePending(db.adapter)).toBe(true);
  });
});
