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

import { getPublicKey } from '@dina/core/src/crypto/ed25519';
import { sealMessage } from '@dina/core/src/d2d/envelope';
import { receiveD2D } from '@dina/core/src/d2d/receive_pipeline';
import { addContact, clearGatesState } from '@dina/core/src/d2d/gates';
import {
  resetStagingState,
  listByStatus,
  getItem as getStagingItem,
} from '@dina/core/src/staging/service';
import { clearVaults } from '@dina/core/src/vault/crud';
import {
  setAccessiblePersonas,
  resetReasoningProvider,
} from '../../src/vault_context/assembly';
import { StagingDrainScheduler } from '../../src/staging/scheduler';
import type { D2DReceivedNotification } from '../../src/staging/drain';
import { configureRateLimiter } from '@dina/core/src/auth/middleware';
import {
  addContact as addDirectoryContact,
  resetContactDirectory,
} from '@dina/core/src/contacts/directory';
import {
  listByPersona as listRemindersByPersona,
  resetReminderState,
} from '@dina/core/src/reminders/service';
import { createCoreRouter } from '@dina/core/src/server/core_server';
import { InProcessTransport } from '../../../core/src/client/in-process-transport';
import { clearReplayCache } from '@dina/core/src/transport/adversarial';
import { makeDinaMessage, resetFactoryCounters } from '@dina/test-harness';
import { MSG_TYPE_SOCIAL_UPDATE } from '@dina/protocol';

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
    resetReasoningProvider();
    resetReminderState();
    clearReplayCache();
    resetFactoryCounters();
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
    // the trust scorer + post-publish contact-update.
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
  });
});
