/**
 * T3.24 — Nudge assembler: vault context for contact nudges.
 *
 * Source: ARCHITECTURE.md Task 3.24
 */

import {
  assembleNudge,
  isPromise,
  isNudgeAllowed,
  recordNudgeSent,
  resetNudgeFrequency,
} from '../../src/nudge/assembler';
import { storeItem, clearVaults } from '../../../core/src/vault/crud';
import { DEFAULT_TEST_PERSONAS } from '../../../core/src/vault/crud';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

describe('Nudge Assembler', () => {
  beforeEach(() => {
    resetFactoryCounters();
    clearVaults([...DEFAULT_TEST_PERSONAS, 'work']);
    resetNudgeFrequency();
  });

  describe('assembleNudge', () => {
    it('returns null when no context found (Silence First)', () => {
      expect(assembleNudge('did:plc:alice', 'Alice')).toBeNull();
    });

    it('returns nudge with items when context exists', () => {
      storeItem(
        'general',
        makeVaultItem({
          summary: 'Lunch with Alice next Thursday',
          body: '',
          contact_did: 'did:plc:alice',
        }),
      );
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge).not.toBeNull();
      expect(nudge!.items.length).toBeGreaterThan(0);
      expect(nudge!.contactDID).toBe('did:plc:alice');
    });

    it('searches by contact name', () => {
      storeItem('general', makeVaultItem({ summary: 'Bob prefers dark roast coffee', body: '' }));
      const nudge = assembleNudge('did:plc:bob', 'Bob');
      expect(nudge).not.toBeNull();
      expect(nudge!.items[0].text).toContain('Bob');
    });

    it('searches multiple personas', () => {
      storeItem('general', makeVaultItem({ summary: 'Alice general note', body: '' }));
      storeItem('work', makeVaultItem({ summary: 'Alice work project', body: '' }));
      const nudge = assembleNudge('did:plc:alice', 'Alice', ['general', 'work']);
      expect(nudge!.items.length).toBe(2);
    });

    it('limits to top 5 items', () => {
      for (let i = 0; i < 8; i++) {
        storeItem('general', makeVaultItem({ summary: `Alice item ${i}`, body: '' }));
      }
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.items.length).toBeLessThanOrEqual(5);
    });

    it('sorts by recency (newest first)', () => {
      storeItem('general', makeVaultItem({ summary: 'Old Alice note', body: '', timestamp: 1000 }));
      storeItem(
        'general',
        makeVaultItem({ summary: 'Recent Alice note', body: '', timestamp: 9999 }),
      );
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.items[0].timestamp).toBeGreaterThan(nudge!.items[1].timestamp);
    });

    it('has generatedAt timestamp', () => {
      storeItem('general', makeVaultItem({ summary: 'Alice test', body: '' }));
      const before = Date.now();
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.generatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('nudge item classification', () => {
    it('classifies promise items', () => {
      storeItem('general', makeVaultItem({ summary: 'Promised to lend Alice the book', body: '' }));
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.items[0].type).toBe('promise');
    });

    it('classifies event items (birthday)', () => {
      storeItem('general', makeVaultItem({ summary: 'Alice birthday March 15', body: '' }));
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.items[0].type).toBe('event');
    });

    it('classifies preference items', () => {
      storeItem('general', makeVaultItem({ summary: 'Alice prefers dark chocolate', body: '' }));
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.items[0].type).toBe('preference');
    });

    it('classifies relationship notes', () => {
      storeItem(
        'general',
        makeVaultItem({ type: 'relationship_note', summary: 'Alice caught up', body: '' }),
      );
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.items[0].type).toBe('note');
    });

    it('defaults to message for unclassified items', () => {
      storeItem(
        'general',
        makeVaultItem({ type: 'email', summary: 'Email from Alice about report', body: '' }),
      );
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.items[0].type).toBe('message');
    });
  });

  describe('summary generation', () => {
    it('includes contact name in summary', () => {
      storeItem('general', makeVaultItem({ summary: 'Alice meeting notes', body: '' }));
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.summary).toContain('Alice');
    });

    it('includes promise count', () => {
      storeItem('general', makeVaultItem({ summary: 'Promised Alice coffee', body: '' }));
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.summary).toContain('promise');
    });

    it('includes event count', () => {
      storeItem('general', makeVaultItem({ summary: 'Alice birthday party', body: '' }));
      const nudge = assembleNudge('did:plc:alice', 'Alice');
      expect(nudge!.summary).toContain('event');
    });
  });

  describe('7-day frequency cap', () => {
    it('first nudge for a contact is allowed', () => {
      expect(isNudgeAllowed('did:plc:alice')).toBe(true);
    });

    it('second nudge within 7 days is blocked', () => {
      const now = Date.now();
      recordNudgeSent('did:plc:alice', now);
      expect(isNudgeAllowed('did:plc:alice', now + 1000)).toBe(false);
    });

    it('nudge allowed after 7 days', () => {
      const now = Date.now();
      recordNudgeSent('did:plc:alice', now);
      const eightDaysLater = now + 8 * 24 * 60 * 60 * 1000;
      expect(isNudgeAllowed('did:plc:alice', eightDaysLater)).toBe(true);
    });

    it('different contacts have independent caps', () => {
      const now = Date.now();
      recordNudgeSent('did:plc:alice', now);
      expect(isNudgeAllowed('did:plc:alice', now + 1000)).toBe(false);
      expect(isNudgeAllowed('did:plc:bob', now + 1000)).toBe(true);
    });

    it('assembleNudge returns null when frequency capped', () => {
      storeItem('general', makeVaultItem({ summary: 'Alice meeting notes', body: '' }));
      const now = Date.now();
      // First nudge succeeds
      const first = assembleNudge('did:plc:alice', 'Alice', undefined, now);
      expect(first).not.toBeNull();
      // Second nudge blocked by cap
      const second = assembleNudge('did:plc:alice', 'Alice', undefined, now + 1000);
      expect(second).toBeNull();
    });

    it('resetNudgeFrequency clears all caps', () => {
      recordNudgeSent('did:plc:alice');
      resetNudgeFrequency();
      expect(isNudgeAllowed('did:plc:alice')).toBe(true);
    });
  });

  describe('isPromise (6 regex patterns from Python)', () => {
    it('"I\'ll bring" → promise', () => {
      expect(isPromise("I'll bring the book to Alice")).toBe(true);
    });

    it('"I owe" → promise', () => {
      expect(isPromise('I owe Bob twenty dollars')).toBe(true);
    });

    it('"promised to" → promise', () => {
      expect(isPromise('Promised to lend Alice the stoicism book')).toBe(true);
    });

    it('"I need to return" → promise', () => {
      expect(isPromise('I need to return the charger to Alice')).toBe(true);
    });

    it('"lend you" → promise', () => {
      expect(isPromise('I can lend you my umbrella')).toBe(true);
    });

    it('"lend her/him/them" → promise', () => {
      expect(isPromise('lend him the tools')).toBe(true);
      expect(isPromise('lend her the recipe')).toBe(true);
      expect(isPromise('lend them the projector')).toBe(true);
    });

    it('"remind me to give" → promise', () => {
      expect(isPromise('Remind me to give Alice the painting')).toBe(true);
    });

    it('non-promise text → false', () => {
      expect(isPromise('Meeting with Alice at 3pm')).toBe(false);
      expect(isPromise('Alice prefers dark chocolate')).toBe(false);
      expect(isPromise('Hello world')).toBe(false);
    });

    it('case-insensitive matching', () => {
      expect(isPromise("I'LL BRING the cake")).toBe(true);
      expect(isPromise('PROMISED TO call Bob')).toBe(true);
    });
  });
});
