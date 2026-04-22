/**
 * Task 4.37 — NotifyHub tests.
 *
 * Uses an in-memory `FakeSocket` that records sent payloads + close
 * invocations. Fully deterministic — no real network, no timers.
 */

import {
  HUB_SHUTDOWN_CODE,
  NotifyHub,
  REPLACED_BY_NEW_SESSION_CODE,
  type NotifyHubEvent,
  type WebSocketLike,
} from '../src/ws/notify_hub';

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed?: { code?: number; reason?: string };
  sendThrows = false;
  closeThrows = false;
  send(data: string): void {
    if (this.sendThrows) throw new Error('EPIPE: socket dead');
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closeThrows) throw new Error('already closed');
    if (code === undefined && reason === undefined) {
      this.closed = {};
    } else if (reason === undefined) {
      this.closed = { code: code! };
    } else if (code === undefined) {
      this.closed = { reason };
    } else {
      this.closed = { code, reason };
    }
  }
}

function fixedClock(now = 1_700_000_000_000) {
  return () => now;
}

describe('NotifyHub (task 4.37)', () => {
  describe('register + unregister', () => {
    it('adds a client + increments size + fires registered event', () => {
      const events: NotifyHubEvent[] = [];
      const hub = new NotifyHub({
        nowMsFn: fixedClock(),
        onEvent: (e) => events.push(e),
      });
      const sock = new FakeSocket();
      hub.register('dev-1', sock);
      expect(hub.size()).toBe(1);
      expect(hub.hasClient('dev-1')).toBe(true);
      expect(events.map((e) => e.kind)).toEqual(['registered']);
    });

    it('replacing a client closes the prior socket with code 4000', () => {
      const events: NotifyHubEvent[] = [];
      const hub = new NotifyHub({ onEvent: (e) => events.push(e) });
      const prior = new FakeSocket();
      const fresh = new FakeSocket();
      hub.register('dev-1', prior);
      hub.register('dev-1', fresh);
      expect(prior.closed).toEqual({
        code: REPLACED_BY_NEW_SESSION_CODE,
        reason: 'replaced by new session',
      });
      expect(hub.size()).toBe(1);
      expect(events.map((e) => e.kind)).toEqual([
        'registered',
        'replaced',
        'registered',
      ]);
    });

    it('replace tolerates close() throwing on the prior socket', () => {
      const hub = new NotifyHub();
      const prior = new FakeSocket();
      prior.closeThrows = true;
      hub.register('dev-1', prior);
      expect(() => hub.register('dev-1', new FakeSocket())).not.toThrow();
      expect(hub.size()).toBe(1);
    });

    it('unregister returns true on known + false on unknown', () => {
      const hub = new NotifyHub();
      hub.register('dev-1', new FakeSocket());
      expect(hub.unregister('dev-1')).toBe(true);
      expect(hub.unregister('dev-1')).toBe(false);
      expect(hub.size()).toBe(0);
    });

    it('unregister emits event', () => {
      const events: NotifyHubEvent[] = [];
      const hub = new NotifyHub({ onEvent: (e) => events.push(e) });
      hub.register('dev-1', new FakeSocket());
      events.length = 0;
      hub.unregister('dev-1');
      expect(events.map((e) => e.kind)).toEqual(['unregistered']);
    });

    it('rejects empty deviceId', () => {
      const hub = new NotifyHub();
      expect(() => hub.register('', new FakeSocket())).toThrow(
        /deviceId is required/,
      );
    });

    it('rejects missing socket', () => {
      const hub = new NotifyHub();
      expect(() =>
        hub.register('dev-1', undefined as unknown as WebSocketLike),
      ).toThrow(/socket is required/);
    });
  });

  describe('send', () => {
    it('serialises and forwards to the target client', () => {
      const hub = new NotifyHub();
      const sock = new FakeSocket();
      hub.register('dev-1', sock);
      expect(hub.send('dev-1', { type: 'ping' })).toBe(true);
      expect(sock.sent).toEqual([JSON.stringify({ type: 'ping' })]);
    });

    it('returns false for unknown deviceId (no error)', () => {
      const hub = new NotifyHub();
      expect(hub.send('ghost', {})).toBe(false);
    });

    it('auto-unregisters a socket whose send() throws', () => {
      const events: NotifyHubEvent[] = [];
      const hub = new NotifyHub({ onEvent: (e) => events.push(e) });
      const sock = new FakeSocket();
      sock.sendThrows = true;
      hub.register('dev-1', sock);
      expect(hub.send('dev-1', { x: 1 })).toBe(false);
      expect(hub.hasClient('dev-1')).toBe(false);
      expect(events.some((e) => e.kind === 'send_failed')).toBe(true);
    });
  });

  describe('broadcast', () => {
    it('sends to every connected client + returns delivered count', () => {
      const hub = new NotifyHub();
      const a = new FakeSocket();
      const b = new FakeSocket();
      const c = new FakeSocket();
      hub.register('dev-a', a);
      hub.register('dev-b', b);
      hub.register('dev-c', c);
      const delivered = hub.broadcast({ type: 'nudge' });
      expect(delivered).toBe(3);
      const expected = JSON.stringify({ type: 'nudge' });
      expect(a.sent).toEqual([expected]);
      expect(b.sent).toEqual([expected]);
      expect(c.sent).toEqual([expected]);
    });

    it('filtered broadcast only hits predicate-true clients', () => {
      const hub = new NotifyHub();
      const a = new FakeSocket();
      const b = new FakeSocket();
      hub.register('dev-a', a);
      hub.register('dev-b', b);
      hub.broadcast({ x: 1 }, (id) => id === 'dev-a');
      expect(a.sent).toHaveLength(1);
      expect(b.sent).toHaveLength(0);
    });

    it('reaps failing sockets during fanout + excludes them from the count', () => {
      const hub = new NotifyHub();
      const a = new FakeSocket();
      const b = new FakeSocket();
      const c = new FakeSocket();
      b.sendThrows = true;
      hub.register('dev-a', a);
      hub.register('dev-b', b);
      hub.register('dev-c', c);
      const delivered = hub.broadcast({ n: 42 });
      expect(delivered).toBe(2);
      expect(hub.hasClient('dev-b')).toBe(false);
      expect(hub.size()).toBe(2);
    });

    it('broadcast on empty hub returns 0', () => {
      const hub = new NotifyHub();
      expect(hub.broadcast({})).toBe(0);
    });
  });

  describe('closeAll (shutdown integration)', () => {
    it('closes every socket with code 1001 + clears registry', () => {
      const hub = new NotifyHub();
      const a = new FakeSocket();
      const b = new FakeSocket();
      hub.register('dev-a', a);
      hub.register('dev-b', b);
      expect(hub.closeAll()).toBe(2);
      expect(a.closed).toEqual({ code: HUB_SHUTDOWN_CODE, reason: 'going away' });
      expect(b.closed).toEqual({ code: HUB_SHUTDOWN_CODE, reason: 'going away' });
      expect(hub.size()).toBe(0);
    });

    it('tolerates close() throwing on individual sockets', () => {
      const hub = new NotifyHub();
      const a = new FakeSocket();
      a.closeThrows = true;
      hub.register('dev-a', a);
      expect(() => hub.closeAll()).not.toThrow();
      expect(hub.size()).toBe(0);
    });

    it('empty hub returns 0', () => {
      const hub = new NotifyHub();
      expect(hub.closeAll()).toBe(0);
    });
  });

  describe('connectedDeviceIds', () => {
    it('returns sorted list of connected deviceIds', () => {
      const hub = new NotifyHub();
      hub.register('c', new FakeSocket());
      hub.register('a', new FakeSocket());
      hub.register('b', new FakeSocket());
      expect(hub.connectedDeviceIds()).toEqual(['a', 'b', 'c']);
    });
  });
});
