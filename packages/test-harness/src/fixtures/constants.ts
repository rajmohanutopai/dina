/**
 * Test constants — exact TypeScript equivalents of Go testutil/fixtures.go.
 *
 * Every hex value, string constant, and byte array is copied verbatim from
 * the Go source. If these values change in the Go codebase, they must be
 * updated here to match.
 *
 * Source: core/test/testutil/fixtures.go
 */

// ---------------------------------------------------------------------------
// BIP-39 Test Seed (64 bytes — output of mnemonicToSeed)
// ---------------------------------------------------------------------------

export const TEST_MNEMONIC_SEED = new Uint8Array([
  0x40, 0x8b, 0x28, 0x5c, 0x12, 0x38, 0x36, 0x00, 0x4f, 0x4b, 0x88, 0x42, 0xc8, 0x93, 0x24, 0xc1,
  0xf0, 0x13, 0x82, 0x45, 0x0c, 0x0d, 0x43, 0x9a, 0xf3, 0x45, 0xba, 0x7f, 0xc4, 0x9a, 0xcf, 0x70,
  0x54, 0x89, 0xc6, 0xfc, 0x77, 0xdb, 0xd4, 0xe3, 0xdc, 0x1d, 0xd8, 0xcc, 0x6b, 0xc9, 0xf0, 0x43,
  0xdb, 0x8a, 0xda, 0x1e, 0x24, 0x3c, 0x4a, 0x0e, 0xaf, 0xb2, 0x90, 0xd3, 0x99, 0x48, 0x08, 0x40,
]);

// ---------------------------------------------------------------------------
// SLIP-0010 Derivation Paths
// ---------------------------------------------------------------------------

export const DINA_DERIVATION_PATH = "m/9999'";
export const DINA_ROOT_KEY_PATH = "m/9999'/0'/0'";

export const DINA_PERSONA_PATHS: Record<string, string> = {
  root: "m/9999'/0'/0'",
  consumer: "m/9999'/1'/0'/0'",
  professional: "m/9999'/1'/1'/0'",
  social: "m/9999'/1'/2'/0'",
  health: "m/9999'/1'/3'/0'",
  financial: "m/9999'/1'/4'/0'",
  citizen: "m/9999'/1'/5'/0'",
};

export const DINA_PLC_RECOVERY_PATH = "m/9999'/2'/0'";
export const FORBIDDEN_BIP44_PATH = "m/44'/0'";
export const NON_HARDENED_PATH = 'm/9999/0';
export const FIRST_CUSTOM_PERSONA_INDEX = 6;

/**
 * Pseudonymous-namespace branch — Trust Network V1 (TN-IDENT-002).
 *
 * Each namespace is a separate cryptographic identity (e.g. one for
 * health reviews, one for product reviews) deterministically derived
 * from the master seed under purpose-4. Indices are user-defined; the
 * helper computes the canonical path string.
 */
export const DINA_NAMESPACE_PATH_PREFIX = "m/9999'/4'";

/** Canonical SLIP-0010 path for namespace index `n`. */
export function dinaNamespacePath(n: number): string {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`dinaNamespacePath: index must be a non-negative integer, got ${n}`);
  }
  return `${DINA_NAMESPACE_PATH_PREFIX}/${n}'`;
}

// ---------------------------------------------------------------------------
// HKDF Info Strings (canonical — from keyderiver.go)
// ---------------------------------------------------------------------------

/**
 * HKDF info strings for persona DEK derivation.
 *
 * Canonical source: `core/internal/adapter/crypto/keyderiver.go`
 * Pattern: "dina:vault:{name}:v1"
 *
 * Verified against Go-exported fixtures (hkdf_persona_deks.json):
 *   HKDF-SHA256(ikm=masterSeed, salt=userSalt, info="dina:vault:{name}:v1", len=32)
 *
 * Note: The Go codebase has two layers — hkdf.go uses "dina:vault:{name}:v1"
 * and keyderiver.go wraps it. The actual HKDF info used is "dina:vault:{name}:v1"
 * as confirmed by cross-language fixture verification.
 */
