/**
 * Namespace creation flow tests (TN-IDENT-007).
 *
 * Drives the orchestrator end-to-end with a fake fetch, asserts:
 *   - Each lower-level primitive runs in the right order with the right
 *     inputs (derive → compose → sign → submit).
 *   - The result aggregates all four pieces — no information loss.
 *   - Validation errors at any layer surface unchanged (no swallowed
 *     errors, no silent rollback).
 *   - Determinism: same params → byte-identical signed op + result.
 *   - `nextAvailableNamespaceIndex` finds the lowest-unused slot,
 *     ignoring malformed VM keys.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { TEST_MNEMONIC_SEED } from '@dina/test-harness';

import {
  buildCreationOperation,
  cidForOperation,
  createNamespace,
  dagCborEncode,
  deriveNamespaceKey,
  derivePLCDID,
  derivePath,
  deriveRotationKey,
  nextAvailableNamespaceIndex,
  PLCSubmitError,
  signOperation,
} from '../../src';

function setUp() {
  const signing = derivePath(TEST_MNEMONIC_SEED, "m/9999'/0'/0'");
  const creation = buildCreationOperation({
    signingKey: signing.privateKey,
    rotationSeed: TEST_MNEMONIC_SEED,
    msgboxEndpoint: 'wss://msg.example/dina',
    handle: 'alice.example',
  });
  const rotationDerived = deriveRotationKey(TEST_MNEMONIC_SEED, 0);
  const { signedOperation: genesisSigned } = signOperation(
    creation.operation,
    rotationDerived.privateKey,
  );
  return {
    did: derivePLCDID(genesisSigned),
    genesisSigned,
    rotationPrivateKey: rotationDerived.privateKey,
    rotationPublicKey: rotationDerived.publicKey,
  };
}

interface FakeFetchCall {
  url: string;
  body: string;
}
function makeFakeFetch(responses: ({ status: number; body?: string } | Error)[]): {
  fetch: typeof globalThis.fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = (init?.body as string) ?? '';
    calls.push({ url, body });
    const r = responses[i++ % responses.length];
    if (r instanceof Error) throw r;
    return new Response(r.body ?? '', { status: r.status });
  };
  return { fetch, calls };
}

const noopSleep = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------

describe('createNamespace (TN-IDENT-007)', () => {
  const ctx = setUp();

  it('runs the full flow and returns the consolidated result', async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200, body: '{}' }]);

    const result = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 0,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: ctx.genesisSigned,
      submitConfig: { fetch, sleep: noopSleep, plcURL: 'https://plc.test' },
    });

    expect(result.namespaceIndex).toBe(0);
    expect(result.fragment).toBe('namespace_0');

    // The returned public key matches what `deriveNamespaceKey` would
    // produce — no off-by-one or wrong-seed-slice.
    const expected = deriveNamespaceKey(TEST_MNEMONIC_SEED, 0);
    expect(bytesToHex(result.namespacePublicKey)).toBe(bytesToHex(expected.publicKey));

    // The composed signed op carries the new VM.
    const vms = result.composed.signedOperation.verificationMethods as Record<string, string>;
    expect(vms.namespace_0).toBeDefined();
    expect(vms.dina_signing).toBeDefined();

    // The signed op's signature verifies under the rotation public key —
    // proves the orchestrator passed the right private key through to the
    // composer (not e.g. the namespace key by mistake).
    const unsigned = { ...result.composed.signedOperation };
    delete unsigned.sig;
    const hash = sha256(dagCborEncode(unsigned));
    const sigBytes = base64urlDecode(result.composed.signedOperation.sig as string);
    const ok = secp256k1.verify(sigBytes, hash, ctx.rotationPublicKey, {
      lowS: true,
      prehash: false,
    });
    expect(ok).toBe(true);

    // The submit step ran exactly once with the right URL + body.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://plc.test/${ctx.did}`);
    expect(JSON.parse(calls[0].body)).toEqual(result.composed.signedOperation);

    // Submit result is echoed.
    expect(result.submitted.status).toBe(200);
    expect(result.submitted.attempts).toBe(1);
    expect(result.submitted.body).toEqual({});
  });

  it('determinism — identical params produce a byte-identical signed op', async () => {
    const f1 = makeFakeFetch([{ status: 200 }]);
    const f2 = makeFakeFetch([{ status: 200 }]);

    const r1 = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 1,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: ctx.genesisSigned,
      submitConfig: { fetch: f1.fetch, sleep: noopSleep },
    });
    const r2 = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 1,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: ctx.genesisSigned,
      submitConfig: { fetch: f2.fetch, sleep: noopSleep },
    });

    expect(r1.composed.signedOperation).toEqual(r2.composed.signedOperation);
    expect(r1.composed.operationHash).toBe(r2.composed.operationHash);
    expect(bytesToHex(r1.namespacePublicKey)).toBe(bytesToHex(r2.namespacePublicKey));
  });

  it('retries 5xx during submit and surfaces final success', async () => {
    const { fetch, calls } = makeFakeFetch([
      { status: 503, body: 'overloaded' },
      { status: 200, body: '{}' },
    ]);

    const result = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 0,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: ctx.genesisSigned,
      submitConfig: { fetch, sleep: noopSleep, backoffBaseMs: 1 },
    });

    expect(result.submitted.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('propagates 4xx as PLCSubmitError(client) — no rollback, caller fixes input', async () => {
    const { fetch } = makeFakeFetch([{ status: 400, body: 'bad sig' }]);

    const err = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 0,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: ctx.genesisSigned,
      submitConfig: { fetch, sleep: noopSleep },
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PLCSubmitError);
    expect((err as PLCSubmitError).kind).toBe('client');
    expect((err as PLCSubmitError).status).toBe(400);
  });

  it('rejects fragment collision (caller picked a taken index) before any network call', async () => {
    // Build a state where namespace_0 already exists, then try to add it again.
    const { fetch: fetch1 } = makeFakeFetch([{ status: 200 }]);
    const first = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 0,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: ctx.genesisSigned,
      submitConfig: { fetch: fetch1, sleep: noopSleep },
    });

    const { fetch, calls } = makeFakeFetch([{ status: 200 }]);
    await expect(
      createNamespace({
        did: ctx.did,
        masterSeed: TEST_MNEMONIC_SEED,
        namespaceIndex: 0, // collides
        rotationPrivateKey: ctx.rotationPrivateKey,
        priorSignedOperation: first.composed.signedOperation,
        submitConfig: { fetch, sleep: noopSleep },
      }),
    ).rejects.toThrow(/already present/);

    // No HTTP call should have been made — collision is caught before submit.
    expect(calls).toHaveLength(0);
  });

  it('rejects bad seed shape before any network call', async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200 }]);

    await expect(
      createNamespace({
        did: ctx.did,
        masterSeed: new Uint8Array(8), // < 16 bytes — slip0010 rejects
        namespaceIndex: 0,
        rotationPrivateKey: ctx.rotationPrivateKey,
        priorSignedOperation: ctx.genesisSigned,
        submitConfig: { fetch, sleep: noopSleep },
      }),
    ).rejects.toThrow(/seed too short/);

    expect(calls).toHaveLength(0);
  });

  it('rejects bad DID shape before any network call', async () => {
    const { fetch, calls } = makeFakeFetch([{ status: 200 }]);

    await expect(
      createNamespace({
        did: 'did:key:zABC',
        masterSeed: TEST_MNEMONIC_SEED,
        namespaceIndex: 0,
        rotationPrivateKey: ctx.rotationPrivateKey,
        priorSignedOperation: ctx.genesisSigned,
        submitConfig: { fetch, sleep: noopSleep },
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });

    expect(calls).toHaveLength(0);
  });

  it('chains across multiple namespace adds — second prev is first cid', async () => {
    // Add namespace_0, then namespace_1 using the result of step 1.
    const { fetch: f1 } = makeFakeFetch([{ status: 200 }]);
    const step1 = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 0,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: ctx.genesisSigned,
      submitConfig: { fetch: f1, sleep: noopSleep },
    });

    const { fetch: f2 } = makeFakeFetch([{ status: 200 }]);
    const step2 = await createNamespace({
      did: ctx.did,
      masterSeed: TEST_MNEMONIC_SEED,
      namespaceIndex: 1,
      rotationPrivateKey: ctx.rotationPrivateKey,
      priorSignedOperation: step1.composed.signedOperation,
      submitConfig: { fetch: f2, sleep: noopSleep },
    });

    expect(step2.composed.signedOperation.prev).toBe(
      cidForOperation(step1.composed.signedOperation),
    );
    const vms2 = step2.composed.signedOperation.verificationMethods as Record<string, string>;
    expect(vms2.namespace_0).toBeDefined();
    expect(vms2.namespace_1).toBeDefined();
  });
});

describe('nextAvailableNamespaceIndex', () => {
  const ctx = setUp();

  it('returns 0 when no namespaces exist', () => {
    expect(nextAvailableNamespaceIndex(ctx.genesisSigned)).toBe(0);
  });

  it('returns the lowest unused index — finds the gap', () => {
    const op = {
      verificationMethods: {
        dina_signing: 'did:key:zXyz',
        namespace_0: 'did:key:zAbc',
        namespace_2: 'did:key:zDef', // gap at 1
      },
    };
    expect(nextAvailableNamespaceIndex(op)).toBe(1);
  });

  it('returns next index when contiguous', () => {
    const op = {
      verificationMethods: {
        dina_signing: 'did:key:zXyz',
        namespace_0: 'did:key:z0',
        namespace_1: 'did:key:z1',
        namespace_2: 'did:key:z2',
      },
    };
    expect(nextAvailableNamespaceIndex(op)).toBe(3);
  });

  it('ignores malformed namespace_xxx keys', () => {
    const op = {
      verificationMethods: {
        dina_signing: 'did:key:zXyz',
        namespace_abc: 'did:key:zJunk', // not numeric
        'namespace_-1': 'did:key:zJunk', // not non-negative
        namespace_0: 'did:key:z0',
      },
    };
    expect(nextAvailableNamespaceIndex(op)).toBe(1);
  });

  it('returns 0 for malformed prior op (no verificationMethods map)', () => {
    expect(nextAvailableNamespaceIndex({ type: 'plc_operation' })).toBe(0);
  });

  it('returns 0 when verificationMethods is non-object (e.g. null)', () => {
    expect(
      nextAvailableNamespaceIndex({ verificationMethods: null as unknown as object }),
    ).toBe(0);
  });
});

// --- helpers --------------------------------------------------------------

function base64urlDecode(s: string): Uint8Array {
  const padLen = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const bin = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
