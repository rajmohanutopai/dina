/**
 * ISVC-10 — trust-boundary unit tests for `verifyRunMessage` (§6.2). Exercises
 * the happy path plus EVERY fail-closed rejection: a forged/tampered/absent
 * signature, a cross-run substitution, an expired or future-dated message, and
 * an unauthorized runtime key.
 */

import { randomBytes } from 'node:crypto';

import { bytesToHex } from '@noble/hashes/utils.js';

import {
  buildRunMessageProjection,
  buildRunExhaustedProjection,
  buildRunResultProjection,
} from '@dina/protocol';

import { getPublicKey, sign } from '../../src/crypto/ed25519';
import {
  verifyRunMessage,
  verifyRunExhausted,
  verifyRunResult,
  type ExpectedRunBinding,
  type SignedRunMessageWire,
  type SignedRunExhaustedWire,
  type SignedRunResultWire,
} from '../../src/run/verify';

const enc = new TextEncoder();
const NOW = 1_700_000_000_000;
const ISSUED_AT = Math.floor(NOW / 1000);

const providerPriv = randomBytes(32);
const providerPub = getPublicKey(providerPriv);

const EXPECTED: ExpectedRunBinding = {
  run_id: 'run-1',
  provider_did: 'did:plc:prov',
  service_uri: 'at://did:plc:prov/com.dinakernel.service.profile/self',
  // The reserved fetch cursor; the default `signedWire` carries `sequence: 1`.
  expected_sequence: 1,
};

/** Build a wire body whose signature is VALID over its (possibly-overridden)
 *  fields — so a test that overrides a field AFTER signing produces a tamper. */
function signedWire(over: Partial<SignedRunMessageWire> = {}): SignedRunMessageWire {
  const base: Omit<SignedRunMessageWire, 'signature'> = {
    provider_did: EXPECTED.provider_did,
    service_uri: EXPECTED.service_uri,
    run_id: EXPECTED.run_id,
    message_id: 'msg-1',
    sequence: 1,
    dedup_key: 'dk-1',
    kind: 'informational',
    action_type: '',
    params_digest: 'a'.repeat(64),
    card_digest: 'c'.repeat(64),
    issued_at: ISSUED_AT,
    expires_at: NOW + 60_000,
    schema_version: 'run.v1',
    runtime_issuer_did: EXPECTED.provider_did,
    runtime_key_id: 'key-1',
    payload: enc.encode('PROVIDER-RESPONSE'),
    ...over,
  };
  const projection = buildRunMessageProjection(base);
  return { ...base, signature: bytesToHex(sign(providerPriv, enc.encode(projection))) };
}

/** The V1 resolver: the runtime issuer IS the provider; return its pubkey. */
const resolveOk = (issuerDid: string): Uint8Array | null =>
  issuerDid === EXPECTED.provider_did ? providerPub : null;

