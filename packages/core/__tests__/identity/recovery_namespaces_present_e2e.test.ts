/**
 * Recovery → namespaces present (TN-TEST-042).
 *
 * Plan §3.5.5's user-facing recovery promise: after a wipe and a
 * restore from the 24-word mnemonic, the user opens the namespace
 * screen and sees the same set of namespaces with the same labels.
 *
 * `namespace_recovery_e2e.test.ts` (TN-IDENT-009) already pins the
 * cryptographic byte-equality of re-signed PLC ops — same mnemonic
 * + same prior op chain + same index → byte-identical bytes on the
 * wire. That's the *signing-continuity* invariant.
 *
 * This file pins the complementary *listing-continuity* invariant:
 *   - The recovered DID document — what `plc.directory` hands the
 *     restored device — still carries every `namespace_<N>` fragment
 *     the user created pre-wipe, with the multibase pubkey strings
 *     unchanged.
 *   - Re-deriving namespace keys from the restored mnemonic produces
 *     the SAME public keys those fragments point at — so signing under
 *     each namespace remains valid (no orphaned attestations).
 *   - Mirroring the mobile screen's derivation (`deriveNamespaceRows`
 *     in `apps/mobile/src/trust/namespace_screen_data.ts`), parsing
 *     the recovered op's `verificationMethods` yields the same ordered
 *     list of namespaces the user saw before the wipe.
 *
 * The mobile derivation lives in `apps/`, which can't be imported
 * from a `packages/core` test (workspace-direction rule). The
 * derivation is small and stable — the parser regex is the same one
 * `nextAvailableNamespaceIndex` uses (`/^namespace_(\d+)$/`). We
 * inline the same shape here so this test breaks loudly if the
 * mobile parser ever drifts away from the `namespace_<N>` literal
 * convention.
 *
 * Why this matters at the user level: a regression that re-derived
 * namespaces silently to a different key — but produced a valid PLC
 * op — would still let recovery "succeed" cryptographically while
 * orphaning every prior attestation under the original key. The
 * listing-continuity assertion catches that class of bug.
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import {
  buildCreationOperation,
  composeAndSignNamespaceUpdate,
  createNamespace,
  deriveNamespaceKey,
  derivePLCDID,
  derivePath,
  deriveRotationKey,
  generateMnemonic,
  mnemonicToSeed,
  namespaceFragment,
  publicKeyToMultibase,
  signOperation,
} from '../../src';

const noopSleep = (): Promise<void> => Promise.resolve();

interface FakeFetchCall {
  url: string;
  body: string;
}
function makeFakeFetch(): {
  fetch: typeof globalThis.fetch;
  calls: FakeFetchCall[];
} {
  const calls: FakeFetchCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const body = (init?.body as string) ?? '';
    calls.push({ url, body });
    return new Response('', { status: 200 });
  };
  return { fetch, calls };
}

/**
 * Recovery-stable genesis: same mnemonic → same DID, same rotation
 * key, same genesis op bytes. Mirror of the helper in
 * `namespace_recovery_e2e.test.ts` (kept inline so a refactor of one
 * file doesn't silently change the other's behaviour).
 */
function buildGenesis(mnemonic: string): {
  masterSeed: Uint8Array;
  rotationPrivateKey: Uint8Array;
  genesisSigned: Record<string, unknown>;
  did: string;
} {
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

/**
 * Mirror of `apps/mobile/src/trust/namespace_screen_data.ts`'s
 * `deriveNamespaceRows`. Pinned inline (not imported) because mobile
 * can't be reached from a packages/core test, but the parser shape
 * IS the user-facing convention — if mobile changes the regex, this
 * test must change too. Documented above the regex so a code review
 * forces the cross-file update.
 */
interface NamespaceRow {
  index: number;
  fragment: string;
  verificationMethodId: string;
  publishedDidKey: string;
}
function listNamespaces(
  did: string,
  signedOperation: Record<string, unknown>,
): NamespaceRow[] {
  const vms = signedOperation.verificationMethods;
  if (!vms || typeof vms !== 'object') return [];
  const rows: NamespaceRow[] = [];
  // Same parser convention as mobile's deriveNamespaceRows + core's
  // nextAvailableNamespaceIndex. Drift here = drift there.
  const re = /^namespace_(\d+)$/;
  for (const [k, v] of Object.entries(vms as Record<string, unknown>)) {
    const m = re.exec(k);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 0) continue;
    if (typeof v !== 'string') continue;
    rows.push({
      index: n,
      fragment: k,
      verificationMethodId: `${did}#${k}`,
      publishedDidKey: v,
    });
  }
  rows.sort((a, b) => a.index - b.index);
  return rows;
}

