> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Layer 0: Identity

### Root Identity

Every Dina has exactly one root identity — a cryptographic keypair generated during initial setup, stored encrypted on the Home Node, never transmitted in plaintext.

```
Root Identity
├── Root keypair (Ed25519)
├── Created: timestamp
├── Device origin: device fingerprint
├── Recovery (Phase 1): BIP-39 mnemonic (24 words, written on paper)
└── Recovery (Phase 2): Shamir's Secret Sharing (3-of-5, trusted contacts + physical)
```

**Key generation:** Happens locally using device entropy (Secure Enclave on iOS, StrongBox on Android, TPM on desktop). The private key never leaves the hardware security module.

**Recovery (Phase 1):** BIP-39 standard mnemonic phrase. 24 words. User writes them down on paper. This is the baseline backup of the root identity. If you lose both the device and the paper, the identity is gone. This is by design — there is no "password reset" because there is no server that knows your password.

**Recovery (Phase 2): Shamir's Secret Sharing (3-of-5).** The BIP-39 entropy is split into 5 Shamir shares — any 3 reconstruct the seed, no single share reveals anything. Custodians: trusted Dina contacts (Ring 2+), family members' Dinas, physical storage (QR code in a bank safe), self-held (USB). Digital shards are encrypted to each custodian's public key and delivered via Dina-to-Dina NaCl. Recovery flow: contact 3+ custodians → each approves on their Dina → shards reassemble locally → seed restored. Share rotation: re-split with new randomness when trust changes — old shares become mathematically useless. A signed recovery manifest on the PDS lists custodian DIDs (not the shards themselves) so a fresh Dina knows who to contact. SSS is architecturally native to Dina — it leverages existing Trust Rings for custodian eligibility, Dina-to-Dina NaCl for shard transport, and aligns with "Trust No One" (no single custodian can compromise the seed). Implementation: ~100 lines of Go (GF(256) polynomial interpolation), same scheme used by Gnosis Safe and Argent wallet.

**Technology choice: W3C Decentralized Identifiers (DIDs).** Specifically `did:plc` — Bluesky's DID method, proven at scale (30M+ identities). `did:plc` stores a signed operation log in a public directory (the PLC Directory), giving every Dina a globally resolvable, key-rotatable identity with no blockchain dependency. Other Dinas find yours by resolving your DID against the PLC Directory, which returns only your DID Document (public key + service endpoint) — never your name, location, or personal data.

**Why `did:plc`:**
- **Key rotation.** If a key is compromised, the user signs a rotation operation with the old key. The PLC Directory updates the DID Document. No identity loss, no new DID needed.
- **Account recovery.** Recovery keys (stored offline, separate from signing keys) can reclaim a DID even if the primary key is lost. Aligns with BIP-39 recovery philosophy.
- **Go implementation exists.** Bluesky's `indigo` repository provides a production Go implementation of `did:plc` resolution and operations.
- **Proven at scale.** 30M+ identities. The method works.
- **Escape hatch via rotation op.** If Bluesky's PLC Directory ever becomes hostile, a rotation operation can redirect the DID to a `did:web` endpoint the user controls: "I am leaving `did:plc`. My new identity lives at `did:web:dina.alice.com`." The rotation is signed by the user's key — no permission needed from anyone.

**Fallback: `did:web` as escape hatch.** If the PLC Directory becomes unavailable or adversarial, Dina supports `did:web` as a sovereignty escape. A `did:web` identifier resolves to a DID Document hosted at a well-known HTTPS path on the user's domain (e.g., `did:web:dina.alice.com` → `https://dina.alice.com/.well-known/did.json`). It piggybacks on the same Cloudflare/Tailscale ingress the Home Node already has. The tradeoff: `did:web` depends on DNS and a web server, so it's not fully decentralized. Both methods use the same Ed25519 keypair and DID Document format — the rotation op handles the transition transparently.

```
did:plc:z72i7hdynmk6r22z27h6tvur
```

This DID resolves to a DID Document — a small public record containing the public key and service endpoint:

```json
{
    "id": "did:plc:z72i7hdynmk6...",
    "service": [
        {
            "type": "DinaMessaging",
            "serviceEndpoint": "https://dina.alice.com/didcomm"
        }
    ],
    "verificationMethod": [{ "type": "Multikey", "publicKeyMultibase": "z6Mk..." }]
}
```

