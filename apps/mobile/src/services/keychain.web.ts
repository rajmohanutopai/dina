/**
 * Web peer for `keychain.ts` — IndexedDB-backed secret store with
 * WebCrypto AES-GCM-at-rest encryption.
 *
 * API parity with `react-native-keychain`'s
 * `getGenericPassword`/`setGenericPassword`/`resetGenericPassword`
 * triple. Call sites import from `'./services/keychain'` and Metro
 * resolves THIS file on the web target — same source on iOS / Android
 * never sees a `.web.ts` peer.
 *
 * ## Threat model
 *
 * The browser's "trust boundary" is the user's logged-in session.
 * Anyone with code-execution on the same origin reads IndexedDB
 * freely; that's a browser, not an OS-keychain. We mitigate the
 * resting-state risk by encrypting every value with AES-GCM under
 * a non-extractable WebCrypto key. Even an attacker who exfiltrates
 * the raw IndexedDB rows cannot decrypt them without the unwrap key
 * — and that key is derived per-origin at first install and never
 * leaves the WebCrypto subsystem.
 *
 * Explicitly out of scope for this peer:
 *   - Hardware-backed isolation (no equivalent of Secure Enclave /
 *     StrongBox on the web). Documented in
 *     `apps/home-node-lite/web/SECURITY.md`.
 *   - Cross-device sync (operator boots fresh per device by design).
 *   - Biometric prompts (`react-native-keychain` accessControl /
 *     authenticationPrompt are silently ignored — UI surfaces the
 *     passphrase modal instead).
 *
 * ## Storage layout
 *
 *   IndexedDB database:  `dina-keychain`        (version 1)
 *   Object store:        `entries`              (keyPath: `service`)
 *   Record shape: { service: string, username: string, payload: Uint8Array }
 *
 *   Wrap key:  stored UN-encrypted in the same DB under the reserved
 *              `service === '__dina_wrap_key__'` row. Held as a
 *              non-extractable CryptoKey (`raw` form not surfaceable).
 *              IndexedDB persists CryptoKey objects via structured
 *              clone; the key itself stays inside the WebCrypto
 *              opaque store.
 *
 * Source: docs/HOME_NODE_LITE_WEB_UI_TASKS.md Phase 2 "Storage shim".
 */

// ---------------------------------------------------------------------------
// React-native-keychain type parity. We declare local copies (not
// imports) so this file is COMPLETELY decoupled from the native
// module — a web bundle never even tries to resolve the native types.
// ---------------------------------------------------------------------------

export interface BaseOptions {
  service?: string;
  // The native module accepts many more fields here; we accept and
  // ignore them so existing call sites compile unchanged.
  [extra: string]: unknown;
}

export type GetOptions = BaseOptions;
export type SetOptions = BaseOptions;

export interface Result {
  service: string;
  storage: 'IndexedDB';
}

