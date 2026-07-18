/**
 * Envelope-encrypted payload store + per-payload-leaf-key crypto-shred
 * (INTERACTIVE_SERVICES_ARCHITECTURE.md §13).
 *
 * A message payload (verified envelope + card + bounded params) or an action
 * result card is stored as:
 *
 *   blob        = AEAD_{k_p}(plaintext)                      -- content-addressed
 *   wrapped_key = AEAD_{k_e}( confidentialityWrap(k_p) )     -- lives in Tier-0
 *
 * where `k_p` is a fresh per-payload data key, `confidentialityWrap` binds `k_p`
 * to the persona DEK (so a locked persona's payload is unrecoverable — "sealed"),
 * and `k_e` is a per-payload leaf ERASURE key held in a separate
 * `ErasureKeyStore`. Decryption needs BOTH keys, so:
 *
 *   crypto-shred = destroy `k_e`  ⇒  wrapped_key undecryptable  ⇒  ciphertext inert,
 *
 * which needs no persona DEK (works while locked) and, with a conforming
 * non-backed erasure backend, defeats backup/WAL/snapshot copies. The strength
 * of that guarantee is the store's frozen `erasure_mode` (§13/§20).
 *
 * A Tier-0 blob registry (`prepared|published|abandoned`) makes the publish CAS
 * and orphan-GC mutually exclusive: GC never deletes a `prepared`/`published`
 * live blob. There is NO cross-database transaction — the erasure key is an
 * external secret that deliberately does not join the SQLite commit (§13); the
 * Tier-0 pointer/registry CAS is the sole atomic commit point.
 *
 * V1 note: this slice handles the persona-OPEN path (wrap under the persona DEK).
 * The locked-arrival device-seal + fsync'd spool + cross-store prepared-write is
 * ISVC-6.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { aeadDecrypt, aeadEncrypt, generateAeadKey } from '../crypto/aead';
import { PersonaLockedError } from '../errors';
import { wrapWithPersonaDEK, unwrapWithPersonaDEK } from '../persona/orchestrator';

import { getErasureKeyStore, type ErasureKeyStore } from './erasure_store';

import type { DatabaseAdapter } from '../storage/db_adapter';

export type BlobState = 'prepared' | 'published' | 'abandoned';

/** Confidentiality wrap of a per-payload data key. Injected so tests can drive
 *  the store without a real persona unlock; defaults to the persona-DEK wrap. */
export interface PersonaCipher {
  /** Returns null when the persona is locked (DEK out of RAM). */
  wrap(persona: string, plaintext: Uint8Array): Uint8Array | null;
  /** Returns null when the persona is locked. */
  unwrap(persona: string, envelope: Uint8Array): Uint8Array | null;
}

const DEFAULT_PERSONA_CIPHER: PersonaCipher = {
  wrap: (persona, pt) => wrapWithPersonaDEK(persona, pt),
  unwrap: (persona, ct) => unwrapWithPersonaDEK(persona, ct),
};

export interface PutPayloadInput {
  payloadId: string;
  runId: string;
  persona: string;
  plaintext: Uint8Array;
}

export interface PayloadRef {
  payload_id: string;
  /** Content hash of the ciphertext blob (content-addressed). */
  content_id: string;
}

export interface PayloadStoreOptions {
  db: DatabaseAdapter;
  erasureStore?: ErasureKeyStore;
  personaCipher?: PersonaCipher;
  nowMsFn?: () => number;
}

export class PayloadStore {
  private readonly db: DatabaseAdapter;
  private readonly cipher: PersonaCipher;
  private readonly now: () => number;
  private readonly explicitErasure?: ErasureKeyStore;

  constructor(opts: PayloadStoreOptions) {
    this.db = opts.db;
    this.explicitErasure = opts.erasureStore;
    this.cipher = opts.personaCipher ?? DEFAULT_PERSONA_CIPHER;
    this.now = opts.nowMsFn ?? (() => Date.now());
  }

  private erasure(): ErasureKeyStore {
    const s = this.explicitErasure ?? getErasureKeyStore();
    if (s === null || s === undefined) {
      throw new Error('PayloadStore: no ErasureKeyStore wired');
    }
    return s;
  }

