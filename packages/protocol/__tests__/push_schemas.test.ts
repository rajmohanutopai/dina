/**
 * PSVC-1 — push protocol schemas (PUSH_SERVICES_ARCHITECTURE.md §7).
 */

import {
  PUSH_EVENT,
  PUSH_EVENT_DOMAIN,
  PUSH_FAMILIES,
  PUSH_NOTIFY_CAPABILITY,
  buildPushEventProjection,
  validatePushEventBody,
} from '../src/push/schemas';

function validEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'e1',
    subscription_ref: 'sub-1',
    provider_did: 'did:plc:prov',
    runtime_issuer_did: 'did:plc:iss',
    runtime_key_id: 'key-1',
    service_uri: 'at://svc',
    topic_id: 'flight.delay',
    condition_ref: 'cond-1',
    claimed_priority: 'solicited',
    card: { version: 1, blocks: [] },
    dedup_key: 'dk-1',
    sequence: 5,
    issued_at: 1_700_000_000_000,
    expires_at: 1_700_000_060_000,
    signature: 'deadbeef',
    ...over,
  };
}

describe('capability + families', () => {
  it('the capability id is flat snake_case; families are the four V1 push.* ids', () => {
    expect(PUSH_NOTIFY_CAPABILITY).toBe('push_notify');
    expect(PUSH_NOTIFY_CAPABILITY).not.toContain('.');
    expect(PUSH_FAMILIES).toContain('push.event');
    expect(PUSH_EVENT).toBe('push.event');
    expect(PUSH_FAMILIES.length).toBe(4);
  });
});

describe('validatePushEventBody (fail-closed)', () => {
  it('accepts a well-formed event', () => {
    const v = validatePushEventBody(validEvent());
    expect(v).not.toBeNull();
    expect(v?.claimed_priority).toBe('solicited');
    expect(v?.sequence).toBe(5);
  });

  it('rejects a missing required field', () => {
    expect(validatePushEventBody(validEvent({ dedup_key: '' }))).toBeNull();
    const { signature: _sig, ...noSig } = validEvent();
    expect(validatePushEventBody(noSig)).toBeNull();
    expect(validatePushEventBody(validEvent({ sequence: 'x' }))).toBeNull();
  });

  it('rejects an unknown claimed_priority (untrusted input, capped later)', () => {
    expect(validatePushEventBody(validEvent({ claimed_priority: 'interrupt_now' }))).toBeNull();
  });

  it('rejects a body with no card', () => {
    const { card: _card, ...noCard } = validEvent();
    expect(validatePushEventBody(noCard)).toBeNull();
  });

  it('preserves optional trigger_evidence when present', () => {
    const v = validatePushEventBody(validEvent({ trigger_evidence: { proof: 'x' } }));
    expect(v?.trigger_evidence).toEqual({ proof: 'x' });
  });
});

describe('buildPushEventProjection (§7.3)', () => {
  it('matches the frozen golden byte string', () => {
    const golden = [
      'dina:push:event:v1',
      'e1',
      'sub-1',
      'did:plc:prov',
      'at://svc',
      'flight.delay',
      'cond-1',
      'solicited',
      'CARD_DIGEST',
      '',
      'dk-1',
      '5',
      '1700000000000',
      '1700000060000',
      'did:plc:iss',
      'key-1',
    ].join('\n');
    expect(
      buildPushEventProjection({
        event_id: 'e1',
        subscription_ref: 'sub-1',
        provider_did: 'did:plc:prov',
        service_uri: 'at://svc',
        topic_id: 'flight.delay',
        condition_ref: 'cond-1',
        claimed_priority: 'solicited',
        card_digest: 'CARD_DIGEST',
        trigger_evidence_digest: '',
        dedup_key: 'dk-1',
        sequence: 5,
        issued_at: 1_700_000_000_000,
        expires_at: 1_700_000_060_000,
        runtime_issuer_did: 'did:plc:iss',
        runtime_key_id: 'key-1',
      }),
    ).toBe(golden);
  });

  it('is domain-separated from the interactive-run projections', () => {
    expect(PUSH_EVENT_DOMAIN).toBe('dina:push:event:v1');
    expect(PUSH_EVENT_DOMAIN).not.toContain('run');
  });
});
