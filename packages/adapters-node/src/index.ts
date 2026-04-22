/**
 * `@dina/adapters-node` — meta package re-exporting every Node-target
 * adapter under capability-named aliases.
 *
 * **Intended consumer: `apps/home-node-lite/*`.** A Fastify Core / Brain
 * server imports `{ SqliteStorage, SignEd25519, HttpClient }` from this
 * one package instead of enumerating `@dina/storage-node`,
 * `@dina/crypto-node`, `@dina/net-node`, etc. Apps get a stable import
 * surface; the granular packages remain independently publishable for
 * external consumers who want just one capability.
 *
 * **Rule of thumb:**
 *   - Apps inside this repo → import from `@dina/adapters-node`.
 *   - External TS consumers → import from the granular package
 *     (`@dina/fs-node`, `@dina/crypto-node`, etc.).
 *
 * Storage-node is scaffolded but not yet implemented (task 3.6+),
 * so there are no re-exports from it here today — add them when the
 * package ships a concrete `NodeSQLiteAdapter` / `NodeDBProvider`.
 *
 * Source: docs/HOME_NODE_LITE_TASKS.md Phase 3f (tasks 3.46–3.50).
 */

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export {
  NodeFsAdapter as FileSystem,
  type FsAdapter as FileSystemAdapter,
  type FsStat as FileStat,
} from '@dina/fs-node';

// ---------------------------------------------------------------------------
// Keystore
// ---------------------------------------------------------------------------

export {
  FileKeystore,
  KeytarKeystore,
  createKeytarKeystore,
  type Keystore,
  type FileKeystoreOptions,
} from '@dina/keystore-node';

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export {
  NodeCryptoAdapter as Crypto,
  type CryptoAdapterNode as CryptoAdapter,
  type Ed25519Port as SignEd25519Port,
  type X25519Port as KeyExchangeX25519Port,
  type Secp256k1Port as SignSecp256k1Port,
  type HashPort,
  type HKDFPort,
  type SealedBoxPort,
  type ArgonPort,
  type RandomPort,
  type DerivedKey,
} from '@dina/crypto-node';

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export {
  NodeHttpClient as HttpClient,
  RetryingHttpClient as HttpClientWithRetry,
  DEFAULT_RETRY_CONFIG,
  createCanonicalRequestSigner,
  type RetryConfig,
  type HttpClient as HttpClientPort,
  type HttpRequestInit,
  type HttpResponse,
  type CanonicalRequestSigner,
  type CanonicalRequestSignerConfig,
  type Ed25519SignFn,
  type NonceFn,
  type NowFn,
  type NodeHttpClientOptions,
} from '@dina/net-node';

// ---------------------------------------------------------------------------
// Storage — placeholder. Task 3.6+ will add:
//   export { NodeSQLiteAdapter as SqliteStorage, NodeDBProvider } from '@dina/storage-node';
// ---------------------------------------------------------------------------