export const HKDF_INFO_STRINGS: Record<string, string> = {
  identity: 'dina:vault:identity:v1',
  general: 'dina:vault:general:v1',
  personal: 'dina:vault:personal:v1',
  health: 'dina:vault:health:v1',
  financial: 'dina:vault:financial:v1',
  social: 'dina:vault:social:v1',
  consumer: 'dina:vault:consumer:v1',
  backup: 'dina:vault:backup:v1',
  archive: 'dina:vault:archive:v1',
  sync: 'dina:vault:sync:v1',
  trust: 'dina:vault:trust:v1',
};

/** Backup key info */
export const HKDF_BACKUP_KEY_INFO = 'dina:backup:key:v1';

// ---------------------------------------------------------------------------
// Argon2id Parameters (IDENTICAL to server — not reduced for mobile)
// ---------------------------------------------------------------------------

export const ARGON2ID_MEMORY_KB = 128 * 1024; // 128 MB in KiB
export const ARGON2ID_ITERATIONS = 3;
export const ARGON2ID_PARALLELISM = 4;
export const ARGON2ID_KEY_LENGTH = 32;
export const ARGON2ID_SALT_LENGTH = 16;

// ---------------------------------------------------------------------------
// Test Passphrases & Keys
// ---------------------------------------------------------------------------

export const TEST_PASSPHRASE = 'correct horse battery staple';
export const TEST_PASSPHRASE_WRONG = 'wrong horse battery staple';

export const TEST_USER_SALT = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

export const TEST_ED25519_SEED = new Uint8Array([
  0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c, 0xc4,
  0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae, 0x7f, 0x60,
]);

export const TEST_DEK = new Uint8Array([
  0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
  0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99,
]);

export const TEST_KEK = new Uint8Array([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
]);

export const TEST_MESSAGE = new TextEncoder().encode('dina test message for signing');

// ---------------------------------------------------------------------------
// Auth Tokens
// ---------------------------------------------------------------------------

/**
 * Server-compatibility tokens — NOT used in mobile auth flows.
 *
 * Mobile uses Ed25519 everywhere (no CLIENT_TOKEN). These constants
 * exist only for cross-compatibility tests that verify mobile can
 * interoperate with server Dina instances that still use CLIENT_TOKEN.
 */
export const SERVER_COMPAT_BRAIN_TOKEN =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
export const SERVER_COMPAT_BRAIN_TOKEN_WRONG =
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
export const SERVER_COMPAT_CLIENT_TOKEN =
  'client-token-0123456789abcdef0123456789abcdef0123456789abcdef01';

// ---------------------------------------------------------------------------
// DID
// ---------------------------------------------------------------------------

export const TEST_DID_KEY_PREFIX = 'did:key:z6Mk';

// ---------------------------------------------------------------------------
// PII Test Cases
// ---------------------------------------------------------------------------

export interface PIITestCase {
  name: string;
  input: string;
  expected: string;
  entities: string[];
}

export const PII_TEST_CASES: PIITestCase[] = [
  {
    name: 'email',
    input: 'Email me at john@example.com',
    expected: 'Email me at [EMAIL_1]',
    entities: ['john@example.com'],
  },
  {
    name: 'phone_us',
    input: 'Call 555-123-4567',
    expected: 'Call [PHONE_1]',
    entities: ['555-123-4567'],
  },
  {
    name: 'ssn',
    input: 'SSN 123-45-6789',
    expected: 'SSN [SSN_1]',
    entities: ['123-45-6789'],
  },
  {
    name: 'credit_card',
    input: 'Card 4111-1111-1111-1111',
    expected: 'Card [CREDIT_CARD_1]',
    entities: ['4111-1111-1111-1111'],
  },
  {
    name: 'multiple_emails',
    input: 'From john@example.com to jane@example.com',
    expected: 'From [EMAIL_1] to [EMAIL_2]',
    entities: ['john@example.com', 'jane@example.com'],
  },
  {
    name: 'no_pii',
    input: 'The weather is nice today',
    expected: 'The weather is nice today',
    entities: [],
  },
  {
    name: 'mixed_pii',
    input: 'Contact john@example.com or call 555-123-4567',
    expected: 'Contact [EMAIL_1] or call [PHONE_1]',
    entities: ['john@example.com', '555-123-4567'],
  },
];