The endpoint points to the user's Home Node (via tunnel). The PLC Directory only stores the signed operation log — it never holds keys, never reads messages, and can be exited via rotation op at any time.

### Personas (Compartments)

Each persona is a derived keypair from the root, using hierarchical deterministic derivation.

### Key Derivation

Two separate derivation schemes serve two different purposes:

| Component | Purpose | Algorithm | Why |
|-----------|---------|-----------|-----|
| **Master Seed (DEK)** | The Root | BIP-39 mnemonic (24 words, 256-bit entropy) → PBKDF2 → 512-bit seed | Industry standard recovery. The seed IS the DEK — key-wrapped on disk by the passphrase-derived KEK. |
| **Identity Keys** | Signing (`did:plc`), persona keypairs | **SLIP-0010** (Ed25519 hardened derivation) | Ed25519 is incompatible with BIP-32's secp256k1 math. SLIP-0010 provides equivalent HD paths with hardened-only derivation (no unsafe public derivation). |
| **Vault DEKs** | SQLCipher database encryption | **Per-persona HKDF-SHA256** from Master Seed with persona-specific info string (e.g. `"dina:vault:personal:v1"`, `"dina:vault:health:v1"`) | Each persona file has its own 256-bit DEK. Compromise of one persona's DEK does not expose other personas. |

**Why not BIP-32:** BIP-32 uses point addition on the secp256k1 curve. Ed25519 keys use SHA-512 and bit clamping — fundamentally different algebra. Implementing BIP-32 on Ed25519 produces invalid keys or weakens curve security. BIP-32 also allows public derivation (`xpub` → child public keys), which is mathematically unsafe on Ed25519 without complex cryptographic tweaks. SLIP-0010 explicitly disables public derivation (hardened-only) to prevent this.

**SLIP-0010 derivation paths:**

**Namespace isolation:** Dina uses purpose code `9999'` — a high unregistered number that will never collide with BIP-44 (`44'`) cryptocurrency wallet derivation. If a user reuses a BIP-39 mnemonic across a crypto wallet and their Dina node, the cryptographic domains remain mathematically walled off. Purpose `44'` is **strictly forbidden** in Dina derivation paths.

```
BIP-39 Mnemonic (24 words = 256-bit entropy)
    │
    ▼  PBKDF2 (mnemonic + optional passphrase → 512-bit seed)
    │
    Master Seed (512-bit) — this IS the DEK (Data Encryption Key)
    │
    └── SLIP-0010 Ed25519 Hardened Derivation (purpose: 9999')
        │
        ├── m/9999'/0'/...   → Root Signing (purpose 0)
        │   ├── m/9999'/0'/0'  → Root Identity Key gen 0 (signs DID Document)
        │   └── m/9999'/0'/1'  → Root Identity Key gen 1 (after rotation)
        │
        ├── m/9999'/1'/...   → Personas (purpose 1, index/generation)
        │   ├── m/9999'/1'/0'/0'  → /consumer gen 0
        │   ├── m/9999'/1'/1'/0'  → /professional gen 0
        │   ├── m/9999'/1'/2'/0'  → /social gen 0
        │   ├── m/9999'/1'/3'/0'  → /health gen 0
        │   ├── m/9999'/1'/4'/0'  → /financial gen 0
        │   ├── m/9999'/1'/5'/0'  → /citizen gen 0
        │   └── m/9999'/1'/N'/0'  → /custom/* gen 0 (scales to thousands)
        │
        ├── m/9999'/2'/...   → PLC Recovery (purpose 2, secp256k1)
        │   └── m/9999'/2'/0'    → PLC rotation key gen 0
        │
        └── m/9999'/3'/...   → Service Auth (purpose 3)
            ├── m/9999'/3'/0'    → Core signing key
            └── m/9999'/3'/1'    → Brain signing key
```

Each persona's Ed25519 keypair is used for **signing** — the persona's private key signs DIDComm messages and Trust Network entries.

**Vault encryption** uses per-persona DEKs — each persona file has its own 256-bit SQLCipher key:

