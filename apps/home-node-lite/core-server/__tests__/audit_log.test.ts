/**
 * Task 4.73 — AuditLog tests.
 *
 * Verifies append-only semantics, hash-chain integrity, filtered
 * querying, retention purge, and tamper detection. Injected clock
 * keeps ts values deterministic.
 */

import { AuditLog, type AuditLogEvent } from '../src/audit/audit_log';
import { GENESIS_MARKER } from '@dina/core';

function mockClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

describe('AuditLog (task 4.73)', () => {
  describe('append', () => {
    it('assigns monotone 1-indexed seq', () => {
      const log = new AuditLog();
      expect(
        log.append({ actor: 'admin', action: 'unlock', resource: '/health', detail: '' }),
      ).toBe(1);
      expect(
        log.append({ actor: 'admin', action: 'unlock', resource: '/financial', detail: '' }),
      ).toBe(2);
      expect(log.size()).toBe(2);
    });

    it('first entry uses GENESIS_MARKER as prev_hash', () => {
      const log = new AuditLog();
      log.append({ actor: 'admin', action: 'unlock', resource: '/health', detail: '' });
      expect(log.all()[0]!.prev_hash).toBe(GENESIS_MARKER);
      expect(log.anchorHash()).toBe(GENESIS_MARKER);
    });

    it('each subsequent prev_hash = prior entry_hash', () => {
      const log = new AuditLog();
      log.append({ actor: 'admin', action: 'a', resource: '/x', detail: '' });
      log.append({ actor: 'admin', action: 'b', resource: '/y', detail: '' });
      log.append({ actor: 'admin', action: 'c', resource: '/z', detail: '' });
      const entries = log.all();
      expect(entries[1]!.prev_hash).toBe(entries[0]!.entry_hash);
      expect(entries[2]!.prev_hash).toBe(entries[1]!.entry_hash);
      expect(log.headHash()).toBe(entries[2]!.entry_hash);
    });

    it('uses injected clock for ts (seconds)', () => {
      const clock = mockClock(1_700_000_000_000);
      const log = new AuditLog({ nowMsFn: clock.nowMsFn });
      log.append({ actor: 'a', action: 'b', resource: '/c', detail: '' });
      expect(log.all()[0]!.ts).toBe(1_700_000_000);
    });

    it('honours tsOverride', () => {
      const log = new AuditLog({ nowMsFn: () => 1_000 });
      log.append({ actor: 'a', action: 'b', resource: '/c', detail: '', tsOverride: 9999 });
      expect(log.all()[0]!.ts).toBe(9999);
    });

    it('rejects empty actor / action / resource', () => {
      const log = new AuditLog();
      expect(() => log.append({ actor: '', action: 'b', resource: '/c', detail: '' })).toThrow(
        /actor is required/,
      );
      expect(() => log.append({ actor: 'a', action: '', resource: '/c', detail: '' })).toThrow(
        /action is required/,
      );
      expect(() => log.append({ actor: 'a', action: 'b', resource: '', detail: '' })).toThrow(
        /resource is required/,
      );
    });

    it('allows empty detail (self-describing events)', () => {
      const log = new AuditLog();
      expect(() =>
        log.append({ actor: 'a', action: 'b', resource: '/c', detail: '' }),
      ).not.toThrow();
    });
  });

  describe('verifyChain', () => {
    it('returns valid=true for empty log', () => {
      const log = new AuditLog();
      expect(log.verifyChain()).toEqual({ valid: true, brokenAt: -1 });
    });

    it('returns valid=true for a clean chain', () => {
      const log = new AuditLog();
      for (let i = 0; i < 10; i++) {
        log.append({ actor: `a${i}`, action: 'x', resource: '/y', detail: `e${i}` });
      }
      expect(log.verifyChain()).toEqual({ valid: true, brokenAt: -1 });
    });

    it('detects tampered entry (field modified)', () => {
      const log = new AuditLog();
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: 'one' });
      log.append({ actor: 'b', action: 'x', resource: '/y', detail: 'two' });
      log.append({ actor: 'c', action: 'x', resource: '/y', detail: 'three' });
      // Tamper: rewrite actor on middle entry (but keep entry_hash — the mismatch shows up in recompute).
      (log.all()[1] as unknown as { actor: string }).actor = 'MALICIOUS';
      // Note: log.all() returns a copy — we need to mutate the internal entry.
      const internals = (log as unknown as { entries: { actor: string }[] }).entries;
      internals[1]!.actor = 'MALICIOUS';
      const res = log.verifyChain();
      expect(res.valid).toBe(false);
      expect(res.brokenAt).toBe(1);
    });

    it('detects broken linkage (prev_hash overwritten)', () => {
      const log = new AuditLog();
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '' });
      log.append({ actor: 'b', action: 'x', resource: '/y', detail: '' });
      const internals = (log as unknown as { entries: { prev_hash: string }[] }).entries;
      internals[1]!.prev_hash = 'deadbeef';
      const res = log.verifyChain();
      expect(res.valid).toBe(false);
      expect(res.brokenAt).toBe(1);
    });
  });

  describe('query', () => {
    function seededLog() {
      const clock = mockClock(1_000_000 * 1000); // ts=1_000_000 seconds
      const log = new AuditLog({ nowMsFn: clock.nowMsFn });
      log.append({ actor: 'admin', action: 'unlock', resource: '/health', detail: 'a' });
      clock.advance(5_000);
      log.append({ actor: 'brain', action: 'query', resource: '/health', detail: 'b' });
      clock.advance(5_000);
      log.append({ actor: 'admin', action: 'lock', resource: '/health', detail: 'c' });
      clock.advance(5_000);
      log.append({ actor: 'brain', action: 'query', resource: '/work', detail: 'd' });
      return { log, clock };
    }

    it('returns all entries on empty filter', () => {
      const { log } = seededLog();
      expect(log.query()).toHaveLength(4);
    });

    it('filters by actor', () => {
      const { log } = seededLog();
      const out = log.query({ actor: 'admin' });
      expect(out).toHaveLength(2);
      expect(out.every((e) => e.actor === 'admin')).toBe(true);
    });

    it('filters by action', () => {
      const { log } = seededLog();
      const out = log.query({ action: 'query' });
      expect(out).toHaveLength(2);
      expect(out.every((e) => e.action === 'query')).toBe(true);
    });

    it('filters by since/until (inclusive)', () => {
      const { log } = seededLog();
      // ts sequence: 1_000_000, 1_000_005, 1_000_010, 1_000_015
      const out = log.query({ since: 1_000_005, until: 1_000_010 });
      expect(out.map((e) => e.detail)).toEqual(['b', 'c']);
    });

    it('applies limit', () => {
      const { log } = seededLog();
      expect(log.query({ limit: 2 })).toHaveLength(2);
    });

    it('combines filters (actor + action)', () => {
      const { log } = seededLog();
      const out = log.query({ actor: 'admin', action: 'unlock' });
      expect(out).toHaveLength(1);
      expect(out[0]!.detail).toBe('a');
    });

    it('returns a defensive copy (mutation does not affect log)', () => {
      const { log } = seededLog();
      const out = log.query();
      out.pop();
      expect(log.size()).toBe(4);
    });
  });

  describe('purge', () => {
    it('drops entries older than retentionDays; returns count removed', () => {
      const clock = mockClock(0);
      const log = new AuditLog({ nowMsFn: clock.nowMsFn });
      // ts=0
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: 'old-1' });
      clock.advance(86_400_000); // +1 day
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: 'old-2' });
      clock.advance(86_400_000); // +1 day (total +2)
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: 'recent' });
      // Now = 2 days since first entry. Retention = 1 day → cutoff = now - 1d = ts of 2nd entry.
      // >= cutoff is kept (strict-<-cutoff is dropped).
      const removed = log.purge(1);
      expect(removed).toBe(1);
      expect(log.size()).toBe(2);
      expect(log.all().map((e) => e.detail)).toEqual(['old-2', 'recent']);
    });

    it('zero retention purges everything in the past', () => {
      const clock = mockClock(10_000);
      const log = new AuditLog({ nowMsFn: clock.nowMsFn });
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: 'e' });
      clock.advance(1_000);
      // retentionDays=0 → cutoff = now in seconds; entry ts < cutoff → purged.
      expect(log.purge(0)).toBe(1);
      expect(log.size()).toBe(0);
    });

    it('rejects negative / NaN retentionDays', () => {
      const log = new AuditLog();
      expect(() => log.purge(-1)).toThrow(/retentionDays must be >= 0/);
      expect(() => log.purge(NaN)).toThrow(/retentionDays must be >= 0/);
    });

    it('keeps chain verifiable after purge (anchor = prev_hash of oldest retained)', () => {
      const clock = mockClock(0);
      const log = new AuditLog({ nowMsFn: clock.nowMsFn });
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '1' });
      const firstHash = log.headHash();
      clock.advance(2 * 86_400_000);
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '2' });
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '3' });

      log.purge(1); // drops the first entry only

      expect(log.size()).toBe(2);
      expect(log.all()[0]!.prev_hash).toBe(firstHash);
      expect(log.anchorHash()).toBe(firstHash);
      expect(log.anchorHash()).not.toBe(GENESIS_MARKER);
      expect(log.verifyChain()).toEqual({ valid: true, brokenAt: -1 });
    });

    it('no-op when retention window covers all entries', () => {
      const clock = mockClock(86_400_000);
      const log = new AuditLog({ nowMsFn: clock.nowMsFn });
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '' });
      expect(log.purge(7)).toBe(0);
      expect(log.size()).toBe(1);
    });
  });

  describe('events', () => {
    it('emits `appended` after each append', () => {
      const events: AuditLogEvent[] = [];
      const log = new AuditLog({ onEvent: (e) => events.push(e) });
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '' });
      log.append({ actor: 'b', action: 'x', resource: '/y', detail: '' });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: 'appended' });
      expect((events[0] as Extract<AuditLogEvent, { kind: 'appended' }>).entry.seq).toBe(1);
    });

    it('emits `purged` with removed count + new anchor', () => {
      const events: AuditLogEvent[] = [];
      const clock = mockClock(0);
      const log = new AuditLog({ nowMsFn: clock.nowMsFn, onEvent: (e) => events.push(e) });
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '1' });
      const firstHash = log.headHash();
      clock.advance(2 * 86_400_000);
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '2' });
      events.length = 0;
      log.purge(1);
      const purged = events.find((e) => e.kind === 'purged') as Extract<
        AuditLogEvent,
        { kind: 'purged' }
      >;
      expect(purged).toBeDefined();
      expect(purged.removed).toBe(1);
      expect(purged.newAnchor).toBe(firstHash);
    });

    it('does not emit `purged` when nothing was removed', () => {
      const events: AuditLogEvent[] = [];
      const log = new AuditLog({ onEvent: (e) => events.push(e) });
      log.append({ actor: 'a', action: 'x', resource: '/y', detail: '' });
      events.length = 0;
      log.purge(30);
      expect(events.find((e) => e.kind === 'purged')).toBeUndefined();
    });
  });

  describe('hash chain properties', () => {
    it('different detail → different entry_hash', () => {
      const log1 = new AuditLog({ nowMsFn: () => 1_700_000_000_000 });
      const log2 = new AuditLog({ nowMsFn: () => 1_700_000_000_000 });
      log1.append({ actor: 'a', action: 'x', resource: '/y', detail: 'one' });
      log2.append({ actor: 'a', action: 'x', resource: '/y', detail: 'two' });
      expect(log1.headHash()).not.toBe(log2.headHash());
    });

    it('same inputs with same clock → deterministic hash', () => {
      const build = () => {
        const log = new AuditLog({ nowMsFn: () => 1_700_000_000_000 });
        log.append({ actor: 'a', action: 'x', resource: '/y', detail: 'one' });
        log.append({ actor: 'b', action: 'x', resource: '/y', detail: 'two' });
        return log.headHash();
      };
      expect(build()).toBe(build());
    });
  });
});
