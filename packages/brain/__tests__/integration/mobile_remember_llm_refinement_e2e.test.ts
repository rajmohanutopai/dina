/**
 * /remember with LLM refinement — asserts the registered LLM providers
 * for the reminder planner + identity extractor actually run during
 * the drain tick.
 *
 * Uses FAKE LLM providers registered via the same public hooks
 * (`registerReminderLLM`, `registerIdentityExtractor`) that mobile
 * boot uses in `boot_capabilities.ts::buildLightweightLLMCall`.
 * The fakes return canned JSON matching the production prompt
 * contracts so the pipelines actually wire through without needing
 * a real Gemini key for this test.
 *
 * What this proves:
 *   - reminder_planner's LLM hook fires (llmRefined=true in postPublish)
 *   - identity_extraction's LLM hook fires (identityLinksFound > 0)
 *   - Both land in `StagingProcessResult.postPublish` after resolve
 *
 * Real-LLM coverage stays in
 * `persona_classification_real_llm_100.test.ts` and
 * `mobile_ask_real_llm_15_scenarios.test.ts`. This file keeps the
 * wiring gate deterministic + fast.
 */


import { createCoreRouter } from '@dina/core/src/server/core_server';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';
import {
  ingest as stagingIngest,
  resetStagingState,
} from '@dina/core/src/staging/service';
import { clearVaults } from '@dina/core/src/vault/crud';
import {
  resetReasoningProvider,
  setAccessiblePersonas,
} from '../../src/vault_context/assembly';
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
  registerIdentityExtractor,
  resetIdentityExtractor,
} from '../../src/pipeline/identity_extraction';

import {
  openSQLiteVault,
  closeSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

describe('mobile `/remember` — LLM refinement hooks fire on post-publish', () => {
  const openHandles: SQLiteVaultHandle[] = [];
  let scheduler: StagingDrainScheduler;

  const COVERED_PERSONAS = ['general', 'personal', 'health', 'family'];

  beforeEach(() => {
    resetStagingState();
    clearVaults();
    resetReasoningProvider();
    resetReminderState();
    resetReminderLLM();
    resetIdentityExtractor();
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
    resetReminderLLM();
    resetIdentityExtractor();
  });

  function buildCoreClient(): InProcessTransport {
    const router = createCoreRouter();
    return new InProcessTransport(router);
  }

  it("reminder_planner's LLM hook fires + refines birthday reminder", async () => {
    const fake = jest.fn(async () => {
      // `parseReminderPlan` contract: `{reminders: [{due_at, message,
      // kind}]}`. Production dedup skips LLM reminders within 1 day
      // of a deterministic one (same kind), so we pick a day the
      // deterministic extractor doesn't stamp — Nov 5, two days
      // before Emma's Nov 7 birthday. That leaves the LLM's "day-
      // before-the-day-before" planning reminder visible so the
      // assertion can tell whether the LLM output actually landed.
      const nextYear = new Date().getUTCFullYear() + 1;
      const due = new Date(Date.UTC(nextYear, 10, 5, 9, 0, 0)).getTime();
      return JSON.stringify({
        reminders: [
          {
            due_at: due,
            message:
              "Emma's birthday is in 2 days — she loves dinosaurs, you may want to pick up a gift.",
            kind: 'birthday',
          },
        ],
        summary: '1 planning reminder set for Emma',
      });
    });
    registerReminderLLM(fake);

    const core = buildCoreClient();
    const nextYear = new Date().getUTCFullYear() + 1;
    const text = `Emma's birthday is on Nov 7th, ${nextYear}`;

    stagingIngest({
      source: 'user_remember',
      source_id: text,
      producer_id: 'user',
      data: { type: 'user_memory', summary: text, body: text },
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

    // LLM actually got called.
    expect(fake).toHaveBeenCalledTimes(1);

    const result = tick.results[0]!;
    expect(result.postPublish).toBeDefined();
    expect(result.postPublish!.llmRefinedReminders).toBe(true);
    expect(result.postPublish!.remindersCreated).toBeGreaterThan(0);
    expect(result.postPublish!.errors).toEqual([]);

    // Reminder row carries the LLM-authored message text.
    const reminders = listRemindersByPersona('general');
    const llmAuthored = reminders.find((r) => r.message.includes('dinosaurs'));
    expect(llmAuthored).toBeDefined();
    expect(llmAuthored!.kind).toBe('birthday');
  });

  it("identity_extraction's LLM hook fires + counts link(s)", async () => {
    // Identity extractor's prompt contract is
    // `{"identity_links": [{name, relationship, confidence, evidence}]}`.
    const fake = jest.fn(async () => {
      return JSON.stringify({
        identity_links: [
          {
            name: 'Emma',
            relationship: 'child',
            confidence: 'high',
            evidence: 'Emma is my daughter',
          },
        ],
      });
    });
    registerIdentityExtractor(fake);

    const core = buildCoreClient();

    stagingIngest({
      source: 'user_remember',
      source_id: 'Emma is my daughter and she loves dinosaurs',
      producer_id: 'user',
      data: {
        type: 'user_memory',
        summary: 'Emma is my daughter and she loves dinosaurs',
        body: 'Emma is my daughter and she loves dinosaurs',
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

    expect(fake).toHaveBeenCalledTimes(1);

    const result = tick.results[0]!;
    expect(result.postPublish).toBeDefined();
    expect(result.postPublish!.identityLinksFound).toBe(1);
    expect(result.postPublish!.errors).toEqual([]);
  });

  it('LLM failures are fail-open — deterministic reminders still created', async () => {
    // Fake that always throws — simulates the router rejecting on
    // consent / offline / rate-limit. `handlePostPublish` must still
    // return without the drain marking the item failed.
    registerReminderLLM(async () => {
      throw new Error('upstream 503');
    });
    registerIdentityExtractor(async () => {
      throw new Error('upstream 503');
    });

    const core = buildCoreClient();
    const nextYear = new Date().getUTCFullYear() + 1;
    const text = `Emma's birthday is on Nov 7th, ${nextYear}`;

    stagingIngest({
      source: 'user_remember',
      source_id: text,
      producer_id: 'user',
      data: { type: 'user_memory', summary: text, body: text },
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

    const result = tick.results[0]!;
    expect(result.postPublish).toBeDefined();
    // Deterministic extractor still ran → reminders land.
    expect(result.postPublish!.remindersCreated).toBeGreaterThan(0);
    // llmRefined is false because the LLM threw.
    expect(result.postPublish!.llmRefinedReminders).toBe(false);
    // Identity extraction is deeply fail-soft — `extractIdentityLinks`
    // catches its own LLM errors internally and falls back to the
    // deterministic pass, so `result.errors` stays empty. Key
    // invariant: the drain did not fail the item.
    expect(tick.failed).toBe(0);
  });
});
