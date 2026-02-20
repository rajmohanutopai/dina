# Dina Core — Test Plan

> Go service (`dina-core`): identity, vault, crypto, transport, gatekeeper, WebSocket, pairing.
> Port 8300 (API), 8100 (admin proxy). Communicates with dina-brain via BRAIN_TOKEN.

---

## 1. Authentication & Authorization

### 1.1 BRAIN_TOKEN (Agent Operations)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Valid BRAIN_TOKEN in `Authorization: Bearer` header | Correct token from `/run/secrets/brain_token` | 200 — request processed |
| 2 | Missing Authorization header | No header | 401 Unauthorized |
| 3 | Malformed header (`Basic` instead of `Bearer`) | `Authorization: Basic <token>` | 401 Unauthorized |
| 4 | Wrong BRAIN_TOKEN value | Random 64-hex string | 401 Unauthorized |
| 5 | Empty Bearer value | `Authorization: Bearer ` | 401 Unauthorized |
| 6 | BRAIN_TOKEN with leading/trailing whitespace | Token with `\n` or spaces | Trimmed and accepted, or 401 if mismatch |
| 7 | Token file missing at startup | `/run/secrets/brain_token` absent | Core refuses to start, exits with error |
| 8 | Token file empty | 0-byte file | Core refuses to start |
| 9 | Timing-attack resistance | Measure response time for wrong vs. correct token | Constant-time comparison (no measurable difference) |

### 1.2 CLIENT_TOKEN (Per-Device Admin Access)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Valid CLIENT_TOKEN | SHA-256 hash matches stored hash | 200 — full admin access |
| 2 | Unknown CLIENT_TOKEN | Hash not in device registry | 401 |
| 3 | Revoked CLIENT_TOKEN | Token previously registered then revoked | 401 |
| 4 | CLIENT_TOKEN on BRAIN_TOKEN-only endpoint | Client token on `/v1/brain/*` | 403 Forbidden |
| 5 | BRAIN_TOKEN on CLIENT_TOKEN-only endpoint | Brain token on `/v1/admin/*` | 403 Forbidden |
| 6 | Concurrent device sessions | Two devices with different CLIENT_TOKENs | Both work independently |
| 7 | CLIENT_TOKEN hash lookup is constant-time | Timing analysis | No measurable difference between valid/invalid |

### 1.3 Browser Session Auth Gateway

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Login with correct passphrase | Argon2id-hashed passphrase matches stored hash | Set-Cookie with session token, redirect to dashboard |
| 2 | Login with wrong passphrase | Incorrect passphrase | 401, no cookie set |
| 3 | Session cookie → Bearer translation | Valid session cookie on proxied request | Core injects `Authorization: Bearer <CLIENT_TOKEN>` |
| 4 | Expired session cookie | Cookie past TTL | 401, redirect to login |
| 5 | CSRF token validation | POST without `X-CSRF-Token` header | 403 |
| 6 | CSRF token mismatch | Wrong CSRF token | 403 |
| 7 | Session fixation resistance | Reuse session ID after login | New session ID generated on successful auth |
| 8 | Concurrent browser sessions | Two browsers, same user | Both sessions valid independently |
| 9 | Logout | POST `/logout` | Cookie cleared, session invalidated server-side |
| 10 | Cookie attributes | Inspect Set-Cookie | `HttpOnly`, `Secure` (when TLS), `SameSite=Strict` |
| 11 | Login rate limit: 5 attempts/min/IP | 6 login attempts in 60s from same IP | 6th attempt → 429, Argon2id slowness (~1s) makes brute force impractical |
| 12 | Session storage: in-memory, lost on restart | Core restarts | All sessions invalidated — users must re-login |
| 13 | Session TTL: 24 hours, configurable | `DINA_SESSION_TTL=3600` (1h) | Session expires after 1h, not default 24h |
| 14 | Session ID generation | Inspect generated session ID | 32 bytes from `crypto/rand`, hex-encoded |
| 15 | Cookie Max-Age matches TTL | Inspect `Set-Cookie` header | `Max-Age=86400` (matches session TTL default) |
| 16 | Successful login → 302 redirect | Correct passphrase submitted | HTTP 302 redirect to `/admin` |
| 17 | Login page: Go embed.FS | GET `/admin` with no session | Static HTML login form from Go binary (`embed.FS`), zero external deps |
| 18 | Device app: Bearer pass-through | `Authorization: Bearer <CLIENT_TOKEN>` on `/admin/*` | Token validated, proxied to brain — no cookie needed |
| 19 | No cookie → login page (not 401) | GET `/admin` without session cookie | Login page served, not 401 |
| 20 | Convenience mode: admin still needs passphrase | Vault auto-unlocked, no browser session | Admin access requires DINA_PASSPHRASE — defense in depth |
| 21 | Brain never sees cookies | Inspect proxied request to brain:8200 | No `Cookie` header forwarded — only `Authorization: Bearer` injected |

### 1.4 Auth Surface Completeness (Kernel Guarantee)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | No third authentication mechanism exists | Enumerate all middleware/auth handlers in source | Only BRAIN_TOKEN and CLIENT_TOKEN code paths — no API keys, no OAuth from external IdP |
| 2 | Unknown auth scheme ignored | `Authorization: ApiKey abc123` | 401 — scheme not recognized, no handler |
| 3 | External JWT rejected | Valid JWT from external identity provider | 401 — core does not validate external JWTs |
| 4 | Route enumeration shows no plugin endpoints | List all registered HTTP routes | No `/v1/plugins`, `/v1/extensions`, `/v1/hooks`, or similar |
| 5 | `identifyToken()` priority: BRAIN_TOKEN first | Present BRAIN_TOKEN | Constant-time comparison checked before SHA-256 DB lookup (prevents timing leak) |
| 6 | `identifyToken()` fallback: CLIENT_TOKEN second | Present CLIENT_TOKEN | `SHA-256(token)` → lookup in `device_tokens WHERE revoked = 0` |
| 7 | `isAdminEndpoint()` allowlist — BRAIN_TOKEN rejected on admin paths | BRAIN_TOKEN on `/v1/did/sign`, `/v1/did/rotate`, `/v1/vault/backup`, `/v1/persona/unlock`, `/admin/*` | 403 Forbidden on every admin endpoint |
| 8 | CLIENT_TOKEN accepted on all endpoints | CLIENT_TOKEN on admin + non-admin paths | 200 — full access including admin |
| 9 | Core never calls external APIs | Code audit: grep for outbound HTTP clients (no OAuth, Gmail, connector calls) | Zero external API calls — core is the sovereign kernel |

### 1.5 Compromised Brain Damage Radius

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Compromised brain: can access open personas | BRAIN_TOKEN + vault query for open persona | 200 — data returned (this is the expected damage radius) |
| 2 | Compromised brain: cannot access locked personas | BRAIN_TOKEN + vault query for locked persona | 403 Persona Locked — DEK not in RAM |
| 3 | Compromised brain: restricted creates detection trail | BRAIN_TOKEN + vault query for restricted persona | 200 — served, but audit entry + daily briefing notification created |
| 4 | Compromised brain: cannot call did/sign | BRAIN_TOKEN + `POST /v1/did/sign` | 403 — admin endpoint, BRAIN_TOKEN rejected |
| 5 | Compromised brain: cannot call did/rotate | BRAIN_TOKEN + `POST /v1/did/rotate` | 403 |
| 6 | Compromised brain: cannot call vault/backup | BRAIN_TOKEN + `POST /v1/vault/backup` | 403 |
| 7 | Compromised brain: cannot call persona/unlock | BRAIN_TOKEN + `POST /v1/persona/unlock` | 403 |
| 8 | Compromised brain: cannot bypass PII scrubber | BRAIN_TOKEN + request that should be scrubbed | PII scrubber runs in core pipeline — brain cannot skip it |
| 9 | Compromised brain: cannot access raw vault files | Brain container filesystem | No SQLite files mounted — brain accesses vault only via core API |

---

## 2. Key Derivation & Cryptography

### 2.1 BIP-39 Mnemonic Generation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Generate 24-word mnemonic | First-run key generation | Valid BIP-39 English wordlist, 256 bits entropy |
| 2 | Mnemonic → seed derivation | Known test vector mnemonic | PBKDF2-HMAC-SHA512, 2048 iterations → known 512-bit seed |
| 3 | Invalid mnemonic (bad checksum) | Mnemonic with wrong last word | Rejected with error |
| 4 | Invalid mnemonic (wrong word count) | 12-word mnemonic where 24 expected | Rejected |
| 5 | Mnemonic with extra whitespace | Words separated by multiple spaces | Normalized and accepted |
| 6 | Master seed IS the DEK | Inspect after mnemonic → PBKDF2 | 512-bit seed used directly as key material — key-wrapped on disk by Argon2id-derived KEK (AES-256-GCM) |
| 7 | Mnemonic recovery: re-derive everything | Enter same 24-word mnemonic on new install | Identical root keypair, identical persona keys, identical vault DEKs — full identity restored |
| 8 | Mnemonic recovery: BIP-39 → seed → SLIP-0010 → same DID | Enter known test mnemonic | Same `did:plc` identity as original — DID preserved across recovery |
| 9 | Lose device + paper = identity gone | No mnemonic, no device backup | Identity unrecoverable — by design, no password reset, no server-side recovery |
| 10 | Root identity never transmitted in plaintext | Network capture on all interfaces during full operation | Master seed, mnemonic, and DEKs never appear in any network traffic |

### 2.2 SLIP-0010 Ed25519 Hardened Derivation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Derive root identity key | Path `m/9999'/0'` | Deterministic Ed25519 keypair |
| 2 | Derive persona N key | Path `m/9999'/N'` (N=1,2,3...) | Unique keypair per persona index |
| 3 | Determinism | Same seed, same path, two runs | Identical keypair both times |
| 4 | Different paths → different keys | `m/9999'/0'` vs `m/9999'/1'` | Different keypairs |
| 5 | Hardened-only enforcement | Attempt non-hardened path `m/9999/0` | Rejected — only hardened derivation allowed |
| 6 | Known test vectors | SLIP-0010 spec test vectors | Output matches published vectors exactly |
| 7 | Purpose `9999'` namespace isolation | Derive at `m/9999'/0'` and `m/44'/0'` from same seed | Different keypairs — Dina purpose `9999'` never collides with BIP-44 `44'` |
| 8 | Purpose `44'` STRICTLY FORBIDDEN | Attempt `m/44'/0'` derivation via Dina API | Rejected with error — purpose `44'` explicitly blocked to prevent crypto wallet key collision |
| 9 | Same mnemonic across Dina + crypto wallet | Reuse BIP-39 mnemonic in both | `m/9999'/*` (Dina) and `m/44'/*` (wallet) produce mathematically independent key trees |
| 10 | Sibling key unlinkability | Derive `m/9999'/1'` and `m/9999'/2'` | No mathematical relationship between siblings — hardened derivation prevents computing one from the other |
| 11 | Go implementation: stellar/go library | Code audit | Uses `github.com/stellar/go/exp/crypto/derivation` or equivalent — no custom HD derivation |
| 12 | Canonical persona index mapping | Derive all default persona keys | `m/9999'/0'` = root identity, `m/9999'/1'` = consumer, `m/9999'/2'` = professional, `m/9999'/3'` = social, `m/9999'/4'` = health, `m/9999'/5'` = financial, `m/9999'/6'` = citizen — indexes match architecture spec exactly |
| 13 | Custom persona index: sequential from 7 | User creates first custom persona | Assigned `m/9999'/7'` — next unused index after built-in personas (0-6) |
| 14 | Persona index stored in identity.sqlite | Inspect `personas` table after creation | Each persona record includes `derivation_index` column — maps persona name to SLIP-0010 path index |

### 2.3 HKDF-SHA256 (Vault DEK Derivation)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Derive per-persona DEK | Master seed + persona ID as info | 256-bit key suitable for SQLCipher |
| 2 | Different personas → different DEKs | Same seed, persona "work" vs "personal" | Different keys |
| 3 | Determinism | Same inputs, two derivations | Identical DEK |
| 4 | Known HKDF test vectors | RFC 5869 test vectors | Output matches |
| 5 | Full info string set | Derive DEKs for all persona types | `dina:vault:identity:v1`, `dina:vault:personal:v1`, `dina:vault:health:v1`, `dina:vault:financial:v1`, `dina:vault:social:v1`, `dina:vault:consumer:v1` — each produces unique 256-bit DEK |
| 6 | Compromise isolation | Attacker obtains `health` DEK | Cannot derive `financial` DEK — HKDF with different info string produces mathematically independent keys |
| 7 | Custom persona info string | User creates `/custom/research` persona | Info string `dina:vault:custom_research:v1` — follows naming convention |
| 8 | Backup Encryption Key | Derive backup key | `HKDF(info="dina:backup:v1")` → wraps persona file snapshots for off-node backup |
| 9 | Archive Key (Tier 5) | Derive archive key | `HKDF(info="dina:archive:v1")` → wraps full vault snapshots for cold storage |
| 10 | Archive Key separate from Backup Key | Rotate backup key | Archive key unaffected — archive survives backup key rotation |
| 11 | Client Sync Key | Derive sync key | `HKDF(info="dina:sync:v1")` → encrypts vault cache pushes to client devices |
| 12 | Reputation Signing Key | Derive reputation key | `HKDF(info="dina:reputation:v1")` → signs anonymized outcome data |
| 13 | `user_salt` is random 32-byte value | Inspect HKDF call parameters | HKDF uses `salt=user_salt` (a random 32-byte value generated at first setup), not `salt=nil` — prevents identical DEKs across Dina nodes that reuse the same BIP-39 mnemonic |
| 14 | `user_salt` generated once at first setup | First-run key generation | 32 bytes from `crypto/rand`, stored in identity.sqlite (unencrypted — salt is not secret, it provides uniqueness) |
| 15 | `user_salt` persisted across reboots | Restart core → derive DEKs | Same `user_salt` retrieved from identity.sqlite → same DEKs → vault files open correctly |
| 16 | `user_salt` included in export | `dina export` produces archive | `user_salt` preserved in export — required for DEK re-derivation on import |
| 17 | Same mnemonic, different `user_salt` → different DEKs | Two Dina nodes, same BIP-39 mnemonic, different `user_salt` | HKDF outputs are different — persona vaults on Node A cannot be decrypted by Node B even with identical mnemonic |
| 18 | `user_salt` absent → startup error | Delete `user_salt` from identity.sqlite | Core refuses to derive DEKs — clear error: "user_salt missing, vault cannot be opened" |

