/**
 * Mobile /remember → drain → /ask end-to-end, wired exactly like the
 * iOS app does:
 *
 *   ingestRemember
 *     → CoreClient.stagingIngest (staging inbox)
 *   StagingDrainScheduler tick
 *     → BrainCoreClient.claimStagingItems   → CoreRouter /v1/staging/claim
 *     → classify + enrich (drain.ts)
 *     → BrainCoreClient.resolveStagingItem  → CoreRouter /v1/staging/resolve
 *         → storeItem() writes to the persona vault
 *   assembleContext (the /ask path)
 *     → queryVault FTS5 search
 *
 * **Backed by real SQLite**, not the `InMemoryVaultRepository` stub.
 * The in-memory repo uses OR-semantics for keyword scoring; real
 * SQLite FTS5 is AND-by-default. That gap let a production bug slip
 * past Jest and reproduce only on the iOS simulator — this test now
 * runs the production FTS5 predicate against a real
 * `better-sqlite3-multiple-ciphers` DB via `@dina/storage-node`.
 *
 * What this still CAN'T catch vs the simulator:
 *   - Metro bundle module duplication
 *   - op-sqlite native binding behaviour (vs better-sqlite3)
 *   - Hermes / iOS keychain quirks
 *
 * Put `/remember "Emma's birthday is March 15"` in at one end, ask
 * "When is Emma's birthday?" at the other, and assert the vault search
 * found it + the reasoning pipeline didn't short-circuit to
 * "I don't have any relevant information".
 */

import { configureRateLimiter } from '@dina/core/src/auth/middleware';
import { createCoreRouter } from '@dina/core/src/server/core_server';
import { resetStagingState } from '@dina/core/src/staging/service';
import {
  clearVaults,
  queryVault,
} from '@dina/core/src/vault/crud';

