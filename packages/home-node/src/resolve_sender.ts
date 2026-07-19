/**
 * `makeResolveSender` — shared `resolveSender` builder for the
 * `bootstrapMsgBox` receive-pipeline contract.
 *
 * Both mobile (`apps/mobile/src/services/msgbox_wiring.ts`) and the
 * lite Core (`apps/home-node-lite/core-server/src/boot.ts`) need to
 * answer "given a sender DID, return its Ed25519 verification keys +
 * the trust level we've recorded for them." The logic is identical:
 *   1. Self-lookup returns our own pubkey + 'self' trust (no PLC
 *      round-trip; works for did:key identities that have no PLC
 *      doc).
 *   2. Anyone else gets resolved through a `DIDResolver` — the
 *      `#dina_signing` VM (or any 32-byte Multikey) wins.
 *   3. Trust comes from the contact directory (`getContact`),
 *      defaulting to 'unknown' for senders we haven't recorded.
 *   4. Resolve failures collapse to `{ keys: [], trust }` so the
 *      receive pipeline quarantines them rather than crashing.
 *
 * Keep this module runtime-agnostic: no node-fs, no react-native
 * primitives. Only depends on `@dina/core` (DIDResolver, getContact,
 * multibaseToPublicKey).
 */

import { getContact, multibaseToPublicKey } from '@dina/core';
import { DIDResolver } from '@dina/core/runtime';

export interface MakeResolveSenderOptions {
  selfDID: string;
  selfPublicKey: Uint8Array;
  /** Optional resolver override — defaults to a shared instance. */
  resolver?: DIDResolver;
  /** Telemetry hook for failed resolves. Defaults to `console.warn`. */
  onResolveError?: (did: string, err: Error) => void;
}

const sharedResolver = new DIDResolver();

/**
 * Build a `resolveSender` closure that the MsgBox receive pipeline
 * calls with every inbound envelope's sender DID. Returns the
 * sender's Ed25519 public key(s) + the trust level we've recorded.
 *
 * Failure modes:
 *   - DID doesn't resolve at all       → `{ keys: [], trust: 'unknown' }`
 *   - DID resolves but no Ed25519 VM   → same (caller treats as unverified)
 *   - DID resolves with a key          → `{ keys: [k], trust }`
 */
export function makeResolveSender(
  opts: MakeResolveSenderOptions,
): (did: string) => Promise<{ keys: Uint8Array[]; trust: string }> {
  const resolver = opts.resolver ?? sharedResolver;
  const onError =
    opts.onResolveError ??
    ((did, err) => {
       
      console.warn(`[resolveSender] ${did} failed:`, err.message);
    });

  return async (did: string) => {
    if (did === opts.selfDID) {
      return { keys: [opts.selfPublicKey], trust: 'self' };
    }

    const contact = getContact(did);
    const trust = contact?.trustLevel ?? 'unknown';

    try {
      const resolved = await resolver.resolve(did);
      const vm = pickEd25519VerificationMethod(resolved.document.verificationMethod);
      if (vm === null || typeof vm.publicKeyMultibase !== 'string') {
        return { keys: [], trust };
      }
      const pubkey = multibaseToPublicKey(vm.publicKeyMultibase);
      return { keys: [pubkey], trust };
    } catch (err) {
      onError(did, err as Error);
      return { keys: [], trust };
    }
  };
}

/**
 * Pick the Ed25519 signing verification method from a DID doc's
 * `verificationMethod` list. Matching order:
 *
 *   1. A method whose id fragment is `#dina_signing` — the convention
 *      Dina's PLC publisher uses for the signing key.
 *   2. Any Multikey whose publicKeyMultibase decodes to a 32-byte
 *      value (Ed25519 keys are 32 bytes, secp256k1 compressed is 33).
 *
 * Returns `null` when neither heuristic finds a match — the caller
 * treats that as "unverifiable sender" and lets the gate drop /
 * quarantine the envelope.
 */
export function pickEd25519VerificationMethod(
  vms: { id?: string; type?: string; publicKeyMultibase?: string }[],
): { publicKeyMultibase?: string } | null {
  for (const vm of vms) {
    if (typeof vm.id === 'string' && vm.id.endsWith('#dina_signing')) {
      return vm;
    }
  }
  for (const vm of vms) {
    if (vm.type !== 'Multikey' || typeof vm.publicKeyMultibase !== 'string') continue;
    try {
      if (multibaseToPublicKey(vm.publicKeyMultibase).length === 32) return vm;
    } catch {
      /* malformed multibase — skip */
    }
  }
  return null;
}
