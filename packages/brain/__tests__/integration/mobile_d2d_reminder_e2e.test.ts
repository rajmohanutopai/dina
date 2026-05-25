/**
 * D2D arrival → drain → auto-generated reminder, end-to-end.
 *
 * Exercises the full live pipeline a phone B sees when phone A sends a
 * D2D message that contains a reminder-worthy event:
 *
 *   A: makeDinaMessage({ body: "Maya's birthday is on Nov 7th" })
 *      → sealMessage (NaCl seal + Ed25519 sign)
 *
 *   wire: opaque sealed bytes (what MsgBox carries)
 *
 *   B: receiveD2D
 *      → unseal + verify + replay-check + trust-gate
 *      → receiveAndStage → ingest into staging
 *
 *   B: StagingDrainScheduler.runTick
 *      → claim + classify + enrich + resolve → SQLite vault row
 *      → handlePostPublish → planReminders (deterministic extractor)
 *        → core.createReminder rows in the identity DB
 *
 * Why this exists: the existing D2D test (`mobile_d2d_e2e.test.ts`)
 * stops at staging — `expect(result.action).toBe('staged')`. The
 * D2D-nudge test (`mobile_d2d_nudge_e2e.test.ts`) exercises the drain
 * but bypasses `receiveD2D` by calling `stagingIngest` directly with
 * hand-rolled `ingress_channel='d2d'`/`origin_did` keys. Neither test
 * covers the seam where `stageMessage` decides which keys land on the
 * staging row. A reminder-bearing D2D message walks every layer of the
 * pipeline, so any missing field (no `summary`, no `ingress_channel`,
 * no `origin_did`) shows up as zero reminders here even though the
 * other two suites stay green.
 */

