/**
 * The backup store's client (USER_BACKUP.md §4.3).
 *
 *   PUT    /v1/backups/{backup_id}/{counter}  — one sealed copy; refused if held
 *   GET    /v1/backups/{backup_id}/list       — `{ copies: [{ counter, size, stored_at }] }`
 *   GET    /v1/backups/{backup_id}/{counter}  — the copy's bytes (`latest` for the newest)
 *   DELETE /v1/backups/{backup_id}            — every copy
 *
 * Every call is signed with the backup signing key, over Core's canonical
 * string (`@dina/protocol` `buildCanonicalPayload`), with the public key in
 * `X-Backup-Key` where Core's calls carry `X-DID`. The store checks that the
 * key hashes to the `backup_id` in the path, so only the holder of the 24
 * words can read, write or delete these copies, and the store never resolves
 * a DID.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { buildCanonicalPayload } from '../auth/canonical';
import { toRFC3339 } from '../auth/timestamp';
import { sign } from '../crypto/ed25519';

import type { BackupIdentity } from './keys';

export const BACKUP_KEY_HEADER = 'X-Backup-Key';

export interface StoredCopy {
  counter: number;
  size: number;
  storedAt: number;
}

export type BackupFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

export class BackupStoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BackupStoreError';
  }
}

/** The four headers a store call carries. Exported for the store's contract test. */
export function signBackupRequest(
  identity: BackupIdentity,
  method: string,
  path: string,
  query: string,
  body: Uint8Array,
  now: Date = new Date(),
): Record<string, string> {
  const timestamp = toRFC3339(now);
  const nonce = bytesToHex(randomBytes(16));
  const canonical = buildCanonicalPayload(method, path, query, timestamp, nonce, body);
  return {
    [BACKUP_KEY_HEADER]: bytesToHex(identity.publicKey),
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': bytesToHex(sign(identity.signSeed, new TextEncoder().encode(canonical))),
  };
}

export class BackupStoreClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly identity: BackupIdentity,
    private readonly fetchFn: BackupFetch = globalThis.fetch as unknown as BackupFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async call(
    method: string,
    suffix: string,
    body: Uint8Array = new Uint8Array(),
  ): Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }> {
    const path = `/v1/backups/${this.identity.backupId}${suffix}`;
    const headers = signBackupRequest(this.identity, method, path, '', body, new Date(this.now()));
    if (method === 'PUT') headers['Content-Type'] = 'application/octet-stream';
    return this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(method === 'PUT' ? { body } : {}),
    });
  }

  private async fail(res: { status: number; text(): Promise<string> }, what: string): Promise<never> {
    let reason = '';
    try {
      const parsed = JSON.parse(await res.text()) as { error?: unknown };
      if (typeof parsed.error === 'string') reason = `: ${parsed.error}`;
    } catch {
      // no JSON error body
    }
    throw new BackupStoreError(`backup store ${what} failed (${res.status})${reason}`, res.status);
  }

  /** Oldest first. Empty when the store holds nothing for this id. */
  async list(): Promise<StoredCopy[]> {
    const res = await this.call('GET', '/list');
    if (res.status !== 200) return this.fail(res, 'list');
    const parsed = JSON.parse(await res.text()) as {
      copies?: { counter: number; size: number; stored_at: number }[];
    };
    return (parsed.copies ?? [])
      .map((c) => ({ counter: c.counter, size: c.size, storedAt: c.stored_at }))
      .sort((a, b) => a.counter - b.counter);
  }

  /** Throws `BackupStoreError` 409 when the store already holds this counter. */
  async put(counter: number, sealed: Uint8Array): Promise<void> {
    const res = await this.call('PUT', `/${counter}`, sealed);
    if (res.status !== 201) return this.fail(res, 'put');
  }

  /** The copy's bytes, or null when the store holds no such copy. */
  async get(counter: number | 'latest'): Promise<Uint8Array | null> {
    const res = await this.call('GET', `/${counter}`);
    if (res.status === 404) return null;
    if (res.status !== 200) return this.fail(res, 'get');
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Every copy under this id. True when the store held any. */
  async deleteAll(): Promise<boolean> {
    const res = await this.call('DELETE', '');
    if (res.status !== 200) return this.fail(res, 'delete');
    return (JSON.parse(await res.text()) as { removed?: number }).removed !== 0;
  }
}
