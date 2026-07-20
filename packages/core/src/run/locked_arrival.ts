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

import type { DatabaseAdapter } from '../storage/db_adapter';

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

/**
 * The staging leaf key's erasure-store id. NAMESPACED apart from the payload's
 * own leaf key (which `preparePayload`/`putPayload` store under the bare
 * `payloadId`), so preparing the payload during the unlock replay can never
 * overwrite the staging key — a crash between the prepared vault write and the
 * Tier-0 commit leaves the staged spool blob still decryptable for the retry
 * (§7 crash-safety: "reservation still held_by_lock, spool blob intact ⇒
 * retried").
 */
function stagedKeyId(payloadId: string): string {
  return `staged:${payloadId}`;
}

/** What `recover` yields: the decrypted plaintext, or a detected loss. */
export type RecoverOutcome =
  | { outcome: 'recovered'; plaintext: Uint8Array }
  | {
      outcome: 'response_lost';
      reason: 'blob_missing' | 'digest_mismatch' | 'erasure_key_gone' | 'corrupt';
    };

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

    this.erasure().put(stagedKeyId(payloadId), kE);
    const spoolId = this.spool.store(serializeStaged(wrappedSealedKp, blob));
    return { spool_id: spoolId, content_digest: contentDigest };
  }

  /**
   * Recover the staged plaintext WITHOUT publishing or consuming anything (§7):
   * peek → digest verify → device-unseal → decrypt. Side-effect free — the spool
   * blob and staging key stay intact, so the caller can run the guarded
   * enqueue-commit (prepare + Tier-0 CAS) and call {@link finalize} only after
   * the commit lands; a crash at any point retries cleanly.
   */
  recover(payloadId: string, ref: SealedResponseRef): RecoverOutcome {
    const staged = this.spool.peek(ref.spool_id);
    if (staged === null) return { outcome: 'response_lost', reason: 'blob_missing' };
    const parsed = deserializeStaged(staged);
    if (parsed === null) return { outcome: 'response_lost', reason: 'corrupt' };
    const { wrappedSealedKp, blob } = parsed;
    if (bytesToHex(sha256(blob)) !== ref.content_digest) {
      return { outcome: 'response_lost', reason: 'digest_mismatch' };
    }
    const kE = this.erasure().get(stagedKeyId(payloadId));
    if (kE === null) return { outcome: 'response_lost', reason: 'erasure_key_gone' };
    try {
      const sealedKp = aeadDecrypt(kE, wrappedSealedKp);
      const kP = this.sealer.unseal(sealedKp);
      return { outcome: 'recovered', plaintext: aeadDecrypt(kP, blob) };
    } catch {
      return { outcome: 'response_lost', reason: 'corrupt' };
    }
  }

  /**
   * Post-commit cleanup: ack-delete the spool blob + destroy the staging leaf
   * key. Idempotent — safe to re-run after a crash-between-commit-and-finalize
   * (the replay detects the already-admitted message and just finalizes).
   */
  finalize(payloadId: string, ref: SealedResponseRef): void {
    this.spool.ack(ref.spool_id);
    this.erasure().destroy(stagedKeyId(payloadId));
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

    // Recover is side-effect free; a failure surfaces `response_lost` (F16).
    const recovered = this.recover(payloadId, ref);
    if (recovered.outcome === 'response_lost') {
      return { outcome: 'response_lost', reason: recovered.reason };
    }

    // Re-encrypt under the normal open-persona envelope (fresh keys + persona
    // DEK); the Tier-0 pointer CAS is the sole commit (§13). The staging leaf
    // key lives under its OWN namespaced id, so a mid-flight failure leaves the
    // spool blob fully decryptable for the retry (VERIF #3 — no restore dance
    // needed). Finalize (spool ack + staging-key destroy) only after success.
    let payloadRef: PayloadRef;
    try {
      payloadRef = this.payloads.putPayload({
        payloadId,
        runId,
        persona,
        plaintext: recovered.plaintext,
      });
    } catch {
      return { outcome: 'response_lost', reason: 'publish_failed' };
    }
    this.finalize(payloadId, ref);
    return { outcome: 'published', ref: payloadRef };
  }

  /**
   * Discard a held payload when a barrier intervenes before unlock (§7): crypto-
   * shred the leaf key (staged blob → inert) and ack-delete the spool blob
   * WITHOUT decryption.
   */
  discard(payloadId: string, ref: SealedResponseRef): void {
    this.erasure().destroy(stagedKeyId(payloadId)); // crypto-shred (no decryption)
    this.spool.ack(ref.spool_id); // physical delete of the inert ciphertext
  }
}

// ---------------------------------------------------------------------------
// Durable spool — SQLite over Tier-0 (`identity.sqlite`), both platforms.
// ---------------------------------------------------------------------------

let spoolSeq = 0;

/**
 * The PRODUCTION `RunSpool`: a Tier-0 SQLite table (`run_spool`, migration
 * `run_reservations_and_payloads`). One implementation serves BOTH boots (the
 * Node server and Expo/Hermes mobile share the DatabaseAdapter port), and a WAL
 * transaction commit gives the durability the doc's "fsync before the
 * `held_by_lock` commit" requires — with same-DB atomicity when the caller wraps
 * store + hold in one Tier-0 transaction (strictly stronger than a separate fs
 * spool). The blob is Core-sealed ciphertext; no plaintext is ever written (§13).
 */
export class SQLiteRunSpool implements RunSpool {
  constructor(private readonly db: DatabaseAdapter) {}

  store(blob: Uint8Array): string {
    const id = `spool-${Date.now().toString(36)}-${(++spoolSeq).toString(36)}`;
    this.db.execute('INSERT INTO run_spool (spool_id, blob, created_at) VALUES (?, ?, ?)', [
      id,
      blob,
      Date.now(),
    ]);
    return id;
  }

  peek(id: string): Uint8Array | null {
    const rows = this.db.query<{ blob: Uint8Array }>(
      'SELECT blob FROM run_spool WHERE spool_id = ? LIMIT 1',
      [id],
    );
    const raw = rows[0]?.blob;
    return raw === undefined || raw === null ? null : new Uint8Array(raw);
  }

  ack(id: string): void {
    this.db.run('DELETE FROM run_spool WHERE spool_id = ?', [id]);
  }
}