### 2.4 Argon2id (Passphrase Hashing)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Hash passphrase | "correct horse battery staple" | Argon2id hash with embedded salt |
| 2 | Verify correct passphrase | Correct passphrase + stored hash | Verification passes |
| 3 | Verify wrong passphrase | Wrong passphrase + stored hash | Verification fails |
| 4 | Default parameters | Inspect hash output | `memory_mb=128` (128 MiB), `iterations=3` (OWASP 2024 min is 2), `parallelism=4` |
| 5 | Unique salts | Hash same passphrase twice | Different hash outputs (random 16-byte salt, stored alongside wrapped blob) |
| 6 | Parameters configurable via config.json | Set `{"argon2id": {"memory_mb": 256, "iterations": 5, "parallelism": 8}}` | Custom params used instead of defaults |
| 7 | Runs once at unlock, not per-request | Vault unlock → measure timing | KEK derived once (~1-2s), stays in RAM for process lifetime — subsequent requests don't re-derive |
| 8 | Passphrase change: re-wrap only | Change passphrase | Master seed re-wrapped with new KEK (Argon2id(new_passphrase) → new KEK → re-encrypt blob) — no re-encryption of multi-GB databases |

### 2.5 Ed25519 Signing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Sign message | Known message + private key | Valid Ed25519 signature |
| 2 | Verify valid signature | Message + signature + public key | Verification passes |
| 3 | Verify tampered message | Modified message + original signature | Verification fails |
| 4 | Verify wrong public key | Message + signature + different key | Verification fails |
| 5 | Canonical JSON signing | Sign `json.Marshal` with sorted keys, no signature fields | Deterministic canonical form |
| 6 | Empty message signing | Empty byte slice | Valid signature (not rejected) |

### 2.6 Ed25519 → X25519 Conversion

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Convert signing key to encryption key | Ed25519 private key | Valid X25519 private key via `crypto_sign_ed25519_sk_to_curve25519` |
| 2 | Convert public key | Ed25519 public key | Valid X25519 public key via `crypto_sign_ed25519_pk_to_curve25519` |
| 3 | Roundtrip: sign then encrypt | Ed25519 sign → X25519 encrypt → decrypt → verify | All operations succeed |
| 4 | One-way property | X25519 private key | Cannot derive original Ed25519 signing key from X25519 encryption key — one-way derivation |
| 5 | Ephemeral per message | Two `crypto_box_seal` calls to same recipient | Each uses fresh ephemeral X25519 keypair — compromise of one message's ephemeral key doesn't expose static signing key |
| 6 | Conscious reuse (not separate keypairs) | Code audit | Single Ed25519 keypair per persona → derived X25519 for encryption. Not separate signing + encryption keypairs (doubles complexity, no practical benefit) |
| 7 | Ephemeral X25519 key zeroed from memory after `crypto_box_seal` | Send D2D message → inspect process memory (test env) | Ephemeral private key destroyed immediately after encryption — not resident in RAM after send completes. Architecture guarantee: "Ephemeral private key destroyed immediately (sender forward secrecy)" |

### 2.7 NaCl crypto_box_seal (Dina-to-Dina Encryption)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Seal message to recipient | Plaintext + recipient X25519 pubkey | Ciphertext (ephemeral sender key embedded) |
| 2 | Open sealed message | Ciphertext + recipient keypair | Original plaintext recovered |
| 3 | Wrong recipient key | Ciphertext + different recipient keypair | Decryption fails |
| 4 | Tampered ciphertext | Modified ciphertext bytes | Decryption fails (authentication failure) |
| 5 | Empty plaintext | Seal empty message | Valid ciphertext, decrypts to empty |
| 6 | Large message | 1 MiB plaintext | Seal and open succeed |

### 2.8 AES-256-GCM Key Wrapping (Keystore)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Wrap key with passphrase-derived KEK | DEK + Argon2id(passphrase) | Wrapped blob (nonce + ciphertext + tag) |
| 2 | Unwrap with correct passphrase | Wrapped blob + correct passphrase | Original DEK recovered |
| 3 | Unwrap with wrong passphrase | Wrapped blob + wrong passphrase | Decryption fails |
| 4 | Tampered wrapped blob | Modified bytes | Authentication failure |
| 5 | Nonce uniqueness | Wrap same key twice | Different wrapped outputs (random nonce) |

---

## 3. Identity (DID)

### 3.1 DID Generation & Persistence

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Generate root DID | First-run | `did:plc` identity registered with PLC Directory from SLIP-0010 `m/9999'/0'` Ed25519 pubkey |
| 2 | Load existing DID | Subsequent startup | Same `did:plc` as initial generation |
| 3 | DID Document structure | Resolve own DID | Contains: `id`, `service` (type `DinaMessaging`, endpoint → Home Node URL), `verificationMethod` (type `Multikey`, `publicKeyMultibase: z6Mk...`) |
| 4 | Multiple persona DIDs | Create personas "work", "personal" | Different DIDs, each derived from unique SLIP-0010 path |
| 5 | DID Document service endpoint | Resolve DID | Endpoint points to Home Node via Cloudflare/Tailscale tunnel — not to PLC Directory |
| 6 | PLC Directory: signed operation log only | Inspect PLC Directory entry | Only stores signed ops — never holds private keys, never reads messages, never stores personal data |
| 7 | Exactly one root identity: second generation rejected | Call first-run setup when root DID already exists | Rejected with error — "root identity already exists". No overwrite, no second root |
| 8 | Root identity: `created_at` timestamp stored | Inspect identity after first-run | Root identity record includes `created_at` timestamp (Unix epoch) — documents when this Dina was born |
| 9 | Root identity: device origin fingerprint stored | Inspect identity after first-run | `device_origin` field records generating device fingerprint (or "unknown" if no HSM) — forensic audit trail |
| 10 | DID Document `verificationMethod`: Multikey with `z6Mk` prefix | Resolve own DID, inspect `publicKeyMultibase` | Prefix `z6Mk` encodes Ed25519 per Multikey specification — wrong prefix (e.g., `z6LS` for X25519) means wrong key type published |

### 3.1.1 Key Rotation (`did:plc`)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Rotate signing key | Old key compromised → sign rotation op with old key | PLC Directory updates DID Document with new public key |
| 2 | Rotation preserves DID | After key rotation | Same `did:plc:z72i7h...` identifier — no identity loss, no new DID |
| 3 | Old key invalid after rotation | Use old key to sign after rotation | Signature verification fails — old key no longer authoritative |
| 4 | Rotation op: signed by old key | Inspect rotation operation | Must be signed by current (old) signing key — PLC Directory rejects unsigned rotations |
| 5 | Recovery keys can reclaim DID | Primary key lost, recovery key available | Recovery key (stored offline, separate from signing key) signs reclaim op → DID recovered |

### 3.1.2 `did:web` Fallback (Escape Hatch)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | `did:web` resolution | `did:web:dina.alice.com` | Resolves to `https://dina.alice.com/.well-known/did.json` — DID Document returned |
| 2 | `did:web` uses same keypair | Compare `did:plc` and `did:web` keys | Same Ed25519 keypair, same DID Document format |
| 3 | Rotation from `did:plc` → `did:web` | PLC Directory becomes adversarial | Signed rotation op redirects DID to `did:web` endpoint user controls — no permission needed |
| 4 | `did:web` piggybacks on existing ingress | Inspect `did:web` hosting | Served via same Cloudflare/Tailscale tunnel Home Node already has |
| 5 | `did:web` tradeoff acknowledged | Architecture review | Depends on DNS + web server — not fully decentralized. Documented as escape hatch, not primary |

### 3.2 Persona Management

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Create persona | Name "work", tier "restricted" | New SLIP-0010 derived key, new SQLCipher vault file at `/var/lib/dina/vault/work.sqlite`, persona registered |
| 2 | List personas | GET `/v1/personas` | Array of persona objects with name, DID, tier, created_at |
| 3 | Delete persona | DELETE persona by ID | Vault file securely wiped, keys removed, DID deactivated |
| 4 | Right to delete: file removal = annihilation | `rm data/vault/health.sqlite` | Persona physically destroyed — no SQL needed, no VACUUM, no residual data |
| 5 | Persona isolation | Write to persona A, read from persona B | Data not visible across personas |
| 6 | Default persona exists | After first setup | At least one "default" `/personal` persona |
| 7 | Per-persona file layout | Inspect `/var/lib/dina/` | `identity.sqlite` (Tier 0) + `vault/personal.sqlite`, `vault/health.sqlite`, etc. — one file per persona |
| 8 | Per-persona independent DEK | Compromise `health.sqlite` DEK | Cannot decrypt `financial.sqlite` — different HKDF info string → different key |
| 9 | Locked persona: file is opaque bytes | Inspect vault file when persona locked | DEK not in RAM — no application bug, no brain compromise, no code path can read it |
| 10 | Selective unlock with TTL | Unlock `/financial` for 15 min | Core derives DEK → opens file → serves queries → closes after TTL → zeroes DEK from RAM |
| 11 | Persona Ed25519 key signs DIDComm (NOT root key) | Persona `/social` sends DIDComm message | Signature verifies against `/social` persona pubkey (`m/9999'/3'`), NOT root pubkey (`m/9999'/0'`) — verify both: signature valid with persona key, signature INVALID with root key |
| 12 | Persona Ed25519 key signs Reputation Graph entries (NOT root key) | Persona publishes attestation | Signed by persona key (e.g., `/consumer` at `m/9999'/1'`), verifiable against persona's DID Document — root key cannot sign on behalf of persona |
| 13 | Even Dina's code cannot cross compartments | Code audit | No code path reads persona B data using persona A's context without root key + logged operation |

### 3.3 Persona Gatekeeper (Tier Enforcement)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Access Open-tier persona | Any authenticated request | 200 — immediate access |
| 2 | Access Restricted-tier persona | Authenticated request | 200 — access granted, event logged, notification sent |
| 3 | Access Locked-tier persona | Request without prior unlock | 403 — DEK not in RAM |
| 4 | Unlock Locked persona | Provide passphrase, TTL=300s | DEK loaded to RAM, 200 on subsequent requests |
| 5 | Locked persona TTL expiry | Wait past TTL after unlock | DEK zeroed from RAM, subsequent requests → 403 |
| 6 | Locked persona re-lock | Explicit re-lock command | DEK zeroed immediately |
| 7 | Audit log for Restricted access | Access restricted persona | Append-only audit entry with timestamp, accessor, action |
| 8 | Notification on Restricted access | Access restricted persona | Notification dispatched to owner |
| 9 | Locked persona unlock flow | Brain calls `POST /v1/persona/unlock {persona: "financial"}` | Core asks human (via WS/push) → human approves with TTL → DEK loaded → brain can query for TTL window |
| 10 | Locked persona unlock: human denies | Human rejects unlock request | 403 persists, brain notified of denial |
| 11 | Locked persona unlock: TTL expires | Human approved with TTL=300s, 5 min pass | DEK zeroed, subsequent requests → 403 again |
| 12 | Cross-persona query: parallel reads | Brain requests `/social` + `/professional` + `/consumer` simultaneously | Core queries each open database independently, merges results — brain gets JSON responses, never SQLite handles |
| 13 | `GetPersonasForContact()`: derived, never cached | Query "which personas have data about Dr. Patel?" | Core scans all OPEN databases: `SELECT EXISTS(SELECT 1 FROM vault_items WHERE contact_did = ?)` — result computed live, not cached |
| 14 | `GetPersonasForContact()`: locked invisible | Query for contact with data in `/financial` (locked) | `/financial` excluded from results — locked personas are invisible, not "access denied" |
| 15 | Tier configuration stored in config.json | Inspect config.json `brain_access` field | `{"/personal": "open", "/health": "restricted", "/financial": "locked", ...}` |

### 3.4 Contact Directory

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Add contact | DID + display name + trust level | Contact stored with per-persona routing rules |
| 2 | Resolve contact DID | Lookup by display name | Returns DID + current service endpoints |
| 3 | Update contact trust level | Change from Unverified → Verified | Trust level updated, sharing policies may change |
| 4 | Delete contact | Remove by DID | Contact removed, associated sharing policies cleaned |
| 5 | Per-persona contact routing | Contact mapped to persona "work" | Messages from contact route to work persona only |
| 6 | Contacts table: NO `persona` column | Inspect `contacts` DDL in identity.sqlite | `contacts` table has NO `persona` column — people are cross-cutting, they span contexts (Dr. Patel sends lab results AND cricket chat). Contact-persona association is derived from vault data, not stored as a column |
| 7 | Contacts table: full schema validation | Inspect `contacts` DDL | `did TEXT PRIMARY KEY, name TEXT, alias TEXT, trust_level TEXT DEFAULT 'unknown', sharing_policy TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP` — all columns present with correct types and defaults |
| 8 | Trust level enum validation | `POST /v1/contacts` with `trust_level: "super_trusted"` | 400 Bad Request — only 'blocked', 'unknown', 'trusted' accepted |
| 9 | `idx_contacts_trust` index exists | Inspect identity.sqlite schema | `CREATE INDEX idx_contacts_trust ON contacts(trust_level)` — must exist for efficient bulk policy queries |

### 3.5 Device Registry

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Register device | Device name + CLIENT_TOKEN hash | Device added to registry |
| 2 | List devices | GET `/v1/devices` | Array of registered devices with last-seen timestamps |
| 3 | Revoke device | Revoke by device ID | CLIENT_TOKEN hash removed, future requests rejected |
| 4 | Max device limit | Register beyond limit (e.g., 10) | 429 or 400 — limit enforced |

### 3.6 Recovery (Shamir's Secret Sharing)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Split master seed | 3-of-5 threshold | 5 shares generated, any 3 reconstruct seed |
| 2 | Reconstruct with threshold shares | 3 valid shares | Original master seed recovered |
| 3 | Reconstruct with fewer than threshold | 2 shares | Reconstruction fails |
| 4 | Reconstruct with invalid share | 2 valid + 1 corrupted | Reconstruction fails or produces wrong seed (detected by checksum) |
| 5 | Share format | Inspect share bytes | Includes share index, threshold metadata |

---

## 4. Vault (SQLCipher)

### 4.1 Vault Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Create new vault | New persona | SQLCipher `.sqlite` file created with per-persona DEK |
| 2 | Open existing vault | Startup with existing vault files | Vault opened, DEK derived, schema validated |
| 3 | Open with wrong DEK | Incorrect passphrase/seed | `SQLITE_NOTADB` error — cannot decrypt |
| 4 | Schema migration | Vault with older schema version | DDL migrations applied in order |
| 5 | Concurrent access | Two goroutines reading/writing | WAL mode handles concurrency, no corruption |
| 6 | SQLCipher PRAGMAs on every connection | Open any vault, inspect PRAGMAs | `cipher_page_size=4096`, `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000` |
| 7 | WAL crash recovery | Kill process mid-write | On restart: incomplete `-wal` file rolled back automatically, `.sqlite` untouched |
| 8 | `synchronous=NORMAL` in WAL mode | Inspect PRAGMA | NORMAL (not FULL) — safe in WAL mode, significantly faster |
| 9 | `foreign_keys=ON` | Insert violating foreign key | Rejected — prevents orphaned data |
| 10 | `busy_timeout=5000` | Concurrent write attempt | Waits up to 5s for lock instead of immediate `SQLITE_BUSY` |

