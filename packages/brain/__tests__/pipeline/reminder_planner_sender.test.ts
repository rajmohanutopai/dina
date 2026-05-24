/**
 * Phase F — reminder planner uses `PersonResolver` + vault facts.
 *
 * When a D2D arrival lands in the staging drain, `handlePostPublish`
 * passes the sender DID through to `planReminders`. The planner then:
 *
 *   1. Resolves the sender via `RepositoryPersonResolver` →
 *      `displayName + relationshipHint + confirmed surfaces`.
 *   2. Prepends a `Sender: <name> (<relationship>)` line to the
 *      `{{vault_context}}` block of the LLM prompt so the model
 *      generates "Sancho is arriving" instead of "Someone is arriving".
 *   3. Adds every confirmed surface to the FTS keyword set so vault
 *      facts stored under any alias surface ("notes about Sanch" →
 *      surfaced even when the inbound text says only "Sancho Garcia").
 *
 * These tests pin the wire-up against a real SQLCipher people-graph
 * + a fake LLM provider that captures the prompt verbatim. The full
 * `planReminders` path runs (PII scrub, LLM call, parse, create) so
 * any breakage in the prompt template, the FTS expansion, or the
 * resolver wiring is caught.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  applyMigrations,
  IDENTITY_MIGRATIONS,
  SQLitePeopleRepository,
  setPeopleRepository,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  createPersona,
  resetPersonaState,
  openPersona,
} from '@dina/core';
import { resetReminderState } from '@dina/core/reminders';
import { storeItem, clearVaults } from '@dina/core';
import {
  planReminders,
  registerReminderLLM,
  resetReminderLLM,
  registerReminderLogger,
  resetReminderLogger,
} from '../../src/pipeline/reminder_planner';

interface PeopleHarness {
  adapter: NodeSQLiteAdapter;
  repo: SQLitePeopleRepository;
  cleanup: () => void;
}

function openPeopleHarness(): PeopleHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-planner-people-'));
  const dbPath = path.join(dir, 'identity.sqlite');
  const passphraseHex = randomBytes(32).toString('hex');
  const adapter = new NodeSQLiteAdapter({
    path: dbPath,
    passphraseHex,
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(adapter, IDENTITY_MIGRATIONS);
  const repo = new SQLitePeopleRepository(adapter);
  return {
    adapter,
    repo,
    cleanup: () => {
      try {
        adapter.close();
      } catch {
        /* idempotent */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

/**
 * Seed a confirmed Sancho with multiple aliases and a contact DID.
 * Returns the personId so the test can hand the DID to the planner.
 */
function seedSancho(repo: SQLitePeopleRepository, did: string): string {
  repo.applyExtraction({
    sourceItemId: 'seed-1',
    extractorVersion: 'test-v1',
    results: [
      {
        canonicalName: 'Sancho Garcia',
        relationshipHint: 'brother',
        sourceExcerpt: 'Sancho is my brother',
        surfaces: [
          { surface: 'Sancho Garcia', surfaceType: 'name', confidence: 'high' },
          { surface: 'Sancho', surfaceType: 'nickname', confidence: 'high' },
          { surface: 'my brother', surfaceType: 'role_phrase', confidence: 'high' },
        ],
      },
    ],
  });
  const sancho = repo.listPeople().find((p) => p.canonicalName === 'Sancho Garcia');
  if (sancho === undefined) throw new Error('seed: failed to insert Sancho');
  repo.linkContact(sancho.personId, did);
  return sancho.personId;
}