import {
  getPublicKey,
  sealMessage,
  receiveD2D,
  resetStagingState,
  stagingListByStatus as listByStatus,
  stagingGetItem as getStagingItem,
  clearVaults,
  configureRateLimiter,
  addContact as addDirectoryContact,
  resetContactDirectory,
  setPeopleRepository,
  createCoreRouter,
  clearReplayCache,
  InProcessTransport,
} from '@dina/core';
import { addContact, clearGatesState } from '@dina/core/d2d';
import {
  setAccessiblePersonas,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import type { D2DReceivedNotification } from '../../src/staging/drain';
import {
  listByPersona as listRemindersByPersona,
  createReminder,
  listPending,
  resetReminderState,
} from '@dina/core/reminders';
import { setReminderBackend } from '../../src/reminders/backend';
import { getThread, resetThreads } from '../../src/chat/thread';
import { postReminderCard } from '../../src/chat/reminder_card';
import { makeDinaMessage, resetFactoryCounters, makeFakePeopleRepo } from '@dina/test-harness';
import { MSG_TYPE_SOCIAL_UPDATE } from '@dina/protocol';
import {
  registerReminderLLM,
  resetReminderLLM,
} from '../../src/pipeline/reminder_planner';

import {
  openSQLiteVault,
  closeSQLiteVault,
  type SQLiteVaultHandle,
} from './helpers/sqlite_vault_harness';

describe('D2D arrival → drain → auto-generated reminder', () => {
  // Two nodes share this Jest process, each with its own Ed25519
  // keypair. Deterministic seeds so audit and replay output stay
  // reproducible.
  const aliceSeed = new Uint8Array(32).fill(0x11);
  const alicePub = getPublicKey(aliceSeed);
  const aliceDID = 'did:plc:alice-d2d-reminder';
  const bobSeed = new Uint8Array(32).fill(0x22);
  const bobPub = getPublicKey(bobSeed);

  const COVERED_PERSONAS = ['general', 'personal', 'family'];

  const openHandles: SQLiteVaultHandle[] = [];
  let scheduler: StagingDrainScheduler;

  beforeEach(() => {
    clearGatesState();
    resetStagingState();
    clearVaults();
    resetContactDirectory();
    setPeopleRepository(makeFakePeopleRepo());
    resetReasoningProvider();
    resetReminderState();
    resetReminderLLM();
    resetThreads();
    clearReplayCache();
    resetFactoryCounters();
    configureRateLimiter({ maxRequests: 10_000, windowSeconds: 60 });
    for (const persona of COVERED_PERSONAS) {
      openHandles.push(openSQLiteVault(persona));
    }
    setAccessiblePersonas(COVERED_PERSONAS);

    // Stub the reminder-planner LLM. Real boots wire this through
    // `agentic_ask.ts:registerReminderLLM(...)` against Gemini; the
    // tests just need it to emit reminders that match each fixture.
    // We scope the match to the rendered Subject/Body fields — the
    // REMINDER_PLAN template embeds "Emma's birthday is March 15" as
    // an in-prompt example, so a flat `prompt.includes` would
    // false-match every test.
    registerReminderLLM(async (_system, prompt) => {
      const subject = (prompt.match(/^- Subject: (.*)$/m)?.[1] ?? '').toLowerCase();
      const body = (prompt.match(/^- Body: (.*)$/m)?.[1] ?? '').toLowerCase();
      const userContent = `${subject}\n${body}`;
      if (userContent.includes('maya') && userContent.includes('birthday')) {
        const nextNov7 = Date.UTC(new Date().getUTCFullYear() + 1, 10, 7, 9, 0, 0);
        return JSON.stringify({
          reminders: [
            {
              message: "Maya's birthday is on Nov 7th",
              due_at: nextNov7,
              kind: 'birthday',
            },
          ],
        });
      }
      if (userContent.includes('coming in 15 minutes')) {
        // Mirror the previous deterministic regex behaviour: arrival
        // event with a 5-min lead → reminder fires 10 min from now.
        const dueAt = Date.now() + 10 * 60 * 1000;
        return JSON.stringify({
          reminders: [
            {
              message: 'I am coming in 15 minutes',
              due_at: dueAt,
              kind: 'arrival',
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
    resetContactDirectory();
    resetReminderState();
    resetReminderLLM();
    // A test may install a reminder backend to simulate lite's
    // over-HTTP reminder path; clear it so the in-process default
    // returns for the others.
    setReminderBackend(null);
    clearReplayCache();
  });

  function buildCoreClient(): InProcessTransport {
    const router = createCoreRouter();
    return new InProcessTransport(router);
  }

  it("sealed 'Maya's birthday is Nov 7' D2D → drain → reminder row appears", async () => {
    // Bob's directory + gates know Alice. Two-step setup mirrors the
    // production split: `addContact` (gates) gates the receive
    // pipeline's trust check; `addDirectoryContact` (contacts) feeds
    // the PeerLens scorer + post-publish contact-update.
    addContact(aliceDID);
    addDirectoryContact(aliceDID, 'Alice', 'verified');

    // Year offset guarantees the due_at stays in the future regardless
    // of wall clock — same trick the /remember reminders test uses.
    const nextYear = new Date().getUTCFullYear() + 1;
    const reminderText = `Maya's birthday is on Nov 7th, ${nextYear}`;

    // ---- NODE A: send side ----
    const message = makeDinaMessage({
      from: aliceDID,
      to: 'did:plc:bob-d2d-reminder',
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: reminderText }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);

    // ---- NODE B: receive side ----
    const receiveResult = receiveD2D(
      sealed,
      bobPub,
      bobSeed,
      [alicePub],
      'contact_ring1',
    );
    expect(receiveResult.action).toBe('staged');
    expect(receiveResult.signatureValid).toBe(true);
    expect(receiveResult.stagingId).toBeTruthy();

    // Sanity: staging inbox has exactly one row in 'received' state.
    const staged = listByStatus('received');
    expect(staged).toHaveLength(1);
    expect(staged[0]!.id).toBe(receiveResult.stagingId);

    // The staging row carries the keys the drain reads to drive the
    // D2D-aware branches (contact_did wire, nudge classification,
    // post_publish sender_did). Without these the drain sees the row
    // as a generic inbox item and silently skips the D2D code paths.
    const stagedRow = getStagingItem(receiveResult.stagingId!)!;
    expect(stagedRow.data.ingress_channel).toBe('d2d');
    expect(stagedRow.data.origin_did).toBe(aliceDID);
    // Plain-text summary so the regex extractor + classifier have
    // something to match. The receive pipeline JSON-stringifies the
    // wire body — staging needs the un-wrapped text.
    expect(stagedRow.data.summary).toContain("Maya's birthday");

    // ---- NODE B: drain ----
    const core = buildCoreClient();
    const nudges: D2DReceivedNotification[] = [];
    scheduler = new StagingDrainScheduler({
      core,
      drain: {
        onD2DReceived: async (n) => {
          nudges.push(n);
        },
        // Host wiring: surface D2D-planned reminders as scheduled chat
        // cards (mirrors apps/mobile boot_service). The drain emits;
        // the host renders.
        onD2DReminderCreated: (r) => postReminderCard('main', r, { scheduled: true }),
      },
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    const tick = await scheduler.runTick();

    expect(tick.failed).toBe(0);
    expect(tick.stored).toBe(1);

    const result = tick.results[0]!;
    // post_publish ran (drain wired it in task 5.470). Strict assert —
    // an undefined `postPublish` means the drain swallowed the hook.
    expect(result.postPublish).toBeDefined();
    expect(result.postPublish!.errors).toEqual([]);

    // The smoking gun: a real D2D message with reminder content must
    // produce at least one reminder. Failure here means either:
    //   (a) summary/body never made it into the staging row → planner
    //       saw an empty payload, or
    //   (b) planReminders ran but extractEvents had nothing to match.
    expect(result.postPublish!.remindersCreated).toBeGreaterThan(0);

    // Reminder rows in the live store. `general` persona because
    // birthdays without an explicit persona route there (matches the
    // /remember reminders test).
    const reminders = COVERED_PERSONAS.flatMap((p) => listRemindersByPersona(p));
    expect(reminders.length).toBeGreaterThan(0);

    const birthday = reminders.find((r) => r.kind === 'birthday');
    expect(birthday).toBeDefined();
    expect(birthday!.due_at).toBeGreaterThan(Date.now());
    expect(birthday!.message.toLowerCase()).toContain('maya');
    expect(birthday!.source_item_id).toBeTruthy();

    // Surfacing: the drain emits the planned reminder via
    // `onD2DReminderCreated`; the host hook (wired above, as
    // boot_service does) posts it as a scheduled card into 'main' — the
    // "Dina prepared this the moment the message arrived" beat.
    const card = getThread('main').find(
      (m) => m.type === 'reminder' && m.metadata?.scheduled === true,
    );
    expect(card).toBeDefined();
    expect(card!.metadata?.reminderKind).toBe('birthday');
    expect((card!.content ?? '').toLowerCase()).toContain('maya');
  });

  it('lite reminder-card read failure (Core HTTP throws) is fail-soft — item still stored', async () => {
    // Regression guard for the #4a boundary: in lite the drain's optional
    // D2D reminder-card lookup goes over Core HTTP and can throw on a
    // transient route/network failure. That read happens AFTER the item's
    // storage + post-publish have already succeeded, so it must never
    // flip the staging item to `failed`.
    addContact(aliceDID);
    addDirectoryContact(aliceDID, 'Alice', 'verified');

    const nextYear = new Date().getUTCFullYear() + 1;
    const message = makeDinaMessage({
      from: aliceDID,
      to: 'did:plc:bob-d2d-reminder',
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: `Maya's birthday is on Nov 7th, ${nextYear}` }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);
    const receiveResult = receiveD2D(sealed, bobPub, bobSeed, [alicePub], 'contact_ring1');
    expect(receiveResult.action).toBe('staged');

    // Simulate lite: create + listPending reach Core fine, but the
    // reminder-card lookup hits a transient Core failure.
    setReminderBackend({
      reminderCreate: async (input) => createReminder(input),
      reminderListByPersona: async () => {
        throw new Error('core unreachable (simulated lite HTTP failure)');
      },
      reminderListPending: async (now) => listPending(now),
    });

    const core = buildCoreClient();
    const logs: Array<Record<string, unknown>> = [];
    scheduler = new StagingDrainScheduler({
      core,
      logger: (e) => logs.push(e),
      drain: {
        onD2DReminderCreated: (r) => postReminderCard('main', r, { scheduled: true }),
      },
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    const tick = await scheduler.runTick();

    // Storage + post-publish succeeded; the thrown reminder-card read did
    // NOT fail the item.
    expect(tick.stored).toBe(1);
    expect(tick.failed).toBe(0);
    // The failure is observable (logged), not swallowed silently.
    expect(
      logs.find((e) => e.event === 'staging.drain.d2d_reminder_read_failed'),
    ).toBeDefined();
    // The reminder write path is independent of the failed read — the
    // reminder was still created (proves we isolated the optional read).
    const created = COVERED_PERSONAS.flatMap((p) => listRemindersByPersona(p));
    expect(created.some((r) => r.kind === 'birthday')).toBe(true);
    // No scheduled card — the read threw before it could emit one.
    expect(getThread('main').filter((m) => m.type === 'reminder')).toHaveLength(0);
  });

  it("'I am coming in 15 minutes' D2D → arrival reminder ~10 min from now", async () => {
    // Real scenario: Alonso messages Sancho "I am coming in 15 minutes"
    // over D2D. Sancho's drain runs the post-publish hook which calls
    // planReminders → extractEvents detects the arrival pattern + relative
    // time, and produces a reminder fire_at = arrival_time - 5min lead.
    //
    // This is the seam Bug #1 ("D2D-to-reminder pipeline silently halted")
    // protects: the message type (coordination.request) maps to vault
    // type 'message', drain stores it, post-publish runs, planner sees
    // a reminder-worthy text. Anything broken in that chain → 0 reminders.
    addContact(aliceDID);
    addDirectoryContact(aliceDID, 'Alonso', 'verified');

    const before = Date.now();
    const arrivalText = 'I am coming in 15 minutes';
    const message = makeDinaMessage({
      from: aliceDID,
      to: 'did:plc:bob-d2d-reminder',
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: arrivalText }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);

    const receiveResult = receiveD2D(
      sealed,
      bobPub,
      bobSeed,
      [alicePub],
      'contact_ring1',
    );
    expect(receiveResult.action).toBe('staged');

    const stagedRow = getStagingItem(receiveResult.stagingId!)!;
    expect(stagedRow.data.summary).toContain('coming in 15 minutes');

    const core = buildCoreClient();
    scheduler = new StagingDrainScheduler({
      core,
      intervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    const tick = await scheduler.runTick();
    const after = Date.now();

    expect(tick.failed).toBe(0);
    expect(tick.stored).toBe(1);

    const result = tick.results[0]!;
    expect(result.postPublish).toBeDefined();
    expect(result.postPublish!.errors).toEqual([]);
    expect(result.postPublish!.remindersCreated).toBeGreaterThanOrEqual(1);

    const reminders = COVERED_PERSONAS.flatMap((p) => listRemindersByPersona(p));
    const arrival = reminders.find((r) => r.kind === 'arrival');
    expect(arrival).toBeDefined();

    // 5-min-before-arrival contract: due_at ≈ now + 10 min.
    expect(arrival!.due_at).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 2000);
    expect(arrival!.due_at).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 2000);
    expect(arrival!.message.toLowerCase()).toContain('coming');
  });

  it('D2D message with no temporal event → 0 reminders (no false-positives)', async () => {
    addContact(aliceDID);
    addDirectoryContact(aliceDID, 'Alice', 'verified');

    const message = makeDinaMessage({
      from: aliceDID,
      to: 'did:plc:bob-d2d-reminder',
      type: MSG_TYPE_SOCIAL_UPDATE,
      body: JSON.stringify({ text: 'thanks for lunch yesterday' }),
    });
    const sealed = sealMessage(message, aliceSeed, bobPub);

    const receiveResult = receiveD2D(
      sealed,
      bobPub,
      bobSeed,
      [alicePub],
      'contact_ring1',
    );
    expect(receiveResult.action).toBe('staged');

    const core = buildCoreClient();
    scheduler = new StagingDrainScheduler({
      core,
      drain: {
        // Hook wired (as in boot) but, with no reminder planned, it must
        // never fire — so no scheduled card appears.
        onD2DReminderCreated: (r) => postReminderCard('main', r, { scheduled: true }),
      },
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
    // Deterministic extractor sees no date → 0 reminders. Proves
    // post_publish runs without hallucinating dates from chitchat.
    expect(result.postPublish!.remindersCreated).toBe(0);
    expect(result.postPublish!.errors).toEqual([]);

    const all = COVERED_PERSONAS.flatMap((p) => listRemindersByPersona(p));
    expect(all).toHaveLength(0);

    // No reminder → no scheduled card posted to chat (Silence First).
    expect(getThread('main').filter((m) => m.type === 'reminder')).toHaveLength(0);
  });
});
