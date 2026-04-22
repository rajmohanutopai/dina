/**
 * PDS client interface types.
 *
 * Declares the shapes a future PDS-client class will satisfy. The
 * actual implementations currently live at their pre-consolidation
 * sites (see ./README.md for the location table); this file pins
 * the TS contract so migrations don't silently drift.
 *
 * **Zero runtime deps here** — pure type declarations + interface
 * definitions. All crypto/HTTP concerns are injected at
 * construction time by the platform adapter.
 */

// ─── Session lifecycle (task 6.2–6.3) ──────────────────────────────────────

/**
 * Credentials returned by a PDS `createSession` call. The access
 * token is carried on subsequent XRPC requests; the refresh token
 * gets persisted in the OS keystore and exchanged when the access
 * token approaches expiry.
 */
export interface PDSSession {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  /** Unix seconds when the access token is no longer trusted. */
  accessExpiresAtMs: number;
}

export interface PDSAccountInput {
  /** Handle the PDS will register (e.g. `alice.bsky.social`). */
  handle: string;
  /** Account password used only for PDS session-provisioning flows. */
  password: string;
  /** Optional invite code some PDS instances require. */
  inviteCode?: string;
  /** Recovery key Dina binds to the DID at genesis so Core can rotate signing keys later. */
  recoveryKey?: string;
}

// ─── Record CRUD (task 6.4) ────────────────────────────────────────────────

/** Shape of a record stored under the PDS's `com.atproto.repo.*` interface. */
export interface PDSRecord<T = unknown> {
  /** The did:plc of the repo-owner. */
  repo: string;
  /** Lexicon collection (e.g. `com.dina.trust.attestation`). */
  collection: string;
  /** Record key. Either caller-supplied or server-minted. */
  rkey: string;
  /** The record value — must validate against `collection`'s lexicon. */
  value: T;
  /** AT-URI of the record: `at://<repo>/<collection>/<rkey>`. */
  uri: string;
  /** Content-addressed hash (CID) of the stored record. */
  cid: string;
}

export interface PutRecordInput<T = unknown> {
  repo: string;
  collection: string;
  rkey: string;
  record: T;
}

export interface ListRecordsOptions {
  repo: string;
  collection: string;
  /** Max records returned (server-enforced cap). */
  limit?: number;
  /** Opaque cursor from a prior listRecords response. */
  cursor?: string;
}

export interface ListRecordsResult<T = unknown> {
  records: PDSRecord<T>[];
  /** Cursor for the next page; absent when at end-of-list. */
  cursor?: string;
}

// ─── The PDS client contract (task 6.1 scaffold, 6.2–6.5 implementation) ──

/**
 * The methods a PDS client exposes to the rest of `@dina/core` and
 * to the Brain via the CoreClient interface. A concrete class lives
 * at `client.ts`; platform adapters (`@dina/adapters-node`) wire the
 * HTTP client + keystore at construction time.
 *
 * Every method is async — PDS calls are network-bound.
 */
export interface PDSClient {
  /** Create a new PDS account + persist session tokens. */
  createAccount(input: PDSAccountInput): Promise<PDSSession>;
  /** Authenticate against an existing account. */
  createSession(handleOrDid: string, password: string): Promise<PDSSession>;
  /** Exchange refresh token for a new access token; may rotate both. */
  refreshSession(): Promise<PDSSession>;
  /** Invalidate the current session on both client + server. */
  deleteSession(): Promise<void>;

  /** Create a new record under the current session's repo. */
  createRecord<T>(input: PutRecordInput<T>): Promise<PDSRecord<T>>;
  /** Upsert: create-or-replace. Pins the `rkey`. */
  putRecord<T>(input: PutRecordInput<T>): Promise<PDSRecord<T>>;
  /** Fetch a record by repo + collection + rkey. `null` when absent. */
  getRecord<T>(repo: string, collection: string, rkey: string): Promise<PDSRecord<T> | null>;
  /** Hard-delete a record. No-op when absent. */
  deleteRecord(repo: string, collection: string, rkey: string): Promise<void>;
  /** Paginated list of records. */
  listRecords<T>(opts: ListRecordsOptions): Promise<ListRecordsResult<T>>;
}
