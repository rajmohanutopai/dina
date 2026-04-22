/**
 * `@dina/keystore-node` — secret-store adapter for the Node build target.
 *
 * Stores per-service string values (the "secret"). Two backends:
 *   - `FileKeystore` — filesystem-backed, one file per secret under
 *     a root directory, chmod 600 so only the owning user can read.
 *     Default choice: zero dependencies, works everywhere Node does.
 *   - `KeytarKeystore` — delegates to the OS credential store via
 *     the optional `keytar` npm package (macOS Keychain, Windows
 *     Credential Vault, libsecret on Linux). Optional — if keytar
 *     isn't installed, `createKeytarKeystore()` returns `null`.
 *
 * Dina uses this for:
 *   - The master seed wrapping/unwrapping envelope (`dina.seed.wrapped`
 *     stores the AES-256-GCM-wrapped seed; unwrapping happens in
 *     `@dina/crypto-node`, not here — this package only persists bytes).
 *   - Ed25519 service-key seeds (`dina.identity.signing`, `dina.identity.rotation`)
 *     that `@dina/crypto-node` consumes.
 *   - AI provider credentials, identity DID markers, role prefs.
 *
 * **Port contract (`Keystore`)** matches the expo counterpart's
 * get/set/delete surface but uses `put`/`get`/`delete`/`list` naming
 * per Phase 3 task 3.44. When `@dina/core` declares `KeystorePort`
 * (Phase 2 task 2.1e), this module re-exports under the canonical name.
 *
 * **Security notes:**
 *   - `FileKeystore` writes files at mode `0o600`. `mkdir` the root
 *     with `0o700` so even a directory listing is owner-only.
 *   - The file backend is plaintext-at-rest from the keystore's view:
 *     the values ARE the secrets. If you need at-rest encryption (e.g.
 *     wrapped master seed), wrap the value via `@dina/crypto-node`
 *     before calling `put()`.
 *   - `KeytarKeystore` inherits OS-level at-rest protection
 *     (Keychain-encrypted on macOS, DPAPI on Windows, libsecret-managed
 *     on Linux).
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 3e (tasks 3.40–3.45).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Keystore port contract. Service names are opaque string keys; the
 * value is an arbitrary UTF-8 string (use `JSON.stringify` for
 * structured payloads; use hex/base64 for bytes).
 */
export interface Keystore {
  /** Store or overwrite a secret. */
  put(service: string, value: string): Promise<void>;
  /** Read a secret. Returns `null` on cache-miss. */
  get(service: string): Promise<string | null>;
  /** Delete a secret. No-op when the service doesn't exist. */
  delete(service: string): Promise<void>;
  /** Enumerate stored service names, sorted. */
  list(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// File backend — primary, zero-dependency, mode 600.
// ---------------------------------------------------------------------------

export interface FileKeystoreOptions {
  /** Root directory holding one file per secret. */
  rootDir: string;
}

/**
 * Filesystem-backed keystore. One file per service, chmod 600.
 *
 * The on-disk layout is flat — each secret is a separate file whose
 * name is the sanitized service string. This makes inspection +
 * backup trivial (`tar czf backup.tgz rootDir`) and avoids opaque
 * index files that can diverge from the real set.
 *
 * **Service name sanitization.** Service names like `dina.seed.wrapped`
 * are fine to use verbatim as filenames on every major OS. To catch
 * accidental path traversal, `put`/`get`/`delete` reject names
 * containing `/`, `\`, `..`, or null bytes.
 */
export class FileKeystore implements Keystore {
  private readonly rootDir: string;

  constructor(options: FileKeystoreOptions) {
    this.rootDir = options.rootDir;
  }

  async put(service: string, value: string): Promise<void> {
    assertSafeService(service);
    await this.ensureRoot();
    const filePath = path.join(this.rootDir, service);
    // writeFile with mode 0o600 — set on creation so a transient
    // read attempt before chmod can't observe a wider mode.
    await fs.writeFile(filePath, value, { encoding: 'utf8', mode: 0o600 });
    // Re-assert mode in case the file already existed with a looser
    // mode (writeFile preserves existing mode on overwrite).
    await fs.chmod(filePath, 0o600);
  }

  async get(service: string): Promise<string | null> {
    assertSafeService(service);
    const filePath = path.join(this.rootDir, service);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  async delete(service: string): Promise<void> {
    assertSafeService(service);
    const filePath = path.join(this.rootDir, service);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if (isEnoent(err)) return; // no-op on miss
      throw err;
    }
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.rootDir);
      return entries.sort();
    } catch (err) {
      if (isEnoent(err)) return []; // root not yet created → empty set
      throw err;
    }
  }

