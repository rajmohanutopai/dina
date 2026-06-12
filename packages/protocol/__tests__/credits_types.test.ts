/**
 * Starter Credits wire contract — validator/normalization tests.
 *
 * The contract is consumed by two independent implementations (grants
 * service + mobile client); these tests pin the parse semantics both
 * rely on: strict shape validation (null on violation, never throw),
 * unknown-field tolerance (forward compat), the anonymous-claim
 * invariant (identity-shaped fields are never read), and the
 * terminal-vs-transient refusal split that drives the client retry
 * loop.
 */

import {
  parseCreditsConfig,
  parseClaimGrantRequest,
  parseClaimGrantResponse,
  parseClaimGrantRefusal,
  TERMINAL_REFUSALS,
} from '../src/types/credits';

describe('parseCreditsConfig', () => {
  const good = {
    enabled: true,
    grant_usd: 0.25,
    model_pin: 'deepseek/deepseek-v4-pro',
    est_conversations: 40,
  };

  it('accepts a well-formed config', () => {
    expect(parseCreditsConfig(good)).toEqual(good);
  });

  it('ignores unknown fields (forward compatibility)', () => {
    expect(parseCreditsConfig({ ...good, future_field: 'x' })).toEqual(good);
  });

  it('floors fractional est_conversations', () => {
    expect(parseCreditsConfig({ ...good, est_conversations: 41.9 })?.est_conversations).toBe(41);
  });

  it.each([
    ['missing enabled', { ...good, enabled: undefined }],
    ['string enabled', { ...good, enabled: 'true' }],
    ['negative grant_usd', { ...good, grant_usd: -1 }],
    ['NaN grant_usd', { ...good, grant_usd: NaN }],
    ['empty model_pin', { ...good, model_pin: '' }],
    ['missing model_pin', { ...good, model_pin: undefined }],
    ['negative est', { ...good, est_conversations: -5 }],
    ['null', null],
    ['array', [good]],
    ['string', 'config'],
  ])('rejects %s', (_label, raw) => {
    expect(parseCreditsConfig(raw)).toBeNull();
  });
});

describe('parseClaimGrantRequest (service side)', () => {
  it('accepts a devicecheck claim', () => {
    const req = parseClaimGrantRequest({
      platform: 'ios',
      attestation: { kind: 'devicecheck', token: 'dc-token' },
    });
    expect(req).toEqual({
      platform: 'ios',
      attestation: { kind: 'devicecheck', token: 'dc-token' },
    });
  });

  it('accepts an app_attest claim', () => {
    const req = parseClaimGrantRequest({
      platform: 'ios',
      attestation: {
        kind: 'app_attest',
        key_id: 'k1',
        assertion: 'a1',
        client_data: 'c1',
      },
    });
    expect(req?.attestation.kind).toBe('app_attest');
  });

  it('accepts a play_integrity claim (android)', () => {
    const req = parseClaimGrantRequest({
      platform: 'android',
      attestation: { kind: 'play_integrity', token: 'pi-token' },
    });
    expect(req?.platform).toBe('android');
  });

  it('does NOT read identity-shaped fields even when sent (anonymous-claim invariant)', () => {
    const req = parseClaimGrantRequest({
      platform: 'ios',
      did: 'did:plc:sneaky',
      x_did: 'did:plc:sneaky',
      attestation: { kind: 'devicecheck', token: 't', did: 'did:plc:sneaky' },
    });
    expect(req).toEqual({
      platform: 'ios',
      attestation: { kind: 'devicecheck', token: 't' },
    });
    expect(JSON.stringify(req)).not.toContain('did:plc');
  });

  it.each([
    ['unknown platform', { platform: 'web', attestation: { kind: 'devicecheck', token: 't' } }],
    ['unknown attestation kind', { platform: 'ios', attestation: { kind: 'pinky_swear' } }],
    ['empty token', { platform: 'ios', attestation: { kind: 'devicecheck', token: '' } }],
    ['missing attestation', { platform: 'ios' }],
    [
      'app_attest missing assertion',
      { platform: 'ios', attestation: { kind: 'app_attest', key_id: 'k', client_data: 'c' } },
    ],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    expect(parseClaimGrantRequest(raw)).toBeNull();
  });
});

describe('parseClaimGrantResponse (client side)', () => {
  const good = { key: 'sk-or-v1-abc', limit_usd: 0.25, model_pin: 'deepseek/deepseek-v4-pro' };

  it('accepts a well-formed response', () => {
    expect(parseClaimGrantResponse(good)).toEqual(good);
  });

  it.each([
    ['empty key', { ...good, key: '' }],
    ['zero limit', { ...good, limit_usd: 0 }],
    ['negative limit', { ...good, limit_usd: -0.25 }],
    ['empty model_pin', { ...good, model_pin: '' }],
    ['null', null],
  ])('rejects %s (client must never store a malformed key record)', (_label, raw) => {
    expect(parseClaimGrantResponse(raw)).toBeNull();
  });
});

describe('parseClaimGrantRefusal + terminal split', () => {
  it.each(['already_claimed', 'attestation_failed', 'grants_paused', 'platform_disabled', 'rate_limited'])(
    'parses known code %s',
    (code) => {
      expect(parseClaimGrantRefusal({ error: code })).toEqual({ error: code });
    },
  );

  it('returns null for unknown codes (client treats as transient)', () => {
    expect(parseClaimGrantRefusal({ error: 'cosmic_rays' })).toBeNull();
    expect(parseClaimGrantRefusal({})).toBeNull();
    expect(parseClaimGrantRefusal(null)).toBeNull();
  });

  it('terminal set stops retries; pauses and rate limits do not', () => {
    expect(TERMINAL_REFUSALS).toEqual(
      expect.arrayContaining(['already_claimed', 'attestation_failed', 'platform_disabled']),
    );
    expect(TERMINAL_REFUSALS).not.toContain('grants_paused');
    expect(TERMINAL_REFUSALS).not.toContain('rate_limited');
  });
});
