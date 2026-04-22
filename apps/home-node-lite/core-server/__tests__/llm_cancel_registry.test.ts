/**
 * Task 5.21 — LLM cancel registry tests.
 */

import {
  LlmCancelRegistry,
  type LlmCancelEvent,
} from '../src/brain/llm_cancel_registry';

describe('LlmCancelRegistry (task 5.21)', () => {
  describe('register', () => {
    it('returns a fresh AbortSignal + unregister callback', () => {
      const reg = new LlmCancelRegistry();
      const { signal, unregister } = reg.register('ask-1');
      expect(signal.aborted).toBe(false);
      expect(reg.has('ask-1')).toBe(true);
      expect(reg.size()).toBe(1);
      unregister();
      expect(reg.has('ask-1')).toBe(false);
    });

    it('rejects empty requestId', () => {
      const reg = new LlmCancelRegistry();
      expect(() => reg.register('')).toThrow(/requestId is required/);
    });

    it('duplicate register aborts prior + replaces', () => {
      const events: LlmCancelEvent[] = [];
      const reg = new LlmCancelRegistry({ onEvent: (e) => events.push(e) });
      const first = reg.register('ask-1');
      expect(first.signal.aborted).toBe(false);
      const second = reg.register('ask-1');
      expect(first.signal.aborted).toBe(true); // prior is now aborted
      expect(second.signal.aborted).toBe(false);
      expect(reg.size()).toBe(1);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(['registered', 'replaced', 'registered']);
    });

    it('emits registered event', () => {
      const events: LlmCancelEvent[] = [];
      const reg = new LlmCancelRegistry({ onEvent: (e) => events.push(e) });
      reg.register('ask-1');
      expect(events).toEqual([{ kind: 'registered', requestId: 'ask-1' }]);
    });
  });

  describe('cancel', () => {
    it('aborts the signal + returns "aborted"', () => {
      const reg = new LlmCancelRegistry();
      const { signal } = reg.register('ask-1');
      expect(reg.cancel('ask-1')).toBe('aborted');
      expect(signal.aborted).toBe(true);
    });

    it('returns "not_found" on unknown id', () => {
      const reg = new LlmCancelRegistry();
      expect(reg.cancel('ghost')).toBe('not_found');
    });

    it('leaves the entry in place (handler unregisters in finally)', () => {
      const reg = new LlmCancelRegistry();
      reg.register('ask-1');
      reg.cancel('ask-1');
      expect(reg.has('ask-1')).toBe(true);
    });

    it('emits cancelled event', () => {
      const events: LlmCancelEvent[] = [];
      const reg = new LlmCancelRegistry({ onEvent: (e) => events.push(e) });
      reg.register('ask-1');
      events.length = 0;
      reg.cancel('ask-1');
      expect(events).toEqual([{ kind: 'cancelled', requestId: 'ask-1' }]);
    });
  });

  describe('unregister', () => {
    it('removes the entry', () => {
      const reg = new LlmCancelRegistry();
      const { unregister } = reg.register('ask-1');
      unregister();
      expect(reg.has('ask-1')).toBe(false);
    });

    it('is idempotent', () => {
      const reg = new LlmCancelRegistry();
      const { unregister } = reg.register('ask-1');
      unregister();
      expect(() => unregister()).not.toThrow();
      expect(reg.has('ask-1')).toBe(false);
    });

    it('does NOT remove a replacement controller (identity check)', () => {
      const reg = new LlmCancelRegistry();
      const first = reg.register('ask-1');
      // second register replaces the first — first.unregister should now be a no-op.
      const second = reg.register('ask-1');
      first.unregister();
      expect(reg.has('ask-1')).toBe(true); // second is still live
      expect(second.signal.aborted).toBe(false);
    });

    it('emits unregistered event', () => {
      const events: LlmCancelEvent[] = [];
      const reg = new LlmCancelRegistry({ onEvent: (e) => events.push(e) });
      const { unregister } = reg.register('ask-1');
      events.length = 0;
      unregister();
      expect(events).toEqual([{ kind: 'unregistered', requestId: 'ask-1' }]);
    });

    it('post-cancel unregister runs cleanly (handler finally-block pattern)', () => {
      const reg = new LlmCancelRegistry();
      const { signal, unregister } = reg.register('ask-1');
      reg.cancel('ask-1');
      expect(signal.aborted).toBe(true);
      unregister();
      expect(reg.has('ask-1')).toBe(false);
    });
  });

  describe('abortAll (graceful shutdown)', () => {
    it('aborts every registered signal + clears registry', () => {
      const reg = new LlmCancelRegistry();
      const a = reg.register('ask-a');
      const b = reg.register('ask-b');
      const c = reg.register('ask-c');
      expect(reg.abortAll()).toBe(3);
      expect(a.signal.aborted).toBe(true);
      expect(b.signal.aborted).toBe(true);
      expect(c.signal.aborted).toBe(true);
      expect(reg.size()).toBe(0);
    });

    it('emits cancelled events + abort_all with count', () => {
      const events: LlmCancelEvent[] = [];
      const reg = new LlmCancelRegistry({ onEvent: (e) => events.push(e) });
      reg.register('ask-a');
      reg.register('ask-b');
      events.length = 0;
      reg.abortAll();
      // two individual cancelled events + one abort_all summary
      expect(events.filter((e) => e.kind === 'cancelled')).toHaveLength(2);
      const summary = events.find((e) => e.kind === 'abort_all') as Extract<
        LlmCancelEvent,
        { kind: 'abort_all' }
      >;
      expect(summary.count).toBe(2);
    });

    it('empty registry: abortAll returns 0', () => {
      const reg = new LlmCancelRegistry();
      expect(reg.abortAll()).toBe(0);
    });

    it('post-abortAll, unregister callbacks from prior registrations are no-ops', () => {
      const reg = new LlmCancelRegistry();
      const a = reg.register('ask-a');
      reg.abortAll();
      // Calling unregister after abortAll should not throw and should not re-emit.
      expect(() => a.unregister()).not.toThrow();
      expect(reg.has('ask-a')).toBe(false);
    });
  });

  describe('integration: AbortSignal flows into a fetch-like call', () => {
    it('aborted signal rejects a pending Promise with AbortError semantics', async () => {
      const reg = new LlmCancelRegistry();
      const { signal } = reg.register('ask-1');
      const pending = new Promise<string>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
        // never resolves on its own
        void resolve;
      });
      reg.cancel('ask-1');
      await expect(pending).rejects.toThrow(/aborted/);
    });

    it('signal has native AbortSignal properties (reason + addEventListener)', () => {
      const reg = new LlmCancelRegistry();
      const { signal } = reg.register('ask-1');
      expect(typeof signal.addEventListener).toBe('function');
      expect(signal.aborted).toBe(false);
      reg.cancel('ask-1');
      expect(signal.aborted).toBe(true);
      // reason is set when we call `controller.abort()` (without arg, reason is a DOMException).
      expect(signal.reason).toBeDefined();
    });
  });

  describe('has + size introspectors', () => {
    it('tracks registration + unregister', () => {
      const reg = new LlmCancelRegistry();
      expect(reg.size()).toBe(0);
      const { unregister } = reg.register('ask-a');
      expect(reg.size()).toBe(1);
      expect(reg.has('ask-a')).toBe(true);
      unregister();
      expect(reg.size()).toBe(0);
    });
  });
});
