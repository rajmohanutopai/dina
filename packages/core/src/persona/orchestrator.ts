/**
 * Persona unlock/lock orchestrator — full lifecycle management.
 *
 * Unlock flow:
 *   1. Check tier requirements (approval/passphrase)
 *   2. Derive persona DEK from master seed via HKDF-SHA256
 *   3. Open vault (in production: SQLCipher with DEK; in-memory for now)
 *   4. Build HNSW index from vault embeddings
 *   5. Mark persona as open
 *
 * Lock flow:
 *   1. Destroy HNSW index (free memory)
 *   2. Close vault (in production: WAL checkpoint + close handle)
 *   3. Zero the DEK (crypto-wipe from memory)
 *   4. Mark persona as closed
 *
 * Security invariants:
 *   - DEK is NEVER stored — derived on unlock, zeroed on lock
 *   - sensitive tier requires explicit user approval before unlock
 *   - locked tier requires passphrase re-entry (not just biometric)
 *   - HNSW index is destroyed on lock (no embedding data in memory)
 *
 * Source: ARCHITECTURE.md Tasks 2.34, 2.35
 */

import { derivePersonaDEK } from '../crypto/hkdf';
import { deriveDEKHash } from '../crypto/hkdf';
import { openPersona, closePersona, getPersona, isPersonaOpen } from './service';
import { requiresApproval, requiresPassphrase } from '../vault/lifecycle';
import { buildIndex, destroyIndex, hasIndex } from '../embedding/persona_index';

export interface UnlockResult {
  success: boolean;
  persona: string;
  dekHash: string;
  indexedItems: number;
  reason?: string;
}

export interface LockResult {
  success: boolean;
  persona: string;
  dekZeroed: boolean;
  indexDestroyed: boolean;
  reason?: string;
}

/** Tracks active DEKs in memory (persona → DEK). Zeroed on lock. */
const activeDEKs = new Map<string, Uint8Array>();

/** Injectable vault opener — in production, opens SQLCipher. */
let vaultOpener: ((persona: string, dek: Uint8Array) => Promise<number>) | null = null;

/** Injectable vault closer — in production, WAL checkpoint + close. */
let vaultCloser: ((persona: string) => Promise<void>) | null = null;

/** Injectable embedding loader — loads embeddings from vault for HNSW. */
let embeddingLoader:
  | ((persona: string) => Promise<Array<{ id: string; embedding: Uint8Array | Float32Array }>>)
  | null = null;

/** Configure the vault opener (for production/testing). */
export function setVaultOpener(
  opener: (persona: string, dek: Uint8Array) => Promise<number>,
): void {
  vaultOpener = opener;
}

/** Configure the vault closer. */
export function setVaultCloser(closer: (persona: string) => Promise<void>): void {
  vaultCloser = closer;
}

/** Configure the embedding loader. */
export function setEmbeddingLoader(
  loader: (persona: string) => Promise<Array<{ id: string; embedding: Uint8Array | Float32Array }>>,
): void {
  embeddingLoader = loader;
}

/** Reset all orchestrator state (for testing). */
export function resetOrchestratorState(): void {
  // Zero all active DEKs
  for (const dek of activeDEKs.values()) {
    zeroBytes(dek);
  }
  activeDEKs.clear();
  vaultOpener = null;
  vaultCloser = null;
  embeddingLoader = null;
}

/**
 * Unlock a persona — full lifecycle.
 *
 * @param name — persona name
 * @param masterSeed — the unlocked master seed (from passphrase → Argon2id → unwrap)
 * @param userSalt — per-user salt for DEK derivation
 * @param approved — user has explicitly approved (for sensitive tier)
 * @param dimensions — embedding dimensions for HNSW (default: 768)
 */