  /** Lazy mkdir with owner-only perms. Called from `put`; `get`/`list`
   *  don't need to create the dir. */
  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    // mkdir's mode argument is honored only at creation; reassert so
    // a pre-existing wider mode is tightened. `chmod` is a no-op when
    // already 0o700.
    await fs.chmod(this.rootDir, 0o700);
  }
}

// ---------------------------------------------------------------------------
// Keytar backend — optional, OS credential store.
// ---------------------------------------------------------------------------

/**
 * Minimal keytar surface this package depends on. Declaring the
 * subset locally lets us ship without a hard type-dep on `keytar`
 * (it's `optional` in peerDependencies). Matches keytar@7's API.
 */
interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, value: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(
    service: string,
  ): Promise<Array<{ account: string; password: string }>>;
}

/**
 * All of Dina's secrets share one `account` so `keytar.findCredentials`
 * returns every service under a single query. Matches the
 * `KEYCHAIN_USERNAME` convention in `@dina/keystore-expo`.
 */
const KEYTAR_ACCOUNT = 'dina';

/**
 * OS credential store-backed keystore. Delegates to `keytar` —
 * inherits at-rest encryption from macOS Keychain, Windows
 * Credential Vault, or libsecret (Linux).
 *
 * keytar uses (service, account) as the primary key. Our convention
 * packs Dina's `service` argument as keytar's `service`, sharing a
 * single `account` constant across all rows.
 */
export class KeytarKeystore implements Keystore {
  constructor(private readonly keytar: KeytarLike) {}

  async put(service: string, value: string): Promise<void> {
    await this.keytar.setPassword(service, KEYTAR_ACCOUNT, value);
  }

  async get(service: string): Promise<string | null> {
    return this.keytar.getPassword(service, KEYTAR_ACCOUNT);
  }

  async delete(service: string): Promise<void> {
    await this.keytar.deletePassword(service, KEYTAR_ACCOUNT);
  }

  async list(): Promise<string[]> {
    // keytar's list API requires a `service` filter; Dina uses a
    // convention where every row lives under a predictable service
    // name (`dina.*`), but keytar has no prefix-filter primitive. To
    // enumerate we have to iterate known services — so `list()` on
    // this backend returns an empty array by default. Callers that
    // need a listing should use FileKeystore OR maintain their own
    // index file. Documented gap: keytar's native API doesn't expose
    // a bulk-list method, and implementing one via platform-specific
    // IPC is out of scope.
    return [];
  }
}

/**
 * Attempt to construct a `KeytarKeystore`. Returns `null` when
 * `keytar` isn't installed — callers use this to prefer keytar
 * when available and fall back to `FileKeystore`.
 *
 * Dynamic `require` so the package can be installed + imported on
 * machines without keytar's native dep. TypeScript doesn't see the
 * import statically — hence the `as unknown as KeytarLike` cast.
 */
export function createKeytarKeystore(): KeytarKeystore | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('keytar') as unknown as KeytarLike;
    return new KeytarKeystore(mod);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a service name. Dina's service names are dot-separated
 * lowercase identifiers (`dina.seed.wrapped`), but we accept any
 * string that doesn't contain path separators or null bytes — the
 * flat file layout means anything without `/` is a safe filename.
 */
function assertSafeService(service: string): void {
  if (service === '' || service.length > 256) {
    throw new Error('keystore: service name must be 1–256 chars');
  }
  if (service.includes('/') || service.includes('\\') || service.includes('\0')) {
    throw new Error(
      `keystore: service name contains forbidden chars (/, \\, null): ${JSON.stringify(service)}`,
    );
  }
  if (service === '.' || service === '..' || service.includes('/..')) {
    throw new Error(`keystore: service name cannot be a traversal path: ${service}`);
  }
}

/**
 * True when the error is a file-not-found / enoent. Node's fs.promises
 * surfaces this as an error with `code === 'ENOENT'`.
 */
function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
