/**
 * T9.13 — Audit log: data hook tests.
 *
 * Source: ARCHITECTURE.md Task 9.13
 */

import {
  getAuditEntries,
  getDistinctActors,
  getDistinctActions,
  verifyChain,
  getAuditSummary,
  resetAudit,
} from '../../src/hooks/useAuditLog';
import { appendAudit, resetAuditState } from '../../../core/src/audit/service';

describe('Audit Log Hook (9.13)', () => {
  beforeEach(() => {
    resetAudit();
  });

  describe('getAuditEntries', () => {
    it('returns empty when no entries', () => {
      expect(getAuditEntries()).toHaveLength(0);
    });

    it('returns entries with UI fields', () => {
      appendAudit('brain', 'vault_store', 'general', 'item vi-1');
      appendAudit('user', 'persona_unlock', 'health', '');

      const entries = getAuditEntries();
      expect(entries).toHaveLength(2);

      // Entries returned newest-first
      const first = entries[0];
      expect(first.actor).toBe('user');
      expect(first.action).toBe('persona_unlock');

      const second = entries[1];
      expect(second.actor).toBe('brain');
      expect(second.action).toBe('vault_store');
      expect(second.actionLabel).toBe('Stored vault item');
      expect(second.hasHash).toBe(true);
      expect(first.timeLabel).toBeTruthy();
    });

    it('maps known action labels', () => {
      appendAudit('system', 'd2d_send', 'did:key:z6Mk', 'type=social.update');
      const entry = getAuditEntries()[0];
      expect(entry.actionLabel).toBe('Sent D2D message');
    });

    it('maps known actor labels', () => {
      appendAudit('user', 'config_change', '', 'timeout=300');
      expect(getAuditEntries()[0].actorLabel).toBe('You');
    });

    it('uses raw value for unknown action', () => {
      appendAudit('system', 'custom_action', '', '');
      expect(getAuditEntries()[0].actionLabel).toBe('custom_action');
    });
  });

  describe('filters', () => {
    beforeEach(() => {
      appendAudit('brain', 'vault_store', 'general', '');
      appendAudit('user', 'persona_unlock', 'health', '');
      appendAudit('brain', 'd2d_send', 'did:key:z6Mk', '');
    });

    it('filters by actor', () => {
      const entries = getAuditEntries({ actor: 'brain' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.actor === 'brain')).toBe(true);
    });

    it('filters by action', () => {
      const entries = getAuditEntries({ action: 'vault_store' });
      expect(entries).toHaveLength(1);
    });

    it('respects limit', () => {
      expect(getAuditEntries(undefined, 1)).toHaveLength(1);
    });
  });

  describe('getDistinctActors', () => {
    it('returns unique actors', () => {
      appendAudit('brain', 'a', '', '');
      appendAudit('user', 'b', '', '');
      appendAudit('brain', 'c', '', '');

      const actors = getDistinctActors();
      expect(actors).toEqual(['brain', 'user']);
    });
  });

  describe('getDistinctActions', () => {
    it('returns unique actions', () => {
      appendAudit('system', 'vault_store', '', '');
      appendAudit('system', 'd2d_send', '', '');
      appendAudit('system', 'vault_store', '', '');

      const actions = getDistinctActions();
      expect(actions).toEqual(['d2d_send', 'vault_store']);
    });
  });

  describe('verifyChain', () => {
    it('passes on empty log', () => {
      const result = verifyChain();
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(0);
    });

    it('passes on valid chain', () => {
      appendAudit('system', 'a', '', '');
      appendAudit('system', 'b', '', '');
      appendAudit('system', 'c', '', '');

      const result = verifyChain();
      expect(result.valid).toBe(true);
      expect(result.totalEntries).toBe(3);
      expect(result.message).toContain('verified');
      expect(result.message).toContain('3 entries');
    });
  });

  describe('getAuditSummary', () => {
    it('returns zero count when empty', () => {
      const summary = getAuditSummary();
      expect(summary.count).toBe(0);
      expect(summary.latestAction).toBe('');
      expect(summary.latestTime).toBeNull();
    });

    it('returns latest entry info', () => {
      appendAudit('brain', 'vault_store', '', '');
      appendAudit('user', 'persona_unlock', '', '');

      const summary = getAuditSummary();
      expect(summary.count).toBe(2);
      expect(summary.latestAction).toBe('Unlocked persona');
      expect(summary.latestTime).toBeTruthy();
    });
  });

  describe('time labels', () => {
    it('formats recent entries as relative time', () => {
      appendAudit('system', 'test', '', '');
      const entries = getAuditEntries();
      expect(entries[0].timeLabel).toBe('Just now');
    });
  });
});
