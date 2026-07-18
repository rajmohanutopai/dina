/**
 * ISVC-1 — interactive-run domain (pure state machine + barrier logic).
 * INTERACTIVE_SERVICES_ARCHITECTURE.md §5/§5.1/§18.
 */

import {
  DEFAULT_DRAIN_DEADLINE_MS,
  MAX_QUEUE_CAP,
  RunValidationError,
  canPause,
  canResume,
  canStop,
  decideBarrier,
  isRunTerminal,
  strengthOfCause,
  terminalStateForCause,
  validateCreateParams,
  type BarrierState,
  type CreateRunParams,
} from '../../src/run/domain';

const NOW = 1_700_000_000_000;

function baseParams(over: Partial<CreateRunParams> = {}): CreateRunParams {
  return {
    service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
    provider_did: 'did:plc:prov',
    persona: 'general',
    idempotency_key: 'idem-1',
    expires_at: NOW + 3_600_000,
    ...over,
  };
}

describe('validateCreateParams', () => {
  it('accepts a minimal pull run and applies defaults', () => {
    const seed = validateCreateParams(baseParams(), NOW);
    expect(seed.transport).toBe('pull');
    expect(seed.queue_cap).toBeGreaterThanOrEqual(1);
    expect(seed.priority_ceiling).toBe('solicited');
    expect(seed.max_count_basis).toBe('decided');
    expect(seed.erasure_mode).toBe('logical_deletion');
    expect(seed.on_stop).toBe('cancel_pending');
  });

  it('rejects push transports in V1 (deferred, §7.1)', () => {
    expect(() => validateCreateParams(baseParams({ transport: 'push_reserved' }), NOW)).toThrow(
      RunValidationError,
    );
    expect(() => validateCreateParams(baseParams({ transport: 'push_open' }), NOW)).toThrow(
      /deferred in V1/,
    );
  });

  it('rejects priority_ceiling=fiduciary in V1 (Tier-1 is Phase 2, §9.1)', () => {
    expect(() => validateCreateParams(baseParams({ priority_ceiling: 'fiduciary' }), NOW)).toThrow(
      /Phase 2/,
    );
  });

  it('rejects queue_cap out of 1..MAX_QUEUE_CAP', () => {
    expect(() => validateCreateParams(baseParams({ queue_cap: 0 }), NOW)).toThrow(/queue_cap/);
    expect(() => validateCreateParams(baseParams({ queue_cap: MAX_QUEUE_CAP + 1 }), NOW)).toThrow(
      /queue_cap/,
    );
    expect(validateCreateParams(baseParams({ queue_cap: MAX_QUEUE_CAP }), NOW).queue_cap).toBe(
      MAX_QUEUE_CAP,
    );
  });

  it('requires a future hard TTL (expires_at)', () => {
    expect(() => validateCreateParams({ ...baseParams(), expires_at: undefined as never }, NOW)).toThrow(
      /expires_at/,
    );
    expect(() => validateCreateParams(baseParams({ expires_at: NOW - 1 }), NOW)).toThrow(/future/);
  });

  it('rejects a BLOCKED action_risk_ceiling', () => {
    expect(() => validateCreateParams(baseParams({ action_risk_ceiling: 'BLOCKED' }), NOW)).toThrow(
      /action_risk_ceiling/,
    );
  });

  it('rejects a non-positive max_count', () => {
    expect(() => validateCreateParams(baseParams({ max_count: 0 }), NOW)).toThrow(/max_count/);
    expect(validateCreateParams(baseParams({ max_count: 3 }), NOW).max_count).toBe(3);
  });
});

