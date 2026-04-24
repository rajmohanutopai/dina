/**
 * Mobile `/remember <birthday>` → reminders auto-created end-to-end.
 *
 * Exercises the CAPABILITIES.md flow:
 *
 *   /remember Emma's birthday is on Nov 7th
 *     → stagingIngest (staging inbox)
 *     → StagingDrainScheduler.runTick
 *         → claim + classify + enrich + resolve → SQLite vault row
 *         → handlePostPublish  ← the piece we just wired
 *             → planReminders (deterministic date extractor)
 *             → core.createReminder rows appear in the identity DB
 *
 * Backed by a real SQLite vault per persona (via
 * `sqlite_vault_harness`). The assertion is intentionally strict:
 * `listByPersona` must surface reminders for the stored item + at
 * least one must carry `kind: 'birthday'` with a future `due_at`.
 * Without today's `handlePostPublish` wire, the reminder planner
 * never ran from the drain — this test would fail with 0 reminders.
 */


import { createCoreRouter } from '@dina/core/src/server/core_server';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';
import {
  ingest as stagingIngest,
  resetStagingState,
} from '@dina/core/src/staging/service';
import { clearVaults } from '@dina/core/src/vault/crud';
import { setAccessiblePersonas, resetReasoningProvider } from '../../src/vault_context/assembly';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import {
  configureRateLimiter,
  registerPublicKeyResolver,
} from '@dina/core/src/auth/middleware';
import {
  listByPersona as listRemindersByPersona,
  resetReminderState,
} from '@dina/core/src/reminders/service';

import {
  openSQLiteVault,
  closeSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

describe('mobile `/remember <birthday>` → auto-generated reminders (CAPABILITIES.md parity)', () => {
  const openHandles: SQLiteVaultHandle[] = [];
  let scheduler: StagingDrainScheduler;

  const COVERED_PERSONAS = ['general', 'personal', 'health', 'family'];

  beforeEach(() => {
    resetStagingState();
    clearVaults();
    resetReasoningProvider();
    resetReminderState();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });
    for (const persona of COVERED_PERSONAS) {
      openHandles.push(openSQLiteVault(persona));
    }
    setAccessiblePersonas(COVERED_PERSONAS);
  });

  afterEach(() => {
    scheduler?.stop();
    while (openHandles.length > 0) {
      closeSQLiteVault(openHandles.pop()!);
    }
    resetReminderState();
  });

  function buildCoreClient(): InProcessTransport {
    const router = createCoreRouter();
    return new InProcessTransport(router);
  }

  // `makeAdapter` removed — `InProcessTransport` natively implements
  // `StagingDrainCoreClient` (= Pick<CoreClient, staging_methods>).

  it("/remember Emma's birthday → reminder rows appear (kind=birthday, future due_at)", async () => {
    const core = buildCoreClient();

    // Use next year so the due_at is guaranteed to be in the future
    // regardless of when this test runs. Format matches what
    // `planReminders`'s deterministic extractor parses (MM/DD or
    // "Month DDth" both work — go with the natural wording Python's
    // example uses).
    const nextYear = new Date().getUTCFullYear() + 1;
    const text = `Emma's birthday is on Nov 7th, ${nextYear}`;

    stagingIngest({
      source: 'user_remember',
      source_id: text,
      producer_id: 'user',
      data: {
        type: 'user_memory',
        summary: text,
        body: text,
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
    const tick = await scheduler.runTick();
    expect(tick.stored).toBe(1);
    expect(tick.failed).toBe(0);

    // Post-publish summary — this is the smoking gun. Without the
    // drain's `handlePostPublish` wire, `postPublish` is undefined
    // + `remindersCreated` never increments.
    const result = tick.results[0]!;
    expect(result.postPublish).toBeDefined();
    expect(result.postPublish!.remindersCreated).toBeGreaterThan(0);
    expect(result.postPublish!.errors).toEqual([]);

    // Actual reminder rows — assert `kind='birthday'` + `due_at`
    // strictly in the future. `listByPersona('general')` because
    // CAPABILITIES.md shows "/remember ... birthday" landing in the
    // general vault.
    const reminders = listRemindersByPersona('general');
    expect(reminders.length).toBeGreaterThan(0);

    const birthday = reminders.find((r) => r.kind === 'birthday');
    expect(birthday).toBeDefined();
    expect(birthday!.due_at).toBeGreaterThan(Date.now());
    expect(birthday!.message.toLowerCase()).toContain('emma');
    expect(birthday!.source_item_id).toBeTruthy();
    expect(birthday!.persona).toBe('general');
  });

  it('/remember with no temporal event → 0 reminders (no false-positives)', async () => {
    const core = buildCoreClient();

    stagingIngest({
      source: 'user_remember',
      source_id: 'flat note',
      producer_id: 'user',
      data: {
        type: 'user_memory',
        summary: 'Alonso prefers window seats on flights',
        body: 'Alonso prefers window seats on flights',
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
    const tick = await scheduler.runTick();
    expect(tick.stored).toBe(1);
    const result = tick.results[0]!;
    expect(result.postPublish).toBeDefined();
    // Deterministic extractor has nothing to match — 0 reminders.
    // Proves post-publish ran without hallucinating dates.
    expect(result.postPublish!.remindersCreated).toBe(0);
    expect(result.postPublish!.errors).toEqual([]);

    // No reminder rows in any persona.
    const all = COVERED_PERSONAS.flatMap((p) => listRemindersByPersona(p));
    expect(all).toHaveLength(0);
  });
});