### 4.1.1 Connection Pool (Multi-Database Vault Manager)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | VaultManager structure | Inspect at runtime | `identity` pool (always open) + `personas` map keyed by name (protected by `sync.RWMutex`) |
| 2 | Write connection: single-writer | Two concurrent writes to same persona | Serialized via `MaxOpenConns=1` on writeConn — second write waits (up to `busy_timeout`) |
| 3 | Read pool: multiple readers | 10 concurrent reads to same persona | All served simultaneously via readPool (`MaxOpenConns = cpu_count * 2`) |
| 4 | Read connections: query_only | Attempt write on read connection | `PRAGMA query_only=ON` prevents accidental writes — error returned |
| 5 | Write autocheckpoint | Heavy write load | `wal_autocheckpoint=1000` — WAL checkpointed every ~4MB, preventing unbounded WAL growth |
| 6 | Cross-persona write independence | Bulk ingest into `/personal` while querying `/health` | Fully independent — different files, different write connections, zero contention |
| 7 | Concurrent readers during write | Write in progress, read request arrives | WAL allows concurrent readers — read sees committed state, write continues |

### 4.2 Vault CRUD (Items)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Store item | Category + JSON payload | Item stored with auto-generated ID, timestamps |
| 2 | Retrieve item by ID | Valid item ID | Full item returned |
| 3 | Retrieve non-existent item | Random UUID | 404 |
| 4 | Update item | Existing ID + new payload | Updated, `updated_at` changed |
| 5 | Delete item | Existing ID | Soft-delete or hard-delete per policy |
| 6 | List items by category | Category filter | Only items in that category returned |
| 7 | Pagination | `limit=10&offset=20` | Correct page of results |
| 8 | Item size limit | Payload exceeding max (e.g., 10 MiB) | 413 or 400 — rejected |

### 4.2.1 Schema Compliance (identity.sqlite)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | `contacts` table: global, no persona field | Inspect schema | `contacts(did TEXT PRIMARY KEY, name, alias, trust_level, sharing_policy, created_at, updated_at)` — NO persona column (contacts are cross-cutting) |
| 2 | `contacts.trust_level` enum | Insert `trust_level = 'invalid'` | Rejected or constrained to `blocked`, `unknown`, `trusted` |
| 3 | `contacts.sharing_policy` is JSON | Insert JSON blob | Valid JSON stored and retrievable |
| 4 | `idx_contacts_trust` index exists | Inspect schema | `CREATE INDEX idx_contacts_trust ON contacts(trust_level)` |
| 5 | `audit_log` table schema | Inspect | `(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp, persona, action, requester, query_type, reason, metadata)` |
| 6 | `kv_store` table for sync cursors | Store and retrieve cursor | `kv_store(key TEXT PRIMARY KEY, value TEXT, updated_at)` — brain is stateless, cursors live here |
| 7 | `device_tokens` table: SHA-256 hash | Inspect token_hash | `SHA-256(CLIENT_TOKEN)` hex-encoded — NOT Argon2id (256-bit random input has no brute-force risk) |
| 8 | `device_tokens` partial index | Inspect schema | `CREATE INDEX idx_device_tokens_hash ON device_tokens(token_hash) WHERE revoked = 0` — only active tokens indexed |
| 9 | `crash_log` table schema | Inspect identity.sqlite | `crash_log(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, error TEXT, traceback TEXT, task_id TEXT)` — stores brain crash tracebacks encrypted at rest (Section 04 §Observability). traceback contains Python locals (PII risk) — only safe because identity.sqlite is SQLCipher-encrypted |

### 4.2.2 Schema Compliance (persona vault)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | `vault_items` required columns | Inspect schema | `(id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, source_id, contact_did, summary, body_text, timestamp INTEGER NOT NULL, ingested_at INTEGER NOT NULL, metadata TEXT)` |
| 2 | `vault_items_fts` FTS5 table | Inspect schema | `CREATE VIRTUAL TABLE vault_items_fts USING fts5(body_text, summary, content=vault_items, content_rowid=rowid, tokenize='unicode61 remove_diacritics 1')` |
| 3 | FTS5 tokenizer: `unicode61` enforced | Inspect FTS5 config | `unicode61 remove_diacritics 1` — multilingual (Hindi, Tamil, Kannada) |
| 4 | Porter stemmer FORBIDDEN | Code audit | No `tokenize='porter'` anywhere — English-only, mangles non-Latin scripts |
| 5 | FTS5 index encrypted by SQLCipher | Inspect FTS5 tables on disk | Encrypted at rest — no plaintext leakage from FTS shadow tables |
| 6 | `relationships` table | Inspect schema | `(id TEXT PRIMARY KEY, entity_name, entity_type, last_interaction INTEGER, interaction_count INTEGER, notes TEXT)` |
| 7 | `vault_items.type` allowed values enforced | `INSERT INTO vault_items` with `type = 'invalid_type'` | Rejected (CHECK constraint or application validation) — only `'email'`, `'message'`, `'event'`, `'note'`, `'photo'` accepted per architecture schema |
| 8 | `relationships.entity_type` allowed values enforced | `INSERT INTO relationships` with `entity_type = 'alien'` | Rejected — only `'person'`, `'org'`, `'bot'` accepted per architecture schema |
| 9 | FTS5 content-sync: INSERT propagates | `INSERT INTO vault_items` (new email) → `SELECT * FROM vault_items_fts WHERE vault_items_fts MATCH 'keyword'` | FTS5 index updated — new item found via FTS5 search. With `content=vault_items` FTS5, triggers or manual sync commands must propagate changes |
| 10 | FTS5 content-sync: UPDATE propagates | `UPDATE vault_items SET body_text = 'new text' WHERE id = ?` → FTS5 search for 'new text' | Updated text found via FTS5 — old text no longer matches. Requires DELETE old + INSERT new in FTS5 shadow table |
| 11 | FTS5 content-sync: DELETE propagates | `DELETE FROM vault_items WHERE id = ?` → FTS5 search for deleted item's text | No results — deleted item removed from FTS5 index. Stale FTS5 entries never returned |
| 12 | Schema version: identity.sqlite | Inspect identity.sqlite metadata | Schema version `v1` stored and verifiable — matches `-- DINA IDENTITY SCHEMA (v1)` in architecture DDL |
| 13 | Schema version: persona vault | Inspect persona vault metadata | Schema version `v3` stored and verifiable — matches `-- DINA VAULT SCHEMA (v3)` in architecture DDL. Core detects version mismatch on open → triggers migration |

### 4.2.3 Batch Ingestion

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Batch store: 100 items | `POST /v1/vault/store/batch` with 100 items | Single transaction: BEGIN → INSERT 100 → COMMIT — atomically stored |
| 2 | Batch performance | 10K items via 100 batches of 100 | ~100 transactions instead of 10K individual writes — ~50x faster |
| 3 | Batch failure: rollback | 100 items, item #50 violates constraint | Entire batch rolled back — no partial insert |
| 4 | Batch during concurrent reads | Batch write to `/personal` + concurrent search | WAL allows readers during batch write — search returns committed data |
| 5 | Batch ingestion + embedding generation | Brain stores batch, then generates embeddings in background | Items available for FTS5 immediately; embeddings arrive later for semantic search |

### 4.3 Vault Search (FTS5 + sqlite-vec)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | FTS5 keyword search | `POST /v1/vault/query {mode: "fts5", q: "battery life"}` | FTS5 results ranked by `unicode61` tokenizer relevance |
| 2 | Semantic vector search | `POST /v1/vault/query {mode: "semantic", q: "..."}` | Brain-provided embedding → sqlite-vec cosine similarity, top-K neighbors |
| 3 | Hybrid search (default) | `POST /v1/vault/query {mode: "hybrid", q: "..."}` | Both engines, merged + deduplicated, `relevance = 0.4 × fts5_rank + 0.6 × cosine_similarity` |
| 4 | Hybrid search formula verified | Known items with known FTS5 + cosine scores | `relevance` field matches `0.4 × fts5 + 0.6 × cosine` formula |
| 5 | Empty results | Query with no matches | `{"items": [], "pagination": {"has_more": false}}`, not error |
| 6 | Search across persona boundary | Search persona A data from persona B context | No cross-persona results |
| 7 | FTS5 injection | Query `"*" OR 1=1 --` | Safely handled, no SQL injection |
| 8 | `include_content: false` (default) | Query without flag | Response contains `summary` only, no `body_text` (safe path) |
| 9 | `include_content: true` | Query with `include_content: true` | Response includes raw `body_text` — caller responsible for PII scrubbing before cloud LLM |
| 10 | Filter by types | `filters: {types: ["email", "calendar"]}` | Only matching item types returned |
| 11 | Filter by time range | `filters: {after: "2026-01-01", before: "2026-02-01"}` | Only items within range |
| 12 | Limit default 20 | Query without `limit` field | Max 20 items returned |
| 13 | Limit max 100 | `limit: 200` | Capped at 100, or 400 error |
| 14 | Pagination | `offset: 20, limit: 20` | Correct page, response `has_more` + `next_offset` |
| 15 | Locked persona → structured 403 | Query locked persona | `{"error": "persona_locked", "message": "/financial requires CLIENT_TOKEN approval", "code": 403}` |
| 16 | Simple search fast path (core alone) | Client WS query "find emails from Sancho" | Core handles FTS5 directly — no brain involved, sub-10ms |
| 17 | Semantic search (brain orchestrates) | Complex query needing reasoning | Core routes to brain → brain generates embedding → brain calls `/v1/vault/query` → brain merges + reasons → response |

### 4.3.1 Embedding Migration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Embedding model tracked in metadata | Inspect vault system table | `embedding_model` column stores model name + version (e.g., `EmbeddingGemma:1.0`) |
| 2 | Model change detected | New model configured, core starts | Core detects mismatch between stored `embedding_model` and configured model |
| 3 | Re-index triggered | Model change detected | Core drops sqlite-vec index → triggers background re-embed job via brain |
| 4 | FTS5 available during re-indexing | Model change, re-embed in progress | FTS5 keyword search works normally — only semantic search temporarily unavailable |
| 5 | Re-embed completes | Brain processes all items in batches | sqlite-vec index rebuilt, semantic search restored |
| 6 | No dual-index | During migration | Old index dropped first, new index built — no parallel indices needed (vault sizes small: ~25MB vectors for 50K items) |

### 4.4 Scratchpad (Brain Cognitive Checkpointing)

> Scratchpad entries are stored in **identity.sqlite** (Tier 4 staging tables).
> Brain checkpoints per-step with step number + accumulated context.
> On crash, brain resumes from the exact step — no re-running completed steps.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Write scratchpad entry (step checkpoint) | `POST /v1/vault/store {type: "scratchpad", task_id: "abc", data: {step: 2, context: {relationship: "...", messages: [...]}}}` | Stored in identity.sqlite scratchpad area |
| 2 | Read scratchpad by task_id | `POST /v1/vault/query {type: "scratchpad", task_id: "abc"}` | Latest checkpoint returned with step number + accumulated context |
| 3 | Per-step context accumulation | Brain completes step 1 → checkpoint, step 2 → checkpoint | Each checkpoint contains ALL prior context (step 1 result + step 2 result), not just latest step |
| 4 | Resume from exact step | Brain crashes at step 3 of 5, restarts | Brain reads scratchpad → sees `step: 2` → resumes from step 3 (skips 1 & 2) |
| 5 | No scratchpad → start fresh | New task, no scratchpad entry | Brain starts from step 1 |
| 6 | Scratchpad TTL: 24h auto-expire | Entry older than 24 hours | Auto-purged by sweeper — stale reasoning from yesterday not useful |
| 7 | Scratchpad deleted on completion | Task completes all 5 steps | Brain sends `POST /v1/vault/store {type: "scratchpad_delete", task_id: "abc"}` → entry removed |
| 8 | Scratchpad size limit | Checkpoint JSON exceeding max size | Rejected with 413 |
| 9 | Scratchpad stored in identity.sqlite | Inspect database location | Not in persona vault — scratchpad is operational state, not user data |
| 10 | Multiple concurrent scratchpads | Two multi-step tasks running | Each has independent scratchpad keyed by task_id, no interference |
| 11 | Scratchpad overwrite (same task, later step) | Step 2 checkpoint overwrites step 1 | Only latest checkpoint retained per task_id (upsert) |

### 4.5 Staging Area (Tier 4 — Ephemeral)

> Tier 4 holds email drafts, payment intents, pending cart handovers, notification queue.
> **Items auto-expire after 72 hours.** Not backed up. Low breach impact.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Stage item for review | New item from ingestion | Stored in staging table, not in `vault_items` (main vault) |
| 2 | Approve staged item | Admin approves | Moved to main vault (`vault_items`) via INSERT + DELETE in single transaction |
| 3 | Reject staged item | Admin rejects | Deleted from staging |
| 4 | Auto-approve low-risk items | Item below risk threshold | Automatically promoted to main vault (no human review) |
| 5 | Per-item expiry via `expires_at` field | Item with `expires_at` in the past, no user action | Core sweeper deletes — `DELETE FROM staging WHERE expires_at < datetime('now')`. Each staged item has its own `expires_at` set at creation time. Architecture §12 shows different TTLs: email drafts = 72h (line 33), cart handover = 12h (line 68). Sweeper honors per-item TTL, not a blanket 72h — using `created_at + 72h` would keep stale payment intents alive 60 hours beyond intended TTL |
| 6 | Staging encrypted at rest | Inspect persona vault | Staging table is inside per-persona SQLCipher database — encrypted like all other data |
| 7 | Staging not backed up | Trigger backup | Backup includes main vault tables but staging items are ephemeral — acceptable if lost |
| 8 | Draft-don't-send in staging | Brain creates email draft | Draft stored as staging item with `type: "email_draft"` — NOT sent until user approves |
| 9 | Cart handover intent in staging | Brain assembles purchase intent | Stored as `type: "cart_handover"` — Dina never touches money, hands back to user |
| 10 | Staging items per-persona | Draft created for `/work` persona | Stored in `work.sqlite` staging table — not visible to `/personal` |
| 11 | Sweeper runs on schedule | 24 hours pass | Core watchdog runs expiry cleanup sweep daily — same sweep as audit log cleanup |
| 12 | Per-type TTL: draft 72h, cart 12h | Create email_draft (72h TTL) and cart_handover (12h TTL) at same time, run sweeper at T+13h | Cart handover deleted (past `expires_at`), email draft still present (53h remaining). Architecture §12: drafts expire after 72h, payment intents after 12h — different action types warrant different urgency windows. Brain sets `expires_at` at creation; core sweeper enforces it uniformly via `WHERE expires_at < datetime('now')` |

