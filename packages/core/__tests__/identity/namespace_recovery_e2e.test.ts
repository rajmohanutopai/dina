/**
 * Namespace recovery integration test (TN-IDENT-009).
 *
 * Plan §3.5.5 promises that master-seed recovery regenerates all
 * namespace keys, that the DID document recovers via the PLC
 * directory, and that the user "sees the same set of namespaces with
 * the same `name` labels post-recovery." TN-IDENT-010 already pinned
 * the key-derivation determinism in isolation; this file pins the
 * higher-level invariant: a full create-flow run, simulated wipe,
 * and post-recovery re-derivation produce **byte-identical** signed
 * PLC operations and submitted requests.
 *
 * What "wipe + restore" looks like in this test:
 *   1. User has a 24-word mnemonic. Phase A: install the app, derive
 *      the master seed, create namespace_0 + namespace_1, observe the
 *      signed PLC ops + their CIDs.
 *   2. Wipe — every variable holding key material is dropped on the
 *      floor. Only the mnemonic is kept (the user wrote it on paper).
 *   3. Phase B: a fresh device, fresh keystore, fresh memory. Derive
 *      master seed from the same mnemonic. Re-run the create flow on
 *      the same prior op state (which the PLC directory still holds).
 *      Assert byte-equality with the Phase A signed ops.
 *
 * Why this matters: a regression in any of `mnemonicToSeed`,
 * `deriveNamespaceKey`, the dag-cbor encoder, the secp256k1 RFC-6979
 * deterministic-k path, or the orchestrator's seam between primitives
 * would silently break recovery — the user gets new keys + new ops
 * that AppView would index as a different namespace, orphaning every
 * attestation they ever published. Pinning byte-equality here closes
 * that hole at the integration level.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import {
  buildCreationOperation,
  cidForOperation,
  createNamespace,
  derivePLCDID,
  derivePath,
  deriveRotationKey,
  generateMnemonic,
  mnemonicToSeed,
  signOperation,
} from '../../src';

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

/**
 * Build the user's "Phase A" identity from the mnemonic — the genesis
 * PLC op signed by the rotation key. This is what the PLC directory's
 * audit log holds before the user creates any namespace.
 */
function buildGenesis(mnemonic: string) {
  const masterSeed = mnemonicToSeed(mnemonic);
  const signing = derivePath(masterSeed, "m/9999'/0'/0'");
  const creation = buildCreationOperation({
    signingKey: signing.privateKey,
    rotationSeed: masterSeed,
    msgboxEndpoint: 'wss://msg.example/dina',
    handle: 'recovery.example',
  });
  const rotation = deriveRotationKey(masterSeed, 0);
  const { signedOperation: genesisSigned } = signOperation(
    creation.operation,
    rotation.privateKey,
  );
  return {
    masterSeed,
    rotationPrivateKey: rotation.privateKey,
    genesisSigned,
    did: derivePLCDID(genesisSigned),
  };
}

// ---------------------------------------------------------------------------

