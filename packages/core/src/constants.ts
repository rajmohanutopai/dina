/**
 * Shared constants — single source of truth for values used across modules.
 *
 * Import from here instead of redefining in each file.
 * Grouped by domain for discoverability.
 */

// ---------------------------------------------------------------
// Time constants (milliseconds unless noted)
// ---------------------------------------------------------------

export const MS_SECOND = 1_000;
export const MS_MINUTE = 60 * MS_SECOND;
export const MS_HOUR = 60 * MS_MINUTE;
export const MS_DAY = 24 * MS_HOUR;
export const MS_WEEK = 7 * MS_DAY;

// ---------------------------------------------------------------
// Crypto / wire-format sizes (bytes)
// ---------------------------------------------------------------

export const ED25519_SEED_BYTES = 32;
export const ED25519_PUBLIC_KEY_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;
export const NACL_EPHEMERAL_KEY_BYTES = 32;
export const NACL_NONCE_BYTES = 24;
export const NACL_TAG_BYTES = 16;
export const RANDOM_ID_BYTES = 8;
export const RANDOM_NONCE_BYTES = 16;
export const BIP39_SEED_BYTES = 64;

// ---------------------------------------------------------------
// Multicodec / protocol prefixes
// ---------------------------------------------------------------

export const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);
export const SECP256K1_MULTICODEC = new Uint8Array([0xe7, 0x01]);
export const HARDENED_OFFSET = 0x80000000;
export const DINA_FILE_MAGIC = new Uint8Array([0x44, 0x49, 0x4e, 0x41]); // "DINA"
export const DINA_FILE_VERSION = 1;

// ---------------------------------------------------------------
// Argon2id parameters (must match server exactly)
// ---------------------------------------------------------------

export const ARGON2ID_PARAMS = {
  memory: 128 * 1024, // 131072 KiB = 128 MB
  iterations: 3,
  parallelism: 4,
} as const;

// ---------------------------------------------------------------
// Network defaults
// ---------------------------------------------------------------

export const CORE_DEFAULT_PORT = 8100;
export const BRAIN_DEFAULT_PORT = 8200;
export const DEFAULT_CORE_URL = `http://localhost:${CORE_DEFAULT_PORT}`;
export const DEFAULT_BRAIN_URL = `http://localhost:${BRAIN_DEFAULT_PORT}`;
export const DEFAULT_PLC_DIRECTORY = 'https://plc.directory';
export const DEFAULT_APPVIEW_URL = 'https://appview.dina.social';

// ---------------------------------------------------------------
// Auth / security windows
// ---------------------------------------------------------------

export const TIMESTAMP_WINDOW_S = 300; // ±5 minutes
export const REQUEST_TIMEOUT_MS = 30 * MS_SECOND;
export const MAX_BODY_SIZE_BYTES = 2_000_000; // 2 MB (matches Express '2mb')
export const NONCE_WINDOW_MS = 5 * MS_MINUTE;
export const BIOMETRIC_MAX_FAILURES = 5;
export const HEALTH_CHECK_TIMEOUT_MS = 5 * MS_SECOND;
export const UNHEALTHY_THRESHOLD = 3; // consecutive failures before crash

// ---------------------------------------------------------------
// Staging pipeline
// ---------------------------------------------------------------

export const STAGING_LEASE_DURATION_S = 15 * 60; // 15 minutes
export const STAGING_ITEM_TTL_S = 7 * 24 * 3600; // 7 days
export const STAGING_MAX_RETRIES = 3;
export const STAGING_CLAIM_DEFAULT = 10;
export const STAGING_CLAIM_MAX = 50;

// ---------------------------------------------------------------
// Vault / search
// ---------------------------------------------------------------

export const VAULT_QUERY_DEFAULT_LIMIT = 20;
export const VAULT_QUERY_MAX_LIMIT = 100;
export const VAULT_BATCH_MAX = 100;
export const HYBRID_FTS_WEIGHT = 0.4;
export const HYBRID_SEMANTIC_WEIGHT = 0.6;

// Trust-weighted reranking multipliers (matching Go vault.go)
// Applied as compounding modifiers after FTS+semantic score fusion.
export const TRUST_RERANK_CAVEATED = 0.7; // caveated retrieval_policy → 0.7x
export const TRUST_RERANK_TRUSTED = 1.2; // self/contact_ring1 sender_trust → 1.2x
export const TRUST_RERANK_LOW_CONFIDENCE = 0.6; // low confidence → 0.6x

// ---------------------------------------------------------------
// Embedding / HNSW
// ---------------------------------------------------------------

export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const HNSW_DEFAULT_M = 16;
export const HNSW_DEFAULT_EF_CONSTRUCTION = 200;

// ---------------------------------------------------------------
// Pairing ceremony
// ---------------------------------------------------------------

export const PAIRING_CODE_MIN = 100000;
export const PAIRING_CODE_RANGE = 900000;
export const PAIRING_CODE_TTL_S = 300; // 5 minutes
export const PAIRING_MAX_PENDING = 100;

// ---------------------------------------------------------------
// Transport / message buffers
// ---------------------------------------------------------------

export const WS_HUB_BUFFER_SIZE = 50;
export const WS_HUB_BUFFER_TTL_MS = 5 * MS_MINUTE;
export const OUTBOX_MAX_BACKOFF_MS = 5 * MS_MINUTE;
export const OUTBOX_INITIAL_BACKOFF_MS = MS_SECOND;
export const DID_CACHE_TTL_MS = 10 * MS_MINUTE;
export const QUARANTINE_TTL_MS = 30 * MS_DAY;

// ---------------------------------------------------------------
// Trust / cache
// ---------------------------------------------------------------

export const TRUST_CACHE_TTL_MS = MS_HOUR;
export const TRUST_RATING_MIN = 0;
export const TRUST_RATING_MAX = 100;

// ---------------------------------------------------------------
// Lifecycle / mobile security
// ---------------------------------------------------------------

export const DEFAULT_BACKGROUND_TIMEOUT_S = 300; // 5 minutes
export const MNEMONIC_DISPLAY_TTL_MS = 60 * MS_SECOND;
export const ONBOARDING_VERIFY_WORD_COUNT = 3;
export const PASSPHRASE_MIN_LENGTH = 8;
export const PASSPHRASE_MAX_LENGTH = 128;
export const SYSTEM_MESSAGE_HISTORY_MAX = 100;

// ---------------------------------------------------------------
// MsgBox / relay protocol
// ---------------------------------------------------------------

export const MSGBOX_HANDSHAKE_PREFIX = 'AUTH_RELAY';
export const MSGBOX_WS_SUFFIX = '/ws';
export const MSGBOX_FORWARD_SUFFIX = '/forward';

// RPC envelope type discriminators
export const RPC_REQUEST_TYPE = 'core_rpc_request';
export const RPC_RESPONSE_TYPE = 'core_rpc_response';
