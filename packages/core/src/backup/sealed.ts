/**
 * The sealed backup copy (USER_BACKUP.md §4.2): the `.dina` archive payload,
 * sealed under the backup key in place of a passphrase.
 *
 * Wire format:
 *
 *   "DINA" (4) | 0x02 (1) | AES-256-GCM(backup_key, inner, aad = the 5 bytes before)
 *   inner = meta_len (4, LE) | meta (canonical JSON) | signature (64) | payload (archive JSON)
 *
 * Version 2 sits beside the passphrase archive's version 1, so a `.dina` file
 * says which door opens it. The signature, by the backup signing key, covers
 * the meta, and the meta names the payload by its SHA-256; the meta carries
 * the DID and handle, so a new phone can finish recovery without the owner
 * typing their handle (§4.5), and the counter the store names the copy by.
 *
 * The store sees only these bytes. It can hold copies back, never forge one.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalJson } from '@dina/protocol';

import { DINA_FILE_MAGIC } from '../constants';
import { aeadDecrypt, aeadEncrypt } from '../crypto/aead';
import { sign, verify } from '../crypto/ed25519';
import {
  decodeArchivePayload,
  encodeArchivePayload,
  type ArchivePayloadV1,
} from '../export/archive';

import type { BackupIdentity } from './keys';

export const SEALED_BACKUP_VERSION = 2;
const SIGN_DOMAIN = 'dina:backup:copy:v1\n';
const SIG_BYTES = 64;
/** A meta is a few hundred bytes; this bounds a crafted length field. */
const META_MAX_BYTES = 16 * 1024;

export interface BackupCopyMeta {
  v: 1;
  backup_id: string;
  did: string;
  handle: string;
  /** Goes only up; the store names the copy by it (§4.2). */
  counter: number;
  created_at: number;
  /** Vault items across every persona, shown before a restore (§4.5). */
  item_count: number;
  payload_sha256: string;
}

export interface OpenedBackup {
  meta: BackupCopyMeta;
  payload: ArchivePayloadV1;
}

export class BackupSealError extends Error {
  constructor(message: string) {
    super(`backup: ${message}`);
    this.name = 'BackupSealError';
  }
}

export function countVaultItems(payload: ArchivePayloadV1): number {
  return payload.personas.reduce((n, p) => n + (p.tables.vault_items?.length ?? 0), 0);
}

function header(): Uint8Array {
  const h = new Uint8Array(5);
  h.set(DINA_FILE_MAGIC, 0);
  h[4] = SEALED_BACKUP_VERSION;
  return h;
}

function signedBytes(meta: BackupCopyMeta): Uint8Array {
  return new TextEncoder().encode(SIGN_DOMAIN + canonicalJson(meta));
}

/** True when `bytes` is a sealed backup copy rather than a passphrase archive. */
export function isSealedBackup(bytes: Uint8Array): boolean {
  const h = header();
  return bytes.length > h.length && h.every((b, i) => bytes[i] === b);
}

export function sealBackup(
  payload: ArchivePayloadV1,
  identity: BackupIdentity,
  info: { did: string; handle: string; counter: number; createdAt: number },
): Uint8Array {
  if (!Number.isSafeInteger(info.counter) || info.counter < 1) {
    throw new BackupSealError('counter must be a positive integer');
  }
  const payloadBytes = encodeArchivePayload(payload);
  const meta: BackupCopyMeta = {
    v: 1,
    backup_id: identity.backupId,
    did: info.did,
    handle: info.handle,
    counter: info.counter,
    created_at: info.createdAt,
    item_count: countVaultItems(payload),
    payload_sha256: bytesToHex(sha256(payloadBytes)),
  };
  const metaBytes = new TextEncoder().encode(canonicalJson(meta));
  const sig = sign(identity.signSeed, signedBytes(meta));
  const inner = new Uint8Array(4 + metaBytes.length + SIG_BYTES + payloadBytes.length);
  new DataView(inner.buffer).setUint32(0, metaBytes.length, true);
  inner.set(metaBytes, 4);
  inner.set(sig, 4 + metaBytes.length);
  inner.set(payloadBytes, 4 + metaBytes.length + SIG_BYTES);

  const h = header();
  const sealed = aeadEncrypt(identity.key, inner, h);
  const out = new Uint8Array(h.length + sealed.length);
  out.set(h, 0);
  out.set(sealed, h.length);
  return out;
}

function parseMeta(bytes: Uint8Array): BackupCopyMeta {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    throw new BackupSealError('meta is not JSON');
  }
  const str = (k: string): string => {
    if (typeof m[k] !== 'string') throw new BackupSealError(`meta.${k} missing`);
    return m[k] as string;
  };
  const int = (k: string): number => {
    if (!Number.isSafeInteger(m[k]) || (m[k] as number) < 0) {
      throw new BackupSealError(`meta.${k} missing`);
    }
    return m[k] as number;
  };
  if (m.v !== 1) throw new BackupSealError('unknown meta version');
  return {
    v: 1,
    backup_id: str('backup_id'),
    did: str('did'),
    handle: str('handle'),
    counter: int('counter'),
    created_at: int('created_at'),
    item_count: int('item_count'),
    payload_sha256: str('payload_sha256'),
  };
}

/**
 * Open a copy: the key, the signature, the backup id and the payload digest
 * must all agree, or it throws. Returns the payload unchecked otherwise: the
 * import (`importArchivePayload`) runs the archive's own checks.
 */
export function openBackup(bytes: Uint8Array, identity: BackupIdentity): OpenedBackup {
  if (!isSealedBackup(bytes)) throw new BackupSealError('not a sealed backup copy');
  const h = header();
  let inner: Uint8Array;
  try {
    inner = aeadDecrypt(identity.key, bytes.subarray(h.length), h);
  } catch {
    throw new BackupSealError('cannot open: wrong recovery phrase or damaged copy');
  }
  if (inner.length < 4) throw new BackupSealError('truncated copy');
  const metaLen = new DataView(inner.buffer, inner.byteOffset, inner.byteLength).getUint32(0, true);
  if (metaLen > META_MAX_BYTES || 4 + metaLen + SIG_BYTES > inner.length) {
    throw new BackupSealError('truncated copy');
  }
  const meta = parseMeta(inner.subarray(4, 4 + metaLen));
  const sig = inner.subarray(4 + metaLen, 4 + metaLen + SIG_BYTES);
  const payloadBytes = inner.subarray(4 + metaLen + SIG_BYTES);
  if (!verify(identity.publicKey, signedBytes(meta), sig)) {
    throw new BackupSealError('signature does not verify');
  }
  if (meta.backup_id !== identity.backupId) {
    throw new BackupSealError('copy belongs to another backup id');
  }
  if (bytesToHex(sha256(payloadBytes)) !== meta.payload_sha256) {
    throw new BackupSealError('payload does not match its digest');
  }
  return { meta, payload: decodeArchivePayload(payloadBytes) };
}
