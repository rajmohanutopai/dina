/**
 * §12.7/§16.2 — "did my own key sign this?", the one question a supplier
 * must answer before re-adopting an order it has no record of.
 *
 * BUILT IN CORE, NOT AT EACH BOOT. The reader half of this feature was
 * unwired at both composition roots for exactly as long as it existed,
 * and the pattern is familiar: a defence every root must remember to
 * install is one a root eventually forgets. So the roots pass
 * `verifyHeldEvidence: makeHeldEvidenceVerifier()` and there is one
 * implementation to be right or wrong, on the phone and on the server
 * alike.
 *
 * WHAT IT CHECKS AND WHAT IT DOES NOT. Only the cryptography: these
 * bytes, this signature, this key. Whether the message came from the
 * right party, went to the right party, or actually carries the record
 * being presented is settled by `CommerceLifecycleEngine.verifyHeldRecord`
 * in compiled code before this ever runs. Splitting it that way means an
 * alternative verifier — a hardware signer, a remote KMS — can be
 * substituted without any chance of the binding checks going with it.
 */

import { hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';

import { buildMessageJSON } from '@dina/protocol';

import { resolveRegisteredPublicKey } from '../auth/middleware';
import { verify } from '../crypto/ed25519';
import { getKeyHistory } from '../identity/rotation';

import type { RetainedEnvelope } from '@dina/commerce-protocol';

/** What the engine hands a verifier. */
export interface HeldEvidenceCheck {
  envelope: RetainedEnvelope;
  signature: string;
  signerKeyId?: string;
  supplierDid: string;
}

/**
 * One key this node is willing to accept for a DID.
 *
 * `keyId` is the DID-document verification-method the key is published
 * under, when the resolver knows it. It is optional because Dina's own
 * layout does not currently give the reader one: PLC publishes a single
 * `dina_signing` method whose VALUE is replaced on rotation, so every
 * generation shares the fragment and no id distinguishes them.
 */
export interface HeldEvidenceKey {
  publicKey: Uint8Array;
  keyId?: string;
}

/**
 * The default candidate set: every generation of THIS node's own signing
 * key, when the DID being checked is this node.
 *
 * ROTATION IS THE POINT. The old resolver returned exactly one key — the
 * current one — so the first rotation made every pre-rotation signature
 * this node had ever produced unverifiable BY THIS NODE. The consequence
 * is not a cosmetic failure: `verifyHeldRecord` feeds the §12.7
 * re-adoption path, and evidence that cannot be verified becomes
 * `never_received`, which is the one answer that authorises the buyer to
 * resubmit. A rotation would therefore have turned legitimately
 * acknowledged orders into duplicate orders — goods shipped twice.
 *
 * `identity/rotation.ts` already retains every generation for exactly
 * this reason ("old public keys are kept in the verification list so that
 * messages signed with prior generations remain verifiable"); nothing in
 * the commerce path was asking it.
 *
 * SELF IS ESTABLISHED BY KEY MATERIAL, not by comparing DID strings this
 * module does not have. The rotation history is derived from this node's
 * master seed, so a `did` whose registered key appears in that history IS
 * this node. Any other DID gets only its registered key — this node's own
 * generations must never be offered as candidates for a peer, which would
 * accept this node's signature as if a peer had produced it.
 *
 * AN EMPTY HISTORY IS THE CURRENT PRODUCTION STATE, and it degrades to
 * exactly the old behaviour: the single registered key. `initializeRotation`
 * is reached only through `fullUnlock`, which no composition root calls, and
 * `rotateKey` is called from nothing but its own test — so the product
 * cannot rotate a signing key today and this path changes no live
 * behaviour. It is written this way so that wiring rotation is a change to
 * the identity layer alone, and does not silently reintroduce duplicate
 * orders in commerce the day it lands.
 */
export function defaultHeldEvidenceKeys(did: string): readonly HeldEvidenceKey[] {
  const registered = resolveRegisteredPublicKey(did);
  if (registered === null) return [];
  const history = getKeyHistory();
  const isSelf = history.some((entry) => equalBytes(entry.publicKey, registered));
  if (!isSelf) return [{ publicKey: registered }];
  return history.map((entry) => ({ publicKey: entry.publicKey }));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** `did:plc:xyz#dina_signing` and `#dina_signing` name the same method. */
function fragmentOf(keyId: string): string {
  const hash = keyId.lastIndexOf('#');
  return hash === -1 ? keyId : keyId.slice(hash + 1);
}

/**
 * The verifier a real node installs.
 *
 * `resolveKeys` defaults to `defaultHeldEvidenceKeys`, which reads the
 * registry the auth layer populates at boot plus this node's rotation
 * history. It is injectable so a test can supply keys without standing up
 * the auth globals, and so a node whose key material lives somewhere else
 * can say so.
 *
 * WHAT `signerKeyId` DOES HERE. When the buyer names the verification
 * method it saw AND the resolver knows ids, the candidate set is narrowed
 * to the keys bearing that id: a signature that verifies under some OTHER
 * key is then refused rather than quietly accepted under a name the buyer
 * never claimed. When the resolver knows no ids — today's case — the id is
 * carried but cannot be judged, and the signature remains the only gate.
 * Refusing on an unjudgeable id would reject valid evidence from any peer
 * that populates the field, which is a worse failure than not narrowing.
 *
 * EVERY failure is `false`, never a throw. This runs inside a decision
 * that must otherwise refuse non-disclosingly; an exception escaping here
 * would turn "I cannot verify that" into a 500 that tells a caller its
 * evidence was at least well-formed.
 */
export function makeHeldEvidenceVerifier(
  resolveKeys: (did: string) => readonly HeldEvidenceKey[] = defaultHeldEvidenceKeys,
): (check: HeldEvidenceCheck) => boolean {
  return ({ envelope, signature, signerKeyId, supplierDid }) => {
    try {
      const candidates = resolveKeys(supplierDid);
      if (candidates.length === 0) return false;
      // 128 hex chars checked BEFORE decoding, because `hexToBytes` throws on
      // anything else and a throw here is indistinguishable from a real
      // failure. Ed25519 signatures are exactly 64 bytes.
      if (signature.length !== 128 || !/^[0-9a-f]+$/.test(signature)) return false;
      const signatureBytes = hexToBytes(signature);

      let usable = candidates;
      if (signerKeyId !== undefined && candidates.some((k) => k.keyId !== undefined)) {
        const wanted = fragmentOf(signerKeyId);
        usable = candidates.filter((k) => k.keyId !== undefined && fragmentOf(k.keyId) === wanted);
        if (usable.length === 0) return false;
      }

      // Rebuilt through the SAME builder the send path signs with. A local
      // re-implementation of the field order would be a second copy of a
      // byte-exact rule, and the two would drift silently — the failure
      // looking like a forged signature rather than a formatting change.
      const signed = buildMessageJSON({
        id: envelope.id,
        type: envelope.type,
        from: envelope.from,
        to: envelope.to,
        created_time: envelope.created_time,
        bodyBase64: base64.encode(new TextEncoder().encode(envelope.body)),
      });
      const signedBytes = new TextEncoder().encode(signed);
      return usable.some((k) => verify(k.publicKey, signedBytes, signatureBytes));
    } catch {
      return false;
    }
  };
}
