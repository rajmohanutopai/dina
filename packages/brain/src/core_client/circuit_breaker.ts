/**
 * Circuit breaker — prevent cascade failures when Core is down.
 *
 * States:
 *   CLOSED  — normal operation, requests pass through
 *   OPEN    — Core is down, requests fail immediately (fast-fail)
 *   HALF_OPEN — testing recovery, one probe request allowed
 *
 * Transitions:
 *   CLOSED → OPEN: after `failureThreshold` consecutive failures
 *   OPEN → HALF_OPEN: after `cooldownMs` has elapsed
 *   HALF_OPEN → CLOSED: if probe request succeeds
 *   HALF_OPEN → OPEN: if probe request fails (reset cooldown)
 *
 * Matching Go's circuit breaker: 5 failures, 30s cooldown.
 *
 * Source: brain/src/service/guardian.py — circuit breaker pattern
 */

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Time in ms to wait before attempting recovery (half-open). Default: 30000 (30s). */
  cooldownMs?: number;
  /** Injectable clock for testing. Returns current time in ms. */
  clock?: () => number;
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  totalFailures: number;
  totalSuccesses: number;
}

// ---------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000; // 30s (matching Go)

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private totalFailures = 0;
  private totalSuccesses = 0;
  private probeInProgress = false;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = config?.clock ?? (() => Date.now());
  }

  /**
   * Check if a request should be allowed through.
   *
   * Returns true if the circuit is closed or half-open (probe allowed).
   * Returns false if the circuit is open (fast-fail).
   */
  allowRequest(): boolean {
    switch (this.state) {
      case 'closed':
        return true;

      case 'open': {
        // Check if cooldown has elapsed → transition to half_open
        const now = this.clock();
        if (this.lastFailureAt !== null && now - this.lastFailureAt >= this.cooldownMs) {
          // Only allow one probe at a time to prevent concurrent probes
          if (this.probeInProgress) return false;
          this.state = 'half_open';
          this.probeInProgress = true;
          return true; // Allow one probe request
        }
        return false; // Still cooling down — fast-fail
      }

      case 'half_open':
        // Only one probe allowed — block additional requests
        if (this.probeInProgress) return false;
        return true;
    }
  }

  /**
   * Record a successful request.
   *
   * In half_open state, this closes the circuit (recovery confirmed).
   */
  recordSuccess(): void {
    this.totalSuccesses++;
    this.lastSuccessAt = this.clock();
    this.probeInProgress = false;

    switch (this.state) {
      case 'half_open':
        // Recovery confirmed — close the circuit
        this.state = 'closed';
        this.consecutiveFailures = 0;
        break;
      case 'closed':
        this.consecutiveFailures = 0;
        break;
    }
  }

  /**
   * Record a failed request.
   *
   * In closed state, increments failure count. Opens circuit at threshold.
   * In half_open state, reopens the circuit (recovery failed).
   */
  recordFailure(): void {
    this.totalFailures++;
    this.consecutiveFailures++;
    this.lastFailureAt = this.clock();
    this.probeInProgress = false;

    switch (this.state) {
      case 'closed':
        if (this.consecutiveFailures >= this.failureThreshold) {
          this.state = 'open';
        }
        break;
      case 'half_open':
        // Probe failed — reopen the circuit
        this.state = 'open';
        break;
    }
  }

  /**
   * Get the current circuit breaker status.
   */
  getStatus(): CircuitBreakerStatus {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /**
   * Reset the circuit breaker to initial state (for testing).
   */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
    this.probeInProgress = false;
  }

  /**
   * Execute a function through the circuit breaker.
   *
   * If the circuit is open, throws immediately without calling fn.
   * If the circuit is closed/half-open, calls fn and records result.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.allowRequest()) {
      throw new CircuitBreakerOpenError(this.getStatus());
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }
}

/**
 * Error thrown when the circuit breaker is open (fast-fail).
 */
export class CircuitBreakerOpenError extends Error {
  readonly status: CircuitBreakerStatus;

  constructor(status: CircuitBreakerStatus) {
    super(
      `Circuit breaker OPEN: ${status.consecutiveFailures} consecutive failures. Cooldown active.`,
    );
    this.name = 'CircuitBreakerOpenError';
    this.status = status;
  }
}
