> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 1: Storage

Six tiers (Tier 0-5). Each with different encryption, sync, and backup strategies. Primary location: Home Node. Client devices cache subsets.

### Tier 0 — Identity Vault

| Property | Value |
|----------|-------|
| Contents | Root keypair, persona keys, ZKP credentials, recovery config |
| Encryption | Hardware-backed (Secure Enclave / StrongBox / TPM) where available |
| Location | Home node (primary) + each client device holds delegated device keys |
| Backup | Phase 1: BIP-39 mnemonic on paper. Phase 2: Shamir's Secret Sharing (3-of-5) — seed split across trusted Dina contacts + physical backups. Home node stores encrypted root key blob (decryptable only with mnemonic or hardware key). |
| Breach impact | Total identity compromise. Catastrophic. |

### Tier 1 — The Vault (Raw Ingested Data)

| Property | Value |
|----------|-------|
| Contents | Emails, chat messages, calendar events, contacts, photos, documents |
| Encryption | SQLCipher whole-database encryption (AES-256-CBC, per-page). Per-persona DEKs derived from master seed via HKDF with persona-specific info strings. Each persona is a separate encrypted file. |
| Storage engine | SQLite with FTS5 (full-text search, `unicode61 remove_diacritics 1` tokenizer — multilingual, handles Indic scripts natively). Porter stemmer is forbidden (English-only, mangles non-Latin). FTS index is encrypted transparently by SQLCipher. Phase 3: ICU tokenizer for CJK word segmentation. |
| Location | Home node (source of truth). Rich clients cache configurable subsets. |
| Client cache | Phone: recent 6 months. Laptop: configurable (up to everything). Thin clients: no local cache. |
| Backup | Encrypted snapshot of all persona files to blob storage of user's choice (S3, Backblaze, NAS, second VPS). |
| Breach impact | Compromise of one persona file exposes ONLY that persona's data. Each file has its own DEK. Locked persona files have DEKs not in RAM — opaque bytes even if file is stolen. |

**Schema sketch for Identity (`identity.sqlite` — Tier 0, always unlocked first):**

```sql
-- DINA IDENTITY SCHEMA (v1)
-- Storage: SQLCipher Encrypted Database
-- Key: Master Seed → HKDF-SHA256("dina:vault:identity:v1") → SQLCipher passphrase
-- Always unlocked first — gatekeeper needs contacts and sharing policy.

-- Contacts: global, NO persona field. People are cross-cutting.
-- Dr. Patel is a contact. His lab results go in /health, his cricket chat in /social.
CREATE TABLE contacts (
    did              TEXT PRIMARY KEY,
    name             TEXT,
    alias            TEXT,
    trust_level      TEXT DEFAULT 'unknown',  -- 'blocked', 'unknown', 'trusted'
    sharing_policy   TEXT,                    -- JSON blob (the rulebook)
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_contacts_trust ON contacts(trust_level);

-- Audit log: every persona access, every brain query
CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    persona   TEXT NOT NULL,
    action    TEXT NOT NULL,
    requester TEXT NOT NULL,
    query_type TEXT,
    reason    TEXT,
    metadata  TEXT
);

-- Key-value store for sync cursors (brain is stateless)
CREATE TABLE kv_store (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Device tokens: per-device CLIENT_TOKEN hashes for client authentication.
-- Plaintext token sent to device once during pairing, never stored by core.
-- SHA-256 is sufficient (256-bit random input, no brute-force risk). Argon2id
-- is reserved for the passphrase (low-entropy human input).
CREATE TABLE device_tokens (
    token_id     TEXT PRIMARY KEY,       -- short display ID (e.g. "dev_a3f8b2")
    token_hash   TEXT NOT NULL UNIQUE,   -- SHA-256(CLIENT_TOKEN), hex-encoded
    device_name  TEXT,                   -- "Raj's iPhone", "MacBook Pro"
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen    DATETIME,               -- updated on each authenticated request
    revoked      BOOLEAN DEFAULT 0
);
CREATE INDEX idx_device_tokens_hash ON device_tokens(token_hash) WHERE revoked = 0;
```

**Schema sketch for Persona Vault (per-persona SQLCipher database):**