describe('verifyRunMessage — trust boundary (§6.2)', () => {
  it('accepts a correctly runtime-issuer-signed message → VerifiedRunMessage', () => {
    const res = verifyRunMessage(signedWire(), EXPECTED, resolveOk, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verified.message_id).toBe('msg-1');
      // content_digest is now the CANONICAL all-immutable-fields digest (81B-03).
      expect(res.verified.content_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(res.verified.kind).toBe('informational');
      expect(res.verified.action_type).toBeNull();
      expect(new TextDecoder().decode(res.verified.payload)).toBe('PROVIDER-RESPONSE');
    }
  });

  it('carries action_type through only for action messages', () => {
    const res = verifyRunMessage(
      signedWire({ kind: 'action', action_type: 'book' }),
      EXPECTED,
      resolveOk,
      NOW,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verified.action_type).toBe('book');
  });

  it('rejects a TAMPERED field (signature no longer matches the projection)', () => {
    // Sign over kind=informational, then flip the wire to action → projection differs.
    const wire = signedWire({ kind: 'informational' });
    const tampered: SignedRunMessageWire = { ...wire, kind: 'action', action_type: 'book' };
    const res = verifyRunMessage(tampered, EXPECTED, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('rejects a corrupted signature', () => {
    const wire = signedWire();
    const res = verifyRunMessage({ ...wire, signature: 'de'.repeat(32) }, EXPECTED, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('rejects a missing signature (never admits unsigned content)', () => {
    const res = verifyRunMessage({ ...signedWire(), signature: '' }, EXPECTED, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing_signature');
  });

  it('rejects a cross-run substitution (wrong run_id / provider / service_uri)', () => {
    for (const bad of [{ run_id: 'run-2' }, { provider_did: 'did:plc:evil' }, { service_uri: 'at://x' }]) {
      const res = verifyRunMessage(signedWire(bad), EXPECTED, resolveOk, NOW);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('cross_run');
    }
  });

  it('rejects a runtime issuer that is NOT the run provider (E76-03)', () => {
    // Signed correctly for issuer=evil, but the run provider is did:plc:prov — a
    // runtime key belonging to any other DID must never be admitted, even if that
    // DID's key resolves.
    const res = verifyRunMessage(
      signedWire({ runtime_issuer_did: 'did:plc:evil' }),
      EXPECTED,
      (issuer) => (issuer === 'did:plc:evil' ? providerPub : null),
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unauthorized_runtime_key');
  });

  it('rejects a sequence BELOW the reserved cursor — stale/replayed (E76-04)', () => {
    // Reserved cursor is 2; a response for sequence 1 is an already-advanced,
    // out-of-window position.
    const res = verifyRunMessage(
      signedWire({ sequence: 1 }),
      { ...EXPECTED, expected_sequence: 2 },
      resolveOk,
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('out_of_window');
  });

  it('accepts a sequence AT or AHEAD of the reserved cursor (fetch-ahead, E76-04)', () => {
    for (const seq of [2, 3]) {
      const res = verifyRunMessage(
        signedWire({ sequence: seq }),
        { ...EXPECTED, expected_sequence: 2 },
        resolveOk,
        NOW,
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.verified.sequence).toBe(seq);
    }
  });

  it('rejects an already-expired message', () => {
    const res = verifyRunMessage(signedWire({ expires_at: NOW - 1 }), EXPECTED, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('rejects a message issued far in the future (clock forgery)', () => {
    const res = verifyRunMessage(
      signedWire({ issued_at: ISSUED_AT + 3600 }),
      EXPECTED,
      resolveOk,
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('future_issued');
  });

  it('rejects when the runtime key does not resolve / is unauthorized', () => {
    const res = verifyRunMessage(signedWire(), EXPECTED, () => null, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unauthorized_runtime_key');
  });

  it('rejects a message signed by the WRONG key even if the resolver returns a key', () => {
    const wrongPriv = randomBytes(32);
    const wire = signedWire();
    // Sign with a different key than the resolver returns → signature fails.
    const forged = {
      ...wire,
      signature: bytesToHex(
        sign(
          wrongPriv,
          enc.encode(
            buildRunMessageProjection({
              provider_did: wire.provider_did,
              service_uri: wire.service_uri,
              run_id: wire.run_id,
              message_id: wire.message_id,
              sequence: wire.sequence,
              dedup_key: wire.dedup_key,
              kind: wire.kind,
              action_type: wire.action_type,
              params_digest: wire.params_digest,
              card_digest: wire.card_digest,
              issued_at: wire.issued_at,
              expires_at: wire.expires_at,
              schema_version: wire.schema_version,
              runtime_issuer_did: wire.runtime_issuer_did,
              runtime_key_id: wire.runtime_key_id,
            }),
          ),
        ),
      ),
    };
    const res = verifyRunMessage(forged, EXPECTED, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });
});

function signedExhausted(over: Partial<SignedRunExhaustedWire> = {}): SignedRunExhaustedWire {
  const base: Omit<SignedRunExhaustedWire, 'signature'> = {
    provider_did: EXPECTED.provider_did,
    service_uri: EXPECTED.service_uri,
    run_id: EXPECTED.run_id,
    cursor: 0,
    issued_at: ISSUED_AT,
    schema_version: 'run.v1',
    runtime_issuer_did: EXPECTED.provider_did,
    runtime_key_id: 'key-1',
    ...over,
  };
  return { ...base, signature: bytesToHex(sign(providerPriv, enc.encode(buildRunExhaustedProjection(base)))) };
}

describe('verifyRunExhausted — trust boundary (§6.2/§7.1)', () => {
  const EXP = { run_id: EXPECTED.run_id, provider_did: EXPECTED.provider_did, service_uri: EXPECTED.service_uri, expected_cursor: 0 };

  it('accepts a correctly-signed exhausted marker for the reserved cursor', () => {
    expect(verifyRunExhausted(signedExhausted(), EXP, resolveOk, NOW).ok).toBe(true);
  });

  it('rejects an exhausted marker for a DIFFERENT cursor (out_of_window)', () => {
    const res = verifyRunExhausted(signedExhausted({ cursor: 5 }), EXP, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('out_of_window');
  });

  it('rejects an exhausted marker whose issuer is not the provider', () => {
    const res = verifyRunExhausted(
      signedExhausted({ runtime_issuer_did: 'did:plc:evil' }),
      EXP,
      (i) => (i === 'did:plc:evil' ? providerPub : null),
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unauthorized_runtime_key');
  });

  it('rejects a tampered exhausted marker (signature over a different cursor)', () => {
    const wire = signedExhausted({ cursor: 0 });
    const res = verifyRunExhausted({ ...wire, cursor: 1 }, { ...EXP, expected_cursor: 1 }, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });
});

function signedResult(over: Partial<SignedRunResultWire> = {}): SignedRunResultWire {
  const base: Omit<SignedRunResultWire, 'signature'> = {
    provider_did: EXPECTED.provider_did,
    service_uri: EXPECTED.service_uri,
    run_id: EXPECTED.run_id,
    message_id: 'msg-1',
    delegation_id: 'deleg-1',
    decision_revision: 1,
    status: 'completed',
    result_card_digest: 'b'.repeat(64),
    issued_at: ISSUED_AT,
    schema_version: 'run.v1',
    runtime_issuer_did: EXPECTED.provider_did,
    runtime_key_id: 'key-1',
    ...over,
  };
  return { ...base, signature: bytesToHex(sign(providerPriv, enc.encode(buildRunResultProjection(base)))) };
}

describe('verifyRunResult — trust boundary (§6.2/§6.3)', () => {
  const EXP = { run_id: EXPECTED.run_id, provider_did: EXPECTED.provider_did, service_uri: EXPECTED.service_uri, delegation_id: 'deleg-1' };

  it('accepts a correctly-signed completion for the dispatched delegation', () => {
    const res = verifyRunResult(signedResult(), EXP, resolveOk, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.verified.status).toBe('completed');
      expect(res.verified.message_id).toBe('msg-1');
    }
  });

  it('carries a failed status through', () => {
    const res = verifyRunResult(signedResult({ status: 'failed' }), EXP, resolveOk, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.verified.status).toBe('failed');
  });

  it('rejects a completion for a DIFFERENT delegation (wrong_delegation)', () => {
    const res = verifyRunResult(signedResult({ delegation_id: 'deleg-2' }), EXP, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('wrong_delegation');
  });

  it('rejects an unknown status', () => {
    const res = verifyRunResult(
      signedResult({ status: 'weird' as unknown as 'completed' }),
      EXP,
      resolveOk,
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('unknown_status');
  });

  it('rejects a completion signed by the wrong key', () => {
    const wire = signedResult();
    const res = verifyRunResult({ ...wire, signature: 'de'.repeat(32) }, EXP, resolveOk, NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });
});