```
Master Seed (512-bit, from BIP-39)
    │
    ├── HKDF-SHA256(ikm=seed, salt=user_salt, info="dina:vault:identity:v1")
    │       → 256-bit SQLCipher passphrase for identity.sqlite
    │
    ├── HKDF-SHA256(ikm=seed, salt=user_salt, info="dina:vault:personal:v1")
    │       → 256-bit SQLCipher passphrase for personal.sqlite
    │
    ├── HKDF-SHA256(ikm=seed, salt=user_salt, info="dina:vault:health:v1")
    │       → 256-bit SQLCipher passphrase for health.sqlite  (Phase 2)
    │
    ├── HKDF-SHA256(ikm=seed, salt=user_salt, info="dina:vault:financial:v1")
    │       → 256-bit SQLCipher passphrase for financial.sqlite  (Phase 2)
    │
    └── ... (one HKDF derivation per persona)
```

Persona isolation is enforced by **cryptographic separation** — each persona is a separate encrypted file with its own DEK. A locked persona's DEK is not in RAM; the file is opaque bytes. This is not application-level access control — it is file-level crypto.

**Go implementation:** Use `github.com/stellar/go/exp/crypto/derivation` or equivalent SLIP-0010 library. Do not roll custom Ed25519 HD derivation.

**Design decision: Ed25519→X25519 key reuse.** Each persona's Ed25519 signing key is also used for DIDComm encryption by converting it to an X25519 key via libsodium's `crypto_sign_ed25519_sk_to_curve25519`. This is a conscious decision, not an oversight. The Ed25519→X25519 conversion is mathematically well-defined (both curves are birationally equivalent — Ed25519 is a twisted Edwards form of Curve25519), and libsodium explicitly supports and tests this path. The alternative — maintaining separate signing and encryption keypairs per persona — doubles key management complexity, doubles SLIP-0010 derivation paths, and doubles the backup surface, with no practical security benefit for our threat model. This reuse is safe specifically because Ed25519→X25519 is a one-way derivation (the signing key derives the encryption key, not vice versa), and because we use ephemeral X25519 keypairs per message (`crypto_box_seal`), so compromise of any single message's ephemeral key does not compromise the static signing key.

**Critical security property:** Personas are cryptographically unlinkable. Knowing the consumer keypair tells you nothing about the health keypair — hardened derivation means each child key is derived from the parent seed plus an index, with no mathematical relationship between siblings. Even Dina's own code cannot cross compartments without the root key authorizing a specific, logged operation.

**Data isolation: Per-persona files with per-file encryption.** Each persona is a separate SQLCipher-encrypted database with its own DEK. Isolation is enforced by cryptography, not application logic.

```
/var/lib/dina/
├── identity.sqlite              ← Tier 0: contacts, sharing policy, audit log
└── vault/
    ├── personal.sqlite          ← Phase 1: everything here
    ├── health.sqlite            ← Phase 2: separate DEK from HKDF("dina:vault:health:v1")
    ├── financial.sqlite         ← Phase 2: separate DEK from HKDF("dina:vault:financial:v1")
    ├── social.sqlite            ← Phase 2: separate DEK from HKDF("dina:vault:social:v1")
    └── consumer.sqlite          ← Phase 2: separate DEK from HKDF("dina:vault:consumer:v1")
```

**Why per-persona files, not a single vault:**
- **True cryptographic isolation.** "Your health data is encrypted with a different key than your financial data, even on the same machine." One-sentence pitch that non-technical people understand and trust.
- **Locked = invisible, not just access-controlled.** When `/health` is locked, the DEK is not in RAM. The file is opaque bytes. No application bug, no brain compromise, no code path can read it. Math enforces the boundary.
- **Right to delete = `rm`.** `rm data/vault/health.sqlite` — persona physically annihilated. No SQL, no VACUUM, no residual data in shared indices.
- **Selective unlock.** User opens `/financial` for 15 minutes → core derives the DEK, opens the file, serves queries, then closes and zeroes the DEK from RAM. The other persona files are unaffected.
- **Breach containment.** Compromise of one persona file exposes only that persona's data. Attacker still needs the master seed (or that persona's specific DEK) to read other files.