```sql
-- DINA VAULT SCHEMA (v3)
-- Storage: SQLCipher Encrypted Database (per-persona file, AES-256-CBC per page)
-- Key: Master Seed → HKDF-SHA256("dina:vault:<persona>:v1") → SQLCipher passphrase
-- Phase 1: only personal.sqlite exists. Phase 2: per-persona files.

-- Core ingestion table
CREATE TABLE vault_items (
    id TEXT PRIMARY KEY,           -- UUID
    type TEXT NOT NULL,            -- 'email', 'message', 'event', 'note', 'photo'
    source TEXT NOT NULL,          -- 'gmail', 'telegram', 'calendar', etc.
    source_id TEXT,                -- original ID in source system
    contact_did TEXT,              -- optional: link to contacts in identity.sqlite
    summary TEXT,                  -- brain-generated summary
    body_text TEXT,                -- the actual content (encrypted at rest by SQLCipher)
    timestamp INTEGER NOT NULL,   -- unix timestamp of original item
    ingested_at INTEGER NOT NULL,  -- when Dina pulled it
    metadata TEXT                  -- JSON: structured metadata
);

-- Full-text search index (encrypted at rest by SQLCipher — no plaintext leakage)
-- unicode61: multilingual tokenizer (Hindi, Tamil, Kannada, etc.). Porter stemmer is
-- English-only and mangles non-Latin scripts — explicitly forbidden.
-- Phase 3: ICU tokenizer for CJK word segmentation (languages without spaces).
CREATE VIRTUAL TABLE vault_items_fts USING fts5(body_text, summary, content=vault_items, content_rowid=rowid, tokenize='unicode61 remove_diacritics 1');

-- Relationships (who sent what to whom)
CREATE TABLE relationships (
    id TEXT PRIMARY KEY,
    entity_name TEXT,              -- "Sancho", "Priya", "Dr. Kumar"
    entity_type TEXT,              -- 'person', 'org', 'bot'
    last_interaction INTEGER,
    interaction_count INTEGER,
    notes TEXT                     -- Dina's inferred notes (encrypted at rest by SQLCipher)
);
```

### Tier 2 — The Index (Derived Intelligence)

| Property | Value |
|----------|-------|
| Contents | Embeddings, summaries, relationship graphs, inferred patterns |
| Encryption | Same per-persona `.sqlite` files — embeddings and indices stored in dedicated tables within each persona's encrypted database |
| Storage engine | SQLite for structured data + sqlite-vec for vector embeddings |
| Location | Home node (primary). Rich clients may build a local subset from their cache for offline search. |
| Backup | Not backed up separately. Regenerable from Tier 1. |
| Breach impact | Attacker sees Dina's inferences. Metadata, not raw data. |

**Vector storage options:**
- Phase 1: `sqlite-vec` (successor to the now-deprecated `sqlite-vss`). Written in pure C, zero dependencies, runs anywhere SQLite runs — phones, desktops, WASM, Raspberry Pi. Mozilla Builders project, MIT/Apache-2.0 licensed. Supports metadata columns and partition keys alongside vectors.
- Phase 2: Consider `sqlite-vector` (from SQLite Cloud, HNSW-based for faster ANN at scale) or Turso's native vector search (libSQL fork with built-in vector support) if index grows large.
- Not using Pinecone/Weaviate — those are third-party cloud services. Dina's embeddings stay on your Home Node.

**Embedding model:** Runs on the Home Node (and optionally on rich client devices for offline search). Options:
- **Phase 1: `EmbeddingGemma`** (308M params, <200MB RAM quantized, 100+ languages). Google's purpose-built on-device embedding model based on Gemma 3 architecture. Best-in-class on MTEB for models under 500M params. Supports Matryoshka representation (768 down to 128 dims) and 2K–8K context. Runs fully offline on phones.
- **Phase 2: `Nomic Embed Text V2`** (475M params, MoE architecture — only 305M active during inference). Trained on 1.6B multilingual pairs, 100+ languages. Flexible dimension truncation (768 → 256). Competitive with models twice its size on BEIR/MIRACL. Needs more hardware but significantly better quality for complex retrieval.
- The embedding model is pluggable. Start small, upgrade later.

**Embedding migration:** The embedding model name and version are stored in vault metadata (`embedding_model` column in the system table). On model change, core detects the mismatch, drops the sqlite-vec index, and triggers a background re-embed job. Brain processes items in batches → new embeddings → core writes to sqlite-vec. FTS5 keyword search remains available during re-indexing; only semantic search is temporarily unavailable. No dual-index or versioning needed — vault sizes are small enough for full rebuild (~25MB of vectors for 50K items, ~2-3 hours on local llama, ~5 minutes via cloud API).