// ---------------------------------------------------------------------------
// SQLCipher Pragmas
// ---------------------------------------------------------------------------

export const EXPECTED_VAULT_PRAGMAS: Record<string, string> = {
  cipher_page_size: '4096',
  journal_mode: 'wal',
  synchronous: '1', // NORMAL
  foreign_keys: '1', // ON
  busy_timeout: '5000',
};

// ---------------------------------------------------------------------------
// Sharing Policy Defaults
// ---------------------------------------------------------------------------

export const PHASE1_RECOGNIZED_CATEGORIES = [
  'presence',
  'availability',
  'context',
  'preferences',
  'location',
  'health',
] as const;

export function defaultSharingPolicy(): Record<string, string> {
  return {
    presence: 'eta_only',
    availability: 'free_busy',
    context: 'summary',
    preferences: 'full',
    location: 'none',
    health: 'none',
  };
}

// ---------------------------------------------------------------------------
// Vault Item Types (23 CHECK-constrained values from persona_001.sql)
// ---------------------------------------------------------------------------

export const VAULT_ITEM_TYPES = [
  'email',
  'message',
  'event',
  'note',
  'photo',
  'email_draft',
  'cart_handover',
  'contact_card',
  'document',
  'bookmark',
  'voice_memo',
  'kv',
  'contact',
  'health_context',
  'work_context',
  'finance_context',
  'family_context',
  'trust_review',
  'purchase_decision',
  'relationship_note',
  'medical_record',
  'medical_note',
  'trust_attestation',
] as const; // 23 values — matches persona_001.sql CHECK constraint

export type VaultItemType = (typeof VAULT_ITEM_TYPES)[number];

// ---------------------------------------------------------------------------
// D2D V1 Message Families
// ---------------------------------------------------------------------------

export const D2D_V1_MESSAGE_TYPES = [
  'presence.signal',
  'coordination.request',
  'coordination.response',
  'social.update',
  'safety.alert',
  'trust.vouch.request',
  'trust.vouch.response',
  'service.query',
  'service.response',
] as const;

/**
 * D2D message types that are ephemeral — never persisted in the vault,
 * regardless of whether they carry memory content.
 *
 * Source: core/internal/domain/message.go (D2DMemoryTypes absence)
 */
export const D2D_EPHEMERAL_MESSAGE_TYPES = [
  'presence.signal',
  'service.query',
  'service.response',
] as const;

export const D2D_MEMORY_TYPE_MAP: Record<string, string> = {
  'social.update': 'relationship_note',
  'trust.vouch.response': 'trust_attestation',
};

// ---------------------------------------------------------------------------
// Gatekeeper Action Risk Levels
// ---------------------------------------------------------------------------

export type RiskLevel = 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';

export const DEFAULT_ACTION_POLICIES: Record<string, RiskLevel> = {
  search: 'SAFE',
  list: 'SAFE',
  query: 'SAFE',
  remember: 'SAFE',
  store: 'SAFE',
  send_small: 'SAFE',
  delete_small: 'SAFE',
  send_large: 'MODERATE',
  delete_large: 'MODERATE',
  modify_settings: 'MODERATE',
  purchase: 'HIGH',
  payment: 'HIGH',
  bulk_operation: 'HIGH',
  credential_export: 'BLOCKED',
  key_access: 'BLOCKED',
};

export const BRAIN_DENIED_ACTIONS = [
  'did_sign',
  'did_rotate',
  'vault_backup',
  'persona_unlock',
  'seed_export',
] as const;

// ---------------------------------------------------------------------------
// Silence Classification
// ---------------------------------------------------------------------------

export const FIDUCIARY_KEYWORDS =
  /cancel|security alert|breach|unusual login|overdrawn|lab result|diagnosis|emergency/i;

export const FIDUCIARY_SOURCES = /security|health_system|bank|emergency/i;

export const SOLICITED_TYPES = new Set(['reminder', 'search_result']);

export const ENGAGEMENT_TYPES = new Set(['notification', 'promo', 'social', 'rss', 'podcast']);
