/**
 * Sender-side cosig footer derivation tests (TN-MOB-044).
 *
 * Pins the rules the sender's attestation detail screen renders:
 *
 *   - `null` labels when the relevant set is empty (no panicky
 *     "0 pending" / "Co-signed by" with nothing after).
 *   - "1 pending" / "2 pending" — singular vs plural copy share the
 *     same word; "pendings" never appears.
 *   - Accepted footer uses plan §10 wording verbatim ("Co-signed by")
 *     and the middle-dot separator (U+00B7).
 *   - Names render in input-array order so the UX is stable across
 *     re-renders.
 *   - Unresolved / null / empty / whitespace names fall back to
 *     "Someone" rather than rendering a raw DID.
 *   - Closed-but-not-success states (`expired`, `rejected`) DO NOT
 *     surface here — they live in separate inbox UX. Pinned by
 *     regression test so a future bug-fix can't accidentally bleed
 *     them into the footer.
 *   - Frozen output arrays guard against poisoning between renders.
 *   - Non-array input throws (silent coercion would hide bugs).
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  ACCEPTED_NAME_SEPARATOR,
  FALLBACK_RECIPIENT_NAME,
  deriveCosigFooter,
} from '../../src/trust/cosig_footer';

import type {
  CosigStateAccepted,
  CosigStateExpired,
  CosigStatePending,
  CosigStateRejected,
} from '@dina/protocol';

// ─── Test fixtures ────────────────────────────────────────────────────────

function pending(requestId: string, expiresAt = '2026-05-06T12:00:00Z'): CosigStatePending {
  return { status: 'pending', requestId, expiresAt };
}

function accepted(
  requestId: string,
  endorsementUri = `at://did:plc:peer/${requestId}`,
  acceptedAt = '2026-04-29T12:00:00Z',
): CosigStateAccepted {
  return {
    status: 'accepted',
    requestId,
    endorsementUri,
    endorsementCid: 'bafy-cid',
    acceptedAt,
  };
}

function rejected(requestId: string): CosigStateRejected {
  return {
    status: 'rejected',
    requestId,
    reason: 'declined',
    rejectedAt: '2026-04-29T12:00:00Z',
  };
}

function expired(requestId: string): CosigStateExpired {
  return {
    status: 'expired',
    requestId,
    expiredAt: '2026-05-07T12:00:00Z',
  };
}

// ─── Empty + counts ───────────────────────────────────────────────────────

describe('deriveCosigFooter — empty + counts', () => {
  it('returns null labels and zero counts when states is empty', () => {
    const r = deriveCosigFooter({ states: [] });
    expect(r.pendingCount).toBe(0);
    expect(r.pendingLabel).toBeNull();
    expect(r.acceptedCount).toBe(0);
    expect(r.acceptedNames).toEqual([]);
    expect(r.accepted).toEqual([]);
    expect(r.acceptedLabel).toBeNull();
  });

  it('counts pending states', () => {
    const r = deriveCosigFooter({ states: [pending('a'), pending('b'), pending('c')] });
    expect(r.pendingCount).toBe(3);
    expect(r.pendingLabel).toBe('3 pending');
  });

  it('counts accepted states', () => {
    const r = deriveCosigFooter({
      states: [accepted('a'), accepted('b')],
      recipientNames: { a: 'Sancho', b: 'Albert' },
    });
    expect(r.acceptedCount).toBe(2);
    expect(r.acceptedNames).toEqual(['Sancho', 'Albert']);
  });
});

// ─── Pending label copy ───────────────────────────────────────────────────

describe('deriveCosigFooter — pending label copy', () => {
  it('singular: "1 pending"', () => {
    const r = deriveCosigFooter({ states: [pending('a')] });
    expect(r.pendingLabel).toBe('1 pending');
  });

  it('plural: "2 pending" — same word, no "pendings"', () => {
    const r = deriveCosigFooter({ states: [pending('a'), pending('b')] });
    expect(r.pendingLabel).toBe('2 pending');
    expect(r.pendingLabel).not.toMatch(/pendings/);
  });

  it('null when no pending states (no "0 pending" subtitle)', () => {
    const r = deriveCosigFooter({
      states: [accepted('a')],
      recipientNames: { a: 'Sancho' },
    });
    expect(r.pendingLabel).toBeNull();
  });
});

// ─── Accepted footer copy ─────────────────────────────────────────────────

describe('deriveCosigFooter — accepted footer copy', () => {
  it('uses plan §10 verbatim "Co-signed by" with middle-dot separator', () => {
    const r = deriveCosigFooter({
      states: [accepted('r1'), accepted('r2')],
      recipientNames: { r1: 'Sancho', r2: 'Albert' },
    });
    expect(r.acceptedLabel).toBe('Co-signed by Sancho · Albert');
    expect(ACCEPTED_NAME_SEPARATOR).toBe(' · '); // pinned: middle dot, U+00B7
  });

  it('singular: "Co-signed by Sancho" (no trailing separator)', () => {
    const r = deriveCosigFooter({
      states: [accepted('r1')],
      recipientNames: { r1: 'Sancho' },
    });
    expect(r.acceptedLabel).toBe('Co-signed by Sancho');
  });

  it('three-plus names list every name with the separator', () => {
    const r = deriveCosigFooter({
      states: [accepted('a'), accepted('b'), accepted('c')],
      recipientNames: { a: 'Sancho', b: 'Albert', c: 'Don Quixote' },
    });
    expect(r.acceptedLabel).toBe('Co-signed by Sancho · Albert · Don Quixote');
  });

  it('null when no accepted states (no dangling "Co-signed by" header)', () => {
    const r = deriveCosigFooter({ states: [pending('a')] });
    expect(r.acceptedLabel).toBeNull();
  });
});

// ─── Name resolution + fallback ───────────────────────────────────────────

describe('deriveCosigFooter — name resolution', () => {
  it('falls back to "Someone" when the resolver has no entry for the requestId', () => {
    const r = deriveCosigFooter({
      states: [accepted('r1')],
      recipientNames: {}, // empty — name unresolved
    });
    expect(r.acceptedNames).toEqual([FALLBACK_RECIPIENT_NAME]);
    expect(r.acceptedLabel).toBe(`Co-signed by ${FALLBACK_RECIPIENT_NAME}`);
  });

  it('falls back to "Someone" for null / undefined / empty / whitespace name', () => {
    const r = deriveCosigFooter({
      states: [accepted('a'), accepted('b'), accepted('c'), accepted('d')],
      recipientNames: { a: null, b: undefined, c: '', d: '   ' },
    });
    expect(r.acceptedNames).toEqual([
      FALLBACK_RECIPIENT_NAME,
      FALLBACK_RECIPIENT_NAME,
      FALLBACK_RECIPIENT_NAME,
      FALLBACK_RECIPIENT_NAME,
    ]);
  });

  it('trims surrounding whitespace from resolved names', () => {
    const r = deriveCosigFooter({
      states: [accepted('a')],
      recipientNames: { a: '  Sancho  ' },
    });
    expect(r.acceptedNames).toEqual(['Sancho']);
  });

  it('omitted recipientNames map is treated as empty (all names → fallback)', () => {
    const r = deriveCosigFooter({ states: [accepted('a')] });
    expect(r.acceptedNames).toEqual([FALLBACK_RECIPIENT_NAME]);
  });

  it('preserves duplicate names (two contacts named Sancho cosign separately)', () => {
    const r = deriveCosigFooter({
      states: [accepted('a'), accepted('b')],
      recipientNames: { a: 'Sancho', b: 'Sancho' },
    });
    expect(r.acceptedNames).toEqual(['Sancho', 'Sancho']);
    expect(r.acceptedLabel).toBe('Co-signed by Sancho · Sancho');
  });
});

// ─── Order preservation ───────────────────────────────────────────────────

describe('deriveCosigFooter — order preservation', () => {
  it('preserves accepted-name order from the input states array', () => {
    const r = deriveCosigFooter({
      states: [accepted('z'), accepted('a'), accepted('m')],
      recipientNames: { z: 'Zoe', a: 'Albert', m: 'Marta' },
    });
    expect(r.acceptedNames).toEqual(['Zoe', 'Albert', 'Marta']);
  });

  it('mixed states: pending counted, accepted ordered relative to other accepts only', () => {
    const r = deriveCosigFooter({
      states: [pending('p1'), accepted('a1'), pending('p2'), accepted('a2')],
      recipientNames: { a1: 'Sancho', a2: 'Albert' },
    });
    expect(r.pendingCount).toBe(2);
    expect(r.acceptedNames).toEqual(['Sancho', 'Albert']);
  });
});

// ─── Closed-but-not-success states do NOT surface ─────────────────────────

describe('deriveCosigFooter — closed-non-success states excluded', () => {
  it('expired states do not increment pendingCount nor surface in accepted', () => {
    const r = deriveCosigFooter({ states: [expired('a'), expired('b')] });
    expect(r.pendingCount).toBe(0);
    expect(r.acceptedCount).toBe(0);
    expect(r.pendingLabel).toBeNull();
    expect(r.acceptedLabel).toBeNull();
  });

  it('rejected states do not increment pendingCount nor surface in accepted', () => {
    const r = deriveCosigFooter({ states: [rejected('a')] });
    expect(r.pendingCount).toBe(0);
    expect(r.acceptedCount).toBe(0);
    expect(r.pendingLabel).toBeNull();
    expect(r.acceptedLabel).toBeNull();
  });

  it('mixed pending + accepted + expired + rejected → only pending and accepted surface', () => {
    const r = deriveCosigFooter({
      states: [
        pending('p1'),
        accepted('a1'),
        expired('e1'),
        rejected('r1'),
        accepted('a2'),
      ],
      recipientNames: { a1: 'Sancho', a2: 'Albert' },
    });
    expect(r.pendingCount).toBe(1);
    expect(r.pendingLabel).toBe('1 pending');
    expect(r.acceptedNames).toEqual(['Sancho', 'Albert']);
    expect(r.acceptedLabel).toBe('Co-signed by Sancho · Albert');
  });
});

// ─── Accepted detail (endorsementUri carry-through) ───────────────────────

describe('deriveCosigFooter — accepted detail', () => {
  it('carries endorsementUri through for tap → endorsement-detail navigation', () => {
    const r = deriveCosigFooter({
      states: [accepted('r1', 'at://did:plc:sancho/com.dina.trust.endorsement/abc')],
      recipientNames: { r1: 'Sancho' },
    });
    expect(r.accepted).toHaveLength(1);
    const first = r.accepted[0];
    if (first === undefined) throw new Error('expected one accepted');
    expect(first.requestId).toBe('r1');
    expect(first.name).toBe('Sancho');
    expect(first.endorsementUri).toBe('at://did:plc:sancho/com.dina.trust.endorsement/abc');
  });

  it('accepted entries follow input order regardless of acceptedAt timestamp', () => {
    // Caller is responsible for sorting if chronological order is wanted —
    // pinning input-order semantics here so the screen knows which axis it's on.
    const r = deriveCosigFooter({
      states: [
        accepted('a', 'at://x/a', '2026-04-30T12:00:00Z'), // later acceptedAt
        accepted('b', 'at://x/b', '2026-04-29T08:00:00Z'), // earlier
      ],
      recipientNames: { a: 'Albert', b: 'Sancho' },
    });
    expect(r.acceptedNames).toEqual(['Albert', 'Sancho']);
  });
});

// ─── Frozen output ────────────────────────────────────────────────────────

describe('deriveCosigFooter — frozen output', () => {
  it('acceptedNames array is frozen', () => {
    const r = deriveCosigFooter({
      states: [accepted('r1')],
      recipientNames: { r1: 'Sancho' },
    });
    expect(Object.isFrozen(r.acceptedNames)).toBe(true);
  });

  it('accepted detail array is frozen', () => {
    const r = deriveCosigFooter({
      states: [accepted('r1')],
      recipientNames: { r1: 'Sancho' },
    });
    expect(Object.isFrozen(r.accepted)).toBe(true);
  });

  it('empty acceptedNames array is also frozen (no later mutation poisons future calls)', () => {
    const r = deriveCosigFooter({ states: [pending('a')] });
    expect(Object.isFrozen(r.acceptedNames)).toBe(true);
    expect(Object.isFrozen(r.accepted)).toBe(true);
  });
});

// ─── Defensive input ──────────────────────────────────────────────────────

describe('deriveCosigFooter — defensive input', () => {
  it('throws on non-array states (silent coercion would hide a wire bug)', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      deriveCosigFooter({ states: null }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error — runtime guard
      deriveCosigFooter({ states: undefined }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error — runtime guard
      deriveCosigFooter({ states: 'not-an-array' }),
    ).toThrow();
  });
});
