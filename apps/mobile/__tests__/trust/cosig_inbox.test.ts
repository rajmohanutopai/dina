/**
 * Cosig inbox row data tests (TN-MOB-040).
 *
 * Pins the rules the inbox renderer + action sheet + deep-link
 * router all share:
 *
 *   - State classification: `pending`, `accepted`, `declined`,
 *     `expired`. `accepted`/`declined` are terminal and ignore
 *     expiry (cosigned-then-time-passed is still "cosigned").
 *   - Title: "<sender> asked you to co-sign their review", with
 *     graceful fallback to "Someone" when the resolver hasn't
 *     produced a display name yet.
 *   - Actions: `['endorse', 'decline']` in pending, `[]` everywhere
 *     else.
 *   - Deep link: `/trust/<subjectId>?attestation=<at-uri>` per plan
 *     §10 + TN-MOB-041 — the source attestation is anchored as a
 *     query param so the screen can scroll to / highlight the exact
 *     record that triggered the inbox row.
 *   - msUntilExpiry: positive when alive, negative once past.
 *   - Malformed `expiresAt` throws (silent NaN would corrupt sort
 *     orders + analytics).
 *
 * Pure function — runs under plain Jest, no RN deps.
 */

import {
  buildCosigInboxRow,
  type CosigInboxInput,
} from '../../src/trust/cosig_inbox';

import type { CosigRequest } from '@dina/protocol';

const T0 = Date.parse('2026-04-29T12:00:00Z');

function request(partial: Partial<CosigRequest> = {}): CosigRequest {
  return {
    type: 'trust.cosig.request',
    requestId: 'req-1',
    attestationUri: 'at://did:plc:author/com.dina.trust.attestation/abc',
    attestationCid: 'bafy...',
    expiresAt: '2026-05-06T12:00:00Z', // 7 days after T0
    createdAt: '2026-04-29T12:00:00Z',
    ...partial,
  };
}

function input(partial: Partial<CosigInboxInput> = {}): CosigInboxInput {
  return {
    request: request(),
    senderName: 'Sancho',
    subjectId: 'subj-aeron',
    recipientLocalState: 'pending',
    nowMs: T0,
    ...partial,
  };
}

// ─── State classification ─────────────────────────────────────────────────

describe('buildCosigInboxRow — state classification', () => {
  it('pending + before expiry → pending', () => {
    const r = buildCosigInboxRow(input({ recipientLocalState: 'pending' }));
    expect(r.state).toBe('pending');
    expect(r.msUntilExpiry).toBeGreaterThan(0);
  });

  it('pending + at expiry boundary → expired (≥ rather than > so the boundary closes the row)', () => {
    const r = buildCosigInboxRow(
      input({
        recipientLocalState: 'pending',
        nowMs: Date.parse('2026-05-06T12:00:00Z'),
      }),
    );
    expect(r.state).toBe('expired');
    expect(r.msUntilExpiry).toBe(0);
  });

  it('pending + past expiry → expired with negative msUntilExpiry', () => {
    const r = buildCosigInboxRow(
      input({
        recipientLocalState: 'pending',
        nowMs: Date.parse('2026-05-10T12:00:00Z'),
      }),
    );
    expect(r.state).toBe('expired');
    expect(r.msUntilExpiry).toBeLessThan(0);
  });

  it('accepted → accepted (terminal — ignores expiry)', () => {
    const r = buildCosigInboxRow(
      input({
        recipientLocalState: 'accepted',
        nowMs: Date.parse('2026-05-10T12:00:00Z'), // past expiry
      }),
    );
    expect(r.state).toBe('accepted');
  });

  it('declined → declined (terminal — ignores expiry)', () => {
    const r = buildCosigInboxRow(
      input({
        recipientLocalState: 'declined',
        nowMs: Date.parse('2026-05-10T12:00:00Z'), // past expiry
      }),
    );
    expect(r.state).toBe('declined');
  });
});

// ─── Title ────────────────────────────────────────────────────────────────

describe('buildCosigInboxRow — title', () => {
  it('renders "<sender> asked you to co-sign their review" with the resolved display name', () => {
    const r = buildCosigInboxRow(input({ senderName: 'Sancho' }));
    expect(r.title).toBe('Sancho asked you to co-sign their review');
  });

  it('falls back to "Someone" when senderName is null / undefined / empty', () => {
    expect(buildCosigInboxRow(input({ senderName: null })).title).toBe(
      'Someone asked you to co-sign their review',
    );
    expect(buildCosigInboxRow(input({ senderName: undefined })).title).toBe(
      'Someone asked you to co-sign their review',
    );
    expect(buildCosigInboxRow(input({ senderName: '' })).title).toBe(
      'Someone asked you to co-sign their review',
    );
    expect(buildCosigInboxRow(input({ senderName: '   ' })).title).toBe(
      'Someone asked you to co-sign their review',
    );
  });

  it('trims a name with whitespace padding', () => {
    const r = buildCosigInboxRow(input({ senderName: '  Don Alonso  ' }));
    expect(r.title).toBe('Don Alonso asked you to co-sign their review');
  });
});