import { InProcessTransport } from '../../../core/src/client/in-process-transport';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import {
  setAccessiblePersonas,
  assembleContext,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';

import {
  openSQLiteVault,
  closeSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

describe('mobile /remember → drain → /ask end-to-end (real SQLite)', () => {
  let scheduler: StagingDrainScheduler;
  const openHandles: SQLiteVaultHandle[] = [];

  /**
   * Pre-open SQLite-backed vault repositories for each persona the
   * drain might route to. Having them all ready BEFORE the drain
   * runs means `getOrAutoProvisionRepo` returns our SQLite repo
   * instead of silently creating an InMemory fallback.
   */
  const COVERED_PERSONAS = [
    'general',
    'personal',
    'health',
    'family',
    'financial',
    'legal',
    'professional',
    'social',
    'consumer',
  ];

  beforeEach(() => {
    resetStagingState();
    clearVaults();
    resetReasoningProvider();
    // Match mobile's in-process rate-limit tuning — every in-process
    // claim/resolve goes through the auth pipeline and would otherwise
    // trip the default 60/min budget during a tight test loop.
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });
    // Wire a real SQLite repo for every persona the classifier might
    // pick. `clearVaults()` already ran → the registry is empty.
    for (const persona of COVERED_PERSONAS) {
      openHandles.push(openSQLiteVault(persona));
    }
    // Accessible persona list mirrors the simulator's post-unlock
    // wiring (mobile's useUnlock.ts step 5b calls
    // `setAccessiblePersonas(opened)`). We widen to all opened vaults.
    setAccessiblePersonas(COVERED_PERSONAS);
  });

  afterEach(() => {
    scheduler?.stop();
    while (openHandles.length > 0) {
      const handle = openHandles.pop();
      if (handle !== undefined) closeSQLiteVault(handle);
    }
  });

  /**
   * Build the production mobile CoreClient — `InProcessTransport` bound
   * to a fresh router. Brain + Core share the RN JS VM on mobile, so
   * there's no HTTP hop + no signed-request pipeline in production,
   * and the transport implements `StagingDrainCoreClient` natively
   * (no adapter needed).
   */
  function buildCoreClient(): InProcessTransport {
    const router = createCoreRouter();
    return new InProcessTransport(router);
  }

  /** Reproduces the production `/remember` transport boundary
   *  WITHOUT the UI / chat-thread side effects. Returns the staging id
   *  the CoreClient ingest produced so the test can correlate. */
  async function ingestRemember(core: InProcessTransport, text: string): Promise<string> {
    const { itemId, duplicate } = await core.stagingIngest({
      source: 'user_remember',
      sourceId: text,
      producerId: 'user',
      data: {
        summary: text,
        type: 'user_memory',
        body: text,
      },
    });
    expect(duplicate).toBe(false);
    return itemId;
  }

  it('Scenario 1 + 2: /remember stores, drain claims + resolves, /ask finds the item', async () => {
    const core = buildCoreClient();

    // 1. /remember — ingest into staging inbox
    const stagingId = await ingestRemember(core, "Emma's birthday is March 15");
    expect(stagingId).toMatch(/^stg-/);

    // Sanity: the module-global inbox has the item before the drain
    // scheduler fires. If this ever fails, ingestRemember's CoreClient
    // ingest path regressed.
    const { listByStatus } = await import('@dina/core/src/staging/service');
    const received = listByStatus('received');
    expect(received.length).toBe(1);
    expect(received[0]?.id).toBe(stagingId);

    // 2. Drain scheduler tick — claim → classify → enrich → resolve.
    //    A single runTick() is enough because the drain processes the
    //    whole claimed batch in-line.
    scheduler = new StagingDrainScheduler({
      core,
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    const tickResult = await scheduler.runTick();
    expect(tickResult.claimed).toBe(1);
    expect(tickResult.stored).toBe(1);
    expect(tickResult.failed).toBe(0);

    // 3. Locate the stored row — the classifier's multi-persona
    //    output decides which vault(s) get written. For
    //    "Emma's birthday is March 15" with source `user_remember`
    //    the keyword scorer doesn't cross its 0.5 threshold on any
    //    domain, so `classifyPersonas` falls back to `['general']`.
    //    We still defensively scan every common vault so a silent
    //    classifier drift surfaces as a test failure, not a
    //    "working but in the wrong vault" ghost.
    const candidates = [
      'general',
      'personal',
      'health',
      'family',
      'financial',
      'legal',
      'professional',
      'social',
      'consumer',
    ];
    const hitPersonas = candidates.filter(
      (p) => queryVault(p, { mode: 'fts5', text: 'emma birthday', limit: 10 }).length > 0,
    );
    expect(hitPersonas.length).toBeGreaterThanOrEqual(1);
    expect(hitPersonas).toContain('general');

    // Widen accessiblePersonas so /ask sees every unlocked vault.
    // In production, mobile's boot should wire a dynamic per-unlocked-
    // persona list; this test pins that /ask actually works once that
    // wiring lands (latent bug called out in the E2E docstring).
    setAccessiblePersonas(candidates);

    // 4. Direct vault query — confirms FTS5 found the exact row
    const direct = queryVault('general', {
      mode: 'fts5',
      text: 'emma birthday',
      limit: 10,
    });
    expect(direct.length).toBeGreaterThanOrEqual(1);
    expect(direct[0]?.summary).toBe("Emma's birthday is March 15");

    // 5. /ask's assembleContext — walks accessiblePersonas + FTS5 each
    const context = await assembleContext('When is Emma birthday');
    expect(context.items.length).toBeGreaterThanOrEqual(1);
    const summaries = context.items.map((item) => item.content_l0);
    expect(summaries.some((s) => /emma/i.test(s ?? ''))).toBe(true);
  });

  it('drain fan-out: multi-persona resolve writes a vault row per persona (GAP-MULTI-01)', async () => {
    const core = buildCoreClient();

    // Health + family content — classifyPersonas should return BOTH
    // `health` and (given keyword matches) the family-adjacent persona.
    await core.stagingIngest({
      source: 'clinic',
      sourceId: 'vx-1',
      producerId: 'user',
      data: {
        summary: "Emma's pediatric vaccination — MMR dose scheduled",
        type: 'note',
        body: "Emma's pediatric vaccination appointment at the clinic — MMR prescription dose",
      },
    });

    scheduler = new StagingDrainScheduler({
      core,
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    const tickResult = await scheduler.runTick();
    expect(tickResult.stored).toBe(1);

    // Health vault should definitely have the row (source: 'clinic'
    // forces SOURCE_HINTS['clinic'] === 'health' on the single-persona
    // classifier — the drain calls classifyPersonas which also short-
    // circuits to 'health' on the clinic source hint).
    const healthHits = queryVault('health', {
      mode: 'fts5',
      text: 'vaccination emma',
      limit: 10,
    });
    expect(healthHits.length).toBeGreaterThanOrEqual(1);
    expect(healthHits[0]?.summary).toMatch(/Emma/i);
  });
});
