/**
 * Mobile `/remember <birthday>` → reminders auto-created end-to-end.
 *
 * Exercises the CAPABILITIES.md flow:
 *
 *   /remember Emma's birthday is on Nov 7th
 *     → stagingIngest (staging inbox)
 *     → StagingDrainScheduler.runTick
 *         → claim + classify + enrich + resolve → SQLite vault row
 *         → handlePostPublish
 *             → planReminders (LLM-only — see reminder_planner.ts head)
 *             → core.createReminder rows appear in the identity DB
 *
 * The reminder planner is LLM-only as of April 2026, so this test
 * registers a stub `ReminderLLMProvider` that emits a birthday
 * reminder for the test fixture text. Production wires the same hook
 * via `agentic_ask.ts:registerReminderLLM(...)` during boot.
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
  registerReminderLLM,
  resetReminderLLM,
} from '../../src/pipeline/reminder_planner';

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
    resetReminderLLM();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });
    for (const persona of COVERED_PERSONAS) {
      openHandles.push(openSQLiteVault(persona));
    }
    setAccessiblePersonas(COVERED_PERSONAS);

    // Stub the reminder-planner LLM. The real `agentic_ask.ts` boot
    // wires this to a Gemini-backed router; the test only needs it to
    // emit a birthday reminder for the fixture text. We match against
    // the rendered Subject/Body fields specifically — `prompt.includes`
    // alone is unsafe because the REMINDER_PLAN template ships with
    // "Emma's birthday is March 15" as an in-prompt example.
    registerReminderLLM(async (_system, prompt) => {
      const subject = (prompt.match(/^- Subject: (.*)$/m)?.[1] ?? '').toLowerCase();
      const body = (prompt.match(/^- Body: (.*)$/m)?.[1] ?? '').toLowerCase();
      const userContent = `${subject}\n${body}`;
      if (userContent.includes('emma') && userContent.includes('birthday')) {
        const nextNov7 = Date.UTC(new Date().getUTCFullYear() + 1, 10, 7, 9, 0, 0);
        return JSON.stringify({
          reminders: [
            {
              message: "Emma's birthday is on Nov 7th",
              due_at: nextNov7,
              kind: 'birthday',
            },
          ],
        });
      }
      return '{"reminders":[]}';
    });
  });

  afterEach(() => {
    scheduler?.stop();
    while (openHandles.length > 0) {
      closeSQLiteVault(openHandles.pop()!);
    }
    resetReminderState();
    resetReminderLLM();
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