  /**
   * Envelope-encrypt + persist a payload. Persona must be OPEN (its DEK in RAM);
   * a locked persona throws `PersonaLockedError` (the locked-arrival path is
   * ISVC-6). Ordering (§13): write the external leaf erasure key first, then the
   * Tier-0 registry (prepared → published CAS) as the sole commit.
   */
  putPayload(input: PutPayloadInput): PayloadRef {
    const kP = generateAeadKey();
    const kE = generateAeadKey();

    const blob = aeadEncrypt(kP, input.plaintext);
    const contentId = bytesToHex(sha256(blob));

    const conf = this.cipher.wrap(input.persona, kP);
    if (conf === null) throw new PersonaLockedError(input.persona);
    const wrappedKey = aeadEncrypt(kE, conf);

    const ts = this.now();
    // External leaf key first (not part of the SQLite commit, §13).
    this.erasure().put(input.payloadId, kE);

    // Tier-0 registry: pin `prepared`, then publish CAS. Both mutate the
    // registry row, so orphan-GC's delete-claim serializes against the publish.
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO run_payload_blobs
           (payload_id, run_id, persona, content_id, blob, wrapped_key, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?)`,
        [input.payloadId, input.runId, input.persona, contentId, blob, wrappedKey, ts, ts],
      );
      const published = this.db.run(
        "UPDATE run_payload_blobs SET state = 'published', updated_at = ? WHERE payload_id = ? AND state = 'prepared'",
        [ts, input.payloadId],
      );
      if (published === 0) {
        throw new Error('PayloadStore: publish CAS failed unexpectedly');
      }
    });

    return { payload_id: input.payloadId, content_id: contentId };
  }

  /**
   * Decrypt a published payload. Returns null when the payload was crypto-shredded
   * (leaf key gone), when the persona is locked (confidentiality wrap
   * unrecoverable — "sealed"), or when the blob is not in a decryptable
   * (`published`) state. Throws only on a genuinely corrupt/tampered envelope.
   */
  getPayload(payloadId: string, persona: string): Uint8Array | null {
    const rows = this.db.query<{ blob: Uint8Array; wrapped_key: Uint8Array; state: string }>(
      'SELECT blob, wrapped_key, state FROM run_payload_blobs WHERE payload_id = ? LIMIT 1',
      [payloadId],
    );
    const row = rows[0];
    if (row === undefined || row.state !== 'published') return null;

    // Crypto-shred: the leaf erasure key is gone ⇒ undecryptable even with the
    // persona DEK and a restored blob row.
    const kE = this.erasure().get(payloadId);
    if (kE === null) return null;

    const wrappedKey = row.wrapped_key instanceof Uint8Array ? row.wrapped_key : new Uint8Array(row.wrapped_key);
    const blob = row.blob instanceof Uint8Array ? row.blob : new Uint8Array(row.blob);

    const conf = aeadDecrypt(kE, wrappedKey);
    const kP = this.cipher.unwrap(persona, conf);
    if (kP === null) return null; // persona locked → sealed
    return aeadDecrypt(kP, blob);
  }

  /** Read-only inspection of the blob's registry state (tests + GC). */
  blobState(payloadId: string): BlobState | null {
    const rows = this.db.query<{ state: string }>(
      'SELECT state FROM run_payload_blobs WHERE payload_id = ? LIMIT 1',
      [payloadId],
    );
    const s = rows[0]?.state;
    return s === undefined ? null : (s as BlobState);
  }

  /** Content id of a published/prepared blob, or null if absent (used by the
   *  locked-arrival unlock recovery to no-op idempotently). */
  contentId(payloadId: string): string | null {
    const rows = this.db.query<{ content_id: string }>(
      'SELECT content_id FROM run_payload_blobs WHERE payload_id = ? LIMIT 1',
      [payloadId],
    );
    return rows[0]?.content_id === undefined ? null : String(rows[0].content_id);
  }

  /**
   * Crypto-shred a payload (§13): destroy its per-payload leaf erasure key. The
   * ciphertext blob + wrapped-key row REMAIN (now inert) — deleting the Tier-0
   * row is NOT the guarantee; destroying the leaf key is. Idempotent. Per-payload
   * isolation: shredding one payload never touches any other. Physical GC of the
   * now-inert blob follows via {@link gcPayload}.
   */
  shredPayload(payloadId: string): void {
    this.erasure().destroy(payloadId);
  }

  /**
   * Mark a never-published `prepared` pin as `abandoned` (the prepared-lease
   * sweep for a crash between pin and publish). Only affects `prepared` rows.
   */
  abandonPrepared(payloadId: string): boolean {
    return (
      this.db.run(
        "UPDATE run_payload_blobs SET state = 'abandoned', updated_at = ? WHERE payload_id = ? AND state = 'prepared'",
        [this.now(), payloadId],
      ) > 0
    );
  }

  /**
   * Physical GC of an inert blob (§13). Deletes the registry row + any residual
   * leaf key ONLY when the blob is safe to reclaim: an `abandoned` pin, or a
   * `published` blob that has already been crypto-shredded (leaf key gone). A
   * live `published` blob (leaf key still present) and a `prepared` pin
   * mid-publish are NEVER deleted — so GC and publish never race.
   *
   * (The reachability recheck across reservation/lifecycle/receipt references is
   * layered on when those reference sources exist — ISVC-3/4/5/6.)
   */
  gcPayload(payloadId: string): boolean {
    const state = this.blobState(payloadId);
    if (state === null) return false;
    if (state === 'prepared') return false; // mid-publish — never GC
    if (state === 'published' && this.erasure().has(payloadId)) return false; // live payload

    // abandoned, or published-but-shredded → reclaim.
    this.db.transaction(() => {
      this.db.run('DELETE FROM run_payload_blobs WHERE payload_id = ?', [payloadId]);
    });
    this.erasure().destroy(payloadId);
    return true;
  }
}
