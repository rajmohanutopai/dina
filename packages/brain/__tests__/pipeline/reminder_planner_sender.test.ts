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
} from '../../../core/src/persona/service';
import { resetReminderState } from '../../../core/src/reminders/service';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
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
});
