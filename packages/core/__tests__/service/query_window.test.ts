/**
 * Tests for `QueryWindow`.
 *
 * Source parity: core/internal/service/query_window_test.go
 *
 * Concurrency note: Go tests include `TestQueryWindow_ReserveConcurrentRace`.
 * JavaScript is single-threaded at the bytecode level and `reserve` is a
 * synchronous method, so a true data race is impossible. We nonetheless keep
 * a test that exercises serialised "concurrent" calls to document the
 * expected behaviour: first caller wins, second caller loses.
 */

import { QueryWindow } from '../../src/service/query_window';

describe('QueryWindow', () => {
  describe('open + checkAndConsume', () => {
    it('first checkAndConsume succeeds, second fails (one-shot)', () => {
      const qw = new QueryWindow();
      qw.open('did:plc:bus42', 'q-001', 'eta_query', 60_000);

      expect(qw.checkAndConsume('did:plc:bus42', 'q-001', 'eta_query')).toBe(true);
      expect(qw.checkAndConsume('did:plc:bus42', 'q-001', 'eta_query')).toBe(false);
    });

    it('rejects wrong capability', () => {
      const qw = new QueryWindow();
      qw.open('did:plc:bus42', 'q-001', 'eta_query', 60_000);

      expect(qw.checkAndConsume('did:plc:bus42', 'q-001', 'route_info')).toBe(false);
      // Entry still present for the correct capability.
      expect(qw.checkAndConsume('did:plc:bus42', 'q-001', 'eta_query')).toBe(true);
    });

    it('rejects wrong peerDID', () => {
      const qw = new QueryWindow();
      qw.open('did:plc:bus42', 'q-001', 'eta_query', 60_000);

      expect(qw.checkAndConsume('did:plc:attacker', 'q-001', 'eta_query')).toBe(false);
    });

    it('rejects wrong queryID', () => {
      const qw = new QueryWindow();
      qw.open('did:plc:bus42', 'q-001', 'eta_query', 60_000);

      expect(qw.checkAndConsume('did:plc:bus42', 'q-002', 'eta_query')).toBe(false);
    });

    it('rejects expired entry', () => {
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:plc:bus42', 'q-002', 'eta_query', 1_000);

      now += 1_500; // advance past TTL
      expect(qw.checkAndConsume('did:plc:bus42', 'q-002', 'eta_query')).toBe(false);
    });

    it('valid at exact instant of expiry (Go parity: strict > only)', () => {
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:plc:bus42', 'q-edge', 'eta_query', 1_000);

      now += 1_000; // exactly at expiry — should still be valid
      expect(qw.checkAndConsume('did:plc:bus42', 'q-edge', 'eta_query')).toBe(true);
    });

    it('invalid one tick past expiry', () => {
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:plc:bus42', 'q-edge', 'eta_query', 1_000);

      now += 1_001;
      expect(qw.checkAndConsume('did:plc:bus42', 'q-edge', 'eta_query')).toBe(false);
    });

    it('peek returns true for live matching entry without consuming', () => {
      const qw = new QueryWindow();
      qw.open('did:plc:bus42', 'q-peek', 'eta_query', 60_000);

      expect(qw.peek('did:plc:bus42', 'q-peek', 'eta_query')).toBe(true);
      expect(qw.peek('did:plc:bus42', 'q-peek', 'eta_query')).toBe(true);
      expect(qw.size()).toBe(1);
    });

    it('peek returns false for missing / expired / wrong capability', () => {
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:plc:bus42', 'q-peek', 'eta_query', 1_000);

      expect(qw.peek('did:plc:bus42', 'q-peek', 'other_cap')).toBe(false);
      expect(qw.peek('did:plc:missing', 'q-peek', 'eta_query')).toBe(false);

      now += 2_000;
      expect(qw.peek('did:plc:bus42', 'q-peek', 'eta_query')).toBe(false);
    });

    it('keeps distinct capabilities for the same (peer, queryID) — issue #20', () => {
      // Old behaviour was last-write-wins on (peer, queryID); a reused
      // query_id with a different capability would silently blow away
      // the earlier window. The key now includes capability so both
      // windows coexist and are independently consumable.
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:plc:bus42', 'q-003', 'eta_query', 60_000);
      qw.open('did:plc:bus42', 'q-003', 'route_info', 60_000);

      expect(qw.checkAndConsume('did:plc:bus42', 'q-003', 'eta_query')).toBe(true);
      expect(qw.checkAndConsume('did:plc:bus42', 'q-003', 'route_info')).toBe(true);
    });
  });

  describe('reserve + commit + release', () => {
    it('reserve-then-commit removes the entry', () => {
      const qw = new QueryWindow();
      qw.open('did:key:zcli', 'q-003', 'eta_query', 60_000);

      expect(qw.reserve('did:key:zcli', 'q-003', 'eta_query')).toBe(true);
      qw.commit('did:key:zcli', 'q-003', 'eta_query');
      expect(qw.size()).toBe(0);
    });

    it('second reserve fails while first is still reserved', () => {
      const qw = new QueryWindow();
      qw.open('did:key:zcli', 'q-005', 'eta_query', 60_000);

      expect(qw.reserve('did:key:zcli', 'q-005', 'eta_query')).toBe(true);
      expect(qw.reserve('did:key:zcli', 'q-005', 'eta_query')).toBe(false);
    });

    it('release restores availability', () => {
      const qw = new QueryWindow();
      qw.open('did:key:zcli', 'q-004', 'eta_query', 60_000);

      expect(qw.reserve('did:key:zcli', 'q-004', 'eta_query')).toBe(true);
      qw.release('did:key:zcli', 'q-004', 'eta_query');
      expect(qw.reserve('did:key:zcli', 'q-004', 'eta_query')).toBe(true);
    });

    it('reserve on expired entry fails', () => {
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:key:zcli', 'q-exp', 'eta_query', 1_000);

      now += 2_000;
      expect(qw.reserve('did:key:zcli', 'q-exp', 'eta_query')).toBe(false);
    });

    it('commit on unreserved entry is a no-op', () => {
      const qw = new QueryWindow();
      qw.open('did:key:zcli', 'q-noop', 'eta_query', 60_000);

      qw.commit('did:key:zcli', 'q-noop', 'eta_query');
      expect(qw.size()).toBe(1); // entry untouched
    });

    it('commit with wrong capability is a no-op', () => {
      const qw = new QueryWindow();
      qw.open('did:key:zcli', 'q-wcap', 'eta_query', 60_000);
      qw.reserve('did:key:zcli', 'q-wcap', 'eta_query');

      qw.commit('did:key:zcli', 'q-wcap', 'route_info');
      expect(qw.size()).toBe(1);
    });

    it('release with wrong capability is a no-op', () => {
      const qw = new QueryWindow();
      qw.open('did:key:zcli', 'q-wrel', 'eta_query', 60_000);
      qw.reserve('did:key:zcli', 'q-wrel', 'eta_query');

      qw.release('did:key:zcli', 'q-wrel', 'route_info');
      // Reservation still held, second reserve still fails.
      expect(qw.reserve('did:key:zcli', 'q-wrel', 'eta_query')).toBe(false);
    });

    it('serialised contention: first reserve wins, second loses', () => {
      const qw = new QueryWindow();
      qw.open('did:key:zcli', 'q-race', 'eta_query', 60_000);

      const results = [
        qw.reserve('did:key:zcli', 'q-race', 'eta_query'),
        qw.reserve('did:key:zcli', 'q-race', 'eta_query'),
      ];
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('cleanup', () => {
    it('removes expired entries, preserves fresh ones', () => {
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:plc:a', 'q-old', 'eta_query', 1_000);
      qw.open('did:plc:b', 'q-fresh', 'eta_query', 60_000);

      now += 2_000;
      expect(qw.cleanup()).toBe(1);
      expect(qw.size()).toBe(1);

      // Fresh entry is still consumable.
      expect(qw.checkAndConsume('did:plc:b', 'q-fresh', 'eta_query')).toBe(true);
    });

    it('cleanup on empty window is a no-op', () => {
      const qw = new QueryWindow();
      expect(qw.cleanup()).toBe(0);
    });
  });

  describe('startCleanupLoop', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('periodically removes expired entries', () => {
      let now = 1_700_000_000_000;
      const qw = new QueryWindow({ nowFn: () => now });
      qw.open('did:plc:a', 'q-loop', 'eta_query', 1_000);

      const dispose = qw.startCleanupLoop(10);
      now += 2_000;
      jest.advanceTimersByTime(25); // two sweeps

      expect(qw.size()).toBe(0);
      dispose();
    });

    it('startCleanupLoop is idempotent', () => {
      const qw = new QueryWindow();
      const d1 = qw.startCleanupLoop(50);
      const d2 = qw.startCleanupLoop(50); // should not spawn a second timer

      d1();
      d2(); // extra dispose is safe
      qw.stopCleanupLoop(); // extra stop is safe
    });

    it('rejects non-positive intervals', () => {
      const qw = new QueryWindow();
      expect(() => qw.startCleanupLoop(0)).toThrow(/> 0/);
      expect(() => qw.startCleanupLoop(-1)).toThrow(/> 0/);
    });
  });
});
