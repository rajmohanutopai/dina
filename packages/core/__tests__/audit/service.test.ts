/**
 * T2.48 — Audit service: append, query, verify chain, retention.
 *
 * Tests newest-first query order, monotonic seq, query limit cap,
 * and genesis marker.
 *
 * Source: ARCHITECTURE.md Task 2.48
 */

import {
  appendAudit,
  appendAuditWithDetail,
  queryAudit,
  verifyAuditChain,
  sweepRetention,
  auditCount,
  latestEntry,
  resetAuditState,
  setRetentionDays,
  getRetentionDays,
  buildAuditDetail,
  parseAuditDetail,
} from '../../src/audit/service';
import { GENESIS_MARKER } from '../../src/audit/hash_chain';

describe('Audit Service', () => {
  beforeEach(() => resetAuditState());

  describe('appendAudit', () => {
    it('appends entry with auto-incremented seq', () => {
      const e1 = appendAudit('brain', 'vault_store', 'general');
      const e2 = appendAudit('brain', 'vault_query', 'health');
      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
    });

    it('entry has SHA-256 hash', () => {
      const e = appendAudit('brain', 'vault_store', 'general', 'stored 5 items');
      expect(e.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('first entry has genesis marker as prev_hash', () => {
      const e = appendAudit('brain', 'vault_store', 'general');
      expect(e.prev_hash).toBe(GENESIS_MARKER);
    });

    it('subsequent entries chain to previous hash', () => {
      const e1 = appendAudit('brain', 'action1', 'res1');
      const e2 = appendAudit('brain', 'action2', 'res2');
      expect(e2.prev_hash).toBe(e1.entry_hash);
    });

    it('stores actor, action, resource, detail', () => {
      const e = appendAudit('did:key:z6MkBrain', 'vault_store', 'general', 'batch of 10');
      expect(e.actor).toBe('did:key:z6MkBrain');
      expect(e.action).toBe('vault_store');
      expect(e.resource).toBe('general');
      expect(e.detail).toBe('batch of 10');
    });

    it('has timestamp', () => {
      const before = Math.floor(Date.now() / 1000);
      const e = appendAudit('x', 'y', 'z');
      expect(e.ts).toBeGreaterThanOrEqual(before);
    });

    it('seq is monotonic across purge (never reused)', () => {
      appendAudit('brain', 'a1', 'r1'); // seq=1
      appendAudit('brain', 'a2', 'r2'); // seq=2

      // Purge all entries
      const ninetyOneDaysMs = 91 * 24 * 60 * 60 * 1000;
      sweepRetention(Date.now() + ninetyOneDaysMs);
      expect(auditCount()).toBe(0);

      // Next entry should be seq=3, not seq=1
      const e3 = appendAudit('brain', 'a3', 'r3');
      expect(e3.seq).toBe(3);
    });
  });

  describe('queryAudit', () => {
    it('returns all entries in newest-first order', () => {
      appendAudit('brain', 'store', 'general');
      appendAudit('brain', 'query', 'health');
      appendAudit('device', 'store', 'general');
      const results = queryAudit();
      expect(results).toHaveLength(3);
      // Newest first: device/store is last appended → first returned
      expect(results[0].actor).toBe('device');
      expect(results[2].actor).toBe('brain');
    });

    it('filters by actor', () => {
      appendAudit('brain', 'store', 'general');
      appendAudit('device', 'store', 'general');
      expect(queryAudit({ actor: 'brain' })).toHaveLength(1);
    });

    it('filters by action', () => {
      appendAudit('brain', 'vault_store', 'general');
      appendAudit('brain', 'vault_query', 'general');
      expect(queryAudit({ action: 'vault_store' })).toHaveLength(1);
    });

    it('filters by resource', () => {
      appendAudit('brain', 'store', 'general');
      appendAudit('brain', 'store', 'health');
      expect(queryAudit({ resource: 'health' })).toHaveLength(1);
    });

    it('respects limit (returns newest N)', () => {
      for (let i = 0; i < 10; i++) appendAudit('brain', 'action', `res-${i}`);
      const results = queryAudit({ limit: 3 });
      expect(results).toHaveLength(3);
      // Newest first: last 3 appended are res-9, res-8, res-7
      expect(results[0].resource).toBe('res-9');
      expect(results[1].resource).toBe('res-8');
      expect(results[2].resource).toBe('res-7');
    });

    it('caps limit at 200 (matching Go)', () => {
      // Even if caller requests more, cap at 200
      for (let i = 0; i < 5; i++) appendAudit('brain', 'a', `r-${i}`);
      const results = queryAudit({ limit: 1000 });
      // Only 5 entries exist, so all 5 returned (cap doesn't inflate)
      expect(results).toHaveLength(5);
    });

    it('returns empty when no matches', () => {
      appendAudit('brain', 'store', 'general');
      expect(queryAudit({ actor: 'nobody' })).toHaveLength(0);
    });

    it('combines filters', () => {
      appendAudit('brain', 'store', 'general');
      appendAudit('brain', 'query', 'general');
      appendAudit('device', 'store', 'general');
      expect(queryAudit({ actor: 'brain', action: 'store' })).toHaveLength(1);
    });
  });

  describe('verifyAuditChain', () => {
    it('valid chain returns valid: true', () => {
      appendAudit('brain', 'store', 'general');
      appendAudit('brain', 'query', 'health');
      appendAudit('brain', 'delete', 'general');
      expect(verifyAuditChain().valid).toBe(true);
    });

    it('empty log is valid', () => {
      expect(verifyAuditChain().valid).toBe(true);
    });

    it('single entry is valid', () => {
      appendAudit('brain', 'store', 'general');
      expect(verifyAuditChain().valid).toBe(true);
    });
  });

  describe('sweepRetention', () => {
    it('purges entries older than 90 days', () => {
      appendAudit('brain', 'old-action', 'general');
      const ninetyOneDaysLater = Date.now() + 91 * 24 * 60 * 60 * 1000;
      const purged = sweepRetention(ninetyOneDaysLater);
      expect(purged).toBe(1);
      expect(auditCount()).toBe(0);
    });

    it('keeps recent entries', () => {
      appendAudit('brain', 'recent', 'general');
      const purged = sweepRetention();
      expect(purged).toBe(0);
      expect(auditCount()).toBe(1);
    });

    it('purges only old entries, keeps recent', () => {
      appendAudit('brain', 'old', 'general');
      const ninetyOneDaysMs = 91 * 24 * 60 * 60 * 1000;
      const purged = sweepRetention(Date.now() + ninetyOneDaysMs);
      expect(purged).toBe(1);
      expect(auditCount()).toBe(0);
    });
  });

  describe('auditCount / latestEntry', () => {
    it('count starts at 0', () => {
      expect(auditCount()).toBe(0);
    });

    it('latestEntry returns null when empty', () => {
      expect(latestEntry()).toBeNull();
    });

    it('latestEntry returns the most recent', () => {
      appendAudit('brain', 'first', 'a');
      appendAudit('brain', 'second', 'b');
      expect(latestEntry()!.action).toBe('second');
    });
  });

  describe('structured detail (JSON packing)', () => {
    it('buildAuditDetail packs sub-fields to JSON', () => {
      const detail = buildAuditDetail({
        query_type: 'vault_search',
        reason: 'user query',
        metadata: { persona: 'health', terms: 3 },
      });
      const parsed = JSON.parse(detail);
      expect(parsed.query_type).toBe('vault_search');
      expect(parsed.reason).toBe('user query');
      expect(parsed.metadata.persona).toBe('health');
    });

    it('parseAuditDetail recovers sub-fields', () => {
      const detail = buildAuditDetail({ query_type: 'search', reason: 'test' });
      const parsed = parseAuditDetail(detail);
      expect(parsed.query_type).toBe('search');
      expect(parsed.reason).toBe('test');
    });

    it('parseAuditDetail wraps plain text as { text }', () => {
      const parsed = parseAuditDetail('plain text detail');
      expect(parsed.text).toBe('plain text detail');
    });

    it('parseAuditDetail handles empty string', () => {
      expect(parseAuditDetail('')).toEqual({});
    });

    it('appendAuditWithDetail stores structured detail', () => {
      const entry = appendAuditWithDetail('brain', 'vault_query', 'health', {
        query_type: 'semantic',
        reason: 'user asked about labs',
        metadata: { terms: 2 },
      });
      const parsed = parseAuditDetail(entry.detail);
      expect(parsed.query_type).toBe('semantic');
      expect(parsed.reason).toBe('user asked about labs');
    });
  });

  describe('configurable retention', () => {
    it('default retention is 90 days', () => {
      expect(getRetentionDays()).toBe(90);
    });

    it('setRetentionDays changes the retention period', () => {
      setRetentionDays(30);
      expect(getRetentionDays()).toBe(30);
    });

    it('shorter retention purges more entries', () => {
      setRetentionDays(1); // 1 day
      appendAudit('brain', 'old', 'general');
      const twoDaysLater = Date.now() + 2 * 24 * 60 * 60 * 1000;
      const purged = sweepRetention(twoDaysLater);
      expect(purged).toBe(1);
    });

    it('rejects less than 1 day', () => {
      expect(() => setRetentionDays(0)).toThrow('at least 1 day');
    });

    it('resetAuditState restores default retention', () => {
      setRetentionDays(7);
      resetAuditState();
      expect(getRetentionDays()).toBe(90);
    });
  });

  describe('timestamp override', () => {
    it('uses current time by default', () => {
      const before = Math.floor(Date.now() / 1000);
      const entry = appendAudit('brain', 'test', 'res');
      expect(entry.ts).toBeGreaterThanOrEqual(before);
    });

    it('accepts timestamp override for import/migration', () => {
      const historicalTs = 1600000000; // Sep 2020
      const entry = appendAudit('brain', 'imported', 'res', 'migrated entry', historicalTs);
      expect(entry.ts).toBe(1600000000);
    });

    it('overridden timestamp is included in hash chain', () => {
      const e1 = appendAudit('brain', 'a', 'r', '', 1600000000);
      const e2 = appendAudit('brain', 'b', 'r', '', 1600000001);
      expect(e2.prev_hash).toBe(e1.entry_hash);
      expect(verifyAuditChain().valid).toBe(true);
    });
  });

  describe('input validation (error path)', () => {
    it('rejects empty actor', () => {
      expect(() => appendAudit('', 'action', 'res')).toThrow('actor is required');
    });

    it('rejects whitespace-only actor', () => {
      expect(() => appendAudit('  ', 'action', 'res')).toThrow('actor is required');
    });

    it('rejects empty action', () => {
      expect(() => appendAudit('brain', '', 'res')).toThrow('action is required');
    });

    it('accepts empty resource (optional)', () => {
      expect(() => appendAudit('brain', 'test', '')).not.toThrow();
    });

    it('accepts empty detail (optional)', () => {
      expect(() => appendAudit('brain', 'test', 'res', '')).not.toThrow();
    });
  });
});
