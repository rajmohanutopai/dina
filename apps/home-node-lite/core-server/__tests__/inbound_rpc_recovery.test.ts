/**
 * Task 4.50 — inbound-RPC recovery tests.
 */

import { CancelRegistry } from '../src/msgbox/cancel_registry';
import {
  InboundRpcRecovery,
  type RecoveryEvent,
} from '../src/msgbox/inbound_rpc_recovery';

const SENDER_A = 'did:plc:alice';
const SENDER_B = 'did:plc:bob';

describe('InboundRpcRecovery (task 4.50)', () => {
  describe('onDisconnect', () => {
    it('aborts all in-flight RPCs + returns the count', () => {
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({ registry });
      const r1 = registry.register(SENDER_A, 'req-1');
      const r2 = registry.register(SENDER_B, 'req-2');
      const count = recovery.onDisconnect('peer closed: 1006');
      expect(count).toBe(2);
      expect(r1.signal.aborted).toBe(true);
      expect(r2.signal.aborted).toBe(true);
      expect(registry.size()).toBe(0);
    });

    it('no-op when no RPCs are in flight', () => {
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({ registry });
      expect(recovery.onDisconnect()).toBe(0);
    });

    it('fires abort_on_disconnect event with count + reason', () => {
      const events: RecoveryEvent[] = [];
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({
        registry,
        onEvent: (e) => events.push(e),
      });
      registry.register(SENDER_A, 'req-1');
      recovery.onDisconnect('socket closed');
      expect(events).toEqual([
        { kind: 'abort_on_disconnect', abortedCount: 1, reason: 'socket closed' },
      ]);
    });

    it('omits reason when not provided', () => {
      const events: RecoveryEvent[] = [];
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({
        registry,
        onEvent: (e) => events.push(e),
      });
      registry.register(SENDER_A, 'req-1');
      recovery.onDisconnect();
      expect(events).toEqual([{ kind: 'abort_on_disconnect', abortedCount: 1 }]);
    });
  });

  describe('onReconnect', () => {
    it('normal flow (prior disconnect already cleaned up) → no-op + no event', () => {
      const events: RecoveryEvent[] = [];
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({
        registry,
        onEvent: (e) => events.push(e),
      });
      // Normal disconnect cleared everything.
      registry.register(SENDER_A, 'req-1');
      recovery.onDisconnect();
      events.length = 0; // reset

      const count = recovery.onReconnect();
      expect(count).toBe(0);
      expect(events).toEqual([]); // silent no-op
    });

    it('defensive: still cleans up if onDisconnect was missed', () => {
      const events: RecoveryEvent[] = [];
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({
        registry,
        onEvent: (e) => events.push(e),
      });
      // Simulate missed onDisconnect: RPC is registered but never aborted.
      const r1 = registry.register(SENDER_A, 'leaked');
      const count = recovery.onReconnect();
      expect(count).toBe(1);
      expect(r1.signal.aborted).toBe(true);
      expect(registry.size()).toBe(0);
      // Logs the stale cleanup.
      expect(events).toEqual([
        {
          kind: 'reconnect_cleanup',
          abortedCount: 1,
          reason: 'stale in-flight RPCs from before the reconnect',
        },
      ]);
    });
  });

  describe('inFlightCount', () => {
    it('reflects the underlying registry size', () => {
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({ registry });
      expect(recovery.inFlightCount()).toBe(0);
      registry.register(SENDER_A, 'req-1');
      registry.register(SENDER_B, 'req-2');
      expect(recovery.inFlightCount()).toBe(2);
      registry.abortAll();
      expect(recovery.inFlightCount()).toBe(0);
    });
  });

  describe('full disconnect→reconnect cycle', () => {
    it('abort on disconnect, then clean slate on reconnect', () => {
      const events: RecoveryEvent[] = [];
      const registry = new CancelRegistry();
      const recovery = new InboundRpcRecovery({
        registry,
        onEvent: (e) => events.push(e),
      });

      // Two RPCs in flight.
      registry.register(SENDER_A, 'req-1');
      registry.register(SENDER_A, 'req-2');
      expect(recovery.inFlightCount()).toBe(2);

      // Socket drops.
      recovery.onDisconnect('ECONNRESET');
      expect(recovery.inFlightCount()).toBe(0);

      // Reconnect — no stale state.
      recovery.onReconnect();
      expect(recovery.inFlightCount()).toBe(0);

      // Only the disconnect event fires; reconnect is silent.
      expect(events).toEqual([
        { kind: 'abort_on_disconnect', abortedCount: 2, reason: 'ECONNRESET' },
      ]);
    });
  });
});