### Tier 3 — Reputation & Preferences

| Property | Value |
|----------|-------|
| Contents | Bot trust registry, user preferences, anonymized outcome data |
| Encryption | Encrypted at rest, but some data intentionally shared (anonymized outcomes) |
| Storage engine | SQLite (structured, small) |
| Location | Home node (source of truth). Replicated to rich clients for offline access. |
| Backup | Included in home node backup |
| Breach impact | Preferences and bot scores exposed. Low-medium severity. |

**Outcome data flow:**
```
Purchase happens (via Cart Handover)
        ↓
Dina records: {product_category, seller_dina_id, price, timestamp}
        ↓
    [ weeks/months later ]
        ↓
Dina asks: "How's that chair?"
User responds or Dina infers (still using it? returned?)
        ↓
Anonymized outcome record created:
{
    product_category: "office_chair",
    seller_trust_ring: 2,
    price_range: "10000-15000_INR",
    outcome: "still_using_6_months",
    dina_trust_ring: 2,
    dina_age_days: 730
}
        ↓
Signed with persona key, submitted to Reputation Graph
(No user identity. No product name. Just category + outcome.)
```

### Tier 4 — Staging (Ephemeral)

| Property | Value |
|----------|-------|
| Contents | Email drafts, payment intents, pending cart handovers, notification queue |
| Encryption | Encrypted at rest |
| Storage engine | SQLite or simple key-value store |
| Location | Home node (for agent-initiated drafts) + originating client device (for user-initiated drafts) |
| Backup | Not backed up |
| Auto-expire | Items older than 72 hours are deleted |
| Breach impact | Pending drafts visible. Low severity. |

### Tier 5 — The Deep Archive

Last-resort recovery. Survives Home Node destruction, backup ransomware, and total infrastructure loss.

| Property | Value |
|----------|-------|
| Contents | Full encrypted vault snapshots (complete Tier 0 + Tier 1 + Tier 3) |
| Encryption | AES-256-GCM, separate Archive Key derived from root |
| Frequency | Weekly (configurable) |
| Retention | Indefinite (or user-configured) |
| Breach impact | Encrypted blobs. Useless without keys. |

**User's choice of cold storage:**

| Option | Tech | Air Gap | Cost | Recovery Time |
|--------|------|---------|------|---------------|
| **Cloud Cold Storage** | AWS S3 Glacier Deep Archive (or Backblaze B2) with **Compliance Mode Object Lock** | Software air gap — even root user and cloud support cannot delete or modify locked objects for the configured retention period | ~$1/TB/month | 12-48 hours (retrieval from archive) |
| **Sovereign Cold Storage** | Physical USB HDD or LTO tape, unplugged after backup | Physical air gap — disconnected hardware | $50-3000 one-time, $0/month | Instant (once plugged in) |

**Why Compliance Mode Object Lock matters:** Without it, a compromised cloud credential can delete backups. With it, backups are immutable for the configured retention period.

**Default:** Most users use Cloud Cold Storage. Privacy absolutists use physical drives. Both are encrypted with a key that lives only on the user's devices.

### Encryption Architecture