### 4.6 Backup

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Online backup via `sqlcipher_export()` | Trigger backup while vault is active | `ATTACH DATABASE 'backup.sqlite' AS backup KEY '<key>'; SELECT sqlcipher_export('backup'); DETACH` — keyed-to-keyed, plaintext never touches disk |
| 2 | Backup is encrypted | Inspect backup file | SQLCipher-encrypted (not plaintext) |
| 3 | VACUUM INTO FORBIDDEN | Code review / audit | `VACUUM INTO` never called — produces PLAINTEXT in SQLCipher (CVE-level vulnerability) |
| 4 | Backup to different location | Specify backup path | Backup file created at target path |
| 5 | Restore from backup | Replace vault with backup | Data integrity verified, all items present |
| 6 | CI/CD plaintext verification | CI test: open backup as plain SQLite3 (no key) | Must FAIL to open — if it opens, BUILD MUST FAIL (catches regression: someone replaces `sqlcipher_export()` with `VACUUM INTO`) |
| 7 | Backup scope: Tier 0 + Tier 1 only | Trigger backup → inspect contents | Backup includes identity.sqlite (Tier 0) + all persona vaults (Tier 1). Tier 2 (index/embeddings) explicitly EXCLUDED — regenerable from Tier 1. Tier 4 (staging) explicitly EXCLUDED — ephemeral, acceptable if lost |
| 8 | Automated backup scheduling (daily default) | Default config (no backup override) | Watchdog triggers `sqlcipher_export()` backup every 24 hours (default). Configurable via `config.json: "backup": {"interval_hours": 24}`. For unattended sovereign nodes, this is the only safety net — if automated backup doesn't run, Home Node failure means total data loss (Section 13 §Home Node Failure). Backup timestamp logged in `kv_store` as `last_backup_timestamp` for admin UI display |

### 4.6.1 Pre-Flight Migration Safety Protocol

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Encrypted backup before migration | Schema migration triggered | `sqlcipher_export()` backup created BEFORE any DDL changes |
| 2 | `PRAGMA integrity_check` after migration | DDL applied | `integrity_check` returns `ok` — every page verified consistent |
| 3 | Integrity ok → commit | `integrity_check = "ok"` | Migration committed, backup retained for 24h then deleted |
| 4 | Integrity fail → ROLLBACK + restore | `integrity_check ≠ "ok"` | Transaction rolled back, vault restored from backup, user alerted |
| 5 | Pre-flight backup path | Inspect | `vault.v{old_version}.bak` — versioned for identification |
| 6 | Automatic on every dina-core update | Core binary updated, restarts | Migration safety protocol runs automatically — user never sees it unless failure |

### 4.7 Audit Log

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Append audit entry | Action + actor + timestamp | Entry appended, cannot be modified |
| 2 | Append-only enforcement | Attempt UPDATE or DELETE on audit table | Rejected by trigger or constraint |
| 3 | Audit log rotation | Log exceeds 90-day retention | Entries older than 90 days archived/purged per policy |
| 4 | Query audit log | Filter by action type, date range | Correct entries returned |
| 5 | Audit log integrity | Compute hash chain | Each entry's hash includes previous entry hash |
| 6 | Audit log JSON format | Inspect stored entry | `{ts: "2026-02-18T03:15:00Z", persona: "/health", action: "query", requester: "brain", query_type: "fts", reason: "nudge_assembly"}` |
| 7 | Retention configurable | Set `config.json: "audit": {"retention_days": 30}` | Entries older than 30 days purged (not default 90) |
| 8 | Watchdog daily cleanup | 24 hours pass with old entries | Core watchdog runs `DELETE FROM audit_log WHERE timestamp < datetime('now', '-90 days')` — daily sweep |
| 9 | Raw entries for forensics | Inspect audit log | Individual timestamped entries preserved — not summarized ("brain accessed /financial 847 times" is useless vs. timestamped pattern detection) |
| 10 | Audit log stored in identity.sqlite | Inspect database | `audit_log` table in identity.sqlite (Tier 0) — not in persona vaults |
| 11 | Storage growth bounded | ~100 entries/day × 200 bytes × 90 days | ~1.8MB for 90 days — trivial, but unbounded growth prevented by retention policy |
| 12 | `crash_log` 90-day retention | Insert crash_log entries with timestamps >90 days old | Watchdog daily sweep runs `DELETE FROM crash_log WHERE timestamp < datetime('now', '-90 days')` — same retention policy as audit_log. crash_log lives in identity.sqlite alongside audit_log (Section 04 §Observability) |

### 4.8 Boot Sequence & Vault Unlock

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Security mode boot: full sequence | config.json `mode: "security"`, no keyfile | Core prompts client device for passphrase → Argon2id → KEK → AES-256-GCM unwrap master seed → HKDF DEKs → open identity.sqlite first → open personal.sqlite → notify brain `{event: "vault_unlocked"}` |
| 2 | Convenience mode boot: full sequence | config.json `mode: "convenience"`, keyfile present at `/var/lib/dina/keyfile` | Core reads raw master seed from keyfile → HKDF DEKs → open identity.sqlite → open personal.sqlite → notify brain |
| 3 | Boot opens identity.sqlite FIRST | Either mode | identity.sqlite opened before any persona vault (gatekeeper needs contacts + sharing policy) |
| 4 | Boot opens personal.sqlite second | Either mode | personal.sqlite opened immediately after identity (default persona, always unlocked) |
| 5 | Other persona databases remain CLOSED at boot | 3 persona vaults configured | Only identity + personal opened — health, financial, etc. remain closed, DEKs not derived |
| 6 | DEKs not derived for closed personas | Boot with locked personas | HKDF not called for locked personas — key material never enters RAM until explicit unlock |
| 7 | Brain notified on vault unlock | Vault opens successfully | Core sends `POST brain:8200/v1/process {event: "vault_unlocked"}` |
| 8 | HKDF info strings are correct | Derive identity DEK | Info string: `dina:vault:identity:v1` produces consistent DEK |
| 9 | HKDF info strings per persona | Derive personal DEK | Info string: `dina:vault:personal:v1` — each persona name in info string |
| 10 | SQLCipher PRAGMAs enforced | Open any vault | `PRAGMA cipher_page_size = 4096`, `PRAGMA journal_mode = WAL` verified |
| 11 | Mode stored in config.json | Inspect config after setup wizard | `mode` field is `"security"` or `"convenience"` |
| 12 | Mode changeable at runtime | Switch from convenience → security | config.json updated, next boot uses new mode |
| 13 | Default mode: managed = convenience | Fresh setup on managed hosting | config.json defaults to `mode: "convenience"` |
| 14 | Default mode: self-hosted = security | Fresh setup on self-hosted/sovereign | config.json defaults to `mode: "security"` |
| 15 | Security mode: wrong passphrase → vault stays locked | Incorrect passphrase on boot | AES-256-GCM unwrap fails, vault remains locked, core starts in degraded mode (dead drop active) |
| 16 | Convenience mode: keyfile missing → startup error | keyfile absent | Core refuses to start with clear error: "keyfile not found at /var/lib/dina/keyfile" |
| 17 | Convenience mode: keyfile wrong permissions | `chmod 644` (world-readable) | Warning logged: "keyfile permissions too open", boot continues (or fails per policy) |
| 18 | config.json missing → graceful default | config.json absent | Core starts with sensible defaults (security mode, single persona) |
| 19 | config.json invalid mode value | `mode: "hybrid"` | Startup fails with validation error |
| 20 | Security mode: wrapped_seed.bin path | Inspect file | Encrypted master seed at `/var/lib/dina/wrapped_seed.bin` (AES-256-GCM blob + 16-byte cleartext Argon2id salt) |
| 21 | Master Seed NEVER plaintext in security mode | Inspect `/var/lib/dina/` in security mode | No plaintext seed on disk — only `wrapped_seed.bin` (encrypted blob) |
| 22 | Convenience mode: keyfile path | Inspect file | Raw master seed at `/var/lib/dina/keyfile` with `chmod 600` |
| 23 | Mode switch: security → convenience (security downgrade) | User requests switch from security to convenience mode | Core prompts for passphrase → Argon2id → KEK → unwrap master seed from `wrapped_seed.bin` → write plaintext seed to `/var/lib/dina/keyfile` (chmod 600) → update config.json `mode: "convenience"`. MUST require explicit user confirmation ("This writes your master seed to disk in plaintext. Continue?") because this is a deliberate security downgrade. Architecture §02 line 40: "Users can change this setting at any time" — bidirectional. §4.8 #12 covers convenience→security; this covers the reverse |

---

## 5. PII Scrubber (Tier 1 — Go Regex)

> Tier 1 runs in Go core at `POST /v1/pii/scrub`. Catches structured PII: credit cards,
> phone numbers, Aadhaar/SSN, emails, bank accounts. Sub-millisecond.
> Returns scrubbed text + replacement map `{token → original}`.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Scrub email address | "Contact john@example.com" | "Contact [EMAIL_1]" + map: `{"[EMAIL_1]": "john@example.com"}` |
| 2 | Scrub phone number | "Call 555-123-4567" | "Call [PHONE_1]" |
| 3 | Scrub SSN | "SSN 123-45-6789" | "SSN [SSN_1]" |
| 4 | Scrub credit card | "Card 4111-1111-1111-1111" | "Card [CC_NUM_1]" |
| 5 | Scrub IP address | "From 192.168.1.1" | "From [IP_1]" |
| 6 | No PII present | "The weather is nice today" | Unchanged — empty replacement map |
| 7 | Multiple PII types in one string | "Email john@ex.com, phone 555-1234" | Both redacted: `[EMAIL_1]`, `[PHONE_1]` — numbered sequentially |
| 8 | PII at string boundaries | "john@example.com" (entire string) | "[EMAIL_1]" |
| 9 | Unicode/international formats | "+44 20 7946 0958" (UK phone) | Redacted (configurable patterns) |
| 10 | Performance: large payload | 1 MiB text with scattered PII | Completes within 100ms (sub-millisecond for typical payloads) |
| 11 | Aadhaar number (India) | "Aadhaar 1234 5678 9012" | "[AADHAAR_1]" — 12-digit Indian national ID |
| 12 | Bank account number | "Acct 1234567890123456" | "[BANK_ACCT_1]" |
| 13 | Multiple same-type PII | "Email john@ex.com and jane@ex.com" | "[EMAIL_1]" and "[EMAIL_2]" — uniquely numbered |
| 14 | Replacement map returned in response | `POST /v1/pii/scrub` with text containing PII | Response body: `{scrubbed_text: "...", replacements: {"[EMAIL_1]": "john@ex.com", "[PHONE_1]": "555-1234"}}` |
| 15 | Replacement map round-trip | Scrub → send to brain → brain sends back with tokens → core de-sanitizes | All `[TOKEN_N]` replaced with originals from map — no data loss |
| 16 | No false positives on numbers | "The product costs $1,234.56" | NOT redacted — price is not PII |
| 17 | Indian phone format | "+91 98765 43210" | "[PHONE_1]" — Indian mobile number format |

---

## 6. Gatekeeper (Egress / Sharing Policy)

### 6.1 Sharing Policy Enforcement

> Default deny. Per-contact per-category. Tiers: `none` / `summary` / `full`.
> Missing key = `"none"` = blocked. Trust level and sharing policy are independent.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Default-deny: no policy exists | Request to share data with unknown contact (no `sharing_policy` row) | Blocked — no data sent |
| 2 | Default-deny: missing category key | Contact has policy but no `location` key | `location` treated as `"none"` — blocked |
| 3 | Policy: `"none"` explicit | Contact has `"health": "none"` | No health data shared — same as missing key |
| 4 | Policy: `"summary"` | Contact has `"availability": "summary"` | Brain sends `{summary: "Busy 2-3pm", full: "Meeting with Dr. Patel..."}` → Core picks `summary` only |
| 5 | Policy: `"full"` | Contact has `"preferences": "full"` | Full details shared: "Chai, no sugar, served warm. Allergic to dairy." (still PII-scrubbed) |
| 6 | Per-contact per-category granularity | Sancho: `presence=eta_only, health=none` | Presence shared (summary tier), health blocked — per-category per-contact |
| 7 | Domain-specific tier: `eta_only` → summary | Contact has `"presence": "eta_only"` | Maps to summary tier: "Arriving in about 15 minutes" (not GPS coords) |
| 8 | Domain-specific tier: `free_busy` → summary | Contact has `"availability": "free_busy"` | Maps to summary tier: "Busy 2-3pm" (not meeting details) |
| 9 | Domain-specific tier: `exact_location` → full | Contact has `"presence": "exact_location"` | Maps to full tier: GPS coordinates and exact ETA |
| 10 | Policy update via PATCH | Admin changes `health` from `"none"` to `"summary"` | `PATCH /v1/contacts/:did/policy` → subsequent requests use updated policy |
| 11 | Bulk policy update | Turn off location for all trusted contacts | `PATCH /v1/contacts/policy/bulk {"filter": {"trust_level": "trusted"}, "policy": {"location": "none"}}` → returns `{"updated": 12}` |
| 12 | Trust level ≠ sharing | Contact is `"trusted"` but no explicit sharing rules | Trusted doesn't auto-share anything — trust and policy are independent |
| 13 | Recognized categories | Phase 1 category list | `presence`, `availability`, `context`, `preferences`, `location`, `health` — extensible |
| 14 | Sharing defaults for new contacts | New contact added, no explicit policy set | Defaults from `config.json "sharing_defaults"`: presence=eta_only, availability=free_busy, context=summary, preferences=full, location=none, health=none |
| 15 | Outbound PII scrub | Share data with `"full"` policy | PII scrubber runs before transmission (even full tier gets scrubbed) |
| 16 | Extensible categories: custom category accepted | `PATCH /v1/contacts/:did/policy {"hobbies": "full"}` | Custom category stored and enforced — system is not limited to the 6 default categories |
| 17 | Extensible categories: custom category enforced at egress | Brain sends payload with `{hobbies: {summary: "...", full: "..."}}`, policy has `hobbies: "summary"` | Core strips to summary — custom categories go through the same egress pipeline |

### 6.2 Sharing Policy API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | GET policy | `GET /v1/contacts/:did/policy` | 200 — returns `{did, name, trust_level, sharing_policy: {presence: "eta_only", ...}}` |
| 2 | PATCH single category | `PATCH /v1/contacts/:did/policy {"location": "exact_location"}` | 200 — only `location` changed, all other categories preserved |
| 3 | PATCH multiple categories | `PATCH /v1/contacts/:did/policy {"health": "summary", "location": "none"}` | 200 — two categories changed, rest preserved |
| 4 | PATCH bulk by trust level | `PATCH /v1/contacts/policy/bulk {"filter": {"trust_level": "trusted"}, "policy": {"location": "none"}}` | 200 — `{"updated": N}` matching contacts updated |
| 5 | PATCH bulk all contacts | `PATCH /v1/contacts/policy/bulk {"filter": {}, "policy": {"location": "none"}}` | 200 — all contacts updated |
| 6 | GET policy for unknown DID | `GET /v1/contacts/did:plc:unknown/policy` | 404 — contact not found |
| 7 | PATCH with invalid tier value | `PATCH ... {"health": "maximum"}` | 400 — unrecognized tier value |
| 8 | Policy stored in contacts table | Inspect identity.sqlite | `sharing_policy` column is JSON blob in `contacts` table |