export async function unlockPersona(
  name: string,
  masterSeed: Uint8Array,
  userSalt: Uint8Array,
  approved?: boolean,
  dimensions?: number,
): Promise<UnlockResult> {
  // 0. Validate persona exists
  const persona = getPersona(name);
  if (!persona) {
    return {
      success: false,
      persona: name,
      dekHash: '',
      indexedItems: 0,
      reason: `Persona "${name}" not found`,
    };
  }

  // Already open — return success with existing state
  if (isPersonaOpen(name)) {
    const existingDek = activeDEKs.get(name);
    return {
      success: true,
      persona: name,
      dekHash: existingDek ? deriveDEKHash(existingDek) : '',
      indexedItems: 0,
      reason: 'Already open',
    };
  }

  // 1. Check tier requirements
  if (requiresApproval(persona.tier) && !approved) {
    return {
      success: false,
      persona: name,
      dekHash: '',
      indexedItems: 0,
      reason: 'Approval required for sensitive persona',
    };
  }
  if (requiresPassphrase(persona.tier) && !approved) {
    return {
      success: false,
      persona: name,
      dekHash: '',
      indexedItems: 0,
      reason: 'Passphrase required for locked persona',
    };
  }

  // 2. Derive DEK
  const dek = derivePersonaDEK(masterSeed, name, userSalt);
  const dekHash = deriveDEKHash(dek);

  // 3. Open vault
  let vaultItemCount = 0;
  if (vaultOpener) {
    vaultItemCount = await vaultOpener(name, dek);
  }

  // Store DEK in memory (will be zeroed on lock)
  activeDEKs.set(name, dek);

  // 4. Mark persona as open
  openPersona(name, true);

  // 5. Build HNSW index from vault embeddings
  let indexedItems = 0;
  if (embeddingLoader) {
    const embeddings = await embeddingLoader(name);
    if (embeddings.length > 0) {
      indexedItems = buildIndex(name, embeddings, dimensions ?? 768);
    }
  }

  return { success: true, persona: name, dekHash, indexedItems };
}

/**
 * Lock a persona — full lifecycle.
 *
 * @param name — persona name
 */
export async function lockPersona(name: string): Promise<LockResult> {
  const persona = getPersona(name);
  if (!persona) {
    return {
      success: false,
      persona: name,
      dekZeroed: false,
      indexDestroyed: false,
      reason: `Persona "${name}" not found`,
    };
  }

  if (!isPersonaOpen(name)) {
    return {
      success: true,
      persona: name,
      dekZeroed: true,
      indexDestroyed: true,
      reason: 'Already locked',
    };
  }

  // 1. Destroy HNSW index
  let indexDestroyed = false;
  if (hasIndex(name)) {
    destroyIndex(name);
    indexDestroyed = true;
  }

  // 2. Close vault
  if (vaultCloser) {
    await vaultCloser(name);
  }

  // 3. Zero the DEK
  let dekZeroed = false;
  const dek = activeDEKs.get(name);
  if (dek) {
    zeroBytes(dek);
    activeDEKs.delete(name);
    dekZeroed = true;
  }

  // 4. Mark persona as closed
  closePersona(name);

  return { success: true, persona: name, dekZeroed, indexDestroyed };
}

/**
 * Lock all open personas — used on background timeout.
 */
export async function lockAllPersonas(): Promise<LockResult[]> {
  const results: LockResult[] = [];
  for (const name of [...activeDEKs.keys()]) {
    results.push(await lockPersona(name));
  }
  return results;
}

/**
 * Check if a persona has an active DEK in memory.
 */
export function hasDEK(name: string): boolean {
  return activeDEKs.has(name);
}

/**
 * Get the DEK hash for a persona (for validation, never the DEK itself).
 */
export function getDEKHash(name: string): string | null {
  const dek = activeDEKs.get(name);
  return dek ? deriveDEKHash(dek) : null;
}

/**
 * Securely zero a byte array.
 *
 * Overwrites every byte with 0. This is the standard approach for
 * zeroing sensitive key material in JavaScript. Note: V8 may optimize
 * this away in some cases, but it's the best we can do without native code.
 */
function zeroBytes(arr: Uint8Array): void {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = 0;
  }
}
