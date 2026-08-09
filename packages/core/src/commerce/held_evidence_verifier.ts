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

import { base64 } from '@scure/base';

import { buildMessageJSON } from '@dina/protocol';

import { resolveRegisteredPublicKey } from '../auth/middleware';
import { verify } from '../crypto/ed25519';

import type { RetainedEnvelope } from '@dina/commerce-protocol';

/** What the engine hands a verifier. */
export interface HeldEvidenceCheck {
  envelope: RetainedEnvelope;
  signature: string;
  signerKeyId?: string;
  supplierDid: string;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The verifier a real node installs.
 *
 * `resolvePublicKey` defaults to the registry the auth layer already
 * populates at boot with this node's own key — the same key that signed
 * the outbound message in the first place, so "verify my own signature"
 * needs nothing new wired. It is injectable so a test can supply a key
 * without standing up the auth globals, and so a node whose key material
 * lives somewhere else can say so.
 *
 * EVERY failure is `false`, never a throw. This runs inside a decision
 * that must otherwise refuse non-disclosingly; an exception escaping here
 * would turn "I cannot verify that" into a 500 that tells a caller its
 * evidence was at least well-formed.
 */
export function makeHeldEvidenceVerifier(
  resolvePublicKey: (did: string) => Uint8Array | null = resolveRegisteredPublicKey,
): (check: HeldEvidenceCheck) => boolean {
  return ({ envelope, signature, supplierDid }) => {
    try {
      const publicKey = resolvePublicKey(supplierDid);
      if (publicKey === null) return false;
      const signatureBytes = hexToBytes(signature);
      if (signatureBytes === null || signatureBytes.length !== 64) return false;
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
      return verify(publicKey, new TextEncoder().encode(signed), signatureBytes);
    } catch {
      return false;
    }
  };
}
