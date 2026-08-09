/**
 * Managed storage and export (§17.2, WS-8.3).
 *
 * A hosted tenant's data sits on the vendor's disks. §17.2 lists the encrypted
 * backup service among the components that may be SHARED, and then constrains
 * it in the same breath: shared components "never receive a reusable tenant
 * master key or unscoped database handle".
 *
 * So this stores CIPHERTEXT it cannot read, keyed by tenant, and hands it back
 * on request. The encryption happens in the tenant's own cell, which is the
 * only place its key exists; this layer sees opaque bytes and a digest.
 *
 * WHY THERE IS NO `decrypt` HERE, NOT EVEN AN INJECTED ONE. A hook the vendor
 * could populate is a key the vendor holds. The tenant's export is decrypted
 * by the tenant, with the recovery phrase they already have — the same
 * material that opens their vault. That is what makes "tenant-owned" a fact
 * about the system rather than a promise about behaviour.
 *
 * WHAT IT DOES ENFORCE: that a blob comes back byte-identical, that it is
 * returned only to the tenant it belongs to, and that a corrupted blob is
 * refused rather than handed over as if it were the backup.
 */

import { sha256 } from '@noble/hashes/sha2.js';

/** One stored, tenant-encrypted object. */
export interface ManagedBlob {
  tenantId: string;
  /** Tenant-chosen name — a vault archive, a catalog snapshot. */
  name: string;
  /** Opaque ciphertext. This package never interprets it. */
  ciphertext: Uint8Array;
  /** SHA-256 of the ciphertext, checked on every read. */
  digest: string;
  storedAtMs: number;
}

export type StoreRefusal =
  /** Asked for another tenant's object. */
  | 'not_your_object'
  | 'not_found'
  /** Stored bytes no longer hash to their recorded digest. */
  | 'corrupt';

export type StoreOutcome<T> = { ok: true; value: T } | { ok: false; refusal: StoreRefusal };

function digestOf(bytes: Uint8Array): string {
  return Array.from(sha256(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export class ManagedBlobStore {
  private readonly blobs = new Map<string, ManagedBlob>();

  constructor(private readonly now: () => number) {}

  private key(tenantId: string, name: string): string {
    return `${tenantId} ${name}`;
  }

  /**
   * Store tenant ciphertext.
   *
   * The digest is computed HERE, over the bytes actually received, rather than
   * accepted from the caller. A caller-supplied digest would make the
   * corruption check circular: a truncated upload would arrive with a digest
   * matching the truncation.
   *
   * The bytes are COPIED. A caller that reuses its buffer would otherwise
   * mutate stored data after the fact, and the digest check would then report
   * corruption for a store that did nothing wrong.
   */
  put(tenantId: string, name: string, ciphertext: Uint8Array): ManagedBlob {
    const blob: ManagedBlob = {
      tenantId,
      name,
      ciphertext: Uint8Array.from(ciphertext),
      digest: digestOf(ciphertext),
      storedAtMs: this.now(),
    };
    this.blobs.set(this.key(tenantId, name), blob);
    return blob;
  }

  /**
   * Read an object back, for the tenant that owns it.
   *
   * `tenantId` is required and compared — there is no "get by name" that could
   * be called without it. The distinction between `not_found` and
   * `not_your_object` is deliberate and safe here: the caller has already been
   * authenticated as a tenant by the control plane, so telling them an object
   * of that name exists elsewhere reveals nothing they could act on, and
   * collapsing the two would leave an operator unable to tell a missing backup
   * from a misrouted one.
   */
  get(tenantId: string, name: string): StoreOutcome<ManagedBlob> {
    const blob = this.blobs.get(this.key(tenantId, name));
    if (blob === undefined) return { ok: false, refusal: 'not_found' };
    if (blob.tenantId !== tenantId) return { ok: false, refusal: 'not_your_object' };
    if (digestOf(blob.ciphertext) !== blob.digest) {
      // REFUSED, not returned with a warning. A backup that has changed under
      // us is exactly the object a tenant would restore from without looking.
      return { ok: false, refusal: 'corrupt' };
    }
    return { ok: true, value: blob };
  }

  /**
   * Everything this tenant owns — the export manifest (§17.2 "tenant-owned,
   * exportable"). Names and digests only: an export listing is not a bulk read.
   */
  list(tenantId: string): { name: string; digest: string; storedAtMs: number }[] {
    return [...this.blobs.values()]
      .filter((b) => b.tenantId === tenantId)
      .map((b) => ({ name: b.name, digest: b.digest, storedAtMs: b.storedAtMs }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Delete one tenant's object. Returns false when there was nothing to
   * delete, so a caller can tell a deletion from a no-op.
   */
  delete(tenantId: string, name: string): boolean {
    return this.blobs.delete(this.key(tenantId, name));
  }
}
