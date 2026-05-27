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

/**
 * Web stub of react-native-keychain's `ACCESSIBLE` enum. The web shim IGNORES
 * the `accessible` option — a browser's IndexedDB has no OS-keychain
 * accessibility class (see the threat-model note above) — but the export must
 * resolve so native call sites (`Keychain.ACCESSIBLE.*`) compile identically
 * on the web target. Values mirror the native enum's raw strings.
 */
export const ACCESSIBLE = {
  WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
  AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
  ALWAYS: 'AccessibleAlways',
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly',
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly',
  ALWAYS_THIS_DEVICE_ONLY: 'AccessibleAlwaysThisDeviceOnly',
} as const;

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
/**
 * Single-flight handle for the open request. Same rationale as
 * `wrapKeyPromise`: if `setGenericPassword(...)` fires from a
 * `Promise.all([...])` while the cache is cold, every call enters
 * `openDB()` synchronously, observes `cachedDb === null`, and starts
 * its OWN `indexedDB.open(...)`. That leaks N–1 orphan connections
 * that prevent any future `deleteDatabase` from completing (it stays
 * blocked until every connection closes).
 */
let openDbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (cachedDb !== null) return Promise.resolve(cachedDb);
  if (openDbPromise !== null) return openDbPromise;
  openDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
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
        openDbPromise = null;
      };
      resolve(cachedDb);
    };
    req.onerror = () => {
      openDbPromise = null;
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
  });
  return openDbPromise;
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

/**
 * Single-flight cache for the wrap key. Caching a `Promise<CryptoKey>`
 * (not the resolved value) is what defeats the concurrent-write race:
 * the FIRST caller starts the read-or-generate flow, every subsequent
 * caller awaits the same promise.
 *
 * Why this matters: `infra_setup.tsx` fires
 * `Promise.all([savePdsUrl, saveAppViewURL])` on the Continue press.
 * Without single-flighting, both calls reach `loadOrCreateWrapKey`
 * concurrently, both see no key in IndexedDB, both call
 * `crypto.subtle.generateKey` (producing DIFFERENT keys), both PUT
 * their key under the same row — one wins persistence. The losing
 * call has already encrypted its row's ciphertext under the now-orphan
 * key; that row is permanently undecryptable.
 *
 * Resetting the cache (`__dangerouslyResetForTests`) drops this so
 * the dual-mode test can deterministically observe fresh state.
 */
let wrapKeyPromise: Promise<CryptoKey> | null = null;

async function loadOrCreateWrapKey(db: IDBDatabase): Promise<CryptoKey> {
  if (wrapKeyPromise !== null) return wrapKeyPromise;
  wrapKeyPromise = (async () => {
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
  })().catch((err) => {
    // Drop the cached rejection so the next caller retries the flow
    // (rather than every future call inheriting a permanent failure).
    wrapKeyPromise = null;
    throw err;
  });
  return wrapKeyPromise;
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
  // Settle anything the previous test left in flight (concurrent-write
  // tests can have CryptoKey-generation work mid-promise). Failure
  // here is fine — we're about to delete the whole DB anyway.
  if (wrapKeyPromise !== null) {
    try {
      await wrapKeyPromise;
    } catch {
      /* swallow */
    }
  }
  wrapKeyPromise = null;
  if (cachedDb !== null) {
    cachedDb.close();
    cachedDb = null;
  }
  openDbPromise = null;
  // `onblocked` fires when another connection still holds the database
  // open. Instead of rejecting (which racy-but-correct teardown would
  // surface as a confusing failure on every other test), we wait for
  // the eventual `onsuccess` — IndexedDB will deliver it once the
  // outstanding connections drop. We DO log the block so a genuinely
  // stuck test (i.e. one that forgot to close a connection it opened)
  // surfaces in CI output rather than hanging silently.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('IndexedDB delete failed'));
    req.onblocked = () => {
      console.warn(
        'keychain.web: IndexedDB deleteDatabase blocked — waiting for connections to drain',
      );
    };
  });
}
