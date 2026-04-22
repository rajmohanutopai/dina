/**
 * Circuit breaker — prevent cascade failures when Core is down.
 *
 * Tests state transitions: closed → open → half_open → closed/open.
 *
 * Source: brain/src/service/guardian.py — circuit breaker pattern
 */

import { CircuitBreaker, CircuitBreakerOpenError } from '../../src/core_client/circuit_breaker';

describe('Circuit Breaker', () => {
  describe('initial state', () => {
    it('starts in closed state', () => {
      const cb = new CircuitBreaker();
      expect(cb.getStatus().state).toBe('closed');
    });

    it('allows requests in closed state', () => {
      const cb = new CircuitBreaker();
      expect(cb.allowRequest()).toBe(true);
    });

    it('has zero failures initially', () => {
      const cb = new CircuitBreaker();
      expect(cb.getStatus().consecutiveFailures).toBe(0);
      expect(cb.getStatus().totalFailures).toBe(0);
    });
  });

  describe('closed → open transition', () => {
    it('opens after threshold consecutive failures (default: 5)', () => {
      const cb = new CircuitBreaker();

      for (let i = 0; i < 4; i++) {
        cb.recordFailure();
        expect(cb.getStatus().state).toBe('closed'); // still closed
      }

      cb.recordFailure(); // 5th failure
      expect(cb.getStatus().state).toBe('open');
    });

    it('respects custom threshold', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });

      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getStatus().state).toBe('closed');

      cb.recordFailure(); // 3rd
      expect(cb.getStatus().state).toBe('open');
    });

    it('resets failure count on success', () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });

      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess(); // resets consecutive count
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getStatus().state).toBe('closed'); // still closed — count reset
    });
  });

  describe('open state (fast-fail)', () => {
    it('blocks requests when open', () => {
      const cb = new CircuitBreaker({ failureThreshold: 2 });
      cb.recordFailure();
      cb.recordFailure(); // opens

      expect(cb.allowRequest()).toBe(false);
    });

    it('tracks total failures across transitions', () => {
      const cb = new CircuitBreaker({ failureThreshold: 2 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getStatus().totalFailures).toBe(2);
    });
  });

  describe('open → half_open transition (cooldown)', () => {
    it('transitions to half_open after cooldown', () => {
      let now = 1000;
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 5000,
        clock: () => now,
      });

      cb.recordFailure();
      cb.recordFailure(); // opens at t=1000

      now = 5999; // 4999ms elapsed — still cooling down
      expect(cb.allowRequest()).toBe(false);
      expect(cb.getStatus().state).toBe('open');

      now = 6000; // 5000ms elapsed — cooldown complete
      expect(cb.allowRequest()).toBe(true);
      expect(cb.getStatus().state).toBe('half_open');
    });
  });

  describe('half_open → closed (recovery)', () => {
    it('closes on successful probe', () => {
      let now = 1000;
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 1000,
        clock: () => now,
      });

      cb.recordFailure();
      cb.recordFailure(); // open

      now = 2001; // cooldown elapsed
      cb.allowRequest(); // transitions to half_open

      cb.recordSuccess(); // probe succeeds
      expect(cb.getStatus().state).toBe('closed');
      expect(cb.getStatus().consecutiveFailures).toBe(0);
    });
  });

  describe('half_open → open (probe fails)', () => {
    it('reopens on failed probe', () => {
      let now = 1000;
      const cb = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 1000,
        clock: () => now,
      });

      cb.recordFailure();
      cb.recordFailure(); // open

      now = 2001;
      cb.allowRequest(); // half_open

      cb.recordFailure(); // probe fails
      expect(cb.getStatus().state).toBe('open');
    });
  });

  describe('execute()', () => {
    it('passes through when closed', async () => {
      const cb = new CircuitBreaker();
      const result = await cb.execute(async () => 42);
      expect(result).toBe(42);
      expect(cb.getStatus().totalSuccesses).toBe(1);
    });

    it('throws CircuitBreakerOpenError when open', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 2 });
      cb.recordFailure();
      cb.recordFailure();

      await expect(cb.execute(async () => 42)).rejects.toThrow(CircuitBreakerOpenError);
    });

    it('records failure when fn throws', async () => {
      const cb = new CircuitBreaker();
      await expect(
        cb.execute(async () => {
          throw new Error('fail');
        }),
      ).rejects.toThrow('fail');
      expect(cb.getStatus().consecutiveFailures).toBe(1);
    });

    it('records success when fn resolves', async () => {
      const cb = new CircuitBreaker();
      await cb.execute(async () => 'ok');
      expect(cb.getStatus().totalSuccesses).toBe(1);
      expect(cb.getStatus().consecutiveFailures).toBe(0);
    });

    it('CircuitBreakerOpenError contains status', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      cb.recordFailure();

      try {
        await cb.execute(async () => 42);
        expect(true).toBe(false); // should not reach
      } catch (err) {
        expect(err).toBeInstanceOf(CircuitBreakerOpenError);
        expect((err as CircuitBreakerOpenError).status.state).toBe('open');
        expect((err as CircuitBreakerOpenError).status.consecutiveFailures).toBe(1);
      }
    });
  });

  describe('reset()', () => {
    it('resets all state', () => {
      const cb = new CircuitBreaker({ failureThreshold: 2 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getStatus().state).toBe('open');

      cb.reset();
      expect(cb.getStatus().state).toBe('closed');
      expect(cb.getStatus().consecutiveFailures).toBe(0);
      expect(cb.getStatus().totalFailures).toBe(0);
      expect(cb.getStatus().totalSuccesses).toBe(0);
    });
  });

  describe('statistics', () => {
    it('tracks total successes and failures independently', () => {
      const cb = new CircuitBreaker();
      cb.recordSuccess();
      cb.recordSuccess();
      cb.recordFailure();
      cb.recordSuccess();

      expect(cb.getStatus().totalSuccesses).toBe(3);
      expect(cb.getStatus().totalFailures).toBe(1);
    });

    it('tracks last success/failure timestamps', () => {
      let now = 1000;
      const cb = new CircuitBreaker({ clock: () => now });

      now = 1000;
      cb.recordSuccess();
      expect(cb.getStatus().lastSuccessAt).toBe(1000);

      now = 2000;
      cb.recordFailure();
      expect(cb.getStatus().lastFailureAt).toBe(2000);
    });
  });
});