```
Master Seed (BIP-39 mnemonic → stored encrypted on Home Node; hardware-backed on client devices)
    │
    ├── Per-Persona Vault DEKs (HKDF-SHA256, one per persona file)
    │   ├── HKDF(info="dina:vault:identity:v1")   → DEK for identity.sqlite
    │   ├── HKDF(info="dina:vault:personal:v1")   → DEK for personal.sqlite
    │   ├── HKDF(info="dina:vault:health:v1")     → DEK for health.sqlite (Phase 2)
    │   ├── HKDF(info="dina:vault:financial:v1")  → DEK for financial.sqlite (Phase 2)
    │   ├── HKDF(info="dina:vault:social:v1")     → DEK for social.sqlite (Phase 2)
    │   ├── HKDF(info="dina:vault:consumer:v1")   → DEK for consumer.sqlite (Phase 2)
    │   └── HKDF(info="dina:vault:<custom>:v1")   → DEK for user-defined personas
    │
    ├── SLIP-0010 Ed25519 Hardened Derivation (purpose: 9999')
    │   │
    │   ├── m/9999'/0' → Root Identity Key (signs DID Document)
    │   │
    │   ├── m/9999'/1' → Persona Key: /consumer     (signing + DIDComm encryption)
    │   ├── m/9999'/2' → Persona Key: /professional  (signing + DIDComm encryption)
    │   ├── m/9999'/3' → Persona Key: /social        (signing + DIDComm encryption)
    │   ├── m/9999'/4' → Persona Key: /health        (signing + DIDComm encryption)
    │   ├── m/9999'/5' → Persona Key: /financial     (signing + DIDComm encryption)
    │   ├── m/9999'/6' → Persona Key: /citizen       (signing + DIDComm encryption)
    │   └── m/9999'/N' → Persona Key: /custom/*      (user-defined)
    │
    ├── Backup Encryption Key (HKDF, info="dina:backup:v1")
    │       └── Wraps persona file snapshots for off-node backup storage
    │
    ├── Archive Key (HKDF, info="dina:archive:v1")
    │       └── Wraps full vault snapshots for Tier 5 cold storage
    │       └── Separate from Backup Key so archive survives backup key rotation
    │
    ├── Client Sync Key (HKDF, info="dina:sync:v1")
    │       └── Encrypts vault cache pushes to client devices
    │
    └── Reputation Signing Key (HKDF, info="dina:reputation:v1")
            └── Signs anonymized outcome data
```

**Two derivation layers:** Identity keys (Ed25519 keypairs for signing) are derived via SLIP-0010 hardened paths from the master seed. Per-persona vault DEKs (256-bit symmetric keys for SQLCipher) are derived via HKDF-SHA256 from the master seed with persona-specific domain separators (e.g. `"dina:vault:health:v1"`). Each persona file has its own DEK — compromise of one file does not expose other persona files.

### Master Key Storage (Key Wrapping)

The Master Seed (DEK — Data Encryption Key) is the 512-bit seed derived from the BIP-39 mnemonic via PBKDF2. It is stored on disk, encrypted by a Key Encryption Key (KEK) derived from the user's passphrase. This is standard key wrapping, not "password-encrypted storage."

```
Passphrase ("correct horse battery staple")
    │
    ▼  Argon2id v1.3 (memory: 128 MB, time: 3 iterations, parallelism: 4 lanes)
    │
    KEK (32-byte Key Encryption Key)
    │
    ▼  AES-256-GCM wrap (or XChaCha20-Poly1305)
    │
    Encrypted Master Seed blob → stored in /var/lib/dina/wrapped_seed.bin
    In convenience mode: raw seed → /var/lib/dina/keyfile (chmod 600)
    │  (plus cleartext 16-byte salt for Argon2id)
    │
    ▼  On unlock: KEK decrypts blob → Master Key loaded into RAM
    │
    Master Key (DEK)
    │
    ├── SLIP-0010 derivation → persona identity keys (Ed25519)
    └── HKDF derivation → per-persona vault DEKs (one per .sqlite file)
```

**Why key wrapping:** Changing the user's passphrase re-wraps the Master Key with a new KEK — no need to re-encrypt the entire multi-gigabyte database. The Master Key itself never changes unless the identity is rotated.

**Argon2id parameters (configurable in `config.json`):**

| Parameter | Default | Rationale |
|-----------|---------|-----------|
| `memory_mb` | 128 | ~1s on Mac Mini, ~2s on Pi 4. Safe on 2GB VPS (12.5% spike). 256MB risks OOM on $5 VPS with 1GB RAM. |
| `iterations` | 3 | OWASP 2024 minimum is 2. Three iterations with 128MB memory makes brute force infeasible (~billions of years for a decent passphrase on stolen disk). |
| `parallelism` | 4 | Matches typical core count on target hardware (Pi 4, Mac Mini M4, VPS). |

```json
// config.json — power users can tune
{
  "argon2id": {
    "memory_mb": 128,
    "iterations": 3,
    "parallelism": 4
  }
}
```

This runs **once at unlock**, not per-request. The derived KEK stays in RAM for the process lifetime. The one-time cost is a ~1-2 second spike during vault unlock — acceptable for a passphrase prompt.

**Home node:** In security mode, the encrypted Master Seed blob is stored at `/var/lib/dina/wrapped_seed.bin` (AES-256-GCM wrapped by the passphrase-derived KEK). In convenience mode, the raw seed is stored at `/var/lib/dina/keyfile` (`chmod 600`). Per-persona DEKs are derived at runtime via HKDF and held in RAM only while the persona database is open. On client devices with hardware security modules, delegated device keys are generated and stored in Secure Enclave / StrongBox / TPM. The Master Seed is NEVER stored in plaintext at rest in security mode.

