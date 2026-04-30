/**
 * Cosig push-notification dispatch tests (TN-MOB-045).
 *
 * Pins the silence-default decision rules + ordering:
 *
 *   - Permission gate: `denied` and `undetermined` both silence;
 *     `undetermined` does NOT trigger a re-prompt (load-bearing
 *     plan-§1-row-72 rule).
 *   - Expiry guard: a request whose `expiresAt` is in the past or
 *     exactly at `nowMs` silences with `request_expired`.
 *   - App state: `foreground` silences (in-app inbox surface
 *     handles it); `background` and `inactive` both fire.
 *   - Order: permission checks come first (most fundamental); then
 *     expiry; then app state.
 *   - Fire body: title matches `cosig_inbox.buildCosigInboxRow`
 *     (sender name with "Someone" fallback); body uses request
 *     reason or generic prompt; deep link `/trust/<subjectId>` with
 *     URL encoding; data payload carries requestId + attestationUri.
 *   - Identity-stable silence constants — two silences with the
 *     same reason return the same object reference (cheap React
 *     reconciliation).
 *   - Frozen output — fire body + nested data.
 *   - Throws on malformed `expiresAt` or empty `subjectId` rather
 *     than coercing.
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  FALLBACK_SENDER_NAME,
  GENERIC_COSIG_BODY,
  decideCosigNotification,
  type DecideCosigNotificationInput,
} from '../../src/trust/notification_dispatch';

import type { CosigRequest } from '@dina/protocol';

const T0 = Date.parse('2026-04-29T12:00:00Z');
const FUTURE_EXPIRY = '2026-05-06T12:00:00Z';
const PAST_EXPIRY = '2026-04-28T12:00:00Z';

function request(partial: Partial<CosigRequest> = {}): CosigRequest {
  return {
    type: 'trust.cosig.request',
    requestId: 'req-1',
    attestationUri: 'at://did:plc:author/com.dina.trust.attestation/abc',
    attestationCid: 'bafy...',
    expiresAt: FUTURE_EXPIRY,
    createdAt: '2026-04-29T12:00:00Z',
    ...partial,
  };
}

function input(partial: Partial<DecideCosigNotificationInput> = {}): DecideCosigNotificationInput {
  return {
    permission: 'granted',
    request: request(),
    senderName: 'Sancho',
    subjectId: 'subj-aeron',
    appState: 'background',
    nowMs: T0,
    ...partial,
  };
}

// ─── Permission gate ──────────────────────────────────────────────────────

describe('decideCosigNotification — permission gate', () => {
  it('denied → silence(permission_denied)', () => {
    const r = decideCosigNotification(input({ permission: 'denied' }));
    expect(r.kind).toBe('silence');
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('permission_denied');
  });

  it('undetermined → silence(permission_undetermined) — DOES NOT re-prompt', () => {
    const r = decideCosigNotification(input({ permission: 'undetermined' }));
    expect(r.kind).toBe('silence');
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('permission_undetermined');
  });

  it('granted + everything else valid → fire', () => {
    const r = decideCosigNotification(input({ permission: 'granted' }));
    expect(r.kind).toBe('fire');
  });
});

// ─── Expiry guard ─────────────────────────────────────────────────────────

describe('decideCosigNotification — expiry guard', () => {
  it('past expiry → silence(request_expired)', () => {
    const r = decideCosigNotification(
      input({ request: request({ expiresAt: PAST_EXPIRY }) }),
    );
    expect(r.kind).toBe('silence');
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('request_expired');
  });

  it('AT expiry boundary → silence(request_expired) — `>=` closes the window', () => {
    const r = decideCosigNotification(
      input({ nowMs: Date.parse(FUTURE_EXPIRY) }),
    );
    expect(r.kind).toBe('silence');
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('request_expired');
  });

  it('1 ms before expiry boundary → fire', () => {
    const r = decideCosigNotification(
      input({ nowMs: Date.parse(FUTURE_EXPIRY) - 1 }),
    );
    expect(r.kind).toBe('fire');
  });
});

// ─── App-state gate ───────────────────────────────────────────────────────

describe('decideCosigNotification — app-state gate', () => {
  it('foreground → silence(app_foreground)', () => {
    const r = decideCosigNotification(input({ appState: 'foreground' }));
    expect(r.kind).toBe('silence');
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('app_foreground');
  });

  it('background → fire', () => {
    const r = decideCosigNotification(input({ appState: 'background' }));
    expect(r.kind).toBe('fire');
  });

  it('inactive → fire (treat as background)', () => {
    const r = decideCosigNotification(input({ appState: 'inactive' }));
    expect(r.kind).toBe('fire');
  });
});

// ─── Decision ordering ────────────────────────────────────────────────────

describe('decideCosigNotification — decision ordering', () => {
  it('denied + expired → returns permission_denied (permission gate first)', () => {
    const r = decideCosigNotification(
      input({ permission: 'denied', request: request({ expiresAt: PAST_EXPIRY }) }),
    );
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('permission_denied');
  });

  it('undetermined + foreground → returns permission_undetermined (permission gate first)', () => {
    const r = decideCosigNotification(
      input({ permission: 'undetermined', appState: 'foreground' }),
    );
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('permission_undetermined');
  });

  it('granted + expired + foreground → returns request_expired (expiry before app state)', () => {
    const r = decideCosigNotification(
      input({
        permission: 'granted',
        request: request({ expiresAt: PAST_EXPIRY }),
        appState: 'foreground',
      }),
    );
    if (r.kind !== 'silence') throw new Error('expected silence');
    expect(r.reason).toBe('request_expired');
  });
});

// ─── Identity-stable silence constants ───────────────────────────────────

describe('decideCosigNotification — identity-stable silence constants', () => {
  it('two denied calls return the same silence reference', () => {
    const a = decideCosigNotification(input({ permission: 'denied' }));
    const b = decideCosigNotification(input({ permission: 'denied' }));
    expect(a).toBe(b);
  });

  it('two undetermined calls return the same silence reference', () => {
    const a = decideCosigNotification(input({ permission: 'undetermined' }));
    const b = decideCosigNotification(input({ permission: 'undetermined' }));
    expect(a).toBe(b);
  });

  it('two foreground calls return the same silence reference', () => {
    const a = decideCosigNotification(input({ appState: 'foreground' }));
    const b = decideCosigNotification(input({ appState: 'foreground' }));
    expect(a).toBe(b);
  });

  it('two expired calls return the same silence reference', () => {
    const a = decideCosigNotification(input({ request: request({ expiresAt: PAST_EXPIRY }) }));
    const b = decideCosigNotification(input({ request: request({ expiresAt: PAST_EXPIRY }) }));
    expect(a).toBe(b);
  });

  it('silence objects are frozen (mutation cannot poison the next render)', () => {
    const r = decideCosigNotification(input({ permission: 'denied' }));
    expect(Object.isFrozen(r)).toBe(true);
  });
});

// ─── Fire body — title ────────────────────────────────────────────────────

describe('decideCosigNotification — fire body title', () => {
  it('renders "<sender> asked you to co-sign their review"', () => {
    const r = decideCosigNotification(input({ senderName: 'Sancho' }));
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.title).toBe('Sancho asked you to co-sign their review');
  });

  it('falls back to "Someone" for null / undefined / empty / whitespace senderName', () => {
    const cases: (string | null | undefined)[] = [null, undefined, '', '   '];
    for (const senderName of cases) {
      const r = decideCosigNotification(input({ senderName }));
      if (r.kind !== 'fire') throw new Error('expected fire');
      expect(r.body.title).toBe(`${FALLBACK_SENDER_NAME} asked you to co-sign their review`);
    }
  });

  it('trims surrounding whitespace from senderName', () => {
    const r = decideCosigNotification(input({ senderName: '  Don Alonso  ' }));
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.title).toBe('Don Alonso asked you to co-sign their review');
  });
});

// ─── Fire body — body text ────────────────────────────────────────────────

describe('decideCosigNotification — fire body text', () => {
  it('uses request.reason when provided', () => {
    const r = decideCosigNotification(
      input({ request: request({ reason: 'You bought one in 2024 too' }) }),
    );
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.body).toBe('You bought one in 2024 too');
  });

  it('falls back to GENERIC_COSIG_BODY when reason is undefined', () => {
    const r = decideCosigNotification(input({ request: request({ reason: undefined }) }));
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.body).toBe(GENERIC_COSIG_BODY);
  });

  it('falls back to GENERIC_COSIG_BODY when reason is whitespace-only', () => {
    const r = decideCosigNotification(input({ request: request({ reason: '   ' }) }));
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.body).toBe(GENERIC_COSIG_BODY);
  });

  it('trims reason before rendering', () => {
    const r = decideCosigNotification(input({ request: request({ reason: '  hi  ' }) }));
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.body).toBe('hi');
  });
});

// ─── Fire body — deep link + data ────────────────────────────────────────

describe('decideCosigNotification — fire body deep link + data', () => {
  it('builds /trust/<subjectId> deep link', () => {
    const r = decideCosigNotification(input({ subjectId: 'subj-aeron' }));
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.deepLink).toBe('/trust/subj-aeron');
  });

  it('URL-encodes special characters in subjectId', () => {
    const r = decideCosigNotification(input({ subjectId: 'subj a/b' }));
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.deepLink).toBe('/trust/subj%20a%2Fb');
  });

  it('data payload carries requestId and attestationUri', () => {
    const r = decideCosigNotification(
      input({
        request: request({
          requestId: 'req-7',
          attestationUri: 'at://did:plc:author/com.dina.trust.attestation/xyz',
        }),
      }),
    );
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(r.body.data.requestId).toBe('req-7');
    expect(r.body.data.attestationUri).toBe(
      'at://did:plc:author/com.dina.trust.attestation/xyz',
    );
  });

  it('fire body + nested data are frozen', () => {
    const r = decideCosigNotification(input());
    if (r.kind !== 'fire') throw new Error('expected fire');
    expect(Object.isFrozen(r.body)).toBe(true);
    expect(Object.isFrozen(r.body.data)).toBe(true);
  });
});

// ─── Malformed input ──────────────────────────────────────────────────────

describe('decideCosigNotification — malformed input', () => {
  it('throws on a non-ISO expiresAt', () => {
    expect(() =>
      decideCosigNotification(input({ request: request({ expiresAt: 'yesterday' }) })),
    ).toThrow(/ISO-8601/);
  });

  it('throws on empty expiresAt', () => {
    expect(() =>
      decideCosigNotification(input({ request: request({ expiresAt: '' }) })),
    ).toThrow(/ISO-8601/);
  });

  it('throws on empty subjectId (would build a broken deep link)', () => {
    expect(() => decideCosigNotification(input({ subjectId: '' }))).toThrow();
  });

  it('throws on non-string subjectId (defensive)', () => {
    expect(() =>
      // @ts-expect-error — runtime guard
      decideCosigNotification(input({ subjectId: undefined })),
    ).toThrow();
  });

  it('does NOT throw on missing subjectId when permission gate silences first', () => {
    // permission_denied short-circuits before the subjectId is read.
    expect(() =>
      // @ts-expect-error — bypass type to confirm short-circuit
      decideCosigNotification({ ...input({ permission: 'denied' }), subjectId: '' }),
    ).not.toThrow();
  });
});