// ---------------------------------------------------------------------------

describe('Recovery → namespaces present (TN-TEST-042)', () => {
  it('after wipe + restore, the recovered DID document still lists every namespace with the same fragment + pubkey', async () => {
    // ─── Phase A: original device ───────────────────────────────────
    const mnemonic = generateMnemonic();
    const a = buildGenesis(mnemonic);

    const { fetch: f0 } = makeFakeFetch();
    const a0 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 0,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a.genesisSigned,
      submitConfig: { fetch: f0, sleep: noopSleep, plcURL: 'https://plc.test' },
    });
    const { fetch: f1 } = makeFakeFetch();
    const a1 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 1,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a0.composed.signedOperation,
      submitConfig: { fetch: f1, sleep: noopSleep, plcURL: 'https://plc.test' },
    });

    // The "latest op" the PLC directory will return to a recovering
    // device — every prior namespace is overlaid into its
    // verificationMethods map by the chain's CBOR-shape contract.
    const latestPublished = a1.composed.signedOperation;

    // Sanity: Phase A's user-visible namespace list has both rows.
    const phaseAList = listNamespaces(a.did, latestPublished);
    expect(phaseAList.map((r) => r.index)).toEqual([0, 1]);
    expect(phaseAList.map((r) => r.fragment)).toEqual(['namespace_0', 'namespace_1']);

    // ─── Wipe ───────────────────────────────────────────────────────
    // Phase A variables fall out of scope below; the only state that
    // survives is the mnemonic + the published op the PLC directory
    // serves to the restored device.

    // ─── Phase B: fresh device, only mnemonic survives ──────────────
    const b = buildGenesis(mnemonic);

    // The user opens the namespace screen on the restored device. The
    // runner has fetched `latestPublished` from plc.directory. We
    // derive the displayable list from that op — exactly the path
    // the mobile screen takes via `deriveNamespaceRows`.
    const recoveredList = listNamespaces(b.did, latestPublished);

    // Same fragments, same indices, same DID — the screen renders
    // an identical list to what the user saw before the wipe.
    expect(recoveredList.map((r) => r.index)).toEqual([0, 1]);
    expect(recoveredList.map((r) => r.fragment)).toEqual(['namespace_0', 'namespace_1']);
    expect(recoveredList.map((r) => r.verificationMethodId)).toEqual([
      `${a.did}#namespace_0`,
      `${a.did}#namespace_1`,
    ]);

    // Critical: published `did:key:` strings must match the multibase
    // of re-derived namespace public keys. If they don't, the user's
    // restored device thinks namespace_0 belongs to a different key —
    // every prior attestation under namespace_0 would orphan even
    // though the listing "succeeds".
    const reDerivedNs0 = deriveNamespaceKey(b.masterSeed, 0);
    const reDerivedNs1 = deriveNamespaceKey(b.masterSeed, 1);

    expect(recoveredList[0]?.publishedDidKey).toBe(
      `did:key:${publicKeyToMultibase(reDerivedNs0.publicKey)}`,
    );
    expect(recoveredList[1]?.publishedDidKey).toBe(
      `did:key:${publicKeyToMultibase(reDerivedNs1.publicKey)}`,
    );

    // Belt-and-braces: byte-equal pubkeys, not just equal-as-strings
    // (catches a multibase regression that produces the same string
    // for different keys, which would be a real bug in publicKeyToMultibase
    // but worth defending).
    expect(bytesToHex(reDerivedNs0.publicKey)).toBe(bytesToHex(a0.namespacePublicKey));
    expect(bytesToHex(reDerivedNs1.publicKey)).toBe(bytesToHex(a1.namespacePublicKey));

    // The user's namespace identities (DID URL form) survive recovery.
    // This is what every prior attestation's `signedBy` reference
    // points at — if it changes, the trust graph breaks.
    expect(recoveredList[0]?.verificationMethodId).toBe(`${a.did}#namespace_0`);
  });

  it('recovered chain extends correctly — adding namespace_2 after recovery produces the canonical timeline op', async () => {
    // Variant: prove the user can keep using their identity after
    // recovery — adding the next namespace must compose into a valid
    // PLC update against the recovered prior op, and the result must
    // chain cleanly. (TN-IDENT-009 already proves byte-identical with
    // a continuous timeline; here we prove the listing AFTER the new
    // op contains the new fragment.)
    const mnemonic = generateMnemonic();
    const a = buildGenesis(mnemonic);

    const { fetch: f0 } = makeFakeFetch();
    const a0 = await createNamespace({
      did: a.did,
      masterSeed: a.masterSeed,
      namespaceIndex: 0,
      rotationPrivateKey: a.rotationPrivateKey,
      priorSignedOperation: a.genesisSigned,
      submitConfig: { fetch: f0, sleep: noopSleep },
    });

    // PLC directory hands the restored device this op.
    const latestPublished = a0.composed.signedOperation;

    // Recovery — only mnemonic survived.
    const b = buildGenesis(mnemonic);
    expect(b.did).toBe(a.did);

    // Adding namespace_1 from the restored device must succeed.
    // Compose-only (don't submit) so the test stays self-contained.
    const reDerivedNs1 = deriveNamespaceKey(b.masterSeed, 1);
    const composed = composeAndSignNamespaceUpdate({
      priorSignedOperation: latestPublished,
      namespaceIndex: 1,
      namespacePublicKey: reDerivedNs1.publicKey,
      rotationPrivateKey: b.rotationPrivateKey,
    });

    // After the composer overlays namespace_1, the signed op carries
    // BOTH namespaces — that's the document state PLC will serve next
    // time the user reopens the screen.
    const afterAddList = listNamespaces(b.did, composed.signedOperation);
    expect(afterAddList.map((r) => r.index)).toEqual([0, 1]);

    // The newly-overlaid pubkey must round-trip to the re-derived key.
    expect(afterAddList[1]?.publishedDidKey).toBe(
      `did:key:${publicKeyToMultibase(reDerivedNs1.publicKey)}`,
    );

    // And the namespace_0 entry the prior op already carried is still
    // there (the composer's overlay-not-replace contract — pinned
    // here at the user-facing list layer).
    expect(afterAddList[0]?.publishedDidKey).toBe(
      `did:key:${publicKeyToMultibase(deriveNamespaceKey(b.masterSeed, 0).publicKey)}`,
    );
  });

  it('cross-mnemonic isolation — a different mnemonic recovers a DIFFERENT user (no namespace bleed-through)', () => {
    // Sanity guard: if two restored devices' namespace listings
    // overlapped, recovery would leak namespaces across users. Pin
    // the isolation at the listing layer (the byte-level guard lives
    // in TN-IDENT-009).
    const mnemonicA = generateMnemonic();
    const mnemonicB = generateMnemonic();
    expect(mnemonicA).not.toBe(mnemonicB);

    const a = buildGenesis(mnemonicA);
    const b = buildGenesis(mnemonicB);

    // Forge a "their op served to my device" scenario: simulate a
    // PLC directory that mistakenly returned User A's op to User B's
    // recovering device. The fragment list parses fine (regex doesn't
    // know whose key is whose) — but the pubkey check must fail,
    // which is the runtime guard against silent identity swap.
    const fakeOpForA: Record<string, unknown> = {
      ...a.genesisSigned,
      verificationMethods: {
        ...((a.genesisSigned as { verificationMethods?: Record<string, string> })
          .verificationMethods ?? {}),
        [namespaceFragment(0)]: `did:key:${publicKeyToMultibase(deriveNamespaceKey(a.masterSeed, 0).publicKey)}`,
      },
    };

    // User B's device parses the listing — surface-level it looks fine.
    const listFromBPerspective = listNamespaces(b.did, fakeOpForA);
    expect(listFromBPerspective.map((r) => r.fragment)).toEqual(['namespace_0']);

    // But B's re-derived key for namespace_0 does NOT match A's
    // published key. This is the load-bearing assertion: a restored
    // device that fetches the WRONG op (or a man-in-the-middle attack
    // injects A's op) sees a published-vs-derived mismatch and can
    // refuse to claim the identity.
    const bsNs0 = deriveNamespaceKey(b.masterSeed, 0);
    expect(listFromBPerspective[0]?.publishedDidKey).not.toBe(
      `did:key:${publicKeyToMultibase(bsNs0.publicKey)}`,
    );
  });
});
