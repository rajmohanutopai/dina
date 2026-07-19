/**
 * Locked-arrival buffering — the `held_by_lock` path
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §7/§13).
 *
 * When a verified arrival's enqueue-commit races a persona LOCK, the persona DEK
 * is out of RAM, so Core wraps the per-payload data key `k_p` to the always-
 * available DEVICE X25519 key and durably stages the ciphertext in a spool
 * (fsync) BEFORE the `held_by_lock` commit — not discarded, no plaintext at rest,
 * no persona DEK required. On UNLOCK it is published to the persona payload store
 * exactly-once via a crash-safe content-addressed prepared-write (the Tier-0
 * pointer CAS is the sole commit; the spool is drained non-destructively with
 * peek/ack). If a barrier intervenes before unlock, the held reservation is
 * terminally cancelled: its per-payload leaf erasure key is crypto-shredded and
 * the spool blob is ack-deleted WITHOUT decryption.
 *
 * The staged blob is double-protected exactly like the open-persona payload
 * (§13): `AEAD_{k_p}(plaintext)`, with `k_p` device-sealed AND that seal wrapped
 * under a per-payload leaf erasure key `k_e`. So crypto-shred = destroy `k_e`,
 * which renders the staged blob inert without touching any other payload.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../crypto/aead';
import { sealDecrypt, sealEncrypt } from '../crypto/nacl';

import { getErasureKeyStore, type ErasureKeyStore } from './erasure_store';
import { PayloadStore, type PayloadRef } from './payload_store';

/**
 * Byte storage for a locked-arrival ciphertext. Net-new `peek`/`ack` two-phase
 * drain over the shipping dead-drop spool (a fsync'd Node impl + an Expo adapter
 * are the platform backings; this port is what Core depends on).
 */
export interface RunSpool {
  /** Durably store an opaque (already-sealed) blob; returns its id. */
  store(blob: Uint8Array): string;
  /** Read WITHOUT removing (the non-destructive drain, §7). Null if absent. */
  peek(id: string): Uint8Array | null;
  /** Remove after a committed publish / a terminal discard. */
  ack(id: string): void;
}

/** In-memory spool for tests. The Node fs impl (fsync + atomic rename) mirrors
 *  home-node-lite's `ingress/dead_drop.ts`. */
export class InMemoryRunSpool implements RunSpool {
  private readonly blobs = new Map<string, Uint8Array>();
  private seq = 0;
  store(blob: Uint8Array): string {
    const id = `spool-${(++this.seq).toString(36)}`;
    this.blobs.set(id, new Uint8Array(blob));
    return id;
  }
  peek(id: string): Uint8Array | null {
    const b = this.blobs.get(id);
    return b ? new Uint8Array(b) : null;
  }
  ack(id: string): void {
    this.blobs.delete(id);
  }
}

/** Seals/unseals a small secret to the device key (§13). The default uses the
 *  `crypto/nacl.ts` sealed box (BLAKE2b(24) nonce) to a device Ed25519 key. */
export interface DeviceSealer {
  seal(plaintext: Uint8Array): Uint8Array;
  unseal(ciphertext: Uint8Array): Uint8Array;
}

export class NaclDeviceSealer implements DeviceSealer {
  constructor(
    private readonly deviceEd25519Pub: Uint8Array,
    private readonly deviceEd25519Priv: Uint8Array,
  ) {}
  seal(plaintext: Uint8Array): Uint8Array {
    return sealEncrypt(plaintext, this.deviceEd25519Pub);
  }
  unseal(ciphertext: Uint8Array): Uint8Array {
    return sealDecrypt(ciphertext, this.deviceEd25519Pub, this.deviceEd25519Priv);
  }
}

/** The `sealed_response_ref` a `held_by_lock` reservation carries (§13). */
export interface SealedResponseRef {
  spool_id: string;
  content_digest: string;
}

export type PublishOutcome =
  | { outcome: 'published'; ref: PayloadRef }
  | {
      outcome: 'response_lost';
      reason: 'blob_missing' | 'digest_mismatch' | 'erasure_key_gone' | 'publish_failed' | 'corrupt';
    };

export interface LockedArrivalStoreOptions {
  spool: RunSpool;
  deviceSealer: DeviceSealer;
  /** The open-persona payload store (used to publish on unlock). */
  payloadStore: PayloadStore;
  erasureStore?: ErasureKeyStore;
}

function serializeStaged(wrappedSealedKp: Uint8Array, blob: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + wrappedSealedKp.length + blob.length);
  new DataView(out.buffer).setUint32(0, wrappedSealedKp.length, false);
  out.set(wrappedSealedKp, 4);
  out.set(blob, 4 + wrappedSealedKp.length);
  return out;
}

function deserializeStaged(
  bytes: Uint8Array,
): { wrappedSealedKp: Uint8Array; blob: Uint8Array } | null {
  // Bounds-check the framing BEFORE reading (F16): a truncated header (< 4 bytes)
  // would throw on getUint32, and a length that overruns the buffer would silently
  // slice garbage. Either is a corrupt/partial staged blob → the caller surfaces a
  // detected `response_lost`, never an uncaught throw or a mis-decoded envelope.
  if (bytes.length < 4) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  if (len > bytes.length - 4) return null; // header claims more key bytes than exist
  return {
    wrappedSealedKp: bytes.slice(4, 4 + len),
    blob: bytes.slice(4 + len),
  };
}

