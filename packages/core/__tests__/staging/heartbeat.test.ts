/**
 * T3.17 — Staging lease heartbeat: extend lease during slow processing.
 *
 * Source: ARCHITECTURE.md Task 3.17
 */

import {
  startHeartbeat,
  stopHeartbeat,
  beatOnce,
  activeHeartbeatCount,
  stopAllHeartbeats,
} from '../../src/staging/heartbeat';
import { ingest, claim, getItem, resetStagingState } from '../../src/staging/service';

describe('Staging Lease Heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetStagingState();
    stopAllHeartbeats();
  });

  afterEach(() => {
    stopAllHeartbeats();
    jest.useRealTimers();
  });

  describe('beatOnce', () => {
    it('extends lease on classifying item', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'a' });
      claim(10);
      const before = getItem(id)!.lease_until;
      const extended = beatOnce(id, 300);
      expect(extended).toBe(true);
      expect(getItem(id)!.lease_until).toBe(before + 300);
    });

    it('returns false for non-classifying item', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'b' });
      // Item is 'received', not 'classifying'
      expect(beatOnce(id, 300)).toBe(false);
    });

    it('returns false for unknown item', () => {
      expect(beatOnce('stg-nonexistent', 300)).toBe(false);
    });
  });

  describe('startHeartbeat / stopHeartbeat', () => {
    it('creates an active heartbeat', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'c' });
      claim(10);
      const hb = startHeartbeat(id, 300, 5000);
      expect(hb.active).toBe(true);
      expect(hb.itemId).toBe(id);
      expect(activeHeartbeatCount()).toBe(1);
      stopHeartbeat(hb);
    });

    it('extends lease on each interval tick', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'd' });
      claim(10);
      const before = getItem(id)!.lease_until;

      const hb = startHeartbeat(id, 300, 1000); // extend by 300s every 1s
      jest.advanceTimersByTime(1000);
      expect(getItem(id)!.lease_until).toBe(before + 300);

      jest.advanceTimersByTime(1000);
      expect(getItem(id)!.lease_until).toBe(before + 600);
      expect(hb.beats).toBe(2);

      stopHeartbeat(hb);
    });

    it('stopHeartbeat stops the timer', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'e' });
      claim(10);
      const before = getItem(id)!.lease_until;

      const hb = startHeartbeat(id, 300, 1000);
      jest.advanceTimersByTime(1000);
      stopHeartbeat(hb);
      expect(hb.active).toBe(false);

      jest.advanceTimersByTime(5000);
      // Lease should NOT have been extended further
      expect(getItem(id)!.lease_until).toBe(before + 300);
    });

    it('auto-stops when item is no longer classifying', () => {
      const { id } = ingest({ source: 'gmail', source_id: 'f' });
      claim(10);

      const hb = startHeartbeat(id, 300, 1000);
      jest.advanceTimersByTime(1000); // beat 1 — succeeds

      // Resolve the item (no longer classifying)
      const { resolve } = require('../../src/staging/service');
      resolve(id, 'general', true);

      jest.advanceTimersByTime(1000); // beat 2 — should auto-stop
      expect(hb.active).toBe(false);
    });
  });

  describe('stopAllHeartbeats', () => {
    it('stops all active heartbeats', () => {
      const { id: id1 } = ingest({ source: 'gmail', source_id: 'g' });
      const { id: id2 } = ingest({ source: 'gmail', source_id: 'h' });
      claim(10);

      startHeartbeat(id1, 300, 1000);
      startHeartbeat(id2, 300, 1000);
      expect(activeHeartbeatCount()).toBe(2);

      stopAllHeartbeats();
      expect(activeHeartbeatCount()).toBe(0);
    });
  });
});
