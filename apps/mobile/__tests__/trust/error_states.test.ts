/**
 * Trust Network error-state classifier + copy tests (TN-MOB-030).
 *
 * Pins the classification rules + the copy contract:
 *
 *   - Every state has copy.
 *   - States that should NOT carry a retry CTA (rate_limited, not_found)
 *     have `action: null` — regression-pinned so a future copy edit
 *     can't accidentally add a "Retry" button to a rate-limit card.
 *   - Status-code routing covers 404 / 429 / 5xx + the long-tail 4xx
 *     fallback to server_error (rather than a misleading "offline"
 *     or "not_found").
 *   - 2xx / 3xx / out-of-range / non-finite inputs return null —
 *     screens use `result === null` to mean "this isn't an error".
 *
 * Pure data + pure function — runs under plain Jest, no RN deps.
 */

import {
  ERROR_STATE_CONTENT,
  classifyTrustError,
  errorStateContentFor,
  type ErrorState,
} from '../../src/trust/error_states';

// ─── Copy guards ──────────────────────────────────────────────────────────

describe('ERROR_STATE_CONTENT', () => {
  const states: ErrorState[] = [
    'offline',
    'network_error',
    'rate_limited',
    'server_error',
    'not_found',
  ];

  it('covers every ErrorState — no missing entries', () => {
    for (const s of states) {
      expect(ERROR_STATE_CONTENT[s]).toBeDefined();
      expect(ERROR_STATE_CONTENT[s].title).toBeTruthy();
      expect(ERROR_STATE_CONTENT[s].body).toBeTruthy();
    }
  });

  it('rate_limited carries no retry CTA — hammering retry is what the limit prevents', () => {
    expect(ERROR_STATE_CONTENT.rate_limited.action).toBeNull();
  });

  it('not_found carries no retry CTA — 404 is terminal for the resource', () => {
    expect(ERROR_STATE_CONTENT.not_found.action).toBeNull();
  });

  it('offline / network_error / server_error all carry retry CTAs', () => {
    expect(ERROR_STATE_CONTENT.offline.action).toBeTruthy();
    expect(ERROR_STATE_CONTENT.network_error.action).toBeTruthy();
    expect(ERROR_STATE_CONTENT.server_error.action).toBeTruthy();
  });

  it('content is frozen at every level', () => {
    expect(Object.isFrozen(ERROR_STATE_CONTENT)).toBe(true);
    for (const s of states) {
      expect(Object.isFrozen(ERROR_STATE_CONTENT[s])).toBe(true);
    }
    const before = ERROR_STATE_CONTENT.offline.title;
    try {
      (ERROR_STATE_CONTENT.offline as { title: string }).title = 'mutated';
    } catch {
      /* sloppy mode silently no-ops; strict mode throws */
    }
    expect(ERROR_STATE_CONTENT.offline.title).toBe(before);
  });
});

// ─── Classifier — known kinds ─────────────────────────────────────────────

describe('classifyTrustError — known kinds', () => {
  it('offline → offline', () => {
    expect(classifyTrustError({ kind: 'offline' })).toBe('offline');
  });

  it('network_error → network_error (distinct from offline)', () => {
    expect(classifyTrustError({ kind: 'network_error' })).toBe('network_error');
  });
});

// ─── Classifier — HTTP status routing ─────────────────────────────────────

describe('classifyTrustError — http_status routing', () => {
  it('404 → not_found', () => {
    expect(classifyTrustError({ kind: 'http_status', status: 404 })).toBe('not_found');
  });

  it('429 → rate_limited', () => {
    expect(classifyTrustError({ kind: 'http_status', status: 429 })).toBe('rate_limited');
  });

  it('5xx → server_error', () => {
    for (const s of [500, 502, 503, 504, 599]) {
      expect(classifyTrustError({ kind: 'http_status', status: s })).toBe('server_error');
    }
  });

  it('long-tail 4xx (auth / validation / etc.) → null — caller must handle', () => {
    // Deliberate contract: 401/403/422/etc. need caller-specific
    // recovery paths (re-auth, validation surface, conflict resolution).
    // Returning null forces the screen to handle them rather than
    // hiding the bug behind a generic "server is having trouble" card.
    for (const s of [400, 401, 403, 405, 409, 410, 422]) {
      expect(classifyTrustError({ kind: 'http_status', status: s })).toBeNull();
    }
  });

  it('2xx → null (not an error)', () => {
    expect(classifyTrustError({ kind: 'http_status', status: 200 })).toBeNull();
    expect(classifyTrustError({ kind: 'http_status', status: 204 })).toBeNull();
  });

  it('3xx → null (success-after-redirect path)', () => {
    expect(classifyTrustError({ kind: 'http_status', status: 301 })).toBeNull();
    expect(classifyTrustError({ kind: 'http_status', status: 304 })).toBeNull();
  });

  it('out-of-range / non-finite statuses → null (caller bug, do not paper over)', () => {
    expect(classifyTrustError({ kind: 'http_status', status: 99 })).toBeNull();
    expect(classifyTrustError({ kind: 'http_status', status: 600 })).toBeNull();
    expect(classifyTrustError({ kind: 'http_status', status: Number.NaN })).toBeNull();
    expect(
      classifyTrustError({ kind: 'http_status', status: Number.POSITIVE_INFINITY }),
    ).toBeNull();
    expect(classifyTrustError({ kind: 'http_status', status: -1 })).toBeNull();
  });
});

// ─── Convenience wrapper ──────────────────────────────────────────────────

describe('errorStateContentFor', () => {
  it('returns the matching content bundle for an error', () => {
    expect(errorStateContentFor({ kind: 'offline' })).toBe(ERROR_STATE_CONTENT.offline);
    expect(errorStateContentFor({ kind: 'http_status', status: 429 })).toBe(
      ERROR_STATE_CONTENT.rate_limited,
    );
  });

  it('returns null when the input is not an error (single-conditional render contract)', () => {
    expect(errorStateContentFor({ kind: 'http_status', status: 200 })).toBeNull();
    expect(errorStateContentFor({ kind: 'http_status', status: Number.NaN })).toBeNull();
  });
});