**Cross-persona queries and the Gatekeeper:** The brain needs data from multiple personas constantly (see [Security Model: The Brain is a Guest](#security-model-the-brain-is-a-guest) above). The Sancho Moment nudge at 3 AM needs `/social` (relationship with Sancho, his mother's illness), `/professional` (calendar — is user free?), and `/consumer` (tea preference). That's three persona crosses for one nudge — dozens of times daily.

Core's `gatekeeper.go` manages which databases are open. Brain makes separate API calls per persona: `POST /v1/vault/query {persona: "/social", ...}`. Core routes the query to the correct open database. If the persona is locked, core returns `403 Persona Locked`.

**The model: personas have access tiers, enforced by which databases are open.** Configured in `config.json`, enforced by `gatekeeper.go` in core.

```
Persona Access Tiers (configured by user, stored in config.json):

  "brain_access": {
    "/personal":     "open",        ← always open (Phase 1: everything here)
    "/social":       "open",        ← database open, brain queries freely
    "/consumer":     "open",        ← database open, brain queries freely
    "/professional": "open",        ← database open, brain queries freely
    "/health":       "restricted",  ← database open, but every access logged + user notified
    "/financial":    "locked",      ← database CLOSED. DEK not in RAM. Brain gets 403.
  }
```

| Tier | Behavior | Use Case |
|------|----------|----------|
| **Open** | Database file is open. Brain queries freely. Core serves. Logged but no gate. | Social, consumer, professional — the personas brain needs constantly for nudges. |
| **Restricted** | Database file is open. Brain can query, but core logs every access to `identity.sqlite` audit log AND pushes a silent notification to client device. User sees "Dina accessed your health data 3 times today" in daily briefing. | Health — brain sometimes needs it (e.g., "you have a doctor's appointment"), but user should know when. |
| **Locked** | Database file is **CLOSED**. DEK not in RAM. Brain gets `403 Persona Locked` — must request unlock via client device: `POST /v1/persona/unlock {persona: "/financial", ttl: "15m"}`. Core derives the DEK, opens the file, auto-closes after TTL expires, zeroes DEK from RAM. | Financial — brain almost never needs this. When it does, it's high-stakes (tax filing, insurance claim). Worth the friction. |

**What this fixes:**

1. **Compromised brain can't touch locked personas at all.** The DEK isn't in memory. No amount of application-level bypass can decrypt the file. Math, not code, enforces this.
2. **Restricted personas create a detection trail.** If a compromised brain starts scraping health data, the user sees it in the audit log.
3. **Open personas stay fast.** The nudge flow works without friction for everyday contexts.
4. **Cross-persona queries use parallel reads.** Brain requests data from `/social` + `/professional` + `/consumer`. Core queries each open database independently, merges results. Brain never sees SQLite handles — it gets JSON responses.

**"Which personas have data about Dr. Patel?"** — derived, never cached:

```go
// core/internal/vault/roster.go
func (v *VaultManager) GetPersonasForContact(contactDID string) []string {
    var personas []string
    for name, db := range v.openDatabases {
        var exists bool
        db.QueryRow(
            "SELECT EXISTS(SELECT 1 FROM vault_items WHERE contact_did = ?)",
            contactDID,
        ).Scan(&exists)
        if exists {
            personas = append(personas, name)
        }
    }
    return personas
}
// Only checks UNLOCKED databases. Locked personas are invisible.
// This is a security feature: you shouldn't know what's in a locked persona.
```

**The audit log (`identity.sqlite`, Tier 0) records every persona access:**

```json
{"ts": "2026-02-18T03:15:00Z", "persona": "/health", "action": "query", "requester": "brain", "query_type": "fts", "reason": "nudge_assembly"}
```

**Audit log retention:** Rolling 90-day window (configurable via `config.json`: `"audit": {"retention_days": 90}`). Core's watchdog runs `DELETE FROM audit_log WHERE timestamp < datetime('now', '-90 days')` daily. At ~100 entries/day × 200 bytes, this is ~1.8MB for 90 days — trivial, but unbounded growth is still a bug. Raw entries are kept for forensics (not summarized — "brain accessed /financial 847 times" is useless vs. timestamped entries showing when a suspicious pattern started).

### Zero-Knowledge Proof Credentials (Trust Rings)

**Ring 1 — Unverified Dina:**
- Just the DID. No proof of anything.
- Anyone can create one in seconds.
- Trust ceiling: very low. Small interactions only.

**Ring 2 — Verified Human:**
- User proves they hold a valid government ID without revealing which one.
- Implementation: ZKP circuit that takes as private input the Aadhaar number / SSN / passport number, and outputs a proof that "this is a valid, unique ID number" without revealing the number itself.
- **Current reality check:** India's UIDAI does not currently offer a ZKP-native API. The practical first step is Aadhaar's existing e-KYC XML with offline verification, processed locally on-device, with only a yes/no attestation stored. True ZKP infrastructure (using Semaphore V4 — now production-proven via World ID with 300+ participant trusted setup ceremony) is Phase 2+.
- One government ID = one verified Dina. Prevents Sybil attacks.

**Ring 3 — Skin in the Game:**
- Optional professional/business credentials.
- Verifiable Credentials (W3C VC standard) from LinkedIn, GitHub, business registrations, GST numbers.
- Each credential adds trust weight but reveals only what the user chooses.

```
Trust Score = f(
    ring_level,           // 1, 2, or 3
    time_alive,           // age of this Dina in days
    transaction_anchors,  // verified money moved (count, volume, span)
    outcome_data,         // purchase outcomes fed to Trust Network
    peer_attestations,    // other verified Dinas who vouch
    credential_count      // Ring 3 credentials linked
)
```

### Open Questions — Identity
- **Key rotation:** If root key is compromised, how does the user rotate while preserving trust? Possible: pre-signed rotation certificate stored in recovery.
- **Multi-device root:** ~~Does each device get a copy of the root key, or do devices get delegated sub-keys?~~ **Resolved:** Devices never hold the root key. Root key stays on the Home Node. Compromised device = revoke one device key, not lose root identity. **Implemented:** CLI generates Ed25519 device keypair (`did:key:z6Mk...`). Public key registered during pairing via `public_key_multibase`. Every HTTP request signed with `X-DID`, `X-Timestamp`, `X-Signature` headers. Canonical payload: `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256(body)}`. 5-minute replay window. CLI uses Ed25519 exclusively — no Bearer token fallback. Non-CLI clients (admin web UI) use CLIENT_TOKEN for authentication.
- **Phase 2: Hardware-Backed Device Keys (Secure Enclave).** Phase 1 stores Ed25519 private keys as PEM files on disk (`~/.dina/cli/identity/`, `chmod 0600`). Phase 2 moves key generation and signing into hardware security modules — the private key never leaves the HSM, never enters user-space RAM.

  | Platform | HSM | API | Key Properties |
  |----------|-----|-----|----------------|
  | iOS | Secure Enclave | `SecKeyCreateRandomKey` + `kSecAttrTokenIDSecureEnclave` | Ed25519 key generated inside SE, never exported |
  | Android | StrongBox Keystore | `KeyGenParameterSpec.Builder.setIsStrongBoxBacked(true)` | Hardware-backed, biometric unlock optional |
  | macOS | Secure Enclave | `Security.framework` / `CryptoKit` | T2/Apple Silicon, same API as iOS |
  | Linux | TPM 2.0 | `tpm2-tss` / PKCS#11 | Fallback: encrypted PEM if no TPM |
  | Windows | CNG / NCrypt | `NCryptCreatePersistedKey` | TPM-backed or software KSP |

  Key lifecycle: HSM generates key → public key exported → `did:key:z6Mk...` derived → public key sent during pairing → all signing delegated to HSM (`sign(payload) → signature`). The `CLIIdentity` interface stays the same — backend is swappable. CLI: `dina configure --hsm` auto-detects available HSM; `dina configure --software` forces PEM fallback (for headless servers, VMs, CI — encrypted via PKCS#8 + Argon2id passphrase). Migration from PEM to HSM: `dina configure --promote-to-hsm` generates new keypair inside HSM, re-pairs with Home Node, old PEM key revoked automatically.

- **Seed recovery:** ~~Single point of failure — BIP-39 mnemonic on paper is the only backup. Non-technical users will lose it.~~ **Resolved (Phase 2):** Shamir's Secret Sharing (3-of-5) splits the seed across trusted contacts and physical backups. Day 1 still uses paper mnemonic; SSS activates once the user has a sufficient trust graph.
- **Death detection:** ~~How does the Digital Estate know the user has died? Timer-based dead man's switch?~~ **Resolved:** Human-initiated via SSS custodian coordination. Same Shamir shares used for identity recovery. No timer — avoids false activations. Aligns with real-world probate.

---

