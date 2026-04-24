/**
 * D2D arrival → nudge notification end-to-end.
 *
 * Exercises the CAPABILITIES.md flow Python calls
 * `guardian.process_event`: a D2D message arrives via staging ingest
 * with `ingress_channel='d2d'` + `origin_did=<sender>`, the drain
 * resolves it, `handlePostPublish` runs (reminders / identity /
 * contact-update), then the drain emits the `d2d_received` event
 * which:
 *
 *   1. Classifies Silence-First priority (fiduciary / solicited /
 *      engagement).
 *   2. For fiduciary + solicited: assembles a nudge from the
 *      sender's vault history + scratchpad-checkpoints step 1 + 2
 *      for crash recovery.
 *   3. Hands a notification envelope to `options.onD2DReceived`
 *      which in production maps to Core's `/v1/notify`.
 *
 * Tier-3 (engagement) items log silently — no envelope is produced.
 * This asserts both paths.
 */


import { createCoreRouter } from '@dina/core/src/server/core_server';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';
import {
  ingest as stagingIngest,
  resetStagingState,
} from '@dina/core/src/staging/service';
import { clearVaults, storeItem } from '@dina/core/src/vault/crud';
import {
  resetReasoningProvider,
  setAccessiblePersonas,
} from '../../src/vault_context/assembly';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import type {
  StagingDrainCoreClient,
  D2DReceivedNotification,
} from '../../src/staging/drain';
import {
  configureRateLimiter,
  registerPublicKeyResolver,
} from '@dina/core/src/auth/middleware';
import {
  addContact,
  resetContactDirectory,
} from '@dina/core/src/contacts/directory';
import { resetReminderState } from '@dina/core/src/reminders/service';
import {
  clearCheckpoints,
  readCheckpoint,
} from '../../src/scratchpad/lifecycle';
import { resetNudgeFrequency } from '../../src/nudge/assembler';

import {
  openSQLiteVault,
  closeSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

describe('D2D arrival → nudge notification (Sancho Moment)', () => {
  const openHandles: SQLiteVaultHandle[] = [];
  let scheduler: StagingDrainScheduler;

  const COVERED_PERSONAS = ['general', 'personal', 'financial'];

  beforeEach(() => {
    resetStagingState();
    clearVaults();
    resetContactDirectory();
    resetReasoningProvider();
    resetReminderState();
    clearCheckpoints();
    resetNudgeFrequency();
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
    resetContactDirectory();
    resetReminderState();
    clearCheckpoints();
    resetNudgeFrequency();
  });

  /**
   * Build an `InProcessTransport` bound to a fresh router. This is the
   * production mobile wiring — Brain + Core share the RN JS VM so there's
   * no HTTP hop + no signing. The transport natively implements
   * `StagingDrainCoreClient` (= `Pick<CoreClient, staging_methods>`)
   * so the drain scheduler consumes it directly without an adapter.
   */
  function buildCoreClient(): InProcessTransport {
    const router = createCoreRouter();
    return new InProcessTransport(router);
  }

  /**
   * Seed the contact directory + a prior vault note so the nudge
   * assembler has context to stitch into the notification.
   */
  function seedSanchoContext(): void {
    addContact('did:plc:sancho', 'Sancho', 'verified');
    // Prior context the nudge assembler should surface.
    storeItem('general', {
      type: 'user_memory',
      summary: 'Sancho is my best friend from college, loves craft beer',
      body: 'Sancho is my best friend from college, loves craft beer',
      sender: 'self',
      sender_trust: 'self',
      timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, // a week ago
    });
  }

  it('fiduciary-tier D2D message → notification envelope delivered', async () => {
    seedSanchoContext();

    const core = buildCoreClient();
    const delivered: D2DReceivedNotification[] = [];

    // Ingest a D2D message — the critical knobs are
    // `ingress_channel='d2d'` + `origin_did=<sender>` so the drain's
    // D2D branch fires + the trust scorer sees a known contact.
    // Summary mentions "security alert" so the deterministic
    // silence-first classifier picks tier 1 (fiduciary).
    stagingIngest({
      source: 'd2d',
      source_id: 'd2d-1',
      producer_id: 'sancho',
      data: {
        type: 'message',
        summary: 'Security alert — someone tried to log into your bank account',
        body: 'Security alert — someone tried to log into your bank account',
        ingress_channel: 'd2d',
        origin_did: 'did:plc:sancho',
      },
    });

    scheduler = new StagingDrainScheduler({
      core,
      drain: {
        onD2DReceived: async (n) => {
          delivered.push(n);
        },
      },
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    const tick = await scheduler.runTick();
    expect(tick.stored).toBe(1);
    expect(tick.failed).toBe(0);

    // Notification landed.
    expect(delivered).toHaveLength(1);
    const notif = delivered[0]!;
    expect(notif.tier).toBe(1);
    expect(notif.interrupt).toBe(true);
    // Deterministic routing: no LLM is wired (resetReasoningProvider in
    // beforeEach), so `classifyDomain`'s keyword rules run — "bank"/"bank
    // account" lands in FINANCIAL_STRONG and routes to the `financial`
    // persona. Strict assertion so any classifier regression that drops
    // this rule surfaces in CI instead of passing vacuously with
    // `toBeTruthy()`.
    expect(notif.persona).toBe('financial');
    // Either the assembled nudge summary (when vault context found)
    // OR the raw message body — both mention Sancho/security.
    expect(notif.body.length).toBeGreaterThan(0);
    expect(notif.title).toBe('Sancho');

    // Scratchpad was cleaned up on success — no leftover state.
    const cp = await readCheckpoint(notif.taskId);
    expect(cp).toBeNull();
  });

  it('engagement-tier D2D message → silent log, no notification', async () => {
    seedSanchoContext();

    const core = buildCoreClient();
    const delivered: D2DReceivedNotification[] = [];

    // Engagement-tier content: a casual catch-up message. No urgency
    // markers → deterministic silence-first defaults to tier 3.
    stagingIngest({
      source: 'd2d',
      source_id: 'd2d-2',
      producer_id: 'sancho',
      data: {
        type: 'message',
        summary: 'saw a cool movie last night',
        body: 'Thought you might enjoy it too',
        ingress_channel: 'd2d',
        origin_did: 'did:plc:sancho',
      },
    });

    scheduler = new StagingDrainScheduler({
      core,
      drain: {
        onD2DReceived: async (n) => {
          delivered.push(n);
        },
      },
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    await scheduler.runTick();

    // Silent log → no envelope delivered. Silence-First: Law 1.
    expect(delivered).toHaveLength(0);
  });

  it('non-D2D items never call onD2DReceived (drain branch gating)', async () => {
    const core = buildCoreClient();
    const delivered: D2DReceivedNotification[] = [];

    // User /remember — ingress_channel NOT 'd2d'.
    stagingIngest({
      source: 'user_remember',
      source_id: 'note-1',
      producer_id: 'user',
      data: {
        type: 'user_memory',
        summary: 'Security alert — a remember note about bank',
        body: 'Just a note I wanted to save',
      },
    });

    scheduler = new StagingDrainScheduler({
      core,
      drain: {
        onD2DReceived: async (n) => {
          delivered.push(n);
        },
      },
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    await scheduler.runTick();

    expect(delivered).toHaveLength(0);
  });
});
