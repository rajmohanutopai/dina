/**
 * Task 4.48 — cancel registry tests.
 */

import { CancelRegistry } from '../src/msgbox/cancel_registry';

const SENDER_A = 'did:plc:alice';
const SENDER_B = 'did:plc:bob';

describe('CancelRegistry (task 4.48)', () => {
  describe('register + signal handoff', () => {
    it('register returns a fresh AbortSignal (not yet aborted)', () => {
      const r = new CancelRegistry();
      const reg = r.register(SENDER_A, 'req-1');
      expect(reg.signal.aborted).toBe(false);
      reg.unregister();
    });

    it('register increments size', () => {
      const r = new CancelRegistry();
      expect(r.size()).toBe(0);
      r.register(SENDER_A, 'req-1');
      expect(r.size()).toBe(1);
      r.register(SENDER_A, 'req-2');
      expect(r.size()).toBe(2);
    });

    it('has() reflects registered state', () => {
      const r = new CancelRegistry();
      expect(r.has(SENDER_A, 'req-1')).toBe(false);
      const reg = r.register(SENDER_A, 'req-1');
      expect(r.has(SENDER_A, 'req-1')).toBe(true);
      reg.unregister();
      expect(r.has(SENDER_A, 'req-1')).toBe(false);
    });
  });

  describe('cancel', () => {
    it('cancel of a registered RPC aborts its signal + returns "aborted"', () => {
      const r = new CancelRegistry();
      const reg = r.register(SENDER_A, 'req-1');
      expect(reg.signal.aborted).toBe(false);
      const result = r.cancel(SENDER_A, 'req-1');
      expect(result).toBe('aborted');
      expect(reg.signal.aborted).toBe(true);
      // Cancel also removes the controller.
      expect(r.size()).toBe(0);
      expect(r.has(SENDER_A, 'req-1')).toBe(false);
    });

    it('cancel of a non-existent RPC returns "not_found"', () => {
      const r = new CancelRegistry();
      expect(r.cancel(SENDER_A, 'never-registered')).toBe('not_found');
    });

    it('cancel after unregister returns "not_found"', () => {
      const r = new CancelRegistry();
      const reg = r.register(SENDER_A, 'req-1');
      reg.unregister();
      expect(r.cancel(SENDER_A, 'req-1')).toBe('not_found');
    });
  });

  describe('sender isolation', () => {
    it('same request_id under different senders: each has its own controller', () => {
      const r = new CancelRegistry();
      const regA = r.register(SENDER_A, 'shared');
      const regB = r.register(SENDER_B, 'shared');
      expect(regA.signal).not.toBe(regB.signal);
      expect(r.size()).toBe(2);

      r.cancel(SENDER_A, 'shared');
      expect(regA.signal.aborted).toBe(true);
      expect(regB.signal.aborted).toBe(false); // unaffected
    });
  });

  describe('duplicate register', () => {
    it('registering the same (sender, id) twice aborts the PRIOR controller + replaces', () => {
      const r = new CancelRegistry();
      const first = r.register(SENDER_A, 'req-1');
      const second = r.register(SENDER_A, 'req-1');
      // Prior controller is aborted.
      expect(first.signal.aborted).toBe(true);
      // New controller is fresh.
      expect(second.signal.aborted).toBe(false);
      // Registry has just one entry (the new one).
      expect(r.size()).toBe(1);
    });

    it('unregister of the REPLACED controller is a no-op (doesn\'t clobber the replacement)', () => {
      const r = new CancelRegistry();
      const first = r.register(SENDER_A, 'req-1');
      const second = r.register(SENDER_A, 'req-1');
      first.unregister(); // old handler finishing up
      expect(r.size()).toBe(1); // still registered (the replacement)
      expect(r.has(SENDER_A, 'req-1')).toBe(true);
      // Second's signal still available for abort.
      expect(second.signal.aborted).toBe(false);
    });
  });

  describe('abortAll', () => {
    it('aborts every in-flight controller + clears the registry', () => {
      const r = new CancelRegistry();
      const r1 = r.register(SENDER_A, 'req-1');
      const r2 = r.register(SENDER_A, 'req-2');
      const r3 = r.register(SENDER_B, 'req-3');

      const count = r.abortAll();
      expect(count).toBe(3);
      expect(r1.signal.aborted).toBe(true);
      expect(r2.signal.aborted).toBe(true);
      expect(r3.signal.aborted).toBe(true);
      expect(r.size()).toBe(0);
    });

    it('abortAll on an empty registry returns 0', () => {
      const r = new CancelRegistry();
      expect(r.abortAll()).toBe(0);
    });
  });

  describe('unregister contract', () => {
    it('handler completing normally frees the controller', () => {
      const r = new CancelRegistry();
      const reg = r.register(SENDER_A, 'req-1');
      expect(r.size()).toBe(1);
      reg.unregister();
      expect(r.size()).toBe(0);
    });

    it('unregister is idempotent (safe to call twice)', () => {
      const r = new CancelRegistry();
      const reg = r.register(SENDER_A, 'req-1');
      reg.unregister();
      expect(() => reg.unregister()).not.toThrow();
      expect(r.size()).toBe(0);
    });
  });

  describe('signal semantics for handler integration', () => {
    it('signal fires an "abort" event when cancelled', () => {
      const r = new CancelRegistry();
      const reg = r.register(SENDER_A, 'req-1');
      let fired = false;
      reg.signal.addEventListener('abort', () => {
        fired = true;
      });
      r.cancel(SENDER_A, 'req-1');
      expect(fired).toBe(true);
    });
  });
});
