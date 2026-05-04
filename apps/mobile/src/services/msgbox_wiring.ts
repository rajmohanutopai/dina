/**
 * MsgBox transport wiring for the Expo boot path.
 *
 * Three knobs the mobile boot needs to actually carry D2D bytes:
 *
 *   `msgboxURL`     — WebSocket URL of the shared relay. Resolved by the
 *                     shared Home Node endpoint policy. Test mode is the
 *                     default; release mode moves MsgBox, PDS, AppView,
 *                     and PLC config together.
 *
 *   `wsFactory`     — Wraps RN's global `WebSocket`. The core msgbox_ws
 *                     client drives the handshake + read pump; all we do
 *                     here is hand it a `WSLike`.
 *
 *   `resolveSender` — Called on every inbound D2D envelope. For a known
 *                     DID:PLC peer we fetch + cache the PLC doc via
 *                     DIDResolver, pull the Ed25519 signing key out of
 *                     the first verificationMethod, and return it paired
 *                     with the contact's trust level. `did:key` is a
 *                     local derivation (no network). Unknown or
 *                     unresolvable senders get `{ keys: [], trust:
 *                     'unknown' }` so the receive pipeline quarantines
 *                     them rather than crashing on a verify-miss.
 *
 * Self-lookups are answered locally so we never round-trip to PLC for
 * our own DID (and so a did:key self-identity that has no PLC doc
 * still works). The caller passes our identity in as a closure.
 */

import { DIDResolver, type WSFactory, type WSLike } from '@dina/core/d2d';
import { multibaseToPublicKey } from '@dina/core';
import { getContact } from '@dina/core';
import { resolveHostedDinaEndpoints, resolveMobileHostedDinaEndpoints } from '@dina/home-node';

/** Default shared Dina mailbox for greenfield test installs. */
export const DEFAULT_MSGBOX_URL = resolveHostedDinaEndpoints('test').msgboxWsUrl;

export function resolveMsgBoxURL(): string {
  return resolveMobileHostedDinaEndpoints().msgboxWsUrl;
}

/**
 * RN WebSocket factory. Relies on the global `WebSocket` constructor
 * every RN runtime ships — we cast to `WSLike` because RN's type
 * doesn't carry `readyState` in the same shape Core expects, but at
 * runtime the fields line up.
 */
export function makeWSFactory(): WSFactory {
  return (url: string): WSLike => {
    const ws = new WebSocket(url);
    return ws as unknown as WSLike;
  };
}

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
 * Build a resolveSender closure that the MsgBox receive pipeline calls
 * with every inbound envelope's sender DID. Returns the sender's
 * Ed25519 public key(s) + the trust level we've recorded for that DID.
 *
 * Failure modes:
 *   - DID doesn't resolve at all         → `{ keys: [], trust: 'unknown' }`
 *   - DID resolves but no verification   → same (caller treats as unverified)
 *   - DID resolves with a key            → `{ keys: [k], trust }` where
 *                                          `trust` comes from the contact
 *                                          directory, defaulting to
 *                                          'unknown' when the sender
 *                                          isn't a recorded contact.
 */
export function makeResolveSender(
  opts: MakeResolveSenderOptions,
): (did: string) => Promise<{ keys: Uint8Array[]; trust: string }> {
  const resolver = opts.resolver ?? sharedResolver;
  const onError =
    opts.onResolveError ??
    ((did, err) => {
      // eslint-disable-next-line no-console
      console.warn(`[resolveSender] ${did} failed:`, err.message);
    });

  return async (did: string) => {
    if (did === opts.selfDID) {
      // Self-lookup stays local; trust is always 'self' so the receive
      // pipeline doesn't gate our own echoes on a contact row.
      return { keys: [opts.selfPublicKey], trust: 'self' };
    }

    const contact = getContact(did);
    const trust = contact?.trustLevel ?? 'unknown';

    try {
      const resolved = await resolver.resolve(did);
      // ATProto PLC docs list the secp256k1 rotation key FIRST
      // (#atproto) and the Ed25519 signing key SECOND (#dina_signing).
      // We need the Ed25519 for D2D signature verification; picking
      // VM[0] blindly would hand back a secp256k1 key that
      // multibaseToPublicKey decodes to the wrong byte shape.
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
 *      the Dina PLC publisher uses for the signing key.
 *   2. Any Multikey whose publicKeyMultibase decodes to a 32-byte
 *      value (Ed25519 keys are 32 bytes, secp256k1 compressed is 33).
 *
 * Returns `null` when neither heuristic finds a match — the caller
 * treats that as "unverifiable sender" and lets the gate drop/
 * quarantine the envelope.
 */
function pickEd25519VerificationMethod(
  vms: Array<{ id?: string; type?: string; publicKeyMultibase?: string }>,
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