### 6.3 Egress Pipeline

> Enforcement is at egress, not ingress. Brain sends max detail in tiered structure.
> Core strips based on policy. Brain never needs to know the policy.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Brain sends tiered payload | Brain calls `POST /v1/dina/send` with `{availability: {summary: "Busy 2-3pm", full: "Meeting with Dr. Patel..."}}` | Core picks correct tier per sharing_policy |
| 2 | Core strips denied categories | Policy has `location: "none"` | Location category entirely removed from outbound payload |
| 3 | Malformed payload → category dropped | Brain sends raw string instead of `{summary, full}` for a category | Malformed = denied — category stripped entirely |
| 4 | Egress enforcement in compiled Go | Inspect code | Sharing policy checked via SQL lookup in Go code — not LLM reasoning. Prompt injection irrelevant |
| 5 | Egress not ingress | Crafted incoming message tries to elicit more data | Incoming message cannot influence egress policy — enforcement is on outbound |
| 6 | Recipient DID resolution | Resolve recipient's service endpoint | DID Document fetched from PLC Directory, endpoint extracted |
| 7 | Egress audit logging | Any outbound data sharing | `INSERT INTO audit_log (..., action='egress_check', contact_did, category, decision, reason)` — every decision logged |
| 8 | Audit includes denied categories | Category blocked by policy | Audit entry: `decision='denied', reason='tier_none'` — even denials are logged |
| 9 | NaCl encryption after policy check | Payload passes egress check | Payload encrypted with `crypto_box_seal` (ephemeral key + recipient X25519) → transmitted |

---

## 7. Transport Layer

### 7.1 Outbox (Reliable Delivery)

> Outbox is in `identity.sqlite` — survives reboot. ULID IDs. Max 5 retries.
> 24-hour TTL. Queue limit: 100 pending messages. Scheduler checks every 30s.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Enqueue message | New outbound message | Persisted in `outbox` table in identity.sqlite with `pending` status, ULID ID |
| 2 | Outbox schema | Inspect identity.sqlite | `outbox(id TEXT PK, to_did TEXT, payload BLOB, created_at INTEGER, next_retry INTEGER, retries INTEGER, status TEXT)` |
| 3 | Successful delivery | Recipient endpoint responds 200 | Task marked `delivered`, deleted after 1 hour |
| 4 | Delivery failure → retry | Recipient returns 500 | Exponential backoff with jitter: 30s → 1m → 5m → 30m → 2h |
| 5 | Max retries exhausted (5) | 5 consecutive failures (~3 hours) | Status → `failed`, Tier 2 nudge: "Couldn't reach Sancho's Dina. His node may be offline." |
| 6 | User requeue after failure | User approves requeue | Fresh retry count, message re-enqueued |
| 7 | 24-hour TTL | Message pending for >24h without delivery | Expired, deleted regardless of retry count |
| 8 | Queue size limit: 100 | 101st message enqueued | Rejected — "outbox full" error returned to caller |
| 9 | Outbox survives restart | Core crashes and restarts | Pending tasks reloaded from SQLite: `SELECT * FROM outbox WHERE status='pending' AND next_retry < ?` |
| 10 | Scheduler interval: 30 seconds | Core running | Outbox checked every 30s: `next_retry < now() AND status = 'pending'` |
| 11 | Idempotent delivery | Same message delivered twice (retry after timeout) | Recipient deduplicates by message ID |
| 12 | Delivered messages cleanup | Message delivered | Deleted from outbox after 1 hour |
| 13 | Failed messages cleanup | Message failed after 5 retries | Deleted after 24 hours |
| 14 | Priority ordering | High-priority (fiduciary) message queued after low-priority | Fiduciary messages sent first |
| 15 | Payload is pre-encrypted | Inspect outbox payload column | BLOB is NaCl-encrypted — ready to send, no re-encryption on retry |
| 16 | `sending` status during delivery attempt | Message in outbox, delivery in progress | Status transitions: `pending` → `sending` (while HTTP request in flight) → `delivered` (on 200) or back to `pending` with incremented retries (on failure) |
| 17 | User ignores nudge → message expires at 24h TTL | Retries exhausted → user notified → user does nothing | Message remains `failed` → cleanup deletes after 24 hours. No infinite retry loop |

### 7.2 Inbox (3-Valve Ingress)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Valve 1: IP rate limit | >50 requests/hour from same IP | 429 Too Many Requests |
| 2 | Valve 1: normal traffic | <50 requests/hour from same IP | Accepted to Valve 2 |
| 3 | Valve 1: global rate limit | >1000 requests/hour total (all IPs) | 429 — botnet defense |
| 4 | Valve 1: payload cap | Message body >256KB | 413 Request Entity Too Large (MaxBytesReader) |
| 5 | Valve 1: payload within cap | Message body <256KB | Accepted — DIDComm is JSON metadata, no media |
| 6 | Valve 2: spool cap (persona locked) | Message for locked persona, spool < 500MB | Spooled to `./data/inbox/msg_{ulid}.blob`, 202 Accepted |
| 7 | Valve 2: spool cap exceeded | Spool at 500MB limit | 429 Too Many Requests (reject-new, NOT drop-oldest) |
| 8 | Valve 2: reject-new preserves existing | Spool full → new message arrives | Existing legitimate messages preserved; new message rejected |
| 9 | Valve 3: sweeper on unlock | Locked persona unlocked | Spooled blobs processed FIFO by ULID timestamp |
| 10 | Valve 3: sweeper decrypts + checks DID | Blob decrypted after unlock | Sender DID identified, trust ring checked, contacts verified |
| 11 | Valve 3: sweeper blocklist feedback | Spam DID detected in spool | Source IP added to Valve 1 permanent blocklist |
| 12 | Valve 3: TTL enforcement | Message with TTL=15min, vault locked for 3 hours | After unlock: message stored silently in history, NO user notification (expired) |
| 13 | Valve 3: message within TTL | Message with TTL=30min, vault locked for 10 min | After unlock: message processed normally, notification delivered |
| 14 | Valve 3: blob cleanup | Spool blob processed successfully | Blob file deleted from `./data/inbox/` |
| 15 | Fast path: vault unlocked | Valid message, vault unlocked | Decrypt in-memory → check DID in contacts → per-DID rate limit → process immediately, zero disk I/O |
| 16 | Fast path: per-DID rate limit | Same DID sends >limit within window (unlocked) | 429 — per-DID rate limiting (only possible when unlocked, identity known) |
| 17 | Dead drop: per-DID impossible when locked | Vault locked | No per-DID rate limiting — identity inside encrypted envelope (physics-based defense only) |
| 18 | DID verification on inbound | Message with valid sender DID signature | Accepted |
| 19 | DID verification failure | Message with invalid/missing signature | Rejected with 401 |
| 20 | Unknown sender DID | Message from unresolvable DID | Queued for manual review or rejected per policy |
| 21 | Spool directory is safe | Inspect `./data/inbox/` contents | Only encrypted blobs — attacker with filesystem access sees ciphertext only |
| 22 | DoS while locked | Millions of payloads, vault locked | Valve 1 rejects most (IP rate). Remainder fills spool to 500MB cap. Valve 2 rejects rest (429). Disk safe. |
| 23 | DoS while unlocked | Millions of payloads, vault unlocked | Valve 1 rejects most. Survivors decrypted — unknown DID → dropped. No disk I/O. |

### 7.3 DID Resolution & Caching

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Resolve known DID | `did:key:z6Mk...` | DID Document returned from network |
| 2 | Cache hit | Second resolution of same DID within TTL | Returned from cache, no network call |
| 3 | Cache expiry | Resolution after cache TTL | Fresh resolution from network |
| 4 | Unresolvable DID | Non-existent DID | Error returned, not cached |
| 5 | Malformed DID | `did:invalid:!!!` | Validation error |

### 7.4 Message Format (DIDComm-Compatible)

> Plaintext structure is DIDComm-compatible from day one.
> Phase 1 envelope: `application/dina-encrypted+json` (libsodium crypto_box_seal).
> Phase 2: migrate to standard JWE. Plaintext unchanged.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Plaintext structure | Create D2D message | `{id: "msg_...", type: "dina/social/arrival", from: "did:plc:...", to: ["did:plc:..."], created_time: unix_ts, body: {...}}` |
| 2 | Message ID format | Inspect message ID | Format: `msg_YYYYMMDD_<random>` — unique, timestamp-prefixed |
| 3 | Message envelope format | Inspect encrypted envelope | `{typ: "application/dina-encrypted+json", from_kid, to_kid, ciphertext: "<base64url>", sig: "<Ed25519>"}` |
| 4 | Ed25519 signature on plaintext | Verify signature | `sig` field is Ed25519 signature over the canonical plaintext. Verification flow: recipient decrypts `ciphertext` via `crypto_box_seal_open` → recovers plaintext → verifies `sig` against `from_kid` public key. Sig is in the outer envelope (visible), but verification requires the plaintext (only recipient has it) |
| 5 | Message categories | Create different types | `dina/social/*`, `dina/commerce/*`, `dina/identity/*`, `dina/reputation/*` — all valid |
| 6 | Unknown message type | Receive `dina/unknown/foo` | Accepted and stored (extensible) — brain classifies, no hard rejection |
| 7 | Ephemeral key per message | Send two messages to same recipient | Each uses fresh ephemeral X25519 keypair for `crypto_box_seal` — different ciphertext |
| 8 | `from_kid`/`to_kid` DID fragment format | Inspect envelope `from_kid` and `to_kid` | Format: `did:plc:...#key-1` — DID URL with fragment identifier referencing the correct `verificationMethod` entry in sender/recipient's DID Document |
| 9 | Phase migration invariant: plaintext unchanged | Compare Phase 1 and Phase 2 envelopes for same message | Plaintext `{id, type, from, to, created_time, body}` is IDENTICAL — only the encryption wrapper changes (libsodium → JWE). Application code and message types don't change |

### 7.5 Connection Establishment

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Full connection flow | Your Dina → Sancho's Dina | Step 1: Resolve DID via PLC Directory → Step 2: Extract endpoint from DID Document → Step 3: Connect → Step 4: Mutual auth → Step 5: Send encrypted |
| 2 | Mutual authentication | Both Dinas present DIDs | Both verify Ed25519 signatures, both must be in each other's contacts list |
| 3 | Contact allowlist check | Message to non-contact DID | Rejected — both sides must have each other in contacts |
| 4 | Endpoint from DID Document | Resolve `did:plc:sancho` | DID Document → `service[0].serviceEndpoint` = `https://sancho-dina.example.com/didcomm` |

### 7.6 Relay Fallback (NAT/Firewall)

> For Home Nodes behind NAT/CGNAT that can't accept inbound connections.
> Relay sees only encrypted blob + recipient DID. Cannot read content.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Relay forward envelope | Message to relay-fronted recipient | `{type: "dina/forward", to: "did:plc:...", payload: "<encrypted blob>"}` — relay peels outer layer, forwards inner |
| 2 | Relay cannot read content | Inspect relay's view | Only recipient DID + encrypted blob — no plaintext access |
| 3 | DID Document points to relay | Recipient behind NAT | DID Document `serviceEndpoint` points to relay, not direct Home Node |
| 4 | User can switch relays | Update DID Document | Change relay endpoint via `did:plc` rotation — messages route to new relay |

---

## 8. Task Queue (Outbox Pattern)

> `dina_tasks` table lives in **identity.sqlite** (shared, not persona-partitioned).
> Task IDs are ULIDs. Timeout is 5 minutes. Dead letter after 3 failed attempts.

### 8.1 Task Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Enqueue task | Core receives event (ingestion, DIDComm, client query) | Row inserted: `{id: ULID, type: "process", payload_json: {...}, status: "pending", attempts: 0, created_at: now()}` |
| 2 | Task ID is ULID | Inspect created task | ID is valid ULID (lexicographically sortable, timestamp-embedded) |
| 3 | Send to brain | Task pending | Core sends `POST brain:8200/api/v1/process {task_id, ...}`, sets `status = "processing"`, `timeout_at = now() + 5min` |
| 4 | Brain ACK (success) | Brain completes task | Brain sends `POST core:8100/v1/task/ack {task_id}` → core deletes task from `dina_tasks` |
| 5 | Brain no-ACK (crash) | Brain crashes, no ACK within 5 min | `timeout_at` expires, task stays `processing` until watchdog resets |
| 6 | Task types | Different event types | Valid types: `process`, `reason`, `embed` — unknown type rejected |
| 7 | Task persistence across restart | Core crashes and restarts | All pending/processing tasks still in `dina_tasks`, re-dispatched |
| 8 | Concurrent workers | Multiple goroutines dequeuing | No duplicate processing (SQLite row-level locking) |

### 8.2 Watchdog (Timeout Recovery)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Watchdog detects timed-out task | Task `status = "processing"`, `timeout_at` < now() | Watchdog resets to `status = "pending"`, increments `attempts` |
| 2 | Watchdog runs periodically | Background goroutine | Scans `dina_tasks WHERE status = 'processing' AND timeout_at < now()` every 30s |
| 3 | Watchdog does not touch healthy tasks | Task processing, timeout not expired | Task left alone |
| 4 | Reset task re-dispatched | Watchdog resets task to pending | Next dispatch cycle picks it up, sends to brain again |

### 8.3 Dead Letter & Retry

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Dead letter after 3 failures | `attempts = 3`, brain fails again | `status = "dead"`, Tier 2 notification: "Brain failed to process event 3 times. Check crash logs." |
| 2 | Dead letter not 5 | `attempts = 4` | Should never happen — dead letter triggers at 3 |
| 3 | Retry backoff | Task fails first time | `attempts` incremented, task reset to pending (no exponential backoff on task queue — outbox has backoff, task queue has simple retry + dead letter) |
| 4 | Task cancellation | Cancel pending task by ID | `status = "cancelled"` |
| 5 | Index on status + timeout | Inspect SQLite schema | `CREATE INDEX idx_tasks_status ON dina_tasks(status, timeout_at)` exists |
| 6 | No silent data loss | Task hits dead letter | User notification via Tier 2 — not silently dropped |

### 8.4 Reminder Loop (One-Shot Scheduling)

