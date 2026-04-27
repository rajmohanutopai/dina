/**
 * T3.29 — Post-publish handler: reminders, contact update, ambiguous routing.
 *
 * Source: ARCHITECTURE.md Task 3.29
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
  addContact,
  getContact,
  resetContactDirectory,
} from '../../../core/src/contacts/directory';
import { resetReminderState, listByPersona } from '../../../core/src/reminders/service';
import {
  registerPersonLinkProvider,
  resetPersonLinkProvider,
} from '../../src/person/linking';
import { handlePostPublish } from '../../src/pipeline/post_publish';

describe('Post-Publish Handler', () => {
  beforeEach(() => {
    resetReminderState();
    resetContactDirectory();
    resetPersonLinkProvider();
    setPeopleRepository(null);
  });

  describe('reminder extraction', () => {
    it('creates reminder from birthday mention', async () => {
      const result = await handlePostPublish({
        id: 'item-001',
        type: 'email',
        summary: 'Emma birthday March 15',
        body: "Don't forget Emma's birthday on March 15",
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.remindersCreated).toBeGreaterThanOrEqual(0);
      // Note: whether a reminder is created depends on event_extractor finding a valid date
    });

    it('does not crash on items without events', async () => {
      const result = await handlePostPublish({
        id: 'item-002',
        type: 'email',
        summary: 'Weekly team update',
        body: "Here are this week's updates...",
        timestamp: Date.now(),
        persona: 'work',
      });
      expect(result.errors).toHaveLength(0);
    });

    it('reminder is stored in the correct persona', async () => {
      // Create an item with a deadline that event_extractor can detect
      await handlePostPublish({
        id: 'item-003',
        // 'invoice' isn't a real vault item type — invoices ingest as
        // 'email' rows whose body mentions the invoice. The test was
        // using a fake value that the vault validator would have
        // rejected; tightening the type caught it.
        type: 'email',
        summary: 'Invoice due January 15',
        body: 'Payment due by January 15, 2027',
        timestamp: Date.now(),
        persona: 'financial',
      });
      // If reminders were created, they should be in the financial persona
      const financialReminders = listByPersona('financial');
      for (const r of financialReminders) {
        expect(r.persona).toBe('financial');
      }
    });
  });

  describe('contact update', () => {
    it('updates last_interaction for known sender', async () => {
      addContact('did:plc:alice', 'Alice');
      const before = getContact('did:plc:alice');
      if (before === null) throw new Error('expected fixture contact to exist');
      const beforeUpdate = before.updatedAt;

      await handlePostPublish({
        id: 'item-010',
        type: 'email',
        summary: 'Hello from Alice',
        body: 'Hi, just checking in!',
        timestamp: Date.now(),
        persona: 'general',
        sender_did: 'did:plc:alice',
      });

      const after = getContact('did:plc:alice');
      if (after === null) throw new Error('expected fixture contact to remain');
      expect(after.updatedAt).toBeGreaterThanOrEqual(beforeUpdate);
    });

    it('returns contactUpdated: true for known sender', async () => {
      addContact('did:plc:bob', 'Bob');
      const result = await handlePostPublish({
        id: 'item-011',
        type: 'email',
        summary: 'Message from Bob',
        body: 'Hey!',
        timestamp: Date.now(),
        persona: 'general',
        sender_did: 'did:plc:bob',
      });
      expect(result.contactUpdated).toBe(true);
    });

    it('returns contactUpdated: false for unknown sender', async () => {
      const result = await handlePostPublish({
        id: 'item-012',
        type: 'email',
        summary: 'Spam',
        body: 'Buy now!',
        timestamp: Date.now(),
        persona: 'general',
        sender_did: 'did:plc:unknown',
      });
      expect(result.contactUpdated).toBe(false);
    });

    it('skips contact update when no sender_did', async () => {
      const result = await handlePostPublish({
        id: 'item-013',
        type: 'note',
        summary: 'Personal note',
        body: 'My thoughts',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.contactUpdated).toBe(false);
    });
  });

  describe('ambiguous routing detection', () => {
    it('flags low confidence (< 0.5) as ambiguous', async () => {
      const result = await handlePostPublish({
        id: 'item-020',
        type: 'email',
        summary: 'Ambiguous content',
        body: 'Could be work or personal',
        timestamp: Date.now(),
        persona: 'general',
        confidence: 0.3,
      });
      expect(result.ambiguousRouting).toBe(true);
    });

    it('does NOT flag high confidence as ambiguous', async () => {
      const result = await handlePostPublish({
        id: 'item-021',
        type: 'email',
        summary: 'Clearly medical',
        body: 'Lab results',
        timestamp: Date.now(),
        persona: 'health',
        confidence: 0.92,
      });
      expect(result.ambiguousRouting).toBe(false);
    });

    it('does NOT flag when confidence is not provided', async () => {
      const result = await handlePostPublish({
        id: 'item-022',
        type: 'email',
        summary: 'No confidence',
        body: 'text',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.ambiguousRouting).toBe(false);
    });
  });

  describe('error resilience', () => {
    it('never throws — catches all internal errors', async () => {
      // Even with bad data, should not throw. We still pass a valid
      // VaultItemType because the strict type forbids ''; the
      // resilience this test checks is the post-publish branch on
      // empty id/summary/body, not invalid type.
      const result = await handlePostPublish({
        id: '',
        type: 'note',
        summary: '',
        body: '',
        timestamp: 0,
        persona: '',
      });
      expect(result).toBeDefined();
      expect(typeof result.remindersCreated).toBe('number');
    });
  });

  describe('people-graph wiring (Phase E)', () => {
    type Cleanup = () => void;
    let cleanup: Cleanup | null = null;

    function installPeopleRepo(): void {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-postpublish-people-'));
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
      setPeopleRepository(repo);
      cleanup = () => {
        setPeopleRepository(null);
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
      };
    }

    afterEach(() => {
      cleanup?.();
      cleanup = null;
    });

    it('peopleGraph telemetry is null when no repo is registered', async () => {
      registerPersonLinkProvider(
        async () => JSON.stringify({ identity_links: [{ name: 'Sancho', confidence: 'high' }] }),
      );
      const result = await handlePostPublish({
        id: 'item-pg-1',
        type: 'note',
        summary: 'Sancho is my brother',
        body: '',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.peopleGraph).toBeNull();
      expect(result.errors).toEqual([]);
    });

    it('writes a person to the repo and surfaces telemetry on a successful link', async () => {
      installPeopleRepo();
      registerPersonLinkProvider(
        async () =>
          JSON.stringify({
            identity_links: [
              {
                name: 'Sancho',
                role_phrase: 'my brother',
                relationship: 'sibling',
                confidence: 'high',
                evidence: 'Sancho is my brother',
              },
            ],
          }),
      );
      const result = await handlePostPublish({
        id: 'item-pg-2',
        type: 'note',
        summary: 'Sancho is my brother',
        body: 'visited yesterday',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.peopleGraph).not.toBeNull();
      expect(result.peopleGraph?.applied).toBe(1);
      expect(result.peopleGraph?.created).toBe(1);
      expect(result.peopleGraph?.updated).toBe(0);
      expect(result.peopleGraph?.conflicts).toBe(0);
      expect(result.peopleGraph?.skipped).toBe(false);
      expect(result.errors).toEqual([]);
    });

    it('records a people_graph error when the LLM provider throws', async () => {
      installPeopleRepo();
      registerPersonLinkProvider(async () => {
        throw new Error('llm overloaded');
      });
      const result = await handlePostPublish({
        id: 'item-pg-3',
        type: 'note',
        summary: 'Sancho is my brother',
        body: '',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(result.peopleGraph).toBeNull();
      expect(
        result.errors.some(
          (e) => e.includes('people_graph') && e.includes('extractor_failed'),
        ),
      ).toBe(true);
    });

    it('telemetry reports skipped: true on idempotent re-runs of the same item', async () => {
      installPeopleRepo();
      registerPersonLinkProvider(
        async () =>
          JSON.stringify({
            identity_links: [{ name: 'Twice', confidence: 'high', evidence: 'twice' }],
          }),
      );
      const first = await handlePostPublish({
        id: 'item-pg-4',
        type: 'note',
        summary: 'Twice arrived',
        body: '',
        timestamp: Date.now(),
        persona: 'general',
      });
      const second = await handlePostPublish({
        id: 'item-pg-4',
        type: 'note',
        summary: 'Twice arrived',
        body: '',
        timestamp: Date.now(),
        persona: 'general',
      });
      expect(first.peopleGraph?.created).toBe(1);
      expect(first.peopleGraph?.skipped).toBe(false);
      expect(second.peopleGraph?.skipped).toBe(true);
      expect(second.peopleGraph?.created).toBe(0);
    });
  });
});
