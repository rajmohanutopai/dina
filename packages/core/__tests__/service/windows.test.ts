/**
 * Tests for the `providerWindow` / `requesterWindow` singletons.
 */

import {
  DEFAULT_WINDOW_CLEANUP_INTERVAL_MS,
  providerWindow,
  releaseProviderWindow,
  requesterWindow,
  resetServiceWindows,
  setProviderWindow,
  setRequesterWindow,
  startServiceWindowCleanup,
  stopServiceWindowCleanup,
} from '../../src/service/windows';

describe('service windows', () => {
  beforeEach(() => {
    resetServiceWindows();
  });

  afterAll(() => {
    resetServiceWindows();
  });

  describe('singletons', () => {
    it('provider and requester are distinct instances', () => {
      expect(providerWindow()).not.toBe(requesterWindow());
    });

    it('lazy creation: first call returns same instance as subsequent calls', () => {
      const a = providerWindow();
      const b = providerWindow();
      expect(a).toBe(b);
    });

    it('resetServiceWindows drops both singletons (new instances next time)', () => {
      const a = providerWindow();
      resetServiceWindows();
      const b = providerWindow();
      expect(a).not.toBe(b);
    });
  });

  describe('setProviderWindow / releaseProviderWindow', () => {
    it('opens an entry that matches checkAndConsume', () => {
      setProviderWindow('did:plc:bus42', 'q-1', 'eta_query', 60);
      expect(providerWindow().checkAndConsume('did:plc:bus42', 'q-1', 'eta_query')).toBe(true);
    });

    it('opens with a future expiry (TTL > 0 is live for some time)', () => {
      // Finer-grained expiry-unit verification lives in query_window.test.ts
      // with an injected clock; here we just prove that a non-zero TTL
      // produces an entry that is immediately peekable.
      setProviderWindow('did:plc:x', 'q-ttl', 'cap', 5);
      expect(providerWindow().size()).toBe(1);
      expect(providerWindow().peek('did:plc:x', 'q-ttl', 'cap')).toBe(true);
    });

    it('release preserves the entry and flips reserved=false', () => {
      setProviderWindow('did:plc:bus42', 'q-2', 'eta_query', 60);
      const ok1 = providerWindow().reserve('did:plc:bus42', 'q-2', 'eta_query');
      expect(ok1).toBe(true);
      releaseProviderWindow('did:plc:bus42', 'q-2', 'eta_query');
      const ok2 = providerWindow().reserve('did:plc:bus42', 'q-2', 'eta_query');
      expect(ok2).toBe(true);
    });
  });

  describe('setRequesterWindow', () => {
    it('opens an entry in the requester singleton (not the provider)', () => {
      setRequesterWindow('did:plc:bus42', 'q-3', 'eta_query', 30);
      expect(providerWindow().size()).toBe(0);
      expect(requesterWindow().size()).toBe(1);
    });

    it('peek returns true for matching triples', () => {
      setRequesterWindow('did:plc:bus42', 'q-4', 'eta_query', 30);
      expect(requesterWindow().peek('did:plc:bus42', 'q-4', 'eta_query')).toBe(true);
    });

    it('peek returns false for the wrong capability', () => {
      setRequesterWindow('did:plc:bus42', 'q-4', 'eta_query', 30);
      expect(requesterWindow().peek('did:plc:bus42', 'q-4', 'route_info')).toBe(false);
    });

    it('peek does NOT consume the entry', () => {
      setRequesterWindow('did:plc:bus42', 'q-4', 'eta_query', 30);
      expect(requesterWindow().peek('did:plc:bus42', 'q-4', 'eta_query')).toBe(true);
      expect(requesterWindow().peek('did:plc:bus42', 'q-4', 'eta_query')).toBe(true);
      expect(requesterWindow().size()).toBe(1);
    });
  });

  describe('cleanup lifecycle', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('DEFAULT_WINDOW_CLEANUP_INTERVAL_MS is 30 seconds', () => {
      expect(DEFAULT_WINDOW_CLEANUP_INTERVAL_MS).toBe(30_000);
    });

    it('startServiceWindowCleanup returns a disposer that stops both sweepers', () => {
      const dispose = startServiceWindowCleanup(100);
      expect(typeof dispose).toBe('function');
      dispose();
      // Second call to disposer is a no-op.
      expect(() => dispose()).not.toThrow();
    });

    it('stopServiceWindowCleanup halts all active sweepers', () => {
      startServiceWindowCleanup(100);
      startServiceWindowCleanup(100); // second sweeper
      expect(() => stopServiceWindowCleanup()).not.toThrow();
    });
  });
});