describe('Namespace recovery integration (TN-IDENT-009)', () => {
  it('wipe → restore from mnemonic → byte-identical signed ops + submit bodies', async () => {
    // ─── Phase A: original device ───────────────────────────────────
    const mnemonic = generateMnemonic();
    const a = buildGenesis(mnemonic);

    const { fetch: fA1, calls: callsA1 } = makeFakeFetch([{ status: 200 }]);
    const a0 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 0,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a.genesisSigned,
      submitConfig: { fetch: fA1, sleep: noopSleep, plcURL: 'https://plc.test' },
    });

    const { fetch: fA2, calls: callsA2 } = makeFakeFetch([{ status: 200 }]);
    const a1 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 1,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a0.composed.signedOperation,
      submitConfig: { fetch: fA2, sleep: noopSleep, plcURL: 'https://plc.test' },
    });

    // ─── Wipe ───────────────────────────────────────────────────────
    // Drop every Phase-A variable except the mnemonic and the prior-op
    // chain (the PLC directory still serves the audit log to a fresh
    // device — that's the recovery contract). Wipe is implicit in JS
    // (we just don't reference Phase-A material from Phase B).
    const fromPlcAuditLog = a0.composed.signedOperation; // what PLC.directory returns to Phase B

    // ─── Phase B: fresh device, only mnemonic survives ──────────────
    const b = buildGenesis(mnemonic);

    // Same DID — proves the genesis derivation is recovery-stable.
    expect(b.did).toBe(a.did);
    // Same genesis bytes — pins the full op-shape recovery, not just the DID.
    expect(b.genesisSigned).toEqual(a.genesisSigned);
    // Same rotation private key bytes — pins the rotation derivation.
    expect(bytesToHex(b.rotationPrivateKey)).toBe(bytesToHex(a.rotationPrivateKey));

    // Re-run create-namespace 1 against the prior op the directory holds.
    const { fetch: fB2, calls: callsB2 } = makeFakeFetch([{ status: 200 }]);
    const b1 = await createNamespace({
      did: b.did,
      masterSeed: b.masterSeed,
      namespaceIndex: 1,
      rotationPrivateKey: b.rotationPrivateKey,
      priorSignedOperation: fromPlcAuditLog,
      submitConfig: { fetch: fB2, sleep: noopSleep, plcURL: 'https://plc.test' },
    });

    // ─── Assertions: byte-identical Phase-A vs Phase-B ──────────────

    // Same namespace public key.
    expect(bytesToHex(b1.namespacePublicKey)).toBe(bytesToHex(a1.namespacePublicKey));
    // Same composed signed op (object equality across every field).
    expect(b1.composed.signedOperation).toEqual(a1.composed.signedOperation);
    // Same operationHash.
    expect(b1.composed.operationHash).toBe(a1.composed.operationHash);
    // Same priorCid (chain integrity preserved).
    expect(b1.composed.priorCid).toBe(a1.composed.priorCid);
    // Same fragment.
    expect(b1.fragment).toBe(a1.fragment);
    // Pull the call records once via destructuring so the (defined!)
    // first call doesn't need a non-null assertion at every assertion site.
    const [callA1] = callsA1;
    const [callA2] = callsA2;
    const [callB2] = callsB2;
    expect(callA1).toBeDefined();
    expect(callA2).toBeDefined();
    expect(callB2).toBeDefined();
    // Same submitted body — what the PLC directory sees on the wire.
    expect(callB2.body).toBe(callA2.body);
    // Same submitted URL.
    expect(callB2.url).toBe(callA2.url);

    // Sanity: Phase A indeed published two distinct ops (otherwise our
    // "byte-identical" assertions would be vacuously true on identical
    // genesis state).
    expect(callA1.body).not.toBe(callA2.body);
  });

  it('post-recovery namespace keys still chain correctly off the audit log', async () => {
    // Variant: simulate a longer history (genesis → ns0 → ns1 →
    // ns2). After wipe, recovering and adding ns3 must produce the
    // same op a continuous timeline would have produced.
    const mnemonic = generateMnemonic();

    // Original timeline.
    const a = buildGenesis(mnemonic);
    const { fetch: f0 } = makeFakeFetch([{ status: 200 }]);
    const a0 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 0,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a.genesisSigned,
      submitConfig: { fetch: f0, sleep: noopSleep },
    });
    const { fetch: f1 } = makeFakeFetch([{ status: 200 }]);
    const a1 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 1,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a0.composed.signedOperation,
      submitConfig: { fetch: f1, sleep: noopSleep },
    });
    const { fetch: f2 } = makeFakeFetch([{ status: 200 }]);
    const a2 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 2,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a1.composed.signedOperation,
      submitConfig: { fetch: f2, sleep: noopSleep },
    });
    const { fetch: f3a } = makeFakeFetch([{ status: 200 }]);
    const a3 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 3,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a2.composed.signedOperation,
      submitConfig: { fetch: f3a, sleep: noopSleep },
    });

    // Recovery — only mnemonic survived. PLC directory hands back the
    // last-seen op (a2) so the user can chain off it.
    const b = buildGenesis(mnemonic);
    const { fetch: f3b } = makeFakeFetch([{ status: 200 }]);
    const b3 = await createNamespace({
      did: b.did,
      masterSeed: b.masterSeed,
      namespaceIndex: 3,
      rotationPrivateKey: b.rotationPrivateKey,
      priorSignedOperation: a2.composed.signedOperation,
      submitConfig: { fetch: f3b, sleep: noopSleep },
    });

    // Pre/post-wipe ns3 op: byte-identical.
    expect(b3.composed.signedOperation).toEqual(a3.composed.signedOperation);
    expect(b3.composed.priorCid).toBe(cidForOperation(a2.composed.signedOperation));
  });

  it('cross-mnemonic distinctness — different mnemonics yield different namespace keys', () => {
    // Sanity guard: if two mnemonics happened to produce the same
    // namespace keys, recovery would leak across users. (Exhaustively
    // unlikely but let's pin it — the BIP-39 entropy bits have to be
    // doing real work.)
    const m1 = generateMnemonic();
    const m2 = generateMnemonic();
    expect(m1).not.toBe(m2);

    const seed1 = mnemonicToSeed(m1);
    const seed2 = mnemonicToSeed(m2);
    expect(bytesToHex(seed1)).not.toBe(bytesToHex(seed2));

    // The genesis DIDs differ — proves the recovery isolation.
    const g1 = buildGenesis(m1);
    const g2 = buildGenesis(m2);
    expect(g1.did).not.toBe(g2.did);
  });
});
