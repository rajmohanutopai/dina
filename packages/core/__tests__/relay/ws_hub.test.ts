/**
 * T10.7 — WebSocket hub: real-time event broadcasting to paired thin clients.
 *
 * Source: ARCHITECTURE.md Task 10.7
 */

import { WebSocketHub, type AuthChecker, type HubConfig } from '../../src/relay/ws_hub';

function createHub(overrides?: Partial<HubConfig>): WebSocketHub {
  const sentMessages: Array<{ clientId: string; message: string }> = [];
  return new WebSocketHub({
    authChecker: (creds) => creds.deviceId ?? null,
    messageSender: (clientId, message) => {
      sentMessages.push({ clientId, message });
      return true;
    },
    ...overrides,
  });
}

describe('WebSocket Hub (10.7)', () => {
  describe('connect / disconnect', () => {
    it('authenticates and connects a client', () => {
      const hub = createHub();
      const clientId = hub.connect({ deviceId: 'dev-1' });

      expect(clientId).toBeTruthy();
      expect(hub.clientCount()).toBe(1);
      expect(hub.getClient(clientId!)!.deviceId).toBe('dev-1');
    });

    it('rejects connection with invalid credentials', () => {
      const hub = createHub({ authChecker: () => null });
      const clientId = hub.connect({ token: 'bad' });

      expect(clientId).toBeNull();
      expect(hub.clientCount()).toBe(0);
    });

    it('allows connection without auth checker (dev mode)', () => {
      const hub = new WebSocketHub();
      const clientId = hub.connect({});

      expect(clientId).toBeTruthy();
      expect(hub.clientCount()).toBe(1);
    });

    it('disconnects a client', () => {
      const hub = createHub();
      const clientId = hub.connect({ deviceId: 'dev-1' })!;

      hub.disconnect(clientId);
      expect(hub.clientCount()).toBe(0);
      expect(hub.getClient(clientId)).toBeNull();
    });

    it('supports multiple simultaneous clients', () => {
      const hub = createHub();
      hub.connect({ deviceId: 'dev-1' });
      hub.connect({ deviceId: 'dev-2' });
      hub.connect({ deviceId: 'dev-3' });

      expect(hub.clientCount()).toBe(3);
      expect(hub.listClients()).toHaveLength(3);
    });
  });

  describe('broadcast', () => {
    it('broadcasts event to all connected clients', () => {
      const sent: Array<{ clientId: string; message: string }> = [];
      const hub = new WebSocketHub({
        authChecker: (c) => c.deviceId ?? null,
        messageSender: (cid, msg) => {
          sent.push({ clientId: cid, message: msg });
          return true;
        },
      });

      const c1 = hub.connect({ deviceId: 'dev-1' })!;
      const c2 = hub.connect({ deviceId: 'dev-2' })!;

      const event = hub.broadcast('vault_updated', { persona: 'general', itemId: 'vi-1' });

      expect(event.type).toBe('vault_updated');
      expect(event.id).toMatch(/^evt-/);
      expect(sent).toHaveLength(2);

      const parsed1 = JSON.parse(sent[0].message);
      expect(parsed1.type).toBe('vault_updated');
      expect(parsed1.data.itemId).toBe('vi-1');
    });

    it('assigns unique event IDs', () => {
      const hub = createHub();
      hub.connect({ deviceId: 'dev-1' });

      const e1 = hub.broadcast('notification', { title: 'A' });
      const e2 = hub.broadcast('notification', { title: 'B' });

      expect(e1.id).not.toBe(e2.id);
    });

    it('includes timestamp in events', () => {
      const hub = createHub();
      const before = Date.now();
      const event = hub.broadcast('system_message', { text: 'hello' });
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
    });
  });

  describe('message buffer', () => {
    it('buffers events for reconnecting clients', () => {
      const hub = createHub({ bufferSize: 50, bufferTTLMs: 60_000 });

      const before = Date.now() - 1;
      hub.broadcast('vault_updated', { id: '1' });
      hub.broadcast('notification', { id: '2' });

      const buffered = hub.getBufferedSince(before);
      expect(buffered).toHaveLength(2);
      expect(buffered[0].type).toBe('vault_updated');
      expect(buffered[1].type).toBe('notification');
    });

    it('evicts oldest when buffer full', () => {
      const hub = createHub({ bufferSize: 3 });

      hub.broadcast('notification', { n: 1 });
      hub.broadcast('notification', { n: 2 });
      hub.broadcast('notification', { n: 3 });
      hub.broadcast('notification', { n: 4 }); // evicts n:1

      expect(hub.bufferCount()).toBe(3);
      const buffered = hub.getBufferedSince(0);
      expect(buffered[0].data.n).toBe(2);
    });

    it('expires old buffer entries by TTL', async () => {
      const hub = createHub({ bufferTTLMs: 1 }); // 1ms TTL

      hub.broadcast('notification', { text: 'old' });
      await new Promise((r) => setTimeout(r, 10));

      expect(hub.bufferCount()).toBe(0);
    });

    it('getBufferedSince filters by timestamp', async () => {
      const hub = createHub({ bufferTTLMs: 60_000 });

      hub.broadcast('notification', { n: 1 });
      await new Promise((r) => setTimeout(r, 5)); // ensure time advances
      const midpoint = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      hub.broadcast('notification', { n: 2 });

      const since = hub.getBufferedSince(midpoint);
      expect(since).toHaveLength(1);
      expect(since[0].data.n).toBe(2);
    });
  });

  describe('replayTo', () => {
    it('replays buffered events to a reconnecting client', () => {
      const sent: string[] = [];
      const hub = new WebSocketHub({
        authChecker: (c) => c.deviceId ?? null,
        messageSender: (_, msg) => {
          sent.push(msg);
          return true;
        },
        bufferTTLMs: 60_000,
      });

      // Events before client connects
      const t0 = Date.now() - 1;
      hub.broadcast('vault_updated', { id: '1' });
      hub.broadcast('notification', { id: '2' });

      // Client connects and replays
      const clientId = hub.connect({ deviceId: 'dev-1' })!;
      sent.length = 0; // clear the broadcast sends
      const replayed = hub.replayTo(clientId, t0);

      expect(replayed).toBe(2);
      expect(sent).toHaveLength(2);
    });

    it('returns 0 for unknown client', () => {
      const hub = createHub();
      expect(hub.replayTo('unknown-client', 0)).toBe(0);
    });
  });

  describe('heartbeat', () => {
    it('updates lastPing on ping', () => {
      const hub = createHub();
      const clientId = hub.connect({ deviceId: 'dev-1' })!;

      const before = hub.getClient(clientId)!.lastPing;
      hub.ping(clientId);
      expect(hub.getClient(clientId)!.lastPing).toBeGreaterThanOrEqual(before);
    });

    it('prunes stale clients', async () => {
      const hub = createHub();
      const c1 = hub.connect({ deviceId: 'dev-1' })!;

      // Simulate stale connection (no ping for a while)
      await new Promise((r) => setTimeout(r, 20));

      const pruned = hub.pruneStaleClients(10); // 10ms timeout
      expect(pruned).toContain(c1);
      expect(hub.clientCount()).toBe(0);
    });

    it('keeps active clients after prune', async () => {
      const hub = createHub();
      const c1 = hub.connect({ deviceId: 'dev-1' })!;

      await new Promise((r) => setTimeout(r, 5));
      hub.ping(c1); // refresh

      const pruned = hub.pruneStaleClients(50); // 50ms timeout
      expect(pruned).toHaveLength(0);
      expect(hub.clientCount()).toBe(1);
    });
  });

  describe('reset', () => {
    it('clears all clients and buffer', () => {
      const hub = createHub();
      hub.connect({ deviceId: 'dev-1' });
      hub.broadcast('notification', { text: 'test' });

      hub.reset();
      expect(hub.clientCount()).toBe(0);
      expect(hub.bufferCount()).toBe(0);
    });
  });
});