// ─── Body preview ─────────────────────────────────────────────────────────

describe('buildCosigInboxRow — body preview', () => {
  it('passes through the request.reason field', () => {
    const r = buildCosigInboxRow(
      input({ request: request({ reason: 'You bought one in 2024 too' }) }),
    );
    expect(r.bodyPreview).toBe('You bought one in 2024 too');
  });

  it('null when no reason was provided', () => {
    const r = buildCosigInboxRow(input({ request: request({ reason: undefined }) }));
    expect(r.bodyPreview).toBeNull();
  });

  it('null when reason is whitespace-only (no empty preview pill)', () => {
    const r = buildCosigInboxRow(input({ request: request({ reason: '   ' }) }));
    expect(r.bodyPreview).toBeNull();
  });

  it('trims reason before rendering', () => {
    const r = buildCosigInboxRow(input({ request: request({ reason: '  why  ' }) }));
    expect(r.bodyPreview).toBe('why');
  });
});

// ─── Actions ──────────────────────────────────────────────────────────────

describe('buildCosigInboxRow — actions', () => {
  it('pending → ["endorse", "decline"]', () => {
    const r = buildCosigInboxRow(input({ recipientLocalState: 'pending' }));
    expect([...r.actions]).toEqual(['endorse', 'decline']);
  });

  it('accepted → no actions', () => {
    const r = buildCosigInboxRow(input({ recipientLocalState: 'accepted' }));
    expect([...r.actions]).toEqual([]);
  });

  it('declined → no actions', () => {
    const r = buildCosigInboxRow(input({ recipientLocalState: 'declined' }));
    expect([...r.actions]).toEqual([]);
  });

  it('expired → no actions (button-press would race with the expired-D2D anyway)', () => {
    const r = buildCosigInboxRow(
      input({
        recipientLocalState: 'pending',
        nowMs: Date.parse('2026-05-10T12:00:00Z'),
      }),
    );
    expect([...r.actions]).toEqual([]);
  });

  it('actions array is frozen (mutation cannot poison the next render)', () => {
    const r = buildCosigInboxRow(input({ recipientLocalState: 'pending' }));
    expect(Object.isFrozen(r.actions)).toBe(true);
  });
});

// ─── Deep link ────────────────────────────────────────────────────────────

describe('buildCosigInboxRow — deep link', () => {
  it('routes to /trust/<subjectId>?attestation=<at-uri> with the source attestation anchored', () => {
    // TN-MOB-041: deep-link includes the source attestation as a
    // query param so the receiver screen can scroll to / highlight
    // it. Without the anchor, the user lands on the subject screen
    // and has to hunt for the row Sancho actually asked about.
    const r = buildCosigInboxRow(
      input({
        subjectId: 'subj-aeron',
        request: request({ attestationUri: 'at://did:plc:author/com.dina.trust.attestation/abc' }),
      }),
    );
    expect(r.deepLink).toBe(
      '/trust/subj-aeron?attestation=at%3A%2F%2Fdid%3Aplc%3Aauthor%2Fcom.dina.trust.attestation%2Fabc',
    );
  });

  it('encodes special characters in the subject id (path segment encoding preserved)', () => {
    const r = buildCosigInboxRow(input({ subjectId: 'subj a/b' }));
    expect(r.deepLink).toMatch(/^\/trust\/subj%20a%2Fb\?attestation=/);
  });

  it('throws on empty / non-string subjectId', () => {
    expect(() => buildCosigInboxRow(input({ subjectId: '' }))).toThrow();
    // @ts-expect-error — runtime guard
    expect(() => buildCosigInboxRow(input({ subjectId: undefined }))).toThrow();
  });
});

// ─── Malformed input ──────────────────────────────────────────────────────

describe('buildCosigInboxRow — malformed input', () => {
  it('throws on a non-ISO expiresAt (silent NaN would corrupt sort orders)', () => {
    expect(() =>
      buildCosigInboxRow(input({ request: request({ expiresAt: 'yesterday' }) })),
    ).toThrow(/ISO-8601/);
  });

  it('throws on an empty expiresAt', () => {
    expect(() =>
      buildCosigInboxRow(input({ request: request({ expiresAt: '' }) })),
    ).toThrow(/ISO-8601/);
  });
});
