/**
 * ISVC-8 — interactive-run signed projections (INTERACTIVE_SERVICES §6.2).
 * Byte-exact frozen goldens: any edit that changes the signed bytes must break
 * this test so a human decides deliberate-wire-break (bump @dina/protocol major)
 * vs bug. Also pins the domain-separation guarantee (a message signature can
 * never be replayed as an exhausted/result signature).
 */

import {
  INTERACTIVE_RUN_CAPABILITY,
  RUN_DECLARATION_NSID,
  RUN_EXHAUSTED_DOMAIN,
  RUN_MESSAGE_DOMAIN,
  RUN_OUTCOME_NSID,
  RUN_RESULT_DOMAIN,
  buildRunExhaustedProjection,
  buildRunMessageProjection,
  buildRunResultProjection,
} from '../src/run/projections';

const MESSAGE_INPUT = {
  provider_did: 'did:plc:prov',
  service_uri: 'at://svc',
  run_id: 'run-1',
  message_id: 'msg-1',
  sequence: 3,
  dedup_key: 'dk-1',
  kind: 'action' as const,
  action_type: 'appointment_book',
  params_digest: 'PARAMS_DIGEST',
  card_digest: 'CARD_DIGEST',
  issued_at: 1_700_000_000_000,
  expires_at: 1_700_000_060_000,
  schema_version: '1',
  runtime_issuer_did: 'did:plc:iss',
  runtime_key_id: 'key-1',
};

describe('buildRunMessageProjection (§6.2)', () => {
  it('matches the frozen golden byte string', () => {
    const golden = [
      'dina:run:message:v1',
      'did:plc:prov',
      'at://svc',
      'run-1',
      'msg-1',
      '3',
      'dk-1',
      'action',
      'appointment_book',
      'PARAMS_DIGEST',
      'CARD_DIGEST',
      '1700000000000',
      '1700000060000',
      '1',
      'did:plc:iss',
      'key-1',
    ].join('\n');
    expect(buildRunMessageProjection(MESSAGE_INPUT)).toBe(golden);
  });

  it('is deterministic and uses LF only, no trailing newline, 16 fields', () => {
    const out = buildRunMessageProjection(MESSAGE_INPUT);
    expect(buildRunMessageProjection(MESSAGE_INPUT)).toBe(out);
    expect(out).not.toContain('\r');
    expect(out.endsWith('\n')).toBe(false);
    expect(out.split('\n').length).toBe(16);
    expect(out.startsWith(RUN_MESSAGE_DOMAIN)).toBe(true);
  });

  it('an informational message carries an empty action_type field', () => {
    const out = buildRunMessageProjection({ ...MESSAGE_INPUT, kind: 'informational', action_type: '' });
    // field 8 (0-indexed 7) is kind, field 9 is the empty action_type
    const parts = out.split('\n');
    expect(parts[7]).toBe('informational');
    expect(parts[8]).toBe('');
  });
});

describe('buildRunExhaustedProjection (§6.2)', () => {
  it('matches the frozen golden byte string', () => {
    const golden = [
      'dina:run:exhausted:v1',
      'did:plc:prov',
      'at://svc',
      'run-1',
      '42',
      '1700000000000',
      '1',
      'did:plc:iss',
      'key-1',
    ].join('\n');
    expect(
      buildRunExhaustedProjection({
        provider_did: 'did:plc:prov',
        service_uri: 'at://svc',
        run_id: 'run-1',
        cursor: 42,
        issued_at: 1_700_000_000_000,
        schema_version: '1',
        runtime_issuer_did: 'did:plc:iss',
        runtime_key_id: 'key-1',
      }),
    ).toBe(golden);
  });
});

describe('buildRunResultProjection (§6.2)', () => {
  it('matches the frozen golden byte string', () => {
    const golden = [
      'dina:run:result:v1',
      'did:plc:prov',
      'at://svc',
      'run-1',
      'msg-1',
      'del-xyz',
      '7',
      'completed',
      'RESULT_CARD_DIGEST',
      '1700000000000',
      '1',
      'did:plc:iss',
      'key-1',
    ].join('\n');
    expect(
      buildRunResultProjection({
        provider_did: 'did:plc:prov',
        service_uri: 'at://svc',
        run_id: 'run-1',
        message_id: 'msg-1',
        delegation_id: 'del-xyz',
        decision_revision: 7,
        status: 'completed',
        result_card_digest: 'RESULT_CARD_DIGEST',
        issued_at: 1_700_000_000_000,
        schema_version: '1',
        runtime_issuer_did: 'did:plc:iss',
        runtime_key_id: 'key-1',
      }),
    ).toBe(golden);
  });
});

describe('domain separation (anti-replay)', () => {
  it('the three domains are distinct and every projection begins with its own domain', () => {
    expect(new Set([RUN_MESSAGE_DOMAIN, RUN_EXHAUSTED_DOMAIN, RUN_RESULT_DOMAIN]).size).toBe(3);
    expect(buildRunMessageProjection(MESSAGE_INPUT).startsWith(RUN_MESSAGE_DOMAIN)).toBe(true);
  });
});

describe('capability id + public NSIDs (§12.1/§12.4)', () => {
  it('the capability id is flat snake_case (no dots)', () => {
    expect(INTERACTIVE_RUN_CAPABILITY).toBe('interactive_run');
    expect(INTERACTIVE_RUN_CAPABILITY).not.toContain('.');
  });
  it('the public NSIDs are dotted com.dinakernel.run.* records', () => {
    expect(RUN_DECLARATION_NSID).toBe('com.dinakernel.run.declaration');
    expect(RUN_OUTCOME_NSID).toBe('com.dinakernel.run.outcome');
  });
});