### Data Safety Protocol (Corruption Immunity)

In a sovereign architecture, there's no SRE team to restore the database. The architecture must defend against code bugs, power failures, and operator error at every level.

**Protection 1: Atomic Writes (Database Level)**

SQLite is robust, but only if configured correctly. A power outage mid-write can corrupt the file.

```sql
-- Run on every connection open (Home Node and client cache)
PRAGMA key='<hex-encoded-256-bit-key>';  -- SQLCipher: unlock the encrypted database
PRAGMA cipher_page_size=4096;            -- SQLCipher: page size (match default)
PRAGMA journal_mode=WAL;                 -- Write-Ahead Logging: changes go to -wal file first
PRAGMA synchronous=NORMAL;               -- Safe in WAL mode, significantly faster than FULL
PRAGMA foreign_keys=ON;                  -- Prevent orphaned data corruption
PRAGMA busy_timeout=5000;                -- Wait up to 5s for write lock (prevents SQLITE_BUSY under load)
```

WAL mode means: if the server crashes mid-write, the main `.sqlite` is untouched. On restart, SQLite sees the incomplete `-wal` file and automatically rolls back. The database is always in a consistent state.

**Protection 1b: Concurrent Access (Single-Writer Pattern)**

dina-core is a concurrent Go server: WebSocket clients, DIDComm reception, and brain API requests (including bulk ingestion from MCP sync cycles) all hit the persona databases. WAL mode allows concurrent readers, but only **one writer at a time per file**. Without proper connection management, writes back up during heavy ingestion (e.g. initial Gmail sync of 10,000 emails) and brain queries time out.

**Connection pool design (multi-database vault manager):**

```go
// Per-database: one write connection (serialized), unlimited read connections
// VaultManager holds pools for all currently open persona databases
type VaultManager struct {
    identity  *VaultPool                    // always open (contacts, audit, kv_store)
    personas  map[string]*VaultPool         // "personal" → pool, "health" → pool, etc.
    mu        sync.RWMutex                  // protects the personas map
}

type VaultPool struct {
    writeConn *sql.DB  // MaxOpenConns=1, busy_timeout=5000
    readPool  *sql.DB  // MaxOpenConns=N (cpu_count * 2), read-only
}
```

```sql
-- Write connection PRAGMAs (in addition to Protection 1 PRAGMAs)
PRAGMA busy_timeout = 5000;        -- Wait up to 5s for lock instead of returning SQLITE_BUSY immediately
PRAGMA wal_autocheckpoint = 1000;  -- Checkpoint every 1000 pages (~4MB)

-- Read connections
PRAGMA query_only = ON;            -- Prevents accidental writes on read connections
```

**Why single-writer per file:** SQLite's WAL allows only one writer per database. Attempting concurrent writes to the same file causes `SQLITE_BUSY`. The alternatives — retry loops, random backoff, connection-level mutexes — are fragile. A single dedicated write connection per persona file with `busy_timeout` is deterministic: writes queue up, readers never block. Bonus: writes to different persona files are fully independent — bulk-ingesting emails into `/personal` doesn't block a query to `/health`.

**Batch ingestion pattern (MCP sync):**

During initial sync, brain fetches thousands of items from OpenClaw. Writing each one individually to vault creates lock contention and WAL bloat.

```
BATCH INGESTION PROTOCOL:

  Brain fetches items via MCP (e.g. 5,000 Gmail messages from OpenClaw)
           ↓
  Brain triages and summarizes in batches
           ↓
  Brain calls POST /v1/vault/store/batch (100 items per request)
           ↓
  Core: BEGIN → INSERT 100 rows → COMMIT (one transaction)
           ↓
  Brain generates embeddings in background for stored items
```

The batch size (100) balances write throughput against WAL file growth. At 100 rows per transaction, a 10,000-email initial sync completes in ~100 transactions instead of 10,000 individual writes — roughly 50x faster and with minimal lock contention.

**Protection 2: Pre-Flight Snapshots (Application Level)**

Before any schema migration or major operation, Dina creates a point-in-time backup.