> Simple Go loop: `vault.NextPendingReminder()` → sleep until due → `notify()` → `MarkFired()`.
> No cron library. No scheduler dependency. Missed reminders fire on startup.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Store reminder | `POST /v1/vault/store {type: "reminder", trigger_at: "2026-02-21T07:00:00Z", message: "License renewal"}` | Reminder stored in vault with trigger timestamp |
| 2 | Next pending reminder | Two reminders: 7 AM today, 9 AM tomorrow | `NextPendingReminder()` returns 7 AM reminder (`ORDER BY trigger_at LIMIT 1`) |
| 3 | Sleep until trigger time | Reminder due in 30 minutes | Loop sleeps for 30 minutes, then fires notification |
| 4 | Missed reminder on startup | Reminder was due 2 hours ago (server was down) | `time.Until(trigger_at)` is negative → fires immediately on startup |
| 5 | Fire + mark done | Reminder fires | `notify(next)` pushes to client → `vault.MarkFired(next.ID)` → reminder not re-triggered |
| 6 | No pending → sleep 1 minute | No reminders in vault | `NextPendingReminder()` returns nil → loop sleeps 1 minute → checks again |
| 7 | No cron library | Code audit | No `robfig/cron`, no scheduling library — just `time.Sleep` and vault query |
| 8 | Complex scheduling → delegate | User asks "every Monday at 9 AM" | Brain tells user: "Want me to create a recurring calendar event?" → delegates to OpenClaw/Calendar service |

---

## 9. WebSocket Protocol

> Full message envelope specification from ARCHITECTURE.md §17 (Infrastructure).
> All messages are JSON with `type`/`id`/`payload`. Responses link via `reply_to`.

### 9.1 Connection Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | WS upgrade on `/ws` | Client connects `wss://dina.local:8100/ws` | HTTP 101 upgrade, connection accepted, 5-second auth timer starts |
| 2 | Auth frame within 5s | Client sends `{"type": "auth", "token": "<CLIENT_TOKEN>"}` | Core validates SHA-256(token) → `{"type": "auth_ok", "device": "phone_pixel7"}`, `last_seen` updated |
| 3 | Auth frame timeout | No auth frame within 5s | Core closes connection — no response sent |
| 4 | Invalid auth frame | Wrong CLIENT_TOKEN in auth frame | `{"type": "auth_fail"}` → core closes connection |
| 5 | Revoked token in auth frame | Previously revoked CLIENT_TOKEN | `{"type": "auth_fail"}` → core closes connection |
| 6 | Auth OK includes device name | Valid auth from "Raj's iPhone" | `auth_ok` response includes `"device": "rajs_iphone"` — device name from pairing |
| 7 | Graceful disconnect | Client sends close frame | Server acknowledges, resources cleaned, device marked offline |
| 8 | Abnormal disconnect | TCP connection drops | Server detects via ping timeout (3 missed pongs), cleans up |

### 9.2 Message Envelope Format (Client → Core)

> All client messages include `type` and `id`. Payload varies by type.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Query message | `{"type": "query", "id": "req_001", "payload": {"text": "Am I free at 3pm?", "persona": "/personal"}}` | Routed to brain, response returned with `reply_to: "req_001"` |
| 2 | Query with persona field | Query with `"persona": "/financial"` | Core checks persona access (open/restricted/locked) before routing to brain |
| 3 | Command message | `{"type": "command", "id": "req_002", "payload": {"action": "unlock_persona", "persona": "/financial"}}` | Executed by core, result returned with `reply_to: "req_002"` |
| 4 | ACK message | `{"type": "ack", "id": "evt_003"}` | Core removes `evt_003` from missed message buffer — acknowledged receipt |
| 5 | Pong message | `{"type": "pong", "ts": 1708300000}` | Core records pong, resets missed-pong counter for this device |
| 6 | Missing `id` field | `{"type": "query", "payload": {...}}` (no `id`) | Error response: `{"type": "error", "payload": {"code": 400, "message": "missing id field"}}` |
| 7 | Unknown message type | `{"type": "foo", "id": "req_003"}` | Error response with `reply_to: "req_003"`, connection NOT dropped (extensible protocol) |

### 9.3 Message Envelope Format (Core → Client)

> Responses include `reply_to` linking to client `id`. Proactive messages have their own `id`.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Whisper stream (chunked) | Brain streams response to query | `{"type": "whisper_stream", "reply_to": "req_001", "payload": {"chunk": "Looking at your calendar... "}}` — multiple chunks |
| 2 | Whisper (final response) | Brain completes response | `{"type": "whisper", "reply_to": "req_001", "payload": {"text": "You're free at 3pm.", "sources": ["calendar:event:abc123"]}}` |
| 3 | Proactive whisper (brain-initiated) | Brain detects incoming D2D message | `{"type": "whisper", "id": "evt_003", "payload": {"text": "Sancho just left home.", "trigger": "didcomm:geofence:sancho:departed", "tier": 2}}` — no `reply_to` |
| 4 | System notification | Watchdog detects connector issue | `{"type": "system", "id": "sys_004", "payload": {"level": "warning", "text": "Gmail hasn't synced in 48h. Re-authenticate?"}}` |
| 5 | Error response | Command fails | `{"type": "error", "reply_to": "req_002", "payload": {"code": 403, "message": "/financial requires approval"}}` |
| 6 | Routing logic: `reply_to` = response | Message has `reply_to` field | Client matches to pending request by `id` — this is a response |
| 7 | Routing logic: no `reply_to` = proactive | Message has `id` but no `reply_to` | Client treats as proactive event from brain or system — requires ACK |
| 8 | Whisper stream terminated by final whisper | Brain finishes streaming | Last `whisper_stream` chunk followed by `whisper` message (same `reply_to`) — client knows stream is complete |

### 9.4 Heartbeat Protocol

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Core sends ping every 30s | Authenticated WS connection idle for 30s | `{"type": "ping", "ts": 1708300000}` sent by core |
| 2 | Client responds with pong | Core sends ping | Client sends `{"type": "pong", "ts": 1708300000}` within 10 seconds |
| 3 | Pong timeout: 10 seconds | Core sends ping, no pong within 10s | Missed pong counter incremented |
| 4 | 3 missed pongs → disconnect | 3 consecutive pings without pong response | Core closes connection, marks device offline |
| 5 | Pong resets counter | 2 missed pongs, then pong received | Counter reset to 0 — connection stays alive |
| 6 | Ping includes timestamp | Inspect ping message | `ts` field is Unix timestamp — client can detect clock drift |

### 9.5 Missed Message Buffer

> Per-device buffer. Max 50 messages, max 5 minutes retention.
> Expired buffer → brain generates fresh briefing instead of replaying stale notifications.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Client temporarily disconnected | 10 messages arrive during disconnect | Client reconnects, auth succeeds, receives 10 buffered messages in order |
| 2 | Buffer cap: max 50 messages | >50 messages during disconnect | Oldest messages dropped, newest 50 retained, client notified of gap |
| 3 | Buffer ordering preserved | Messages buffered in order | Delivered in original order on reconnect (FIFO) |
| 4 | Buffer TTL: 5 minutes | Client disconnected for 10 minutes | Buffer expired after 5 min — messages gone. Brain generates fresh briefing on reconnect |
| 5 | Client ACKs buffered messages | Client receives buffered messages | Client sends `{"type": "ack", "id": "evt_XXX"}` for each → ACKed messages removed from buffer |
| 6 | Buffer per-device | Device A disconnected, Device B connected | Only Device A's buffer exists — Device B receives messages in real-time |
| 7 | Buffer within TTL: all delivered | Client disconnected for 3 minutes | All buffered messages delivered on reconnect (within 5-min TTL) |
| 8 | Why 5 min, not longer | Design review | If phone is offline for hours, brain generates fresh briefing — replaying stale notifications is worse than summarizing |
| 9 | Reconnection: exponential backoff (client-side) | Client detects disconnect | Client reconnects with backoff: 1s → 2s → 4s → 8s → 16s → max 30s. On reconnect: re-send auth frame |

---

## 10. Device Pairing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Generate pairing code | Initiate pairing from admin | 6-digit code generated, valid for 5 minutes |
| 2 | Pair with valid code | New device submits correct code within TTL | CLIENT_TOKEN issued, device registered |
| 3 | Pair with expired code | Code submitted after 5 minutes | 410 Gone — code expired |
| 4 | Pair with wrong code | Incorrect 6-digit code | 401 — pairing failed |
| 5 | Brute-force protection | >3 wrong attempts for same code | Code invalidated, new code required |
| 6 | Code single-use | Use valid code twice | Second attempt fails — code consumed |
| 7 | Concurrent pairing codes | Two codes active simultaneously | Both work independently |

### 10.1 Device Management API

> Architecture §17 defines device management endpoints beyond pairing:
> listing, revoking, token format, response schema. Brain §8.3 tests admin UI
> calls to these; this section tests core's API implementation.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | List paired devices (GET /v1/devices) | BRAIN_TOKEN (or admin session) after 3 devices paired | 200 with array of `{token_id, device_name, last_seen, created_at, revoked}` for each device. `last_seen` reflects most recent WS auth_ok. Architecture §17: "Brain: queries device_tokens via core" — admin UI and brain both need this endpoint |
| 2 | Revoke device (PATCH /v1/devices/{token_id}/revoke) | Admin request to revoke specific device | 200 — `revoked=true` in device_tokens. Next request from that device → 401 immediately. Core §9.1 #5 tests WS-level rejection; this tests the revocation API itself. Architecture §17: "Core sets revoked=true. Next request from iPad → 401. Immediate." |
| 3 | Pair completion response includes node_did + ws_url | Successful pairing via POST /v1/pair/complete | Response body: `{client_token: "...", node_did: "did:plc:...", ws_url: "wss://..."}` — all three fields present. Client needs node_did for identity verification and ws_url for WebSocket connection. Architecture §17 pairing flow step 10 |
| 4 | CLIENT_TOKEN format: 32 bytes, hex-encoded | Inspect token from pair completion | 64 hex chars (0-9a-f) — `crypto/rand` 32 bytes → hex. Architecture §17: "CLIENT_TOKEN is a 32-byte cryptographic random value (hex-encoded, 64 chars)" |

---

## 11. Brain Client & Circuit Breaker

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Healthy brain | Brain responds within timeout | Request succeeds |
| 2 | Brain timeout | Brain doesn't respond in 30s | Timeout error, circuit breaker increments failure count |
| 3 | Circuit breaker opens | 5 consecutive failures | Subsequent requests fail-fast without calling brain |
| 4 | Circuit breaker half-open | After cooldown period | Single probe request sent; if success, breaker closes |
| 5 | Circuit breaker closes | Probe request succeeds | Normal traffic resumes |
| 6 | Brain crash recovery | Brain container restarts | Watchdog detects health, circuit breaker resets |

### 11.1 Watchdog

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Brain healthy | `/v1/health` returns 200 | No action |
| 2 | Brain unhealthy | `/v1/health` fails 3 consecutive times | Alert dispatched, circuit breaker opened |
| 3 | Brain recovery | Health restored after failure | Alert cleared, normal operation |
| 4 | Watchdog interval | Check frequency | Every 10s (configurable) |

---

## 12. Admin Proxy

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Proxy to brain admin UI | GET `localhost:8100/admin/` | Reverse-proxied to brain:8200/admin/ |
| 2 | Auth required | Unauthenticated request to :8100 | Redirect to login page |
| 3 | Static asset proxying | CSS/JS files | Correctly proxied with right Content-Type |
| 4 | WebSocket upgrade through proxy | WS connection to :8100/ws | Proxied to brain:8200/ws |

---

## 13. Rate Limiting

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Below rate limit | Normal request rate | All requests succeed |
| 2 | At rate limit | Exactly at limit | Last request succeeds |
| 3 | Above rate limit | Burst exceeding limit | 429 Too Many Requests |
| 4 | Rate limit reset | Wait for window to pass | Requests succeed again |
| 5 | Per-IP isolation | Two IPs at their limits | Each tracked independently |
| 6 | Rate limit headers | Any response | `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers present |

---

## 14. Configuration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Load from environment variables | `DINA_DATA_DIR`, `BRAIN_URL` set | Config populated from env |
| 2 | Load from Docker secrets | `/run/secrets/brain_token` | Token read from file |
| 3 | Missing required config | `BRAIN_URL` not set | Startup fails with descriptive error |
| 4 | Default values | Optional config not set | Sensible defaults applied (e.g., spool max 500MB) |
| 5 | Config validation | Invalid port number, negative TTL | Startup fails with validation error |
| 6 | DINA_SPOOL_MAX enforcement | Spool directory exceeds configured max | New spooling rejected (Valve 2 closes) |

---

## 15. API Endpoint Tests

### 15.1 Health & Readiness

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Liveness probe | `GET /healthz` | 200 OK — HTTP server responding, near-zero cost |
| 2 | Readiness probe: vault healthy | `GET /readyz` | 200 OK — `db.PingContext()` succeeds on identity.sqlite |
| 3 | Readiness probe: vault locked | `GET /readyz` when vault locked (security mode, no passphrase) | 503 — vault not queryable |
| 4 | Readiness probe: SQLite locked | `GET /readyz` when db.PingContext() times out | 503 — database locked or corrupted |
| 5 | Liveness ≠ Readiness | `/healthz` returns 200, `/readyz` returns 503 | Zombie state: process alive but vault unusable — Docker should restart |
| 6 | Docker healthcheck uses `/healthz` | Inspect docker-compose.yml | `wget -q --spider http://localhost:8100/healthz` — liveness check (see §20.2 for full params) |
| 7 | Docker healthcheck params | Inspect compose healthcheck | interval=10s, timeout=3s, retries=3, start_period=5s (per docker-compose.yml §17) |
| 8 | Brain starts after core healthy | `docker compose up` | `dina-brain.depends_on.dina-core.condition: service_healthy` |

### 15.2 Vault API (Architecture Contract)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Search vault | `POST /v1/vault/query` with persona, q, mode, filters | 200 with items array + pagination |
| 2 | Store item | `POST /v1/vault/store` with persona, type, source, summary, embedding | 201 Created with `{status: "ok", id: "vault_..."}` |
| 3 | Get item by ID | `GET /v1/vault/item/:id` | 200 with full item JSON |
| 4 | Delete item (right to forget) | `DELETE /v1/vault/item/:id` | 200 — item permanently removed |
| 5 | Store crash traceback | `POST /v1/vault/crash` with `{error, traceback, task_id}` | 200 — stored in `crash_log` table in identity.sqlite (encrypted at rest) |
| 6 | ACK task | `POST /v1/task/ack {task_id}` | 200 — task deleted from `dina_tasks` |
| 7 | Vault KV store | `PUT /v1/vault/kv/gmail_cursor {value: "2026-02-20T10:00:00Z"}` | 200 — key-value pair stored in `kv_store` table in identity.sqlite |
| 8 | Vault KV read | `GET /v1/vault/kv/gmail_cursor` | 200 — `{value: "2026-02-20T10:00:00Z"}` returned |
| 9 | Vault KV upsert | `PUT /v1/vault/kv/gmail_cursor` with new value | 200 — `updated_at` updated, old value replaced |
| 10 | Vault KV not found | `GET /v1/vault/kv/nonexistent_key` | 404 |
| 11 | Vault batch store | `POST /v1/vault/store/batch` with 100 items | 201 — all 100 stored in single transaction |
| 12 | Vault batch store exceeds cap | `POST /v1/vault/store/batch` with 200 items | 400 — max 100 items per batch request |

