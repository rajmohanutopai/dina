/**
 * Cosig recipient-action data tests (TN-MOB-043).
 *
 * Pins the rules the action sheet + decline path rely on:
 *
 *   - `classifyActionable` — pending+alive → actionable; pending+at
 *     or past expiry → expired; terminal states (accepted / rejected /
 *     expired) → not actionable. Boundary closes (`>=`).
 *   - Result constants are module-level frozen + identity-stable.
 *   - `buildCosigRejectFrame` — wire-validates the produced
 *     `CosigReject` via the protocol's authoritative validator.
 *     Throws (not return-null) so the screen gets a synchronous
 *     error.
 *   - `text` is omitted from the frame when absent (no `text: undefined`
 *     pollution).
 *   - `createdAt` derives from `nowMs` deterministically.
 *   - All four `CosigRejectReason` values supported.
 *
 * Pure functions — runs under plain Jest, no RN deps.
 */

import {
  buildCosigRejectFrame,
  classifyActionable,
  type ActionableResult,
} from '../../src/trust/cosig_action';

import type {
  CosigStateAccepted,
  CosigStateExpired,
  CosigStatePending,
  CosigStateRejected,
} from '@dina/protocol';

const T0 = Date.parse('2026-04-29T12:00:00Z');
const EXP_AT = '2026-05-06T12:00:00Z';
const EXP_MS = Date.parse(EXP_AT);

function pending(expiresAt = EXP_AT): CosigStatePending {
  return { status: 'pending', requestId: 'req-1', expiresAt };
}

function accepted(): CosigStateAccepted {
  return {
    status: 'accepted',
    requestId: 'req-1',
    endorsementUri: 'at://x/y',
    endorsementCid: 'bafy',
    acceptedAt: '2026-04-30T00:00:00Z',
  };
}

function rejected(): CosigStateRejected {
  return {
    status: 'rejected',
    requestId: 'req-1',
    reason: 'declined',
    rejectedAt: '2026-04-30T00:00:00Z',
  };
}

function expired(): CosigStateExpired {
  return { status: 'expired', requestId: 'req-1', expiredAt: '2026-05-07T00:00:00Z' };
}

// ─── classifyActionable — state classification ────────────────────────────

describe('classifyActionable — state classification', () => {
  it('pending + before expiry → actionable / status=pending', () => {
    const r = classifyActionable(pending(), T0);
    expect(r.actionable).toBe(true);
    expect(r.status).toBe('pending');
  });

  it('pending + AT expiry boundary → expired (>= closes the row)', () => {
    const r = classifyActionable(pending(), EXP_MS);
    expect(r.actionable).toBe(false);
    expect(r.status).toBe('expired');
  });

  it('pending + past expiry → expired', () => {
    const r = classifyActionable(pending(), EXP_MS + 1000);
    expect(r.actionable).toBe(false);
    expect(r.status).toBe('expired');
  });

  it('accepted (terminal) → not actionable / status=already-accepted, even past expiry', () => {
    const r = classifyActionable(accepted(), EXP_MS + 86_400_000);
    expect(r.actionable).toBe(false);
    expect(r.status).toBe('already-accepted');
  });

  it('rejected (terminal) → not actionable / status=already-rejected, even past expiry', () => {
    const r = classifyActionable(rejected(), EXP_MS + 86_400_000);
    expect(r.actionable).toBe(false);
    expect(r.status).toBe('already-rejected');
  });

  it('expired → not actionable / status=expired', () => {
    const r = classifyActionable(expired(), T0);
    expect(r.actionable).toBe(false);
    expect(r.status).toBe('expired');
  });
});

// ─── classifyActionable — identity stability ──────────────────────────────