> **CRITICAL WARNING — CVE-level vulnerability:**
> Do **NOT** use the standard SQLite `VACUUM INTO` command for backups. In SQLCipher, `VACUUM INTO 'backup.sqlite'` does **not** inherit the encryption context of the parent database. It produces a **plaintext** copy — completely bypassing the encryption layer. Shipping this would mean every backup vomits secrets into a plaintext file that anyone with filesystem access could read.
>
> Backups **MUST** be performed using `sqlcipher_export()` via the `ATTACH DATABASE` method. This is the only mathematically safe way to back up a SQLCipher database.

```
MIGRATION SAFETY PROTOCOL:

  1. Create encrypted backup using sqlcipher_export():
     ATTACH DATABASE 'vault.v{old_version}.bak' AS backup KEY '<same_key>';
     SELECT sqlcipher_export('backup');
     DETACH DATABASE backup;
     (Keyed-to-Keyed transaction: decrypts page-by-page from main,
      re-encrypts page-by-page into backup. Plaintext never touches disk.)
           ↓
  2. Apply schema changes inside a transaction
           ↓
  3. Run: PRAGMA integrity_check
     (Verifies every page of the database is consistent)
           ↓
  4a. If integrity_check = "ok" → Commit. Delete backup after 24h.
  4b. If integrity_check ≠ "ok" → ROLLBACK. Restore from backup. Alert user.
```

```go
// Go implementation using mutecomm/go-sqlcipher
func (s *Store) SecureBackup(backupPath string, key string) error {
    // 1. Ensure backup file does not exist (SQLite will create it)
    if _, err := os.Stat(backupPath); err == nil {
        os.Remove(backupPath)
    }

    // 2. Atomic Keyed-to-Keyed backup via sqlcipher_export()
    //    ATTACH initializes the new file with encryption header + derived key
    //    before any data is written. sqlcipher_export() decrypts from main
    //    and re-encrypts into backup — plaintext never touches disk.
    query := `
        ATTACH DATABASE ? AS backup KEY ?;
        SELECT sqlcipher_export('backup');
        DETACH DATABASE backup;
    `

    // 3. Execute — same key for seamless restoration
    _, err := s.db.Exec(query, backupPath, key)
    if err != nil {
        return fmt.Errorf("secure backup failed: %w", err)
    }

    return nil
}
```

**CI/CD verification (mandatory):** The backup test suite must attempt to open the resulting `backup.sqlite` as a standard plaintext SQLite file. If the file opens successfully (valid `SQLite format 3\0` header), the build **MUST** fail. This catches any regression where someone replaces `sqlcipher_export()` with `VACUUM INTO`.

This runs automatically on every `dina-core` update. The user never sees it unless something goes wrong — in which case their vault is restored to the state 1 second before the update.

**Protection 3: File System Snapshots (Infrastructure Level)**

For managed hosting (Level 1/2) and power-user self-hosting:

- Format the `/var/lib/dina/vault/` volume as **ZFS** or **Btrfs** (managed hosting: `/var/lib/dina/users/<did>/vault/`)
- Auto-snapshot every 15 minutes (copy-on-write: instant, near-zero space cost until data changes)
- Retain: 24h of 15-minute snapshots, 7 days of hourly, 30 days of daily

Recovery: `zfs rollback dina/vault@15min_ago` — file system instantly reverts to that point in time.

**Protection 4: Off-Site Backup (Network Level)**

Encrypted vault snapshots pushed to remote blob storage (S3, Backblaze, second VPS). Covers disk failure, datacenter outage, theft.

**Protection 5: Deep Archive (Storage Tier 5)**

Immutable cold storage with compliance lock. Covers ransomware, total infrastructure loss, catastrophic operator error.

**The full corruption immunity stack:**

| Threat | Protection | Tech | Recovery Time |
|--------|-----------|------|---------------|
| Power outage mid-write | Atomic commits | `PRAGMA journal_mode=WAL` | Automatic (on restart) |
| Bad migration / code bug | Pre-flight snapshot | `sqlcipher_export()` (Keyed-to-Keyed backup) + integrity check | Seconds (auto-rollback) |
| Accidental deletion / logic bug | File system snapshot | ZFS/Btrfs snapshots (15 min) | Seconds (rollback) |
| Disk failure / hardware death | Off-site backup | Encrypted S3/Backblaze sync | Minutes to hours |
| Ransomware / total destruction | Immutable archive | Tier 5 Deep Archive (Object Lock) | 12-48 hours |

---