### 15.3 Identity API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Get own DID | GET `/v1/did` | 200 with DID Document |
| 2 | Create persona | POST `/v1/personas` | 201 with new persona DID |
| 3 | List personas | GET `/v1/personas` | 200 with array |
| 4 | Get contacts | GET `/v1/contacts` | 200 with contact list |
| 5 | Add contact | POST `/v1/contacts` | 201 |
| 6 | Register device | POST `/v1/devices` | 201 |
| 7 | List devices | GET `/v1/devices` | 200 with device array |

### 15.4 Messaging API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Send message | POST `/v1/msg/send` + recipient DID + payload | 202 Accepted (queued in outbox) |
| 2 | Receive messages | GET `/v1/msg/inbox` | 200 with message array |
| 3 | Acknowledge message | POST `/v1/msg/{id}/ack` | 200 |

### 15.5 Pairing API

> Detailed pairing flow from ARCHITECTURE.md §17 (Client Authentication).
> 6-digit code = short-lived proximity proof. CLIENT_TOKEN = long-lived per-device credential.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Initiate pairing | POST `/v1/pair/initiate` | 200 — `{"code": "847291", "expires_in": 300}` (5 minutes) |
| 2 | Initiate stores pending pairing | After initiate | Core stores: `pending_pairings[code] = {expires, used: false}` |
| 3 | Complete pairing | POST `/v1/pair/complete` `{"code": "847291", "device_name": "Raj's iPhone"}` | 200 — `{"client_token": "a3f8b2c1d4e5...", "node_did": "did:plc:5qtzkvd...", "ws_url": "wss://192.168.1.42:8100/ws"}` |
| 4 | CLIENT_TOKEN is 32 bytes hex | Inspect `client_token` in response | 64 hex chars (32 bytes from `crypto/rand`) |
| 5 | SHA-256 hash stored, not token | Inspect `device_tokens` table after pairing | `token_hash` = SHA-256(CLIENT_TOKEN) — plaintext token never stored |
| 6 | Pending pairing deleted after complete | After successful complete | `pending_pairings[code]` removed — code cannot be reused |
| 7 | Device name stored | Inspect `device_tokens` after pairing | `device_name: "Raj's iPhone"` stored alongside token hash |
| 8 | Managed hosting: no terminal | Managed signup flow | Pairing code displayed in signup UI — same flow, different presentation |

### 15.6 AT Protocol Discovery

> **Critical for PDS federation.** Core must serve this endpoint or PDS federation silently fails.
> AT Protocol relays use this to find the PDS on port 2583.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | AT Protocol discovery | `GET /.well-known/atproto-did` | 200 — body: `did:plc:abc123...` (plain text, `Content-Type: text/plain`) |
| 2 | Discovery returns root DID | Inspect response body | Root DID from `vault.GetRootDID()` — not persona DID |
| 3 | Discovery unauthenticated | No auth header | 200 — public endpoint, no authentication required (AT Protocol spec) |
| 4 | Discovery available in dev mode | `GET localhost:8100/.well-known/atproto-did` | Returns DID on port 8100 (dev) — production serves on 443 via tunnel |
| 5 | Missing DID (no identity yet) | Fresh install, DID not yet generated | 404 or 503 — not empty 200 |

### 15.7 PII API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Scrub text | POST `/v1/pii/scrub` + text body | 200 with scrubbed text |

---

## 16. Error Handling & Edge Cases

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Malformed JSON body | `{invalid json` | 400 Bad Request with parse error |
| 2 | Request body too large | >10 MiB body | 413 Payload Too Large |
| 3 | Unknown endpoint | GET `/v1/nonexistent` | 404 Not Found |
| 4 | Method not allowed | DELETE on GET-only endpoint | 405 Method Not Allowed |
| 5 | Content-Type enforcement | POST without `Content-Type: application/json` | 415 Unsupported Media Type |
| 6 | Concurrent vault writes | Two simultaneous writes to same persona vault | Both succeed (WAL mode) or one retries |
| 7 | Disk full | Vault write when disk is full | Graceful error, no corruption |
| 8 | Vault file corruption | SQLCipher file truncated | Detected on open, error reported |
| 9 | Graceful shutdown | SIGTERM received | In-flight requests complete, outbox flushed, connections closed |
| 10 | Panic recovery | Goroutine panics | Recovered by middleware, 500 returned, not a crash |

---

## 17. Security Hardening

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | No VACUUM INTO | Code audit | `VACUUM INTO` never used (plaintext backup CVE) |
| 2 | SQL injection resistance | Malicious input in API fields | Parameterized queries only, no string concatenation |
| 3 | Path traversal | `../../etc/passwd` in file paths | Rejected, path normalized |
| 4 | Header injection | Newlines in header values | Stripped or rejected |
| 5 | Memory zeroization | After key use | Sensitive key material zeroed from memory (Go `memguard` or manual) |
| 6 | TLS enforcement (production) | HTTP request to HTTPS-only endpoint | 301 redirect or connection refused |
| 7 | Docker network isolation | Brain tries to reach PDS directly | Blocked — different Docker networks (bowtie topology) |
| 8 | Secrets not in environment | Inspect `docker inspect` | Secrets mounted as files, not env vars |
| 9 | No plaintext keys on disk | Inspect keystore files | All keys AES-256-GCM wrapped |
| 10 | Constant-time comparisons | All token/hash comparisons | `crypto/subtle.ConstantTimeCompare` used |
| 11 | No plugin loading mechanism | Code audit: grep for `plugin.Open`, dynamic loading, `dlopen` | Zero matches — no dynamic code loading |
| 12 | No plugin API endpoint | Enumerate all registered routes | No plugin/extension registration endpoints |
| 13 | Only two extension points (architecture audit) | Trace all outbound calls from core | NaCl (transport to peers) and HTTP (to brain) only — no third integration |
| 14 | No plaintext vault data on disk | After vault read/write: inspect `DINA_DATA_DIR` | Only `.sqlite` (SQLCipher-encrypted) files, no plaintext dumps, temp files, or swap |
| 15 | Plaintext discarded after processing | Trigger vault read → wait → inspect `/proc/self/maps` or equivalent (test env) | Decrypted data not resident in memory after response sent |
| 16 | Keys in RAM only while needed | After persona lock: dump process memory (test env) | DEK absent from memory after lock/TTL expiry (not just zeroed struct) |
| 17 | SQLCipher library: `mutecomm/go-sqlcipher` (NOT `mattn/go-sqlite3`) | Code audit: inspect go.mod | `github.com/mutecomm/go-sqlcipher` — NOT `mattn/go-sqlite3` (SQLCipher support was never merged into mattn mainline) |
| 18 | CI: raw .sqlite bytes are NOT valid SQLite headers | CI test: open any vault file as plain sqlite3 (no key) | MUST fail to open — if it opens, CI build fails (proves encryption is active) |
| 19 | Serialization: JSON for core↔brain traffic | Inspect all inter-container API calls | JSON (Phase 1, debuggable). No MessagePack/Protobuf until profiling shows it matters |
| 20 | Container image: digest pinning, never `:latest` | Inspect Dockerfiles and docker-compose.yml | All `FROM` statements use `@sha256:...` digest — never `:latest` tag |
| 21 | Container image: Cosign signature | Inspect CI pipeline | Published images signed with Cosign — `cosign verify` passes |
| 22 | SBOM generated | Inspect CI artifacts | `syft` generates SPDX SBOM for each image — enables supply chain auditing |
| 23 | Secrets NEVER in environment variables | `docker inspect dina-core`, check `Env` section | No `BRAIN_TOKEN`, `DINA_PASSPHRASE` in environment — only in `/run/secrets/` (tmpfs) |
| 24 | Secrets tmpfs mount (never on disk) | Inspect `/run/secrets/` inside container | Files mounted as in-memory tmpfs — never touch disk inside container |
| 25 | `GOOGLE_API_KEY` exception documented | Inspect `.env` and docker-compose env | API key in `.env` (not secrets) — it's a revocable cloud key, not a local credential |
| 26 | Docker network: `dina-pds-net` is internal | Inspect `docker network inspect dina-pds-net` | `internal: true` — PDS network has no outbound internet access |
| 27 | Docker network: `dina-brain-net` is standard | Inspect `docker network inspect dina-brain-net` | Standard bridge (not internal) — brain needs outbound internet for Gemini/Claude API |
| 28 | External ports: only 8100 + 2583 | Inspect docker-compose port mappings | Only `8100:8100` (core) and `2583:2583` (PDS) exposed to host — brain and llama internal only |

---

