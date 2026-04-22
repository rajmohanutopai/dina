/**
 * T10.7 — WebSocket message buffer: per-device, max 50, 5-min TTL.
 *
 * Source: ARCHITECTURE.md Task 10.7
 */

import {
  bufferMessage,
  flushBuffer,
  bufferCount,
  totalBuffered,
  purgeExpired,
  peekBuffer,
  resetMessageBuffers,
} from '../../src/ws/message_buffer';

describe('WebSocket Message Buffer', () => {
  beforeEach(() => resetMessageBuffers());

  describe('bufferMessage', () => {
    it('buffers a message with generated ID', () => {
      const msg = bufferMessage('dev-001', 'vault_update', { text: 'hello' });
      expect(msg.id).toMatch(/^wm-\d+$/);
      expect(msg.deviceId).toBe('dev-001');
      expect(msg.type).toBe('vault_update');
      expect(msg.payload).toEqual({ text: 'hello' });
    });

    it('sets 5-minute TTL', () => {
      const now = Date.now();
      const msg = bufferMessage('dev-001', 'x', {}, now);
      expect(msg.expiresAt).toBe(now + 5 * 60 * 1000);
    });

    it('evicts oldest when at 50-message capacity', () => {
      for (let i = 0; i < 50; i++) {
        bufferMessage('dev-001', 'event', { n: i });
      }
      expect(bufferCount('dev-001')).toBe(50);

      bufferMessage('dev-001', 'event', { n: 50 }); // evicts first
      expect(bufferCount('dev-001')).toBe(50);

      const messages = peekBuffer('dev-001');
      expect((messages[0].payload as Record<string, number>).n).toBe(1); // 0 was evicted
      expect((messages[49].payload as Record<string, number>).n).toBe(50); // newest
    });

    it('per-device isolation', () => {
      bufferMessage('dev-A', 'x', {});
      bufferMessage('dev-B', 'y', {});
      expect(bufferCount('dev-A')).toBe(1);
      expect(bufferCount('dev-B')).toBe(1);
      expect(totalBuffered()).toBe(2);
    });
  });

  describe('flushBuffer', () => {
    it('returns all messages and clears buffer', () => {
      bufferMessage('dev-001', 'a', { n: 1 });
      bufferMessage('dev-001', 'b', { n: 2 });
      const flushed = flushBuffer('dev-001');
      expect(flushed).toHaveLength(2);
      expect(flushed[0].type).toBe('a'); // oldest first
      expect(bufferCount('dev-001')).toBe(0);
    });

    it('filters out expired messages', () => {
      const now = Date.now();
      bufferMessage('dev-001', 'old', {}, now);
      bufferMessage('dev-001', 'new', {}, now + 4 * 60 * 1000);

      const sixMinLater = now + 6 * 60 * 1000;
      const flushed = flushBuffer('dev-001', sixMinLater);
      expect(flushed).toHaveLength(1);
      expect(flushed[0].type).toBe('new');
    });

    it('returns empty for unknown device', () => {
      expect(flushBuffer('dev-missing')).toEqual([]);
    });

    it('returns empty for device with all expired messages', () => {
      const now = Date.now();
      bufferMessage('dev-001', 'old', {}, now);
      const tenMinLater = now + 10 * 60 * 1000;
      expect(flushBuffer('dev-001', tenMinLater)).toHaveLength(0);
    });
  });

  describe('purgeExpired', () => {
    it('removes expired messages across all devices', () => {
      const now = Date.now();
      bufferMessage('dev-A', 'old', {}, now);
      bufferMessage('dev-B', 'old', {}, now);
      bufferMessage('dev-B', 'new', {}, now + 4 * 60 * 1000);

      const sixMin = now + 6 * 60 * 1000;
      const purged = purgeExpired(sixMin);
      expect(purged).toBe(2); // both 'old' messages
      expect(bufferCount('dev-A')).toBe(0); // device A fully purged
      expect(bufferCount('dev-B')).toBe(1); // device B keeps 'new'
    });

    it('returns 0 when nothing expired', () => {
      bufferMessage('dev-001', 'fresh', {});
      expect(purgeExpired()).toBe(0);
    });
  });

  describe('peekBuffer', () => {
    it('returns copy without flushing', () => {
      bufferMessage('dev-001', 'x', {});
      const peeked = peekBuffer('dev-001');
      expect(peeked).toHaveLength(1);
      expect(bufferCount('dev-001')).toBe(1); // not flushed
    });

    it('returns empty for unknown device', () => {
      expect(peekBuffer('dev-unknown')).toEqual([]);
    });
  });

  describe('bufferCount / totalBuffered', () => {
    it('counts per device', () => {
      bufferMessage('dev-A', 'x', {});
      bufferMessage('dev-A', 'y', {});
      expect(bufferCount('dev-A')).toBe(2);
      expect(bufferCount('dev-B')).toBe(0);
    });

    it('totalBuffered counts all devices', () => {
      bufferMessage('dev-A', 'x', {});
      bufferMessage('dev-B', 'y', {});
      bufferMessage('dev-B', 'z', {});
      expect(totalBuffered()).toBe(3);
    });
  });
});