describe('classifyActionable — identity stability (cheap React reconciliation)', () => {
  it('two pending+alive states return the same result reference', () => {
    const a = classifyActionable(pending(), T0);
    const b = classifyActionable(pending('2030-01-01T00:00:00Z'), T0);
    expect(a).toBe(b);
  });

  it('two accepted states return the same result reference', () => {
    const a = classifyActionable(accepted(), T0);
    const b = classifyActionable(accepted(), T0 + 1);
    expect(a).toBe(b);
  });

  it('result objects are frozen (mutation cannot poison the next render)', () => {
    const r = classifyActionable(pending(), T0);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('expired-from-pending and expired-from-state share the same result reference', () => {
    const fromPending = classifyActionable(pending(), EXP_MS + 1);
    const fromExpired = classifyActionable(expired(), T0);
    expect(fromPending).toBe(fromExpired);
  });
});

// ─── classifyActionable — malformed input ─────────────────────────────────

describe('classifyActionable — malformed input', () => {
  it('throws on a non-ISO expiresAt (silent coercion would close an active row)', () => {
    expect(() => classifyActionable(pending('yesterday'), T0)).toThrow(/ISO-8601/);
  });

  it('throws on an empty expiresAt', () => {
    expect(() => classifyActionable(pending(''), T0)).toThrow(/ISO-8601/);
  });
});

// ─── buildCosigRejectFrame — happy path ───────────────────────────────────

describe('buildCosigRejectFrame — happy path', () => {
  it('builds a valid CosigReject for "declined" (the user-facing decline)', () => {
    const frame = buildCosigRejectFrame({
      requestId: 'req-1',
      reason: 'declined',
      nowMs: T0,
    });
    expect(frame.type).toBe('trust.cosig.reject');
    expect(frame.requestId).toBe('req-1');
    expect(frame.reason).toBe('declined');
    expect(frame.createdAt).toBe('2026-04-29T12:00:00.000Z');
    expect(frame).not.toHaveProperty('text');
  });

  it('passes text through when provided', () => {
    const frame = buildCosigRejectFrame({
      requestId: 'req-1',
      reason: 'declined',
      text: 'Not the right fit for me',
      nowMs: T0,
    });
    expect(frame.text).toBe('Not the right fit for me');
  });

  it('omits text key entirely when undefined (no `text: undefined` pollution)', () => {
    const frame = buildCosigRejectFrame({
      requestId: 'req-1',
      reason: 'declined',
      nowMs: T0,
    });
    expect(Object.keys(frame).sort()).toEqual(
      ['type', 'requestId', 'reason', 'createdAt'].sort(),
    );
  });

  it('supports all four CosigRejectReason values', () => {
    const reasons = ['declined', 'unable-to-verify', 'not-applicable', 'other'] as const;
    for (const reason of reasons) {
      const frame = buildCosigRejectFrame({ requestId: 'req-1', reason, nowMs: T0 });
      expect(frame.reason).toBe(reason);
    }
  });

  it('createdAt derives from nowMs deterministically', () => {
    const ms = Date.parse('2027-01-15T08:30:45.123Z');
    const frame = buildCosigRejectFrame({
      requestId: 'req-2',
      reason: 'other',
      nowMs: ms,
    });
    expect(frame.createdAt).toBe('2027-01-15T08:30:45.123Z');
  });
});

// ─── buildCosigRejectFrame — validation throws ────────────────────────────

describe('buildCosigRejectFrame — validation throws', () => {
  it('throws on empty requestId (sender bug — should never reach the wire)', () => {
    expect(() =>
      buildCosigRejectFrame({ requestId: '', reason: 'declined', nowMs: T0 }),
    ).toThrow();
  });

  it('throws on unknown reason value', () => {
    expect(() =>
      buildCosigRejectFrame({
        requestId: 'req-1',
        // @ts-expect-error — unknown reason should fail at runtime
        reason: 'whatever',
        nowMs: T0,
      }),
    ).toThrow();
  });

  it('throws when text exceeds the protocol-side cap (does NOT silently truncate)', () => {
    expect(() =>
      buildCosigRejectFrame({
        requestId: 'req-1',
        reason: 'declined',
        text: 'a'.repeat(1001), // protocol cap is 1000
        nowMs: T0,
      }),
    ).toThrow();
  });

  it('throws on non-finite nowMs', () => {
    expect(() =>
      buildCosigRejectFrame({
        requestId: 'req-1',
        reason: 'declined',
        nowMs: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      buildCosigRejectFrame({
        requestId: 'req-1',
        reason: 'declined',
        nowMs: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
  });

  it('throws on non-number nowMs (defensive)', () => {
    expect(() =>
      buildCosigRejectFrame({
        requestId: 'req-1',
        reason: 'declined',
        // @ts-expect-error — runtime guard
        nowMs: 'now',
      }),
    ).toThrow();
  });
});

// ─── Type sanity ──────────────────────────────────────────────────────────

describe('cosig_action — type sanity', () => {
  it('ActionableResult shape is the documented contract', () => {
    const r: ActionableResult = classifyActionable(pending(), T0);
    expect(typeof r.actionable).toBe('boolean');
    expect(['pending', 'expired', 'already-accepted', 'already-rejected']).toContain(r.status);
  });
});