describe('decideBarrier — monotonic strengthen-only (§5.1)', () => {
  it('opens a fresh barrier when not draining', () => {
    const d = decideBarrier(null, 'finish_pending', NOW + 60_000);
    expect(d.kind).toBe('open');
    if (d.kind === 'open') {
      expect(d.barrier.strength).toBe('permissive');
      expect(d.barrier.cause).toBe('finish_pending');
    }
  });

  it('strengthens a permissive drain to fencing (cancel_pending / expiry)', () => {
    const current: BarrierState = {
      cause: 'finish_pending',
      strength: 'permissive',
      deadline_at: NOW + 60_000,
    };
    const d = decideBarrier(current, 'cancel_pending', NOW + 40_000);
    expect(d.kind).toBe('strengthen');
    if (d.kind === 'strengthen') {
      expect(d.barrier.strength).toBe('fencing');
      // deadline only moves earlier-or-equal
      expect(d.barrier.deadline_at).toBe(NOW + 40_000);
    }
  });

  it('never extends the deadline when strengthening', () => {
    const current: BarrierState = {
      cause: 'count',
      strength: 'permissive',
      deadline_at: NOW + 30_000,
    };
    const d = decideBarrier(current, 'expiry', NOW + 90_000);
    expect(d.kind).toBe('strengthen');
    if (d.kind === 'strengthen') expect(d.barrier.deadline_at).toBe(NOW + 30_000);
  });

  it('is a no-op for a weaker/duplicate cause and never weakens a fencing barrier', () => {
    const fencing: BarrierState = {
      cause: 'cancel_pending',
      strength: 'fencing',
      deadline_at: NOW + 10_000,
    };
    // permissive cause onto a fencing barrier → no-op
    expect(decideBarrier(fencing, 'finish_pending', NOW + 5_000).kind).toBe('noop');
    expect(decideBarrier(fencing, 'count', NOW + 5_000).kind).toBe('noop');
    // duplicate fencing → no-op (never re-fences or moves the deadline)
    expect(decideBarrier(fencing, 'expiry', NOW + 5_000).kind).toBe('noop');
    // duplicate permissive → no-op
    const perm: BarrierState = { cause: 'count', strength: 'permissive', deadline_at: NOW + 20_000 };
    expect(decideBarrier(perm, 'finish_pending', NOW + 1_000).kind).toBe('noop');
  });
});

describe('cause helpers', () => {
  it('maps cause → strength', () => {
    expect(strengthOfCause('cancel_pending')).toBe('fencing');
    expect(strengthOfCause('expiry')).toBe('fencing');
    expect(strengthOfCause('finish_pending')).toBe('permissive');
    expect(strengthOfCause('count')).toBe('permissive');
    expect(strengthOfCause('exhaustion')).toBe('permissive');
  });

  it('maps cause → terminal state', () => {
    expect(terminalStateForCause('cancel_pending')).toBe('stopped');
    expect(terminalStateForCause('finish_pending')).toBe('stopped');
    expect(terminalStateForCause('count')).toBe('completed');
    expect(terminalStateForCause('exhaustion')).toBe('completed');
    expect(terminalStateForCause('expiry')).toBe('expired');
  });
});

describe('command / state matrix (§5.1)', () => {
  it('pause only from active', () => {
    expect(canPause('active')).toBe(true);
    expect(canPause('paused')).toBe(false);
    expect(canPause('draining')).toBe(false);
    expect(canPause('completed')).toBe(false);
  });
  it('resume only from paused', () => {
    expect(canResume('paused')).toBe(true);
    expect(canResume('active')).toBe(false);
    expect(canResume('stopped')).toBe(false);
  });
  it('stop from active/paused/draining, never terminal', () => {
    expect(canStop('active')).toBe(true);
    expect(canStop('paused')).toBe(true);
    expect(canStop('draining')).toBe(true);
    expect(canStop('completed')).toBe(false);
    expect(canStop('stopped')).toBe(false);
    expect(canStop('expired')).toBe(false);
  });
  it('isRunTerminal', () => {
    expect(isRunTerminal('completed')).toBe(true);
    expect(isRunTerminal('stopped')).toBe(true);
    expect(isRunTerminal('expired')).toBe(true);
    expect(isRunTerminal('active')).toBe(false);
    expect(isRunTerminal('draining')).toBe(false);
  });
  it('exposes the default drain deadline window', () => {
    expect(DEFAULT_DRAIN_DEADLINE_MS).toBeGreaterThan(0);
  });
});