export interface UserCredentials extends Result {
  username: string;
  password: string;
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing.
// ---------------------------------------------------------------------------

const DB_NAME = 'dina-keychain';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const WRAP_KEY_SERVICE = '__dina_wrap_key__';
const DEFAULT_SERVICE = 'dina';

let cachedDb: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (cachedDb !== null) return Promise.resolve(cachedDb);
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'service' });
      }
    };
    req.onsuccess = () => {
      cachedDb = req.result;
      // If the connection version-changes underneath us (another tab
      // opening with a newer schema), drop the cache so future calls
      // re-open. Without this the stale connection would silently
      // reject every transaction.
      cachedDb.onversionchange = () => {
        cachedDb?.close();
        cachedDb = null;
      };
      resolve(cachedDb);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

// ---------------------------------------------------------------------------
// WebCrypto wrap-key bootstrapping.
// ---------------------------------------------------------------------------

interface WrapKeyRow {
  service: typeof WRAP_KEY_SERVICE;
  key: CryptoKey;
}

async function loadOrCreateWrapKey(db: IDBDatabase): Promise<CryptoKey> {
  // Try to read the existing key first. AES-GCM keys are structured-
  // cloneable into IndexedDB, so the CryptoKey survives a round-trip
  // even though the raw bytes never leak.
  const existing = (await awaitRequest(tx(db, 'readonly').get(WRAP_KEY_SERVICE))) as
    | WrapKeyRow
    | undefined;
  if (existing !== undefined && existing.key instanceof CryptoKey) {
    return existing.key;
  }
  const fresh = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
  await awaitRequest(
    tx(db, 'readwrite').put({ service: WRAP_KEY_SERVICE, key: fresh } satisfies WrapKeyRow),
  );
  return fresh;
}

// ---------------------------------------------------------------------------
// AES-GCM encrypt / decrypt helpers.
// ---------------------------------------------------------------------------

interface EncryptedPayload {
  /** 12-byte AES-GCM nonce. */
  iv: Uint8Array;
  /** Ciphertext + 16-byte GCM auth tag. */
  ct: Uint8Array;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

async function encryptString(key: CryptoKey, plaintext: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, TEXT_ENCODER.encode(plaintext)),
  );
  return { iv, ct };
}

async function decryptString(key: CryptoKey, payload: EncryptedPayload): Promise<string> {
  // The IndexedDB round-trip widens `payload.{iv,ct}` to
  // `Uint8Array<ArrayBufferLike>` (because structured clone could in
  // principle hand back a SharedArrayBuffer-backed view). WebCrypto's
  // current lib types only accept plain `ArrayBuffer`. Copy into fresh
  // buffers so the types narrow back to a concrete `BufferSource`.
  const iv = new Uint8Array(payload.iv);
  const ct = new Uint8Array(payload.ct);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return TEXT_DECODER.decode(plain);
}

// ---------------------------------------------------------------------------
// Stored row shape.
// ---------------------------------------------------------------------------

interface EntryRow {
  service: string;
  username: string;
  iv: Uint8Array;
  ct: Uint8Array;
}

function resolveService(opts: BaseOptions | undefined): string {
  const raw = opts?.service;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return DEFAULT_SERVICE;
}

// ---------------------------------------------------------------------------
// Public API — mirrors react-native-keychain's surface.
// ---------------------------------------------------------------------------

export async function setGenericPassword(
  username: string,
  password: string,
  options?: SetOptions,
): Promise<Result> {
  const service = resolveService(options);
  const db = await openDB();
  const key = await loadOrCreateWrapKey(db);
  const { iv, ct } = await encryptString(key, password);
  const row: EntryRow = { service, username, iv, ct };
  await awaitRequest(tx(db, 'readwrite').put(row));
  return { service, storage: 'IndexedDB' };
}

export async function getGenericPassword(options?: GetOptions): Promise<false | UserCredentials> {
  const service = resolveService(options);
  const db = await openDB();
  const existing = (await awaitRequest(tx(db, 'readonly').get(service))) as EntryRow | undefined;
  if (existing === undefined) return false;
  const key = await loadOrCreateWrapKey(db);
  const password = await decryptString(key, { iv: existing.iv, ct: existing.ct });
  return {
    service,
    storage: 'IndexedDB',
    username: existing.username,
    password,
  };
}

export async function resetGenericPassword(options?: BaseOptions): Promise<boolean> {
  const service = resolveService(options);
  const db = await openDB();
  await awaitRequest(tx(db, 'readwrite').delete(service));
  return true;
}

// ---------------------------------------------------------------------------
// Internal test hook — purge everything (wrap key + all entries) so
// the dual-mode jest spec starts from a clean slate. Mobile callers
// never reach this; native keychain has its own per-service reset.
// ---------------------------------------------------------------------------

export async function __dangerouslyResetForTests(): Promise<void> {
  if (cachedDb !== null) {
    cachedDb.close();
    cachedDb = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('IndexedDB delete failed'));
    req.onblocked = () => reject(new Error('IndexedDB delete blocked'));
  });
}