describe('Reminder planner — PersonResolver + vault facts wiring', () => {
  let harness: PeopleHarness;
  let capturedPrompts: string[];

  beforeEach(() => {
    resetReminderState();
    resetReminderLLM();
    clearVaults();
    resetPersonaState();
    createPersona('general', 'default');
    openPersona('general');

    harness = openPeopleHarness();
    setPeopleRepository(harness.repo);

    capturedPrompts = [];
    registerReminderLLM(async (_system, prompt) => {
      capturedPrompts.push(prompt);
      // Return an empty plan — these tests assert on the PROMPT,
      // not on reminder creation. The planner's downstream parser/
      // create paths are pinned by the existing reminder_planner.test.ts.
      return JSON.stringify({ reminders: [] });
    });

    // Silence the default console logger so test output stays clean.
    registerReminderLogger({
      warn: () => {
        /* test-only: drop diagnostics */
      },
    });
  });

  afterEach(() => {
    setPeopleRepository(null);
    harness.cleanup();
    resetReminderLLM();
    resetReminderLogger();
  });

  it('injects the resolved sender as a "Sender:" line in the prompt context', async () => {
    seedSancho(harness.repo, 'did:plc:sancho');

    await planReminders({
      itemId: 'item-1',
      type: 'message',
      summary: 'I am arriving in 5 minutes',
      body: 'I am arriving in 5 minutes',
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:sancho',
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    // Sender block must include canonical name + relationship hint.
    expect(prompt).toContain('Sender: Sancho Garcia (brother)');
  });

  it("surfaces the sender's preference over crowding event notes, and excludes the self-event", async () => {
    seedSancho(harness.repo, 'did:plc:sancho');

    // The actionable fact about Sancho — what the reminder should weave in.
    storeItem('general', {
      id: 'pref-1',
      type: 'note',
      timestamp: Date.now(),
      summary: 'Sancho loves espresso',
      body: 'Sancho loves espresso — keep a cup ready when he visits',
    });
    // Crowding: event notes from OTHER people that share the arrival's
    // scheduling phrasing ("coming over tomorrow at N PM"). Pre-fix these
    // out-ranked the preference (more token overlap with the event query)
    // and filled the whole 5-item budget, so the LLM saw no preference.
    for (let i = 0; i < 6; i++) {
      storeItem('general', {
        id: `evt-${i}`,
        type: 'note',
        timestamp: Date.now(),
        summary: `Guest ${i} is coming over tomorrow at ${i + 1} PM`,
        body: `Guest ${i} is coming over tomorrow at ${i + 1} PM`,
      });
    }
    // The just-stored event being planned — its own text must NOT come
    // back as its own context.
    const selfText = 'Sancho is coming over tomorrow at 4 PM';
    storeItem('general', {
      id: 'self-evt',
      type: 'note',
      timestamp: Date.now(),
      summary: selfText,
      body: selfText,
    });

    await planReminders({
      itemId: 'self-evt',
      type: 'message',
      summary: selfText,
      body: selfText,
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:sancho',
    });

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0]!;
    // Person-scoped phase puts the preference in the budget before the
    // event text can crowd it out.
    expect(prompt).toContain('Sancho loves espresso');
    // The event being planned is never its own context line.
    expect(prompt).not.toContain(`- ${selfText}`);
  });

  it('omits the relationship suffix when the person has no relationshipHint', async () => {
    harness.repo.applyExtraction({
      sourceItemId: 'seed-anon',
      extractorVersion: 'test-v1',
      results: [
        {
          canonicalName: 'Albert',
          relationshipHint: '',
          sourceExcerpt: '',
          surfaces: [
            { surface: 'Albert', surfaceType: 'name', confidence: 'high' },
          ],
        },
      ],
    });
    const albert = harness.repo
      .listPeople()
      .find((p) => p.canonicalName === 'Albert');
    if (albert === undefined) throw new Error('seed: failed to insert Albert');
    harness.repo.linkContact(albert.personId, 'did:plc:albert');

    await planReminders({
      itemId: 'item-2',
      type: 'message',
      summary: 'arriving soon',
      body: '',
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:albert',
    });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain('Sender: Albert');
    // Specifically — no parenthetical when relationshipHint is empty.
    expect(prompt).not.toContain('Albert (');
  });

  it('falls back gracefully when no senderDid is supplied', async () => {
    seedSancho(harness.repo, 'did:plc:sancho');

    await planReminders({
      itemId: 'item-3',
      type: 'note',
      summary: 'random note',
      body: 'no sender',
      timestamp: Date.now(),
      persona: 'general',
    });

    const prompt = capturedPrompts[0];
    // The prompt template documents what a "Sender:" line means in
    // the rules section (with a quoted example), so a blind substring
    // match would collide. Anchor to LINE START with the multiline
    // flag — the injected sender line (rendered into vault_context)
    // begins a line; the instructional example sits inline inside
    // an indented bullet, never at line start.
    expect(prompt).not.toMatch(/^Sender:\s*Sancho/m);
    expect(prompt).not.toMatch(/^Sender:\s*Albert/m);
  });

  it('falls back gracefully when senderDid does not match any person', async () => {
    seedSancho(harness.repo, 'did:plc:sancho');

    await planReminders({
      itemId: 'item-4',
      type: 'message',
      summary: 'hello from a stranger',
      body: '',
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:stranger',
    });

    const prompt = capturedPrompts[0];
    // The prompt template documents what a "Sender:" line means in
    // the rules section (with a quoted example), so a blind substring
    // match would collide. Anchor to LINE START with the multiline
    // flag — the injected sender line (rendered into vault_context)
    // begins a line; the instructional example sits inline inside
    // an indented bullet, never at line start.
    expect(prompt).not.toMatch(/^Sender:\s*Sancho/m);
    expect(prompt).not.toMatch(/^Sender:\s*Albert/m);
  });

  it('falls back gracefully when no people repo is registered', async () => {
    setPeopleRepository(null);
    // Even with a senderDid, the planner can't resolve without a repo.
    await planReminders({
      itemId: 'item-5',
      type: 'message',
      summary: 'arrived',
      body: '',
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:sancho',
    });

    const prompt = capturedPrompts[0];
    // The prompt template documents what a "Sender:" line means in
    // the rules section (with a quoted example), so a blind substring
    // match would collide. Anchor to LINE START with the multiline
    // flag — the injected sender line (rendered into vault_context)
    // begins a line; the instructional example sits inline inside
    // an indented bullet, never at line start.
    expect(prompt).not.toMatch(/^Sender:\s*Sancho/m);
    expect(prompt).not.toMatch(/^Sender:\s*Albert/m);
  });

  it('expands the FTS keyword set with confirmed surfaces — vault facts stored under an alias surface', async () => {
    seedSancho(harness.repo, 'did:plc:sancho');

    // Vault row stored under the canonical name "Sancho" (the inbound
    // body says only "arriving in 5" — without alias expansion via the
    // resolved sender, the planner would never search for "Sancho").
    storeItem('general', {
      id: 'fact-1',
      type: 'note',
      timestamp: Date.now(),
      summary: 'Sancho enjoys cardamom tea',
      body: 'Sancho enjoys cardamom tea — keep some on hand',
    });

    // Vault row stored under the role_phrase "my brother".
    storeItem('general', {
      id: 'fact-2',
      type: 'note',
      timestamp: Date.now(),
      summary: 'my brother visited last week',
      body: '',
    });

    await planReminders({
      itemId: 'incoming-d2d',
      type: 'message',
      summary: 'arriving in 5',
      body: 'arriving in 5',
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:sancho',
    });

    const prompt = capturedPrompts[0];
    // Both vault rows surface in the prompt context block — the
    // alias-keyed note and the role-phrase-keyed note. This is the
    // capabilities.md spec ("He enjoys cardamom tea ...") working.
    expect(prompt).toContain('cardamom tea');
    expect(prompt).toContain('my brother visited last week');
  });

  it('does NOT expand keywords when senderDid resolves to no person', async () => {
    seedSancho(harness.repo, 'did:plc:sancho');

    // Note keyed on Sancho's nickname surface. The inbound text says
    // "arriving in 5" so without sender resolution the keyword pass
    // never produces "Sancho", and FTS shouldn't surface this row.
    storeItem('general', {
      id: 'fact-orphan',
      type: 'note',
      timestamp: Date.now(),
      summary: 'Sancho enjoys cardamom tea',
      body: '',
    });

    await planReminders({
      itemId: 'incoming-d2d',
      type: 'message',
      summary: 'arriving in 5',
      body: 'arriving in 5',
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:stranger',
    });

    const prompt = capturedPrompts[0];
    // No expansion, no fact in the prompt.
    expect(prompt).not.toContain('cardamom tea');
  });

  it('self-/remember: by-name lookup surfaces a confirmed person referenced in the body', async () => {
    // The Emma scenario the user has raised repeatedly: "Emma is set
    // as daughter" via the People UI (→ confirmed person with
    // relationshipHint 'daughter'), then a later /remember "Emma's
    // birthday is on November 7th" has NO senderDid (self-action).
    // The planner must still pick up Emma's relationship from the
    // people graph so the reminder can read "your daughter Emma's
    // birthday".
    //
    // Pins both contributions of the by-name lookup:
    //   1. A "Referenced: Emma (daughter)" line in the prompt context.
    //   2. Emma's surfaces become FTS keyword expansions so vault
    //      facts mentioning her under any alias rank in.
    harness.repo.applyExtraction({
      sourceItemId: 'seed-emma',
      extractorVersion: 'test-v1',
      results: [
        {
          canonicalName: 'Emma',
          relationshipHint: 'daughter',
          sourceExcerpt: 'Emma is my daughter',
          surfaces: [
            { surface: 'Emma', surfaceType: 'name', confidence: 'high' },
            { surface: 'my daughter', surfaceType: 'role_phrase', confidence: 'high' },
          ],
        },
      ],
    });

    // A prior /remember whose text doesn't contain "Emma" — only the
    // role phrase. Without surface expansion, FTS would never reach
    // it from a query about "Emma's birthday".
    storeItem('general', {
      id: 'fact-role-phrase',
      type: 'note',
      timestamp: Date.now(),
      summary: 'my daughter loves dinosaurs',
      content_l0: 'my daughter loves dinosaurs',
      body: '',
    });

    await planReminders({
      itemId: 'item-self-remember',
      type: 'note',
      summary: "Emma's birthday is on November 7th",
      body: "Emma's birthday is on November 7th",
      timestamp: Date.now(),
      persona: 'general',
      // No senderDid — this is a self-/remember.
    });

    const prompt = capturedPrompts[0];
    // (1) Referenced line carries the relationship.
    expect(prompt).toContain('Referenced: Emma (daughter)');
    // (2) Surface expansion ("my daughter") pulled the role-phrase
    //     vault note into the context block even though "Emma" never
    //     appears in its text.
    expect(prompt).toContain('dinosaurs');
  });

  it('self-/remember: by-name lookup skips suggested (unconfirmed) people', async () => {
    // Mirror of the test above but with a SUGGESTED Emma (no
    // high-confidence surface). The planner must NOT surface
    // unsanctioned people-graph guesses — that would put extraction
    // mistakes into the user's reminders.
    harness.repo.applyExtraction({
      sourceItemId: 'seed-emma-suggested',
      extractorVersion: 'test-v1',
      results: [
        {
          canonicalName: 'Emma',
          relationshipHint: 'daughter',
          sourceExcerpt: 'Emma is my daughter',
          surfaces: [
            // All `medium` → person stays in 'suggested' state.
            { surface: 'Emma', surfaceType: 'name', confidence: 'medium' },
          ],
        },
      ],
    });

    await planReminders({
      itemId: 'item-self-suggested',
      type: 'note',
      summary: "Emma's birthday is on November 7th",
      body: "Emma's birthday is on November 7th",
      timestamp: Date.now(),
      persona: 'general',
    });

    const prompt = capturedPrompts[0];
    expect(prompt).not.toContain('Referenced: Emma');
  });

  it('D2D: by-name lookup does not double-list the sender as "Referenced"', async () => {
    // When the inbound D2D names the sender themselves ("I, Sancho,
    // am arriving") the sender already shows up via senderHint;
    // the by-name pass must not re-emit them as Referenced.
    seedSancho(harness.repo, 'did:plc:sancho');

    await planReminders({
      itemId: 'item-d2d-self-ref',
      type: 'message',
      summary: 'Sancho is arriving in 10 minutes',
      body: 'Sancho is arriving in 10 minutes',
      timestamp: Date.now(),
      persona: 'general',
      senderDid: 'did:plc:sancho',
    });

    const prompt = capturedPrompts[0];
    // Pull just the "Related vault context" block so we don't match
    // template prose (e.g., the prompt's worked example mentions a
    // sender for an unrelated Alonso scenario).
    const ctxStart = prompt.indexOf('Related vault context');
    const ctxEnd = prompt.indexOf('How to compute');
    const ctxSlice = ctxStart >= 0 && ctxEnd > ctxStart ? prompt.slice(ctxStart, ctxEnd) : '';
    // Sender line is there exactly once.
    const senderMatches = ctxSlice.match(/Sender: Sancho/g) ?? [];
    expect(senderMatches.length).toBe(1);
    // Referenced line is NOT emitted for the sender themselves.
    expect(ctxSlice).not.toContain('Referenced: Sancho');
  });
});