export class LockedArrivalStore {
  private readonly spool: RunSpool;
  private readonly sealer: DeviceSealer;
  private readonly payloads: PayloadStore;
  private readonly explicitErasure?: ErasureKeyStore;

  constructor(opts: LockedArrivalStoreOptions) {
    this.spool = opts.spool;
    this.sealer = opts.deviceSealer;
    this.payloads = opts.payloadStore;
    this.explicitErasure = opts.erasureStore;
  }

  private erasure(): ErasureKeyStore {
    const s = this.explicitErasure ?? getErasureKeyStore();
    if (s === null || s === undefined) throw new Error('LockedArrivalStore: no ErasureKeyStore wired');
    return s;
  }

  /**
   * Stage a locked-arrival payload (§7): encrypt under a fresh `k_p`, device-seal
   * `k_p`, wrap that seal under a per-payload leaf key `k_e`, and durably spool
   * the ciphertext BEFORE the caller commits the `held_by_lock` reservation.
   * Returns the `sealed_response_ref` (spool id + content digest).
   */
  stage(payloadId: string, plaintext: Uint8Array): SealedResponseRef {
    const kP = generateAeadKey();
    const kE = generateAeadKey();
    const blob = aeadEncrypt(kP, plaintext);
    const contentDigest = bytesToHex(sha256(blob));
    const sealedKp = this.sealer.seal(kP);
    const wrappedSealedKp = aeadEncrypt(kE, sealedKp);

    this.erasure().put(payloadId, kE);
    const spoolId = this.spool.store(serializeStaged(wrappedSealedKp, blob));
    return { spool_id: spoolId, content_digest: contentDigest };
  }

  /**
   * Publish a held payload to the persona store on UNLOCK (§7). Non-destructive
   * peek → verify digest → device-unseal → decrypt → re-encrypt via the normal
   * open-persona envelope (the Tier-0 CAS is the sole commit) → ack the spool. A
   * missing/corrupt staged blob or a shredded leaf key surfaces `response_lost`.
   */
  publish(payloadId: string, runId: string, persona: string, ref: SealedResponseRef): PublishOutcome {
    // Crash-recovery no-op (§7): if the persona blob was already published (crash
    // after the Tier-0 CAS, before the spool ack), just ack and return — never a
    // duplicate insert, never a double-admit.
    const alreadyPublished = this.payloads.contentId(payloadId);
    if (alreadyPublished !== null && this.payloads.blobState(payloadId) === 'published') {
      this.spool.ack(ref.spool_id);
      return { outcome: 'published', ref: { payload_id: payloadId, content_id: alreadyPublished } };
    }

    const staged = this.spool.peek(ref.spool_id);
    if (staged === null) return { outcome: 'response_lost', reason: 'blob_missing' };
    const parsed = deserializeStaged(staged);
    if (parsed === null) return { outcome: 'response_lost', reason: 'corrupt' }; // bad framing
    const { wrappedSealedKp, blob } = parsed;
    if (bytesToHex(sha256(blob)) !== ref.content_digest) {
      return { outcome: 'response_lost', reason: 'digest_mismatch' };
    }
    const kE = this.erasure().get(payloadId);
    if (kE === null) return { outcome: 'response_lost', reason: 'erasure_key_gone' };

    // The stored digest covers only `blob`, so a corrupted `wrappedSealedKp` (or
    // a tampered sealed k_p) passes the digest check and only fails here — catch
    // the auth/decrypt throw and surface `response_lost` rather than propagating
    // an uncaught exception that would strand the unlock recovery (F16).
    let plaintext: Uint8Array;
    try {
      const sealedKp = aeadDecrypt(kE, wrappedSealedKp);
      const kP = this.sealer.unseal(sealedKp);
      plaintext = aeadDecrypt(kP, blob);
    } catch {
      return { outcome: 'response_lost', reason: 'corrupt' };
    }

    // Re-encrypt under the normal open-persona envelope (fresh keys + persona
    // DEK); the Tier-0 pointer CAS is the sole commit (§13). `putPayload`
    // overwrites the staging leaf key at `payloadId`, so if it fails mid-flight
    // the spool blob would become undecryptable — RESTORE the staging key so a
    // retry can re-decrypt, and surface a detected `response_lost` rather than
    // an uncaught throw + permanent loss (VERIF #3). Then ack the spool.
    let payloadRef: PayloadRef;
    try {
      payloadRef = this.payloads.putPayload({ payloadId, runId, persona, plaintext });
    } catch {
      this.erasure().put(payloadId, kE); // restore the staging key (retry-safe)
      return { outcome: 'response_lost', reason: 'publish_failed' };
    }
    this.spool.ack(ref.spool_id);
    return { outcome: 'published', ref: payloadRef };
  }

  /**
   * Discard a held payload when a barrier intervenes before unlock (§7): crypto-
   * shred the leaf key (staged blob → inert) and ack-delete the spool blob
   * WITHOUT decryption.
   */
  discard(payloadId: string, ref: SealedResponseRef): void {
    this.erasure().destroy(payloadId); // crypto-shred (no decryption)
    this.spool.ack(ref.spool_id); // physical delete of the inert ciphertext
  }
}