## 18. Core ↔ Brain API Contract

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Core exposes `/v1/vault/query` to brain | BRAIN_TOKEN + query request | 200 with results |
| 2 | Core exposes `/v1/vault/store` to brain | BRAIN_TOKEN + store request | 201 Created |
| 3 | Core exposes `/v1/did/sign` — admin only | BRAIN_TOKEN | 403 — admin endpoint |
| 4 | Core exposes `/v1/did/verify` to brain | BRAIN_TOKEN + verify request | 200 with verification result |
| 5 | Core exposes `/v1/pii/scrub` to brain | BRAIN_TOKEN + text | 200 with scrubbed text |
| 6 | Core exposes `/v1/notify` to brain | BRAIN_TOKEN + push notification | 200 — notification pushed to connected clients |
| 7 | All brain-callable endpoints accept BRAIN_TOKEN | Iterate all non-admin endpoints with BRAIN_TOKEN | All return 200 (not 403) |
| 8 | No other endpoints exist beyond documented set | Enumerate all routes | Exact match with documented API surface — 8 brain-callable families (vault/query, vault/store, did/verify, pii/scrub, notify, msg/send, reputation/query, process+reason) plus admin-only endpoints (did/sign, did/rotate, vault/backup, persona/unlock, admin/*) |
| 9 | Core exposes `/v1/msg/send` to brain | BRAIN_TOKEN + encrypted message payload (recipient DID, ciphertext) | 200 — message queued in outbox for Dina-to-Dina delivery. Architecture §03 line 135 lists `msg/send` in BRAIN_TOKEN scope. Brain triggers outbound messages (e.g., sharing a verdict with a contact); core handles encryption envelope and transport |
| 10 | Core exposes `/v1/reputation/query` to brain | BRAIN_TOKEN + query (entity, category) | 200 with reputation score from local cache or PDS federation. Architecture §03 line 135 lists `reputation/query` in BRAIN_TOKEN scope. Brain needs reputation data for LLM routing decisions (e.g., which bot to delegate to) and trust ring evaluation |

---

## 19. Onboarding Sequence

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Managed onboarding: "email + password → done" | User enters email + passphrase | Full silent setup completes, Dina starts ingesting |
| 2 | Silent step 1: BIP-39 mnemonic generated | First-run | 24-word mnemonic, 512-bit master seed |
| 3 | Silent step 2: root Ed25519 keypair derived | Master seed | SLIP-0010 `m/9999'/0'` → root keypair |
| 4 | Silent step 3: did:plc registered | Root keypair | DID registered with plc.directory |
| 5 | Silent step 4: per-database DEKs derived | Master seed | HKDF with persona-specific info strings |
| 6 | Silent step 5: password wraps master seed | Passphrase | Argon2id → KEK → AES-256-GCM wrap (key wrapping, not derivation) |
| 7 | Silent step 6: databases created | DEKs | identity.sqlite + personal.sqlite created |
| 8 | Silent step 7: convenience mode set (managed) | Managed hosting | Master seed written to keyfile, `chmod 600` |
| 9 | Silent step 8: brain starts guardian loop | Vault unlocked | Brain receives vault_unlocked event, begins operation |
| 10 | Silent step 9: initial sync triggered | Brain ready | MCP → OpenClaw fetches Gmail/Calendar |
| 11 | One default persona: `/personal` | After setup | Only `/personal` persona exists — no /health, /financial, /citizen |
| 12 | Mnemonic backup deferred to Day 7 | Day 7 after setup | Prompt: "Write down these 24 words" — not shown during onboarding |
| 13 | Sharing rules default to empty | After setup | No sharing policies — default-deny egress |

---

## 20. Observability & Self-Healing

> A sovereign node must stay alive without human intervention. A running process
> can have a locked SQLite or deadlocked goroutine — Docker won't restart it
> unless the healthcheck catches it.

### 20.1 Health Endpoints

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | `/healthz` liveness: server alive | `GET /healthz` | 200 OK — near-zero cost, no DB call |
| 2 | `/readyz` readiness: vault queryable | `GET /readyz` | `db.PingContext()` with strict timeout → 200 if vault open |
| 3 | `/readyz` failure: vault locked | `GET /readyz` when vault locked (security mode) | 503 — not ready to serve |
| 4 | `/readyz` failure: db deadlocked | `GET /readyz` when SQLite locked | `PingContext` times out → 503 |
| 5 | Zombie detection | `/healthz` → 200, `/readyz` → 503 | Container alive but useless — Docker restarts after 3 consecutive failures |
| 6 | `/healthz` unauthenticated | No auth header | 200 — liveness probes must not require auth |
| 7 | `/readyz` unauthenticated | No auth header | 200 — readiness probes must not require auth |

### 20.2 Docker Healthcheck Configuration

> Values sourced from docker-compose.yml in ARCHITECTURE.md §17 (Infrastructure).

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Core healthcheck endpoint: `/healthz` | Inspect docker-compose.yml | `test: ["CMD", "wget", "-q", "--spider", "http://localhost:8100/healthz"]` |
| 2 | Core healthcheck: interval 10s | Inspect compose | `interval: 10s` — check every 10 seconds (brain+PDS+llama all use 30s) |
| 3 | Core healthcheck: timeout 3s | Inspect compose | `timeout: 3s` — fail if response takes >3s |
| 4 | Core healthcheck: retries 3 | Inspect compose | `retries: 3` — restart after 3 consecutive failures (30s of downtime at 10s interval) |
| 5 | Core healthcheck: start_period 5s | Inspect compose | `start_period: 5s` — grace period for boot |
| 6 | Brain healthcheck: `/healthz` | Inspect compose | `test: ["CMD", "wget", "-q", "--spider", "http://localhost:8200/healthz"]`, `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 15s` |
| 7 | PDS healthcheck: `/xrpc/_health` | Inspect compose | `test: ["CMD", "wget", "-q", "--spider", "http://localhost:2583/xrpc/_health"]`, `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 10s` |
| 8 | llama healthcheck: `/health` | Inspect compose | `test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]`, `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 30s` (model loading ~30-45s) |
| 9 | Why `wget` not `curl` | Inspect container image | Minimal Alpine images include `wget` but not `curl` |
| 10 | `restart: unless-stopped` on all containers | Inspect compose | All services have `restart: unless-stopped` (not `always` — allows `docker stop` without auto-restart) |
| 11 | Brain `depends_on: core: service_healthy` | Inspect compose | Brain won't start until core healthcheck passes — ensures vault subsystem is ready |
| 12 | Core `depends_on: pds: service_started` | Inspect compose | Core starts after PDS container has started (not necessarily healthy — PDS can take time to load repos) |
| 13 | llama `profiles: ["local-llm"]` | `docker compose up` (no profile flag) | llama container NOT started — only started with `docker compose --profile local-llm up` |

### 20.3 Crash Log Storage

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Crash traceback stored in identity.sqlite | Brain sends `POST /v1/vault/crash` | Row inserted in `crash_log` table: `{id, timestamp, error, traceback, task_id}` |
| 2 | Crash log table schema | Inspect identity.sqlite | `crash_log(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp, error TEXT, traceback TEXT, task_id TEXT)` |
| 3 | Crash log encrypted at rest | Inspect crash_log via raw file | Not readable — SQLCipher encrypts entire identity.sqlite |
| 4 | Crash log retention: 90 days | Entries older than 90 days | Watchdog deletes old entries (same retention as audit log) |
| 5 | Crash log queryable | Admin queries "crashes from last week" | `SELECT * FROM crash_log WHERE timestamp > datetime('now', '-7 days')` |
| 6 | Crash log included in backup | `dina export` | crash_log table included in identity.sqlite backup |
| 7 | Admin UI displays crash history | GET `/admin/crashes` | Table of recent crashes with error, timestamp, task_id |

---

## 21. Logging Policy

> All containers emit structured JSON to stdout. No file logs.
> PII MUST NOT reach stdout. Enforced by code review and CI linting.

### 21.1 Structured Logging

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Go core: `slog` structured JSON | Trigger any core operation | JSON log line: `{"time":"...","level":"...","msg":"...","module":"..."}` |
| 2 | Python brain: `structlog` JSON | Trigger any brain operation | JSON log line to stdout |
| 3 | No file logs | Inspect container filesystems after 24h operation | No log files written anywhere — stdout only |
| 4 | Docker log rotation configured | Inspect daemon.json or compose `logging` | Max 10MB, 3 files — prevents storage exhaustion over years |

### 21.2 PII Exclusion from Logs

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Vault content never logged | Vault read/write operations | Logs contain item IDs, counts, latency — never email bodies, calendar events, contact details |
| 2 | User queries never logged | Client sends "find emails about my divorce" | Log shows: `{persona: "/personal", type: "fts5", results: 3}` — not the query text |
| 3 | Brain reasoning never logged | Brain assembles nudge | Log shows: `{task_id: "abc", step: 3, duration_ms: 150}` — not reasoning output |
| 4 | NaCl plaintext never logged | Decrypt inbound DIDComm message | Log shows: `{sender_did: "did:key:...", persona: "/social"}` — not message content |
| 5 | Passphrase never logged | Login attempt | Log shows: `{event: "login", ip: "...", success: true}` — not passphrase |
| 6 | API tokens never logged | BRAIN_TOKEN or CLIENT_TOKEN in request | Log shows: `{auth: "brain"}` or `{auth: "client"}` — not token value |

### 21.3 CI Banned Log Patterns

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | CI catches `log.*query=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*query.*='` flagged — zero runtime cost, catches bad habits before merge |
| 2 | CI catches `log.*content=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*content.*='` flagged |
| 3 | CI catches `log.*body=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*body.*='` flagged |
| 4 | CI catches `log.*plaintext=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*plaintext.*='` flagged |
| 5 | CI catches f-string with user data | Code review / CI pipeline | Pattern `r'log\.\w+\(.*f".*{.*user'` flagged |
| 6 | No spaCy NER on log lines | Code review | PII scrubbing is for data path to cloud LLMs, not log output — wrong layer, expensive, unreliable |

### 21.4 Brain Crash Traceback Safety

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Brain crash: stdout gets sanitized one-liner | Brain crashes with PII in local vars | Docker logs show: `guardian crash: RuntimeError at line 142` — no traceback, no variable values |
| 2 | Brain crash: full traceback to vault | Same crash | Full `traceback.format_exc()` sent to `POST core:8100/api/v1/vault/crash` — encrypted at rest |
| 3 | Brain catch-all wraps main loop | Inspect `brain/src/main.py` | `try: await guardian_loop() except Exception as e:` — logs type + line to stdout, full trace to vault |
| 4 | Crash handler sends task_id | Brain crashes during task | `current_task_id` included in crash report — correlates with `dina_tasks` for debugging |
| 5 | Crash handler re-raises | After logging + vault write | `raise` called — lets Docker restart policy trigger |

---

## 22. PDS Integration (AT Protocol)

> Core signs reputation records with user's Ed25519 persona key and writes them
> to the AT Protocol PDS. PDS stores signed Merkle repos — cannot forge records.

### 22.1 Record Signing & Publishing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Sign attestation record | Brain requests `POST /v1/reputation/publish` with attestation payload | Core signs with persona key → writes to PDS as `com.dina.reputation.attestation` record |
| 2 | Sign outcome report | Brain requests outcome publication | Core signs with Reputation Signing Key (HKDF "dina:reputation:v1") → writes to PDS |
| 3 | Lexicon validation | Attestation missing required field (`productCategory`) | Core rejects before signing — schema enforced |
| 4 | Record in Merkle repo | Inspect PDS after publish | Record stored in signed Merkle tree — tamper-evident |
| 5 | PDS connection failure | PDS container down | Core queues record in outbox for retry — record not lost |
| 6 | Type B: bundled PDS (default) | docker-compose default | Core writes directly to `pds:2583` container on internal network |
| 7 | Type A: external PDS | Home Node behind CGNAT | Core pushes signed commit to external PDS via outbound HTTPS |
| 8 | Rating range enforcement (0-100) | Attestation with `rating: 101` | Core rejects before signing — Lexicon schema enforces `"minimum": 0, "maximum": 100`. Also test: `rating: -1` → rejected, `rating: 0` → accepted, `rating: 100` → accepted |
| 9 | Verdict is structured object with sub-scores | Attestation with `verdict: "good"` (plain string) | Core rejects — `verdict` must be a `#verdictDetail` ref (object with sub-scores like `build_quality`, `lumbar_support`, `value_for_money`, `durability_estimate`). Also test: valid object → accepted |
| 10 | All 5 required Lexicon fields validated | Attestation missing each field one at a time | Core rejects if ANY of the 5 required fields is missing: `expertDid` (did format), `productCategory` (string), `productId` (string), `rating` (integer 0-100), `verdict` (ref object). Test each omission independently |

### 22.2 Signed Tombstones (Deletion)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Author deletes own record | User requests deletion of review | Core generates `Tombstone {target, author, sig}` signed by same key → PDS deletes record |
| 2 | Non-author deletion rejected | External request to delete someone else's record | Signature doesn't match author → rejected |
| 3 | Tombstone propagation | Tombstone published to PDS | Relay distributes tombstone to all federated AppViews |
| 4 | Deleted record absent from queries | Record deleted via tombstone | AppView no longer returns record — aggregate scores recomputed without it |

---

## 23. Portability & Migration

### 23.1 Export Process

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | `dina export` produces encrypted archive | Run on populated instance | `.dina` archive (encrypted tar.gz with Argon2id → AES-256-GCM) |
| 2 | WAL checkpoint before export | Active vault with pending WAL | `PRAGMA wal_checkpoint(TRUNCATE)` on all open databases before archiving |
| 3 | Archive contains correct files | Inspect archive contents | identity.sqlite, vault/*.sqlite, keyfile (convenience only), config.json, manifest.json |
| 4 | manifest.json contents | Inspect manifest | Contains: version, export timestamp, SHA-256 checksums per file |
| 5 | Export excludes BRAIN_TOKEN | Inspect archive | BRAIN_TOKEN not present (per-machine, regenerated by install.sh) |
| 6 | Export excludes CLIENT_TOKEN hashes | Inspect archive | `device_tokens` table excluded — devices re-pair on new machine |
| 7 | Export excludes passphrase | Inspect archive | Passphrase not stored — archive encrypted *with* it, not *containing* it |
| 8 | Export excludes PDS data | Inspect archive | No PDS repo data — PDS re-syncs from relay via AT Protocol |
| 9 | Export excludes Docker secrets | Inspect archive | No `/run/secrets/` contents — regenerated by install.sh |
| 10 | Export while vault locked | Security mode, vault locked | Export still works — files are encrypted on disk, no DEK needed |
| 11 | Database writes resumed after export | Export completes | WAL writes resume, no data loss during export window |

### 23.2 Import Process

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Import prompts for passphrase | Run `dina import` | Passphrase prompted → Argon2id → decrypt archive |
| 2 | Import with wrong passphrase | Incorrect passphrase | AES-256-GCM decryption fails, import aborted |
| 3 | Import verifies checksums | Valid archive | manifest.json checksums verified against restored files |
| 4 | Import detects corruption | Corrupted archive (flipped bits) | Checksum mismatch → import aborted |
| 5 | Import checks version compatibility | Archive from incompatible version | Rejected with "incompatible archive version" error |
| 6 | Import runs integrity_check | After restoring .sqlite files | `PRAGMA integrity_check` on each database — all pass |
| 7 | Import integrity_check failure | Archive with corrupted .sqlite | integrity_check fails → import aborted, files cleaned up |
| 8 | Import prompts for re-pairing | Successful import | User notified: "Re-pair your devices (6-digit code) and re-configure OpenClaw" |
| 9 | Imported DID matches original | Compare DID pre-export vs post-import | Identical `did:key` — identity preserved across migration |
| 10 | Import on fresh instance | No existing data | Clean restore, all personas and vault items present |
| 11 | Import on instance with existing data | Import when vault already populated | Rejected (or merge with explicit `--force` flag) — no silent overwrite |
| 12 | Import rejects tampered archive | Modified bytes in archive | Integrity error — import aborted |

### 23.3 Cross-Host Migration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Managed → self-hosted VPS | Export on managed, import on VPS | Identical functionality, all data accessible |
| 2 | Raspberry Pi → Mac Mini | Export on Pi, import on Mac | Same archive, same command, any hardware |
| 3 | Same Docker image across hosting levels | Build once, deploy to managed/VPS/sovereign | Identical startup behavior and API responses |
| 4 | Migration preserves vault search | Export with 10K items → import → search | FTS5 + sqlite-vec results identical post-migration |

---

## 24. Deferred (Phase 2+)

> These scenarios depend on features not yet implemented. Include in active test
> suite when the corresponding phase ships.

### 24.1 ZKP Trust Rings (Identity Verification)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Ring 1 — Unverified Dina | New DID, no verification | Trust level: `unverified`, very low trust ceiling, small interactions only |
| 2 | Ring 2 — Verified Human (ZKP) | User proves valid government ID via ZKP circuit | Proof that "this is a valid, unique ID number" without revealing number — Sybil prevention |
| 3 | Ring 2 — Phase 1 compromise | Aadhaar e-KYC XML with offline verification | Processed locally on-device, only yes/no attestation stored — not full ZKP (UIDAI doesn't offer ZKP-native API) |
| 4 | Ring 2 — one ID = one verified Dina | Attempt second verification with same government ID | Rejected — prevents Sybil attacks |
| 5 | Ring 3 — Skin in the Game | W3C Verifiable Credentials from LinkedIn, GitHub, business registration | Each credential adds trust weight, reveals only what user chooses |
| 6 | Trust Score formula | Compute trust score | `f(ring_level, time_alive, transaction_anchors, outcome_data, peer_attestations, credential_count)` — composite function |
| 7 | Trust level affects sharing/routing | Unverified contact vs Verified contact | Different default sharing policies applied |

### 24.2 HSM / Secure Enclave Key Generation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Key generation uses Secure Enclave (iOS) | iOS device setup | Private key generated inside Secure Enclave, never exported |
| 2 | Key generation uses StrongBox (Android) | Android device setup | Private key generated inside StrongBox Keymaster |
| 3 | Key generation uses TPM (desktop) | Desktop/server setup | Private key generated via TPM 2.0 |
| 4 | Fallback: software entropy | No HSM available | `crypto/rand` from OS entropy pool — secure but not hardware-isolated |

### 24.3 Tier 5 Deep Archive (Cold Storage)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Archive encrypted with Archive Key | Create Tier 5 snapshot | AES-256-GCM with `HKDF("dina:archive:v1")` key — separate from Backup Key |
| 2 | Archive contains Tier 0 + 1 + 3 (NOT Tier 2 or 4) | Inspect archive contents | identity.sqlite (Tier 0) + all persona vaults (Tier 1) + reputation/preferences (Tier 3). Tier 2 (index/embeddings) explicitly ABSENT — regenerable from Tier 1. Tier 4 (staging) explicitly ABSENT — ephemeral. Verify by listing archive entries: no embedding tables, no staging tables, no sqlite-vec data |
| 3 | Weekly frequency (configurable) | Check schedule | Default weekly, configurable via config.json |
| 4 | S3 Glacier + Compliance Mode Object Lock | Push to S3 | Object locked — even root user / cloud support cannot delete during retention period |
| 5 | Sovereign: USB/LTO tape | Push to local drive | Physically unplugged after backup — air-gapped |
| 6 | Archive useless without keys | Attacker obtains archive blob | Encrypted blobs — cannot decrypt without master seed |

### 24.4 ZFS/Btrfs File System Snapshots

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Auto-snapshot every 15 minutes | ZFS on `/var/lib/dina/vault/` | Copy-on-write snapshots — instant, near-zero space cost |
| 2 | Snapshot retention policy | Inspect schedule | 24h of 15-min, 7 days of hourly, 30 days of daily |
| 3 | `zfs rollback` recovery | Corruption detected | `zfs rollback dina/vault@15min_ago` — instant revert |
| 4 | Managed hosting: per-user volumes | Two users on same host | `/var/lib/dina/users/<did>/vault/` — separate ZFS datasets |

### 24.5 Client Cache Sync

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Phone: recent 6 months cached | Inspect phone vault cache | Only last 6 months of data, encrypted with Client Sync Key |
| 2 | Laptop: configurable cache size | Set cache to "everything" | Full vault replica (or subset) |
| 3 | Thin client: no local cache | Inspect thin client | Zero vault data stored locally — WS relay only |
| 4 | Cache encrypted with Sync Key | Inspect cache on device | Encrypted with `HKDF("dina:sync:v1")` — not raw DEKs |

---

## Appendix A: Test Data & Fixtures

- **Test mnemonic**: Use a fixed BIP-39 test mnemonic for deterministic key derivation tests
- **Test DID**: Pre-generated `did:key:z6Mk...` for identity tests
- **Test vault**: Pre-populated SQLCipher database for search/CRUD tests
- **Test messages**: Sealed NaCl messages between two known keypairs
- **Mock brain**: HTTP test server returning canned responses for brain client tests

## Appendix B: Performance Benchmarks

| Test | Target |
|------|--------|
| Vault item write (single) | < 5ms |
| Vault FTS5 search (10K items) | < 50ms |
| PII regex scrub (1 MiB text) | < 100ms |
| NaCl seal (1 KiB payload) | < 1ms |
| SLIP-0010 key derivation | < 10ms |
| Argon2id hash (production params) | 500ms–1s |
| Rate limiter check | < 1μs |
