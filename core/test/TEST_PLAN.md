# Dina Core — Test Plan

> Go service (`dina-core`): identity, vault, crypto, transport, gatekeeper, WebSocket, pairing.
> Port 8300 (API), 8100 (admin proxy). Communicates with dina-brain via Service Signature Auth.

---

## 1. Authentication & Authorization

### 1.1 Service Signature Auth (Agent Operations)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-001]** Valid Service Signature Auth in `Authorization: Bearer` header | Correct token from `/run/secrets/brain_token` | 200 — request processed |
| 2 | **[TST-CORE-002]** Missing Authorization header | No header | 401 Unauthorized |
| 3 | **[TST-CORE-003]** Malformed header (`Basic` instead of `Bearer`) | `Authorization: Basic <token>` | 401 Unauthorized |
| 4 | **[TST-CORE-004]** Wrong Service Signature Auth value | Random 64-hex string | 401 Unauthorized |
| 5 | **[TST-CORE-005]** Empty Bearer value | `Authorization: Bearer ` | 401 Unauthorized |
| 6 | **[TST-CORE-006]** Service Signature Auth with leading/trailing whitespace | Token with `\n` or spaces | Trimmed and accepted, or 401 if mismatch |
| 7 | **[TST-CORE-007]** Token file missing at startup | `/run/secrets/brain_token` absent | Core refuses to start, exits with error |
| 8 | **[TST-CORE-008]** Token file empty | 0-byte file | Core refuses to start |
| 9 | **[TST-CORE-009]** Timing-attack resistance | Measure response time for wrong vs. correct token | Constant-time comparison (no measurable difference) |

### 1.2 CLIENT_TOKEN (Per-Device Admin Access)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-010]** Valid CLIENT_TOKEN | SHA-256 hash matches stored hash | 200 — full admin access |
| 2 | **[TST-CORE-011]** Unknown CLIENT_TOKEN | Hash not in device registry | 401 |
| 3 | **[TST-CORE-012]** Revoked CLIENT_TOKEN | Token previously registered then revoked | 401 |
| 4 | **[TST-CORE-013]** CLIENT_TOKEN on Service Signature Auth-only endpoint | Client token on `/v1/brain/*` | 403 Forbidden |
| 5 | **[TST-CORE-014]** Service Signature Auth on CLIENT_TOKEN-only endpoint | Service signature auth on `/v1/admin/*` | 403 Forbidden |
| 6 | **[TST-CORE-015]** Concurrent device sessions | Two devices with different CLIENT_TOKENs | Both work independently |
| 7 | **[TST-CORE-016]** CLIENT_TOKEN hash lookup is constant-time | Timing analysis | No measurable difference between valid/invalid |

### 1.3 Browser Session Auth Gateway

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-017]** Login with correct passphrase | Argon2id-hashed passphrase matches stored hash | Set-Cookie with session token, redirect to dashboard |
| 2 | **[TST-CORE-018]** Login with wrong passphrase | Incorrect passphrase | 401, no cookie set |
| 3 | **[TST-CORE-019]** Session cookie → Bearer translation | Valid session cookie on proxied request | Core injects `Authorization: Bearer <CLIENT_TOKEN>` |
| 4 | **[TST-CORE-020]** Expired session cookie | Cookie past TTL | 401, redirect to login |
| 5 | **[TST-CORE-021]** CSRF token validation | POST without `X-CSRF-Token` header | 403 |
| 6 | **[TST-CORE-022]** CSRF token mismatch | Wrong CSRF token | 403 |
| 7 | **[TST-CORE-023]** Session fixation resistance | Reuse session ID after login | New session ID generated on successful auth |
| 8 | **[TST-CORE-024]** Concurrent browser sessions | Two browsers, same user | Both sessions valid independently |
| 9 | **[TST-CORE-025]** Logout | POST `/logout` | Cookie cleared, session invalidated server-side |
| 10 | **[TST-CORE-026]** Cookie attributes | Inspect Set-Cookie | `HttpOnly`, `Secure` (when TLS), `SameSite=Strict` |
| 11 | **[TST-CORE-027]** Login rate limit: 5 attempts/min/IP | 6 login attempts in 60s from same IP | 6th attempt → 429, Argon2id slowness (~1s) makes brute force impractical |
| 12 | **[TST-CORE-028]** Session storage: in-memory, lost on restart | Core restarts | All sessions invalidated — users must re-login |
| 13 | **[TST-CORE-029]** Session TTL: 24 hours, configurable | `DINA_SESSION_TTL=3600` (1h) | Session expires after 1h, not default 24h |
| 14 | **[TST-CORE-030]** Session ID generation | Inspect generated session ID | 32 bytes from `crypto/rand`, hex-encoded |
| 15 | **[TST-CORE-031]** Cookie Max-Age matches TTL | Inspect `Set-Cookie` header | `Max-Age=86400` (matches session TTL default) |
| 16 | **[TST-CORE-032]** Successful login → 302 redirect | Correct passphrase submitted | HTTP 302 redirect to `/admin` |
| 17 | **[TST-CORE-033]** Login page: Go embed.FS | GET `/admin` with no session | Static HTML login form from Go binary (`embed.FS`), zero external deps |
| 18 | **[TST-CORE-034]** Device app: Bearer pass-through | `Authorization: Bearer <CLIENT_TOKEN>` on `/admin/*` | Token validated, proxied to brain — no cookie needed |
| 19 | **[TST-CORE-035]** No cookie → login page (not 401) | GET `/admin` without session cookie | Login page served, not 401 |
| 20 | **[TST-CORE-036]** Convenience mode: admin still needs passphrase | Vault auto-unlocked, no browser session | Admin access requires DINA_PASSPHRASE — defense in depth |
| 21 | **[TST-CORE-037]** Brain never sees cookies | Inspect proxied request to brain:8200 | No `Cookie` header forwarded — only `Authorization: Bearer` injected |

### 1.4 Auth Surface Completeness (Kernel Guarantee)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-038]** No third authentication mechanism exists | Enumerate all middleware/auth handlers in source | Only Service Signature Auth and CLIENT_TOKEN code paths — no API keys, no OAuth from external IdP |
| 2 | **[TST-CORE-039]** Unknown auth scheme ignored | `Authorization: ApiKey abc123` | 401 — scheme not recognized, no handler |
| 3 | **[TST-CORE-040]** External JWT rejected | Valid JWT from external identity provider | 401 — core does not validate external JWTs |
| 4 | **[TST-CORE-041]** Route enumeration shows no plugin endpoints | List all registered HTTP routes | No `/v1/plugins`, `/v1/extensions`, `/v1/hooks`, or similar |
| 5 | **[TST-CORE-042]** `identifyToken()` priority: Service Signature Auth first | Present Service Signature Auth | Constant-time comparison checked before SHA-256 DB lookup (prevents timing leak) |
| 6 | **[TST-CORE-043]** `identifyToken()` fallback: CLIENT_TOKEN second | Present CLIENT_TOKEN | `SHA-256(token)` → lookup in `device_tokens WHERE revoked = 0` |
| 7 | **[TST-CORE-044]** `isAdminEndpoint()` allowlist — Service Signature Auth rejected on admin paths | Service Signature Auth on `/v1/did/sign`, `/v1/did/rotate`, `/v1/vault/backup`, `/v1/persona/unlock`, `/admin/*` | 403 Forbidden on every admin endpoint |
| 8 | **[TST-CORE-045]** CLIENT_TOKEN accepted on all endpoints | CLIENT_TOKEN on admin + non-admin paths | 200 — full access including admin |
| 9 | **[TST-CORE-046]** Core never calls external APIs | Code audit: grep for outbound HTTP clients (no OAuth, Gmail, connector calls) | Zero external API calls — core is the sovereign kernel |

### 1.5 Compromised Brain Damage Radius

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-047]** Compromised brain: can access open personas | Service Signature Auth + vault query for open persona | 200 — data returned (this is the expected damage radius) |
| 2 | **[TST-CORE-048]** Compromised brain: cannot access locked personas | Service Signature Auth + vault query for locked persona | 403 Persona Locked — DEK not in RAM |
| 3 | **[TST-CORE-049]** Compromised brain: restricted creates detection trail | Service Signature Auth + vault query for restricted persona | 200 — served, but audit entry + daily briefing notification created |
| 4 | **[TST-CORE-050]** Compromised brain: cannot call did/sign | Service Signature Auth + `POST /v1/did/sign` | 403 — admin endpoint, Service Signature Auth rejected |
| 5 | **[TST-CORE-051]** Compromised brain: cannot call did/rotate | Service Signature Auth + `POST /v1/did/rotate` | 403 |
| 6 | **[TST-CORE-052]** Compromised brain: cannot call vault/backup | Service Signature Auth + `POST /v1/vault/backup` | 403 |
| 7 | **[TST-CORE-053]** Compromised brain: cannot call persona/unlock | Service Signature Auth + `POST /v1/persona/unlock` | 403 |
| 8 | **[TST-CORE-054]** Compromised brain: cannot bypass PII scrubber | Service Signature Auth + request that should be scrubbed | PII scrubber runs in core pipeline — brain cannot skip it |
| 9 | **[TST-CORE-055]** Compromised brain: cannot access raw vault files | Brain container filesystem | No SQLite files mounted — brain accesses vault only via core API |

### 1.6 Authorization Middleware (Allowlist Enforcement)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1097]** Service signature auth on /v1/did/sign → forbidden | Service Signature Auth + `POST /v1/did/sign` | 403 Forbidden |
| 2 | **[TST-CORE-1098]** Client token on /v1/did/sign → allowed | CLIENT_TOKEN + `POST /v1/did/sign` | 200 OK |
| 3 | **[TST-CORE-1099]** Service signature auth on /v1/vault/query → allowed | Service Signature Auth + `POST /v1/vault/query` | 200 OK |
| 4 | **[TST-CORE-1100]** Service signature auth on admin endpoints → forbidden | Service Signature Auth + admin paths (sign, rotate, backup, unlock, export, import, pair) | 403 Forbidden for all |
| 5 | **[TST-CORE-1101]** Client token on all endpoints → allowed | CLIENT_TOKEN + all paths (admin + brain-allowed) | 200 OK for all |
| 6 | **[TST-CORE-1102]** Service signature auth on allowed non-admin paths → OK | Service Signature Auth + allowed paths (vault, msg, task, pii, did) | 200 OK for all |
| 7 | **[TST-CORE-1103]** Unauthenticated requests on public paths pass through | No token + `/healthz` | 200 OK (authz middleware passes through) |
| 8 | **[TST-CORE-1104]** Explicit context token_kind enforcement | Context with brain/client kinds on admin path | Brain → 403, Client → 200 |
| 9 | **[TST-CORE-1105]** Concurrent token validation thread-safe | 100 goroutines validating concurrently | No data races, all succeed |

---

## 2. Key Derivation & Cryptography

### 2.1 BIP-39 Mnemonic Generation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-056]** Generate 24-word mnemonic | First-run key generation | Valid BIP-39 English wordlist, 256 bits entropy |
| 2 | **[TST-CORE-057]** Mnemonic → seed derivation | Known test vector mnemonic | PBKDF2-HMAC-SHA512, 2048 iterations → known 512-bit seed |
| 3 | **[TST-CORE-058]** Invalid mnemonic (bad checksum) | Mnemonic with wrong last word | Rejected with error |
| 4 | **[TST-CORE-059]** Invalid mnemonic (wrong word count) | 12-word mnemonic where 24 expected | Rejected |
| 5 | **[TST-CORE-060]** Mnemonic with extra whitespace | Words separated by multiple spaces | Normalized and accepted |
| 6 | **[TST-CORE-061]** Master seed IS the DEK | Inspect after mnemonic → PBKDF2 | 512-bit seed used directly as key material — key-wrapped on disk by Argon2id-derived KEK (AES-256-GCM) |
| 7 | **[TST-CORE-062]** Mnemonic recovery: re-derive everything | Enter same 24-word mnemonic on new install | Identical root keypair, identical persona keys, identical vault DEKs — full identity restored |
| 8 | **[TST-CORE-063]** Mnemonic recovery: BIP-39 → seed → SLIP-0010 → same DID | Enter known test mnemonic | Same `did:plc` identity as original — DID preserved across recovery |
| 9 | **[TST-CORE-064]** Lose device + paper = identity gone | No mnemonic, no device backup | Identity unrecoverable — by design, no password reset, no server-side recovery |
| 10 | **[TST-CORE-065]** Root identity never transmitted in plaintext | Network capture on all interfaces during full operation | Master seed, mnemonic, and DEKs never appear in any network traffic |

### 2.2 SLIP-0010 Ed25519 Hardened Derivation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-066]** Derive root identity key | Path `m/9999'/0'/0'` | Deterministic Ed25519 keypair |
| 2 | **[TST-CORE-067]** Derive persona N key | Path `m/9999'/1'/N'/0'` (N=0,1,2...) | Unique keypair per persona index |
| 3 | **[TST-CORE-068]** Determinism | Same seed, same path, two runs | Identical keypair both times |
| 4 | **[TST-CORE-069]** Different paths → different keys | `m/9999'/0'/0'` vs `m/9999'/1'/0'/0'` | Different keypairs |
| 5 | **[TST-CORE-070]** Hardened-only enforcement | Attempt non-hardened path `m/9999/0` | Rejected — only hardened derivation allowed |
| 6 | **[TST-CORE-071]** Known test vectors | SLIP-0010 spec test vectors | Output matches published vectors exactly |
| 7 | **[TST-CORE-072]** Purpose `9999'` namespace isolation | Derive at `m/9999'/0'/0'` and `m/44'/0'` from same seed | Different keypairs — Dina purpose `9999'` never collides with BIP-44 `44'` |
| 8 | **[TST-CORE-073]** Purpose `44'` STRICTLY FORBIDDEN | Attempt `m/44'/0'` derivation via Dina API | Rejected with error — purpose `44'` explicitly blocked to prevent crypto wallet key collision |
| 9 | **[TST-CORE-074]** Same mnemonic across Dina + crypto wallet | Reuse BIP-39 mnemonic in both | `m/9999'/*` (Dina) and `m/44'/*` (wallet) produce mathematically independent key trees |
| 10 | **[TST-CORE-075]** Sibling key unlinkability | Derive `m/9999'/1'/0'/0'` and `m/9999'/1'/1'/0'` | No mathematical relationship between siblings — hardened derivation prevents computing one from the other |
| 11 | **[TST-CORE-076]** Go implementation: stellar/go library | Code audit | Uses `github.com/stellar/go/exp/crypto/derivation` or equivalent — no custom HD derivation |
| 12 | **[TST-CORE-077]** Canonical persona index mapping | Derive all default persona keys | `m/9999'/0'/0'` = root, `m/9999'/1'/0'/0'` = consumer, `m/9999'/1'/1'/0'` = professional, `m/9999'/1'/2'/0'` = social, `m/9999'/1'/3'/0'` = health, `m/9999'/1'/4'/0'` = financial, `m/9999'/1'/5'/0'` = citizen — purpose-separated tree, personas scale to thousands |
| 13 | **[TST-CORE-078]** Custom persona index: sequential from 6 | User creates first custom persona | Assigned `m/9999'/1'/6'/0'` — next unused persona index after built-in (0-5) |
| 14 | **[TST-CORE-079]** Persona index stored in identity.sqlite | Inspect `personas` table after creation | Each persona record includes `derivation_index` column — maps persona name to SLIP-0010 path index |

### 2.3 HKDF-SHA256 (Vault DEK Derivation)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-080]** Derive per-persona DEK | Master seed + persona ID as info | 256-bit key suitable for SQLCipher |
| 2 | **[TST-CORE-081]** Different personas → different DEKs | Same seed, persona "work" vs "personal" | Different keys |
| 3 | **[TST-CORE-082]** Determinism | Same inputs, two derivations | Identical DEK |
| 4 | **[TST-CORE-083]** Known HKDF test vectors | RFC 5869 test vectors | Output matches |
| 5 | **[TST-CORE-084]** Full info string set | Derive DEKs for all persona types | `dina:vault:identity:v1`, `dina:vault:personal:v1`, `dina:vault:health:v1`, `dina:vault:financial:v1`, `dina:vault:social:v1`, `dina:vault:consumer:v1` — each produces unique 256-bit DEK |
| 6 | **[TST-CORE-085]** Compromise isolation | Attacker obtains `health` DEK | Cannot derive `financial` DEK — HKDF with different info string produces mathematically independent keys |
| 7 | **[TST-CORE-086]** Custom persona info string | User creates `/custom/research` persona | Info string `dina:vault:custom_research:v1` — follows naming convention |
| 8 | **[TST-CORE-087]** Backup Encryption Key | Derive backup key | `HKDF(info="dina:backup:v1")` → wraps persona file snapshots for off-node backup |
| 9 | **[TST-CORE-088]** Archive Key (Tier 5) | Derive archive key | `HKDF(info="dina:archive:v1")` → wraps full vault snapshots for cold storage |
| 10 | **[TST-CORE-089]** Archive Key separate from Backup Key | Rotate backup key | Archive key unaffected — archive survives backup key rotation |
| 11 | **[TST-CORE-090]** Client Sync Key | Derive sync key | `HKDF(info="dina:sync:v1")` → encrypts vault cache pushes to client devices |
| 12 | **[TST-CORE-091]** Trust Signing Key | Derive trust key | `HKDF(info="dina:trust:v1")` → signs anonymized outcome data |
| 13 | **[TST-CORE-092]** `user_salt` is random 32-byte value | Inspect HKDF call parameters | HKDF uses `salt=user_salt` (a random 32-byte value generated at first setup), not `salt=nil` — prevents identical DEKs across Dina nodes that reuse the same BIP-39 mnemonic |
| 14 | **[TST-CORE-093]** `user_salt` generated once at first setup | First-run key generation | 32 bytes from `crypto/rand`, stored in identity.sqlite (unencrypted — salt is not secret, it provides uniqueness) |
| 15 | **[TST-CORE-094]** `user_salt` persisted across reboots | Restart core → derive DEKs | Same `user_salt` retrieved from identity.sqlite → same DEKs → vault files open correctly |
| 16 | **[TST-CORE-095]** `user_salt` included in export | `dina export` produces archive | `user_salt` preserved in export — required for DEK re-derivation on import |
| 17 | **[TST-CORE-096]** Same mnemonic, different `user_salt` → different DEKs | Two Dina nodes, same BIP-39 mnemonic, different `user_salt` | HKDF outputs are different — persona vaults on Node A cannot be decrypted by Node B even with identical mnemonic |
| 18 | **[TST-CORE-097]** `user_salt` absent → startup error | Delete `user_salt` from identity.sqlite | Core refuses to derive DEKs — clear error: "user_salt missing, vault cannot be opened" |

### 2.4 Argon2id (Passphrase Hashing)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-098]** Hash passphrase | "correct horse battery staple" | Argon2id hash with embedded salt |
| 2 | **[TST-CORE-099]** Verify correct passphrase | Correct passphrase + stored hash | Verification passes |
| 3 | **[TST-CORE-100]** Verify wrong passphrase | Wrong passphrase + stored hash | Verification fails |
| 4 | **[TST-CORE-101]** Default parameters | Inspect hash output | `memory_mb=128` (128 MiB), `iterations=3` (OWASP 2024 min is 2), `parallelism=4` |
| 5 | **[TST-CORE-102]** Unique salts | Hash same passphrase twice | Different hash outputs (random 16-byte salt, stored alongside wrapped blob) |
| 6 | **[TST-CORE-103]** Parameters configurable via config.json | Set `{"argon2id": {"memory_mb": 256, "iterations": 5, "parallelism": 8}}` | Custom params used instead of defaults |
| 7 | **[TST-CORE-104]** Runs once at unlock, not per-request | Vault unlock → measure timing | KEK derived once (~1-2s), stays in RAM for process lifetime — subsequent requests don't re-derive |
| 8 | **[TST-CORE-105]** Passphrase change: re-wrap only | Change passphrase | Master seed re-wrapped with new KEK (Argon2id(new_passphrase) → new KEK → re-encrypt blob) — no re-encryption of multi-GB databases |

### 2.5 Ed25519 Signing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-106]** Sign message | Known message + private key | Valid Ed25519 signature |
| 2 | **[TST-CORE-107]** Verify valid signature | Message + signature + public key | Verification passes |
| 3 | **[TST-CORE-108]** Verify tampered message | Modified message + original signature | Verification fails |
| 4 | **[TST-CORE-109]** Verify wrong public key | Message + signature + different key | Verification fails |
| 5 | **[TST-CORE-110]** Canonical JSON signing | Sign `json.Marshal` with sorted keys, no signature fields | Deterministic canonical form |
| 6 | **[TST-CORE-111]** Empty message signing | Empty byte slice | Valid signature (not rejected) |

### 2.6 Ed25519 → X25519 Conversion

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-112]** Convert signing key to encryption key | Ed25519 private key | Valid X25519 private key via `crypto_sign_ed25519_sk_to_curve25519` |
| 2 | **[TST-CORE-113]** Convert public key | Ed25519 public key | Valid X25519 public key via `crypto_sign_ed25519_pk_to_curve25519` |
| 3 | **[TST-CORE-114]** Roundtrip: sign then encrypt | Ed25519 sign → X25519 encrypt → decrypt → verify | All operations succeed |
| 4 | **[TST-CORE-115]** One-way property | X25519 private key | Cannot derive original Ed25519 signing key from X25519 encryption key — one-way derivation |
| 5 | **[TST-CORE-116]** Ephemeral per message | Two `crypto_box_seal` calls to same recipient | Each uses fresh ephemeral X25519 keypair — compromise of one message's ephemeral key doesn't expose static signing key |
| 6 | **[TST-CORE-117]** Conscious reuse (not separate keypairs) | Code audit | Single Ed25519 keypair per persona → derived X25519 for encryption. Not separate signing + encryption keypairs (doubles complexity, no practical benefit) |
| 7 | **[TST-CORE-118]** Ephemeral X25519 key zeroed from memory after `crypto_box_seal` | Send D2D message → inspect process memory (test env) | Ephemeral private key destroyed immediately after encryption — not resident in RAM after send completes. Architecture guarantee: "Ephemeral private key destroyed immediately (sender forward secrecy)" |

### 2.7 NaCl crypto_box_seal (Dina-to-Dina Encryption)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-119]** Seal message to recipient | Plaintext + recipient X25519 pubkey | Ciphertext (ephemeral sender key embedded) |
| 2 | **[TST-CORE-120]** Open sealed message | Ciphertext + recipient keypair | Original plaintext recovered |
| 3 | **[TST-CORE-121]** Wrong recipient key | Ciphertext + different recipient keypair | Decryption fails |
| 4 | **[TST-CORE-122]** Tampered ciphertext | Modified ciphertext bytes | Decryption fails (authentication failure) |
| 5 | **[TST-CORE-123]** Empty plaintext | Seal empty message | Valid ciphertext, decrypts to empty |
| 6 | **[TST-CORE-124]** Large message | 1 MiB plaintext | Seal and open succeed |

### 2.8 AES-256-GCM Key Wrapping (Keystore)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-125]** Wrap key with passphrase-derived KEK | DEK + Argon2id(passphrase) | Wrapped blob (nonce + ciphertext + tag) |
| 2 | **[TST-CORE-126]** Unwrap with correct passphrase | Wrapped blob + correct passphrase | Original DEK recovered |
| 3 | **[TST-CORE-127]** Unwrap with wrong passphrase | Wrapped blob + wrong passphrase | Decryption fails |
| 4 | **[TST-CORE-128]** Tampered wrapped blob | Modified bytes | Authentication failure |
| 5 | **[TST-CORE-129]** Nonce uniqueness | Wrap same key twice | Different wrapped outputs (random nonce) |
| 6 | **[TST-CORE-880]** Key generation verified to use `crypto/rand` (not weak entropy) | Code audit of key generation functions | All key material sourced from `crypto/rand`, never `math/rand` |
| 7 | **[TST-CORE-881]** Archive key survives backup key rotation (separate HKDF derivations) | Rotate backup key, verify archive key | Archive key unchanged — separate HKDF info string `dina:archive:v1` |
| 8 | **[TST-CORE-882]** Client sync key used for sync encryption, trust key for signing | Derive both keys, verify usage | Sync key (`dina:sync:v1`) encrypts cache; trust key (`dina:trust:v1`) signs data |

---

## 3. Identity (DID)

### 3.1 DID Generation & Persistence

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-130]** Generate root DID | First-run | `did:plc` identity registered with PLC Directory from SLIP-0010 `m/9999'/0'/0'` Ed25519 pubkey |
| 2 | **[TST-CORE-131]** Load existing DID | Subsequent startup | Same `did:plc` as initial generation |
| 3 | **[TST-CORE-132]** DID Document structure | Resolve own DID | Contains: `id`, `service` (type `DinaMessaging`, endpoint → Home Node URL), `verificationMethod` (type `Multikey`, `publicKeyMultibase: z6Mk...`) |
| 4 | **[TST-CORE-133]** Multiple persona DIDs | Create personas "work", "personal" | Different DIDs, each derived from unique SLIP-0010 path |
| 5 | **[TST-CORE-134]** DID Document service endpoint | Resolve DID | Endpoint points to Home Node via Cloudflare/Tailscale tunnel — not to PLC Directory |
| 6 | **[TST-CORE-135]** PLC Directory: signed operation log only | Inspect PLC Directory entry | Only stores signed ops — never holds private keys, never reads messages, never stores personal data |
| 7 | **[TST-CORE-136]** Exactly one root identity: second generation rejected | Call first-run setup when root DID already exists | Rejected with error — "root identity already exists". No overwrite, no second root |
| 8 | **[TST-CORE-137]** Root identity: `created_at` timestamp stored | Inspect identity after first-run | Root identity record includes `created_at` timestamp (Unix epoch) — documents when this Dina was born |
| 9 | **[TST-CORE-138]** Root identity: device origin fingerprint stored | Inspect identity after first-run | `device_origin` field records generating device fingerprint (or "unknown" if no HSM) — forensic audit trail |
| 10 | **[TST-CORE-139]** DID Document `verificationMethod`: Multikey with `z6Mk` prefix | Resolve own DID, inspect `publicKeyMultibase` | Prefix `z6Mk` encodes Ed25519 per Multikey specification — wrong prefix (e.g., `z6LS` for X25519) means wrong key type published |

### 3.1.1 Key Rotation (`did:plc`)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-140]** Rotate signing key | Old key compromised → sign rotation op with old key | PLC Directory updates DID Document with new public key |
| 2 | **[TST-CORE-141]** Rotation preserves DID | After key rotation | Same `did:plc:z72i7h...` identifier — no identity loss, no new DID |
| 3 | **[TST-CORE-142]** Old key invalid after rotation | Use old key to sign after rotation | Signature verification fails — old key no longer authoritative |
| 4 | **[TST-CORE-143]** Rotation op: signed by old key | Inspect rotation operation | Must be signed by current (old) signing key — PLC Directory rejects unsigned rotations |
| 5 | **[TST-CORE-144]** Recovery keys can reclaim DID | Primary key lost, recovery key available | Recovery key (stored offline, separate from signing key) signs reclaim op → DID recovered |

### 3.1.2 `did:web` Fallback (Escape Hatch)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-145]** `did:web` resolution | `did:web:dina.alice.com` | Resolves to `https://dina.alice.com/.well-known/did.json` — DID Document returned |
| 2 | **[TST-CORE-146]** `did:web` uses same keypair | Compare `did:plc` and `did:web` keys | Same Ed25519 keypair, same DID Document format |
| 3 | **[TST-CORE-147]** Rotation from `did:plc` → `did:web` | PLC Directory becomes adversarial | Signed rotation op redirects DID to `did:web` endpoint user controls — no permission needed |
| 4 | **[TST-CORE-148]** `did:web` piggybacks on existing ingress | Inspect `did:web` hosting | Served via same Cloudflare/Tailscale tunnel Home Node already has |
| 5 | **[TST-CORE-149]** `did:web` tradeoff acknowledged | Architecture review | Depends on DNS + web server — not fully decentralized. Documented as escape hatch, not primary |

### 3.2 Persona Management

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-150]** Create persona | Name "work", tier "restricted" | New SLIP-0010 derived key, new SQLCipher vault file at `/var/lib/dina/vault/work.sqlite`, persona registered |
| 2 | **[TST-CORE-151]** List personas | GET `/v1/personas` | Array of persona objects with name, DID, tier, created_at |
| 3 | **[TST-CORE-152]** Delete persona | DELETE persona by ID | Vault file securely wiped, keys removed, DID deactivated |
| 4 | **[TST-CORE-153]** Right to delete: file removal = annihilation | `rm data/vault/health.sqlite` | Persona physically destroyed — no SQL needed, no VACUUM, no residual data |
| 5 | **[TST-CORE-154]** Persona isolation | Write to persona A, read from persona B | Data not visible across personas |
| 6 | **[TST-CORE-155]** Default persona exists | After first setup | At least one "default" `/personal` persona |
| 7 | **[TST-CORE-156]** Per-persona file layout | Inspect `/var/lib/dina/` | `identity.sqlite` (Tier 0) + `vault/personal.sqlite`, `vault/health.sqlite`, etc. — one file per persona |
| 8 | **[TST-CORE-157]** Per-persona independent DEK | Compromise `health.sqlite` DEK | Cannot decrypt `financial.sqlite` — different HKDF info string → different key |
| 9 | **[TST-CORE-158]** Locked persona: file is opaque bytes | Inspect vault file when persona locked | DEK not in RAM — no application bug, no brain compromise, no code path can read it |
| 10 | **[TST-CORE-159]** Selective unlock with TTL | Unlock `/financial` for 15 min | Core derives DEK → opens file → serves queries → closes after TTL → zeroes DEK from RAM |
| 11 | **[TST-CORE-160]** Persona Ed25519 key signs DIDComm (NOT root key) | Persona `/social` sends DIDComm message | Signature verifies against `/social` persona pubkey (`m/9999'/1'/2'/0'`), NOT root pubkey (`m/9999'/0'/0'`) — verify both: signature valid with persona key, signature INVALID with root key |
| 12 | **[TST-CORE-161]** Persona Ed25519 key signs Trust Network entries (NOT root key) | Persona publishes attestation | Signed by persona key (e.g., `/consumer` at `m/9999'/1'/0'/0'`), verifiable against persona's DID Document — root key cannot sign on behalf of persona |
| 13 | **[TST-CORE-162]** Even Dina's code cannot cross compartments | Code audit | No code path reads persona B data using persona A's context without root key + logged operation |

### 3.3 Persona Gatekeeper (4-Tier Enforcement)

The 4-tier model controls access based on persona sensitivity and caller type (user/brain/agent):

| Tier | Boot State | Users | Brain | Agents | Audit |
|------|-----------|-------|-------|--------|-------|
| **default** | Auto-open | Free | Free | Free | Silent |
| **standard** | Auto-open | Free | Free | Needs session grant | On agent access |
| **sensitive** | Closed | Unlock with confirm | Needs approval | Needs approval | Always |
| **locked** | Closed | Passphrase | Denied (403) | Denied (403) | Always |

Legacy tiers are auto-migrated: `open` → `default`/`standard`, `restricted` → `sensitive`.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-163]** Access Default-tier persona | Any authenticated request | 200 — immediate access for all caller types |
| 2 | **[TST-CORE-164]** Access Sensitive-tier persona | Authenticated request | 200 for users, access granted + event logged. Brain/agents need session grant |
| 3 | **[TST-CORE-165]** Access Locked-tier persona | Request without prior unlock | 403 — DEK not in RAM |
| 4 | **[TST-CORE-166]** Unlock Locked persona | Provide passphrase, TTL=300s | DEK loaded to RAM, 200 on subsequent requests (users only — agents still denied) |
| 5 | **[TST-CORE-167]** Locked persona TTL expiry | Wait past TTL after unlock | DEK zeroed from RAM, subsequent requests → 403 |
| 6 | **[TST-CORE-168]** Locked persona re-lock | Explicit re-lock command | DEK zeroed immediately |
| 7 | **[TST-CORE-169]** Audit log for Sensitive access | Access sensitive persona | Append-only audit entry with timestamp, accessor, caller type, action |
| 8 | **[TST-CORE-170]** Notification on Sensitive access | Access sensitive persona | Notification dispatched to owner |
| 9 | **[TST-CORE-171]** Locked persona unlock flow | Admin calls `POST /v1/persona/unlock {persona: "financial"}` | Core asks human (via WS/push) → human approves with TTL → DEK loaded → user can query for TTL window |
| 10 | **[TST-CORE-172]** Locked persona unlock: human denies | Human rejects unlock request | 403 persists, requestor notified of denial |
| 11 | **[TST-CORE-173]** Locked persona unlock: TTL expires | Human approved with TTL=300s, 5 min pass | DEK zeroed, subsequent requests → 403 again |
| 12 | **[TST-CORE-174]** Cross-persona query: parallel reads | Brain requests `/social` + `/professional` + `/consumer` simultaneously | Core queries each open database independently, merges results |
| 13 | **[TST-CORE-175]** `GetPersonasForContact()`: derived, never cached | Query "which personas have data about Dr. Patel?" | Core scans all OPEN databases — result computed live, not cached |
| 14 | **[TST-CORE-176]** `GetPersonasForContact()`: locked invisible | Query for contact with data in `/financial` (locked) | `/financial` excluded from results — locked personas are invisible |
| 15 | **[TST-CORE-177]** Tier configuration persisted | Inspect persona_state.json | Tier values: default, standard, sensitive, locked. Legacy values auto-migrated on load |
| 16 | **[TST-CORE-TIER-001]** Tier migration | MigrateTier("open","personal") | "default". MigrateTier("open","consumer") → "standard". MigrateTier("restricted","health") → "sensitive" |
| 17 | **[TST-CORE-TIER-002]** Create with new tiers | Create personas with default/standard/sensitive/locked | All accepted. Legacy "open"/"restricted" also accepted (auto-migrated) |
| 18 | **[TST-CORE-TIER-003]** Default tier allows all callers | User/brain/agent access default persona | All succeed |
| 19 | **[TST-CORE-TIER-004]** Standard denies agent without session | Agent accesses standard persona without session grant | ErrApprovalRequired returned |
| 20 | **[TST-CORE-TIER-005]** Sensitive denies brain and agent | Brain/agent access sensitive persona without grant | ErrApprovalRequired returned |
| 21 | **[TST-CORE-TIER-006]** Session start + grant enables agent | Start session → add grant → agent access | Access granted |
| 22 | **[TST-CORE-TIER-007]** Session end revokes grants | End session → agent access | Access denied |
| 23 | **[TST-CORE-TIER-008]** Session reconnect | Start same-name session twice | Returns existing session (same ID) |
| 24 | **[TST-CORE-TIER-009]** Approval lifecycle | Request → approve → grant created | Agent can access via session |
| 25 | **[TST-CORE-TIER-010]** Approval deny | Request → deny | No grant created, approval removed from pending |
| 26 | **[TST-CORE-TIER-011]** Locked denies agent even unlocked | Unlock locked persona → agent access | Still denied (locked tier = users only) |

### 3.4 Contact Directory

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-178]** Add contact | DID + display name + trust level | Contact stored with per-persona routing rules |
| 2 | **[TST-CORE-179]** Resolve contact DID | Lookup by display name | Returns DID + current service endpoints |
| 3 | **[TST-CORE-180]** Update contact trust level | Change from Unverified → Verified | Trust level updated, sharing policies may change |
| 4 | **[TST-CORE-181]** Delete contact | Remove by DID | Contact removed, associated sharing policies cleaned |
| 5 | **[TST-CORE-182]** Per-persona contact routing | Contact mapped to persona "work" | Messages from contact route to work persona only |
| 6 | **[TST-CORE-183]** Contacts table: NO `persona` column | Inspect `contacts` DDL in identity.sqlite | `contacts` table has NO `persona` column — people are cross-cutting, they span contexts (Dr. Patel sends lab results AND cricket chat). Contact-persona association is derived from vault data, not stored as a column |
| 7 | **[TST-CORE-184]** Contacts table: full schema validation | Inspect `contacts` DDL | `did TEXT PRIMARY KEY, name TEXT, alias TEXT, trust_level TEXT DEFAULT 'unknown', sharing_policy TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP` — all columns present with correct types and defaults |
| 8 | **[TST-CORE-185]** Trust level enum validation | `POST /v1/contacts` with `trust_level: "super_trusted"` | 400 Bad Request — only 'blocked', 'unknown', 'trusted' accepted |
| 9 | **[TST-CORE-186]** `idx_contacts_trust` index exists | Inspect identity.sqlite schema | `CREATE INDEX idx_contacts_trust ON contacts(trust_level)` — must exist for efficient bulk policy queries |

### 3.5 Device Registry

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-187]** Register device | Device name + CLIENT_TOKEN hash | Device added to registry |
| 2 | **[TST-CORE-188]** List devices | GET `/v1/devices` | Array of registered devices with last-seen timestamps |
| 3 | **[TST-CORE-189]** Revoke device | Revoke by device ID | CLIENT_TOKEN hash removed, future requests rejected |
| 4 | **[TST-CORE-190]** Max device limit | Register beyond limit (e.g., 10) | 429 or 400 — limit enforced |

### 3.6 Recovery (Shamir's Secret Sharing)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-191]** Split master seed | 3-of-5 threshold | 5 shares generated, any 3 reconstruct seed |
| 2 | **[TST-CORE-192]** Reconstruct with threshold shares | 3 valid shares | Original master seed recovered |
| 3 | **[TST-CORE-193]** Reconstruct with fewer than threshold | 2 shares | Reconstruction fails |
| 4 | **[TST-CORE-194]** Reconstruct with invalid share | 2 valid + 1 corrupted | Reconstruction fails or produces wrong seed (detected by checksum) |
| 5 | **[TST-CORE-195]** Share format | Inspect share bytes | Includes share index, threshold metadata |
| 6 | **[TST-CORE-926]** DID Document endpoint update on ingress tier change | Change ingress tier | DID Document service endpoint updated to reflect new ingress |
| 7 | **[TST-CORE-927]** Trust ring level enum defined in code | Inspect trust level constants | Enum values: unverified=1, verified=2, skin_in_game=3 |
| 8 | **[TST-CORE-928]** No MCP/OpenClaw credential can access vault endpoints | MCP/OpenClaw token on /v1/vault/* | 401/403 — only Service Signature Auth and CLIENT_TOKEN accepted |

---

## 4. Vault (SQLCipher)

### 4.1 Vault Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-196]** Create new vault | New persona | SQLCipher `.sqlite` file created with per-persona DEK |
| 2 | **[TST-CORE-197]** Open existing vault | Startup with existing vault files | Vault opened, DEK derived, schema validated |
| 3 | **[TST-CORE-198]** Open with wrong DEK | Incorrect passphrase/seed | `SQLITE_NOTADB` error — cannot decrypt |
| 4 | **[TST-CORE-199]** Schema migration | Vault with older schema version | DDL migrations applied in order |
| 5 | **[TST-CORE-200]** Concurrent access | Two goroutines reading/writing | WAL mode handles concurrency, no corruption |
| 6 | **[TST-CORE-201]** SQLCipher PRAGMAs on every connection | Open any vault, inspect PRAGMAs | `cipher_page_size=4096`, `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000` |
| 7 | **[TST-CORE-202]** WAL crash recovery | Kill process mid-write | On restart: incomplete `-wal` file rolled back automatically, `.sqlite` untouched |
| 8 | **[TST-CORE-203]** `synchronous=NORMAL` in WAL mode | Inspect PRAGMA | NORMAL (not FULL) — safe in WAL mode, significantly faster |
| 9 | **[TST-CORE-204]** `foreign_keys=ON` | Insert violating foreign key | Rejected — prevents orphaned data |
| 10 | **[TST-CORE-205]** `busy_timeout=5000` | Concurrent write attempt | Waits up to 5s for lock instead of immediate `SQLITE_BUSY` |

### 4.1.1 Connection Pool (Multi-Database Vault Manager)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-206]** VaultManager structure | Inspect at runtime | `identity` pool (always open) + `personas` map keyed by name (protected by `sync.RWMutex`) |
| 2 | **[TST-CORE-207]** Write connection: single-writer | Two concurrent writes to same persona | Serialized via `MaxOpenConns=1` on writeConn — second write waits (up to `busy_timeout`) |
| 3 | **[TST-CORE-208]** Read pool: multiple readers | 10 concurrent reads to same persona | All served simultaneously via readPool (`MaxOpenConns = cpu_count * 2`) |
| 4 | **[TST-CORE-209]** Read connections: query_only | Attempt write on read connection | `PRAGMA query_only=ON` prevents accidental writes — error returned |
| 5 | **[TST-CORE-210]** Write autocheckpoint | Heavy write load | `wal_autocheckpoint=1000` — WAL checkpointed every ~4MB, preventing unbounded WAL growth |
| 6 | **[TST-CORE-211]** Cross-persona write independence | Bulk ingest into `/personal` while querying `/health` | Fully independent — different files, different write connections, zero contention |
| 7 | **[TST-CORE-212]** Concurrent readers during write | Write in progress, read request arrives | WAL allows concurrent readers — read sees committed state, write continues |

### 4.2 Vault CRUD (Items)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-213]** Store item | Category + JSON payload | Item stored with auto-generated ID, timestamps |
| 2 | **[TST-CORE-214]** Retrieve item by ID | Valid item ID | Full item returned |
| 3 | **[TST-CORE-215]** Retrieve non-existent item | Random UUID | 404 |
| 4 | **[TST-CORE-216]** Update item | Existing ID + new payload | Updated, `updated_at` changed |
| 5 | **[TST-CORE-217]** Delete item | Existing ID | Soft-delete or hard-delete per policy |
| 6 | **[TST-CORE-218]** List items by category | Category filter | Only items in that category returned |
| 7 | **[TST-CORE-219]** Pagination | `limit=10&offset=20` | Correct page of results |
| 8 | **[TST-CORE-220]** Item size limit | Payload exceeding max (e.g., 10 MiB) | 413 or 400 — rejected |

### 4.2.1 Schema Compliance (identity.sqlite)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-221]** `contacts` table: global, no persona field | Inspect schema | `contacts(did TEXT PRIMARY KEY, name, alias, trust_level, sharing_policy, created_at, updated_at)` — NO persona column (contacts are cross-cutting) |
| 2 | **[TST-CORE-222]** `contacts.trust_level` enum | Insert `trust_level = 'invalid'` | Rejected or constrained to `blocked`, `unknown`, `trusted` |
| 3 | **[TST-CORE-223]** `contacts.sharing_policy` is JSON | Insert JSON blob | Valid JSON stored and retrievable |
| 4 | **[TST-CORE-224]** `idx_contacts_trust` index exists | Inspect schema | `CREATE INDEX idx_contacts_trust ON contacts(trust_level)` |
| 5 | **[TST-CORE-225]** `audit_log` table schema | Inspect | `(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp, persona, action, requester, query_type, reason, metadata)` |
| 6 | **[TST-CORE-226]** `kv_store` table for sync cursors | Store and retrieve cursor | `kv_store(key TEXT PRIMARY KEY, value TEXT, updated_at)` — brain is stateless, cursors live here |
| 7 | **[TST-CORE-227]** `device_tokens` table: SHA-256 hash | Inspect token_hash | `SHA-256(CLIENT_TOKEN)` hex-encoded — NOT Argon2id (256-bit random input has no brute-force risk) |
| 8 | **[TST-CORE-228]** `device_tokens` partial index | Inspect schema | `CREATE INDEX idx_device_tokens_hash ON device_tokens(token_hash) WHERE revoked = 0` — only active tokens indexed |
| 9 | **[TST-CORE-229]** `crash_log` table schema | Inspect identity.sqlite | `crash_log(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, error TEXT, traceback TEXT, task_id TEXT)` — stores brain crash tracebacks encrypted at rest (Section 04 §Observability). traceback contains Python locals (PII risk) — only safe because identity.sqlite is SQLCipher-encrypted |

### 4.2.2 Schema Compliance (persona vault)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-230]** `vault_items` required columns | Inspect schema | `(id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, source_id, contact_did, summary, body_text, timestamp INTEGER NOT NULL, ingested_at INTEGER NOT NULL, metadata TEXT)` |
| 2 | **[TST-CORE-231]** `vault_items_fts` FTS5 table | Inspect schema | `CREATE VIRTUAL TABLE vault_items_fts USING fts5(body_text, summary, content=vault_items, content_rowid=rowid, tokenize='unicode61 remove_diacritics 1')` |
| 3 | **[TST-CORE-232]** FTS5 tokenizer: `unicode61` enforced | Inspect FTS5 config | `unicode61 remove_diacritics 1` — multilingual (Hindi, Tamil, Kannada) |
| 4 | **[TST-CORE-233]** Porter stemmer FORBIDDEN | Code audit | No `tokenize='porter'` anywhere — English-only, mangles non-Latin scripts |
| 5 | **[TST-CORE-234]** FTS5 index encrypted by SQLCipher | Inspect FTS5 tables on disk | Encrypted at rest — no plaintext leakage from FTS shadow tables |
| 6 | **[TST-CORE-235]** `relationships` table | Inspect schema | `(id TEXT PRIMARY KEY, entity_name, entity_type, last_interaction INTEGER, interaction_count INTEGER, notes TEXT)` |
| 7 | **[TST-CORE-236]** `vault_items.type` allowed values enforced | `INSERT INTO vault_items` with `type = 'invalid_type'` | Rejected (CHECK constraint or application validation) — only `'email'`, `'message'`, `'event'`, `'note'`, `'photo'` accepted per architecture schema |
| 8 | **[TST-CORE-237]** `relationships.entity_type` allowed values enforced | `INSERT INTO relationships` with `entity_type = 'alien'` | Rejected — only `'person'`, `'org'`, `'bot'` accepted per architecture schema |
| 9 | **[TST-CORE-238]** FTS5 content-sync: INSERT propagates | `INSERT INTO vault_items` (new email) → `SELECT * FROM vault_items_fts WHERE vault_items_fts MATCH 'keyword'` | FTS5 index updated — new item found via FTS5 search. With `content=vault_items` FTS5, triggers or manual sync commands must propagate changes |
| 10 | **[TST-CORE-239]** FTS5 content-sync: UPDATE propagates | `UPDATE vault_items SET body_text = 'new text' WHERE id = ?` → FTS5 search for 'new text' | Updated text found via FTS5 — old text no longer matches. Requires DELETE old + INSERT new in FTS5 shadow table |
| 11 | **[TST-CORE-240]** FTS5 content-sync: DELETE propagates | `DELETE FROM vault_items WHERE id = ?` → FTS5 search for deleted item's text | No results — deleted item removed from FTS5 index. Stale FTS5 entries never returned |
| 12 | **[TST-CORE-241]** Schema version: identity.sqlite | Inspect identity.sqlite metadata | Schema version `v1` stored and verifiable — matches `-- DINA IDENTITY SCHEMA (v1)` in architecture DDL |
| 13 | **[TST-CORE-242]** Schema version: persona vault | Inspect persona vault metadata | Schema version `v3` stored and verifiable — matches `-- DINA VAULT SCHEMA (v3)` in architecture DDL. Core detects version mismatch on open → triggers migration |

### 4.2.3 Batch Ingestion

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-243]** Batch store: 100 items | `POST /v1/vault/store/batch` with 100 items | Single transaction: BEGIN → INSERT 100 → COMMIT — atomically stored |
| 2 | **[TST-CORE-244]** Batch performance | 10K items via 100 batches of 100 | ~100 transactions instead of 10K individual writes — ~50x faster |
| 3 | **[TST-CORE-245]** Batch failure: rollback | 100 items, item #50 violates constraint | Entire batch rolled back — no partial insert |
| 4 | **[TST-CORE-246]** Batch during concurrent reads | Batch write to `/personal` + concurrent search | WAL allows readers during batch write — search returns committed data |
| 5 | **[TST-CORE-247]** Batch ingestion + embedding generation | Brain stores batch, then generates embeddings in background | Items available for FTS5 immediately; embeddings arrive later for semantic search |

### 4.3 Vault Search (FTS5 + sqlite-vec)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-248]** FTS5 keyword search | `POST /v1/vault/query {mode: "fts5", q: "battery life"}` | FTS5 results ranked by `unicode61` tokenizer relevance |
| 2 | **[TST-CORE-249]** Semantic vector search | `POST /v1/vault/query {mode: "semantic", q: "..."}` | Brain-provided embedding → sqlite-vec cosine similarity, top-K neighbors |
| 3 | **[TST-CORE-250]** Hybrid search (default) | `POST /v1/vault/query {mode: "hybrid", q: "..."}` | Both engines, merged + deduplicated, `relevance = 0.4 × fts5_rank + 0.6 × cosine_similarity` |
| 4 | **[TST-CORE-251]** Hybrid search formula verified | Known items with known FTS5 + cosine scores | `relevance` field matches `0.4 × fts5 + 0.6 × cosine` formula |
| 5 | **[TST-CORE-252]** Empty results | Query with no matches | `{"items": [], "pagination": {"has_more": false}}`, not error |
| 6 | **[TST-CORE-253]** Search across persona boundary | Search persona A data from persona B context | No cross-persona results |
| 7 | **[TST-CORE-254]** FTS5 injection | Query `"*" OR 1=1 --` | Safely handled, no SQL injection |
| 8 | **[TST-CORE-255]** `include_content: false` (default) | Query without flag | Response contains `summary` only, no `body_text` (safe path) |
| 9 | **[TST-CORE-256]** `include_content: true` | Query with `include_content: true` | Response includes raw `body_text` — caller responsible for PII scrubbing before cloud LLM |
| 10 | **[TST-CORE-257]** Filter by types | `filters: {types: ["email", "calendar"]}` | Only matching item types returned |
| 11 | **[TST-CORE-258]** Filter by time range | `filters: {after: "2026-01-01", before: "2026-02-01"}` | Only items within range |
| 12 | **[TST-CORE-259]** Limit default 20 | Query without `limit` field | Max 20 items returned |
| 13 | **[TST-CORE-260]** Limit max 100 | `limit: 200` | Capped at 100, or 400 error |
| 14 | **[TST-CORE-261]** Pagination | `offset: 20, limit: 20` | Correct page, response `has_more` + `next_offset` |
| 15 | **[TST-CORE-262]** Locked persona → structured 403 | Query locked persona | `{"error": "persona_locked", "message": "/financial requires CLIENT_TOKEN approval", "code": 403}` |
| 16 | **[TST-CORE-263]** Simple search fast path (core alone) | Client WS query "find emails from Sancho" | Core handles FTS5 directly — no brain involved, sub-10ms |
| 17 | **[TST-CORE-264]** Semantic search (brain orchestrates) | Complex query needing reasoning | Core routes to brain → brain generates embedding → brain calls `/v1/vault/query` → brain merges + reasons → response |

### 4.3.1 Embedding Migration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-265]** Embedding model tracked in metadata | Inspect vault system table | `embedding_model` column stores model name + version (e.g., `EmbeddingGemma:1.0`) |
| 2 | **[TST-CORE-266]** Model change detected | New model configured, core starts | Core detects mismatch between stored `embedding_model` and configured model |
| 3 | **[TST-CORE-267]** Re-index triggered | Model change detected | Core drops sqlite-vec index → triggers background re-embed job via brain |
| 4 | **[TST-CORE-268]** FTS5 available during re-indexing | Model change, re-embed in progress | FTS5 keyword search works normally — only semantic search temporarily unavailable |
| 5 | **[TST-CORE-269]** Re-embed completes | Brain processes all items in batches | sqlite-vec index rebuilt, semantic search restored |
| 6 | **[TST-CORE-270]** No dual-index | During migration | Old index dropped first, new index built — no parallel indices needed (vault sizes small: ~25MB vectors for 50K items) |

### 4.4 Scratchpad (Brain Cognitive Checkpointing)

> Scratchpad entries are stored in **identity.sqlite** (Tier 4 staging tables).
> Brain checkpoints per-step with step number + accumulated context.
> On crash, brain resumes from the exact step — no re-running completed steps.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-271]** Write scratchpad entry (step checkpoint) | `POST /v1/vault/store {type: "scratchpad", task_id: "abc", data: {step: 2, context: {relationship: "...", messages: [...]}}}` | Stored in identity.sqlite scratchpad area |
| 2 | **[TST-CORE-272]** Read scratchpad by task_id | `POST /v1/vault/query {type: "scratchpad", task_id: "abc"}` | Latest checkpoint returned with step number + accumulated context |
| 3 | **[TST-CORE-273]** Per-step context accumulation | Brain completes step 1 → checkpoint, step 2 → checkpoint | Each checkpoint contains ALL prior context (step 1 result + step 2 result), not just latest step |
| 4 | **[TST-CORE-274]** Resume from exact step | Brain crashes at step 3 of 5, restarts | Brain reads scratchpad → sees `step: 2` → resumes from step 3 (skips 1 & 2) |
| 5 | **[TST-CORE-275]** No scratchpad → start fresh | New task, no scratchpad entry | Brain starts from step 1 |
| 6 | **[TST-CORE-276]** Scratchpad TTL: 24h auto-expire | Entry older than 24 hours | Auto-purged by sweeper — stale reasoning from yesterday not useful |
| 7 | **[TST-CORE-277]** Scratchpad deleted on completion | Task completes all 5 steps | Brain sends `POST /v1/vault/store {type: "scratchpad_delete", task_id: "abc"}` → entry removed |
| 8 | **[TST-CORE-278]** Scratchpad size limit | Checkpoint JSON exceeding max size | Rejected with 413 |
| 9 | **[TST-CORE-279]** Scratchpad stored in identity.sqlite | Inspect database location | Not in persona vault — scratchpad is operational state, not user data |
| 10 | **[TST-CORE-280]** Multiple concurrent scratchpads | Two multi-step tasks running | Each has independent scratchpad keyed by task_id, no interference |
| 11 | **[TST-CORE-281]** Scratchpad overwrite (same task, later step) | Step 2 checkpoint overwrites step 1 | Only latest checkpoint retained per task_id (upsert) |

### 4.5 Staging Area (Tier 4 — Ephemeral)

> Tier 4 holds email drafts, payment intents, pending cart handovers, notification queue.
> **Items auto-expire after 72 hours.** Not backed up. Low breach impact.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-282]** Stage item for review | New item from ingestion | Stored in staging table, not in `vault_items` (main vault) |
| 2 | **[TST-CORE-283]** Approve staged item | Admin approves | Moved to main vault (`vault_items`) via INSERT + DELETE in single transaction |
| 3 | **[TST-CORE-284]** Reject staged item | Admin rejects | Deleted from staging |
| 4 | **[TST-CORE-285]** Auto-approve low-risk items | Item below risk threshold | Automatically promoted to main vault (no human review) |
| 5 | **[TST-CORE-286]** Per-item expiry via `expires_at` field | Item with `expires_at` in the past, no user action | Core sweeper deletes — `DELETE FROM staging WHERE expires_at < datetime('now')`. Each staged item has its own `expires_at` set at creation time. Architecture §12 shows different TTLs: email drafts = 72h (line 33), cart handover = 12h (line 68). Sweeper honors per-item TTL, not a blanket 72h — using `created_at + 72h` would keep stale payment intents alive 60 hours beyond intended TTL |
| 6 | **[TST-CORE-287]** Staging encrypted at rest | Inspect persona vault | Staging table is inside per-persona SQLCipher database — encrypted like all other data |
| 7 | **[TST-CORE-288]** Staging not backed up | Trigger backup | Backup includes main vault tables but staging items are ephemeral — acceptable if lost |
| 8 | **[TST-CORE-289]** Draft-don't-send in staging | Brain creates email draft | Draft stored as staging item with `type: "email_draft"` — NOT sent until user approves |
| 9 | **[TST-CORE-290]** Cart handover intent in staging | Brain assembles purchase intent | Stored as `type: "cart_handover"` — Dina never touches money, hands back to user |
| 10 | **[TST-CORE-291]** Staging items per-persona | Draft created for `/work` persona | Stored in `work.sqlite` staging table — not visible to `/personal` |
| 11 | **[TST-CORE-292]** Sweeper runs on schedule | 24 hours pass | Core watchdog runs expiry cleanup sweep daily — same sweep as audit log cleanup |
| 12 | **[TST-CORE-293]** Per-type TTL: draft 72h, cart 12h | Create email_draft (72h TTL) and cart_handover (12h TTL) at same time, run sweeper at T+13h | Cart handover deleted (past `expires_at`), email draft still present (53h remaining). Architecture §12: drafts expire after 72h, payment intents after 12h — different action types warrant different urgency windows. Brain sets `expires_at` at creation; core sweeper enforces it uniformly via `WHERE expires_at < datetime('now')` |

### 4.6 Backup

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-294]** Online backup via `sqlcipher_export()` | Trigger backup while vault is active | `ATTACH DATABASE 'backup.sqlite' AS backup KEY '<key>'; SELECT sqlcipher_export('backup'); DETACH` — keyed-to-keyed, plaintext never touches disk |
| 2 | **[TST-CORE-295]** Backup is encrypted | Inspect backup file | SQLCipher-encrypted (not plaintext) |
| 3 | **[TST-CORE-296]** VACUUM INTO FORBIDDEN | Code review / audit | `VACUUM INTO` never called — produces PLAINTEXT in SQLCipher (CVE-level vulnerability) |
| 4 | **[TST-CORE-297]** Backup to different location | Specify backup path | Backup file created at target path |
| 5 | **[TST-CORE-298]** Restore from backup | Replace vault with backup | Data integrity verified, all items present |
| 6 | **[TST-CORE-299]** CI/CD plaintext verification | CI test: open backup as plain SQLite3 (no key) | Must FAIL to open — if it opens, BUILD MUST FAIL (catches regression: someone replaces `sqlcipher_export()` with `VACUUM INTO`) |
| 7 | **[TST-CORE-300]** Backup scope: Tier 0 + Tier 1 only | Trigger backup → inspect contents | Backup includes identity.sqlite (Tier 0) + all persona vaults (Tier 1). Tier 2 (index/embeddings) explicitly EXCLUDED — regenerable from Tier 1. Tier 4 (staging) explicitly EXCLUDED — ephemeral, acceptable if lost |
| 8 | **[TST-CORE-301]** Automated backup scheduling (daily default) | Default config (no backup override) | Watchdog triggers `sqlcipher_export()` backup every 24 hours (default). Configurable via `config.json: "backup": {"interval_hours": 24}`. For unattended sovereign nodes, this is the only safety net — if automated backup doesn't run, Home Node failure means total data loss (Section 13 §Home Node Failure). Backup timestamp logged in `kv_store` as `last_backup_timestamp` for admin UI display |

### 4.6.1 Pre-Flight Migration Safety Protocol

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-302]** Encrypted backup before migration | Schema migration triggered | `sqlcipher_export()` backup created BEFORE any DDL changes |
| 2 | **[TST-CORE-303]** `PRAGMA integrity_check` after migration | DDL applied | `integrity_check` returns `ok` — every page verified consistent |
| 3 | **[TST-CORE-304]** Integrity ok → commit | `integrity_check = "ok"` | Migration committed, backup retained for 24h then deleted |
| 4 | **[TST-CORE-305]** Integrity fail → ROLLBACK + restore | `integrity_check ≠ "ok"` | Transaction rolled back, vault restored from backup, user alerted |
| 5 | **[TST-CORE-306]** Pre-flight backup path | Inspect | `vault.v{old_version}.bak` — versioned for identification |
| 6 | **[TST-CORE-307]** Automatic on every dina-core update | Core binary updated, restarts | Migration safety protocol runs automatically — user never sees it unless failure |

### 4.7 Audit Log

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-308]** Append audit entry | Action + actor + timestamp | Entry appended, cannot be modified |
| 2 | **[TST-CORE-309]** Append-only enforcement | Attempt UPDATE or DELETE on audit table | Rejected by trigger or constraint |
| 3 | **[TST-CORE-310]** Audit log rotation | Log exceeds 90-day retention | Entries older than 90 days archived/purged per policy |
| 4 | **[TST-CORE-311]** Query audit log | Filter by action type, date range | Correct entries returned |
| 5 | **[TST-CORE-312]** Audit log integrity | Compute hash chain | Each entry's hash includes previous entry hash |
| 6 | **[TST-CORE-313]** Audit log JSON format | Inspect stored entry | `{ts: "2026-02-18T03:15:00Z", persona: "/health", action: "query", requester: "brain", query_type: "fts", reason: "nudge_assembly"}` |
| 7 | **[TST-CORE-314]** Retention configurable | Set `config.json: "audit": {"retention_days": 30}` | Entries older than 30 days purged (not default 90) |
| 8 | **[TST-CORE-315]** Watchdog daily cleanup | 24 hours pass with old entries | Core watchdog runs `DELETE FROM audit_log WHERE timestamp < datetime('now', '-90 days')` — daily sweep |
| 9 | **[TST-CORE-316]** Raw entries for forensics | Inspect audit log | Individual timestamped entries preserved — not summarized ("brain accessed /financial 847 times" is useless vs. timestamped pattern detection) |
| 10 | **[TST-CORE-317]** Audit log stored in identity.sqlite | Inspect database | `audit_log` table in identity.sqlite (Tier 0) — not in persona vaults |
| 11 | **[TST-CORE-318]** Storage growth bounded | ~100 entries/day × 200 bytes × 90 days | ~1.8MB for 90 days — trivial, but unbounded growth prevented by retention policy |
| 12 | **[TST-CORE-319]** `crash_log` 90-day retention | Insert crash_log entries with timestamps >90 days old | Watchdog daily sweep runs `DELETE FROM crash_log WHERE timestamp < datetime('now', '-90 days')` — same retention policy as audit_log. crash_log lives in identity.sqlite alongside audit_log (Section 04 §Observability) |

### 4.8 Boot Sequence & Vault Unlock

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-320]** Security mode boot: full sequence | config.json `mode: "security"`, no keyfile | Core prompts client device for passphrase → Argon2id → KEK → AES-256-GCM unwrap master seed → HKDF DEKs → open identity.sqlite first → open personal.sqlite → notify brain `{event: "vault_unlocked"}` |
| 2 | **[TST-CORE-321]** Convenience mode boot: full sequence | config.json `mode: "convenience"`, keyfile present at `/var/lib/dina/keyfile` | Core reads raw master seed from keyfile → HKDF DEKs → open identity.sqlite → open personal.sqlite → notify brain |
| 3 | **[TST-CORE-322]** Boot opens identity.sqlite FIRST | Either mode | identity.sqlite opened before any persona vault (gatekeeper needs contacts + sharing policy) |
| 4 | **[TST-CORE-323]** Boot opens personal.sqlite second | Either mode | personal.sqlite opened immediately after identity (default persona, always unlocked) |
| 5 | **[TST-CORE-324]** Other persona databases remain CLOSED at boot | 3 persona vaults configured | Only identity + personal opened — health, financial, etc. remain closed, DEKs not derived |
| 6 | **[TST-CORE-325]** DEKs not derived for closed personas | Boot with locked personas | HKDF not called for locked personas — key material never enters RAM until explicit unlock |
| 7 | **[TST-CORE-326]** Brain notified on vault unlock | Vault opens successfully | Core sends `POST brain:8200/v1/process {event: "vault_unlocked"}` |
| 8 | **[TST-CORE-327]** HKDF info strings are correct | Derive identity DEK | Info string: `dina:vault:identity:v1` produces consistent DEK |
| 9 | **[TST-CORE-328]** HKDF info strings per persona | Derive personal DEK | Info string: `dina:vault:personal:v1` — each persona name in info string |
| 10 | **[TST-CORE-329]** SQLCipher PRAGMAs enforced | Open any vault | `PRAGMA cipher_page_size = 4096`, `PRAGMA journal_mode = WAL` verified |
| 11 | **[TST-CORE-330]** Mode stored in config.json | Inspect config after setup wizard | `mode` field is `"security"` or `"convenience"` |
| 12 | **[TST-CORE-331]** Mode changeable at runtime | Switch from convenience → security | config.json updated, next boot uses new mode |
| 13 | **[TST-CORE-332]** Default mode: managed = convenience | Fresh setup on managed hosting | config.json defaults to `mode: "convenience"` |
| 14 | **[TST-CORE-333]** Default mode: self-hosted = security | Fresh setup on self-hosted/sovereign | config.json defaults to `mode: "security"` |
| 15 | **[TST-CORE-334]** Security mode: wrong passphrase → vault stays locked | Incorrect passphrase on boot | AES-256-GCM unwrap fails, vault remains locked, core starts in degraded mode (dead drop active) |
| 16 | **[TST-CORE-335]** Convenience mode: keyfile missing → startup error | keyfile absent | Core refuses to start with clear error: "keyfile not found at /var/lib/dina/keyfile" |
| 17 | **[TST-CORE-336]** Convenience mode: keyfile wrong permissions | `chmod 644` (world-readable) | Warning logged: "keyfile permissions too open", boot continues (or fails per policy) |
| 18 | **[TST-CORE-337]** config.json missing → graceful default | config.json absent | Core starts with sensible defaults (security mode, single persona) |
| 19 | **[TST-CORE-338]** config.json invalid mode value | `mode: "hybrid"` | Startup fails with validation error |
| 20 | **[TST-CORE-339]** Security mode: wrapped_seed.bin path | Inspect file | Encrypted master seed at `/var/lib/dina/wrapped_seed.bin` (AES-256-GCM blob + 16-byte cleartext Argon2id salt) |
| 21 | **[TST-CORE-340]** Master Seed NEVER plaintext in security mode | Inspect `/var/lib/dina/` in security mode | No plaintext seed on disk — only `wrapped_seed.bin` (encrypted blob) |
| 22 | **[TST-CORE-341]** Convenience mode: keyfile path | Inspect file | Raw master seed at `/var/lib/dina/keyfile` with `chmod 600` |
| 23 | **[TST-CORE-342]** Mode switch: security → convenience (security downgrade) | User requests switch from security to convenience mode | Core prompts for passphrase → Argon2id → KEK → unwrap master seed from `wrapped_seed.bin` → write plaintext seed to `/var/lib/dina/keyfile` (chmod 600) → update config.json `mode: "convenience"`. MUST require explicit user confirmation ("This writes your master seed to disk in plaintext. Continue?") because this is a deliberate security downgrade. Architecture §02 line 40: "Users can change this setting at any time" — bidirectional. §4.8 #12 covers convenience→security; this covers the reverse |

### 4.9 Vault Extras

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-883]** FTS5 with Indic scripts (Hindi, Tamil, Kannada) | Insert vault items with Hindi/Tamil/Kannada text, search | FTS5 matches Indic script content via unicode61 tokenizer |
| 2 | **[TST-CORE-884]** Verify sqlite-vec used (not deprecated sqlite-vss) | Code audit of vector search implementation | `sqlite-vec` extension loaded, not `sqlite-vss` |
| 3 | **[TST-CORE-885]** FTS5 remains available during sqlite-vec re-indexing | Trigger re-index, attempt FTS5 search | FTS5 search succeeds while embedding re-index runs in background |

---

## 5. PII Scrubber (Tier 1 — Go Regex)

> Tier 1 runs in Go core at `POST /v1/pii/scrub`. Catches structured PII: credit cards,
> phone numbers, Aadhaar/SSN, emails, bank accounts. Sub-millisecond.
> Returns scrubbed text + replacement map `{token → original}`.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-343]** Scrub email address | "Contact john@example.com" | "Contact [EMAIL_1]" + map: `{"[EMAIL_1]": "john@example.com"}` |
| 2 | **[TST-CORE-344]** Scrub phone number | "Call 555-123-4567" | "Call [PHONE_1]" |
| 3 | **[TST-CORE-345]** Scrub SSN | "SSN 123-45-6789" | "SSN [SSN_1]" |
| 4 | **[TST-CORE-346]** Scrub credit card | "Card 4111-1111-1111-1111" | "Card [CC_NUM_1]" |
| 5 | **[TST-CORE-347]** Scrub IP address | "From 192.168.1.1" | "From [IP_1]" |
| 6 | **[TST-CORE-348]** No PII present | "The weather is nice today" | Unchanged — empty replacement map |
| 7 | **[TST-CORE-349]** Multiple PII types in one string | "Email john@ex.com, phone 555-1234" | Both redacted: `[EMAIL_1]`, `[PHONE_1]` — numbered sequentially |
| 8 | **[TST-CORE-350]** PII at string boundaries | "john@example.com" (entire string) | "[EMAIL_1]" |
| 9 | **[TST-CORE-351]** Unicode/international formats | "+44 20 7946 0958" (UK phone) | Redacted (configurable patterns) |
| 10 | **[TST-CORE-352]** Performance: large payload | 1 MiB text with scattered PII | Completes within 100ms (sub-millisecond for typical payloads) |
| 11 | **[TST-CORE-353]** Aadhaar number (India) | "Aadhaar 1234 5678 9012" | "[AADHAAR_1]" — 12-digit Indian national ID |
| 12 | **[TST-CORE-354]** Bank account number | "Acct 1234567890123456" | "[BANK_ACCT_1]" |
| 13 | **[TST-CORE-355]** Multiple same-type PII | "Email john@ex.com and jane@ex.com" | "[EMAIL_1]" and "[EMAIL_2]" — uniquely numbered |
| 14 | **[TST-CORE-356]** Replacement map returned in response | `POST /v1/pii/scrub` with text containing PII | Response body: `{scrubbed_text: "...", replacements: {"[EMAIL_1]": "john@ex.com", "[PHONE_1]": "555-1234"}}` |
| 15 | **[TST-CORE-357]** Replacement map round-trip | Scrub → send to brain → brain sends back with tokens → core de-sanitizes | All `[TOKEN_N]` replaced with originals from map — no data loss |
| 16 | **[TST-CORE-358]** No false positives on numbers | "The product costs $1,234.56" | NOT redacted — price is not PII |
| 17 | **[TST-CORE-359]** Indian phone format | "+91 98765 43210" | "[PHONE_1]" — Indian mobile number format |
| 18 | **[TST-CORE-776]** Address detection (optional) | "Lives at 42 Baker Street, London" | Address entities detected if pattern configured |
| 19 | **[TST-CORE-777]** Table-driven PII test suite | Multiple test cases from PIITestCases fixture | All expected scrubs pass |
| 20 | **[TST-CORE-778]** Empty input handling | "" (empty string) | Unchanged — empty scrubbed text, no entities |
| 21 | **[TST-CORE-779]** Email in URL (mailto:) | "Visit mailto:john@example.com" | Email extracted from mailto: prefix |
| 22 | **[TST-CORE-780]** Consecutive same-type PII | "SSN 123-45-6789 and 987-65-4321" | Both scrubbed: [SSN_1] and [SSN_2] |
| 23 | **[TST-CORE-781]** SQL injection in scrubber input | "'; DROP TABLE users; --" | Safely handled, no error or injection |
| 24 | **[TST-CORE-782]** Unicode text with PII | "नमस्ते john@example.com" | Email detected in Unicode context |
| 26 | **[TST-CORE-886]** PII de-sanitization endpoint — restores tokens from replacement map | Scrubbed text + entity map | Original PII values restored from token map |
| 27 | **[TST-CORE-887]** PII scrubber makes zero outbound network calls (hard invariant) | Trigger scrub, monitor network | Zero network calls during PII scrubbing — regex-only, fully local |
| 28 | **[TST-CORE-888]** Sensitive persona mandatory PII scrub before cloud LLM | Health/financial persona data sent to cloud LLM | PII scrubbing enforced before cloud routing — no opt-out for sensitive personas |


---

## 6. Gatekeeper (Egress / Sharing Policy)

### 6.1 Sharing Policy Enforcement

> Default deny. Per-contact per-category. Tiers: `none` / `summary` / `full`.
> Missing key = `"none"` = blocked. Trust level and sharing policy are independent.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-360]** Default-deny: no policy exists | Request to share data with unknown contact (no `sharing_policy` row) | Blocked — no data sent |
| 2 | **[TST-CORE-361]** Default-deny: missing category key | Contact has policy but no `location` key | `location` treated as `"none"` — blocked |
| 3 | **[TST-CORE-362]** Policy: `"none"` explicit | Contact has `"health": "none"` | No health data shared — same as missing key |
| 4 | **[TST-CORE-363]** Policy: `"summary"` | Contact has `"availability": "summary"` | Brain sends `{summary: "Busy 2-3pm", full: "Meeting with Dr. Patel..."}` → Core picks `summary` only |
| 5 | **[TST-CORE-364]** Policy: `"full"` | Contact has `"preferences": "full"` | Full details shared: "Chai, no sugar, served warm. Allergic to dairy." (still PII-scrubbed) |
| 6 | **[TST-CORE-365]** Per-contact per-category granularity | Sancho: `presence=eta_only, health=none` | Presence shared (summary tier), health blocked — per-category per-contact |
| 7 | **[TST-CORE-366]** Domain-specific tier: `eta_only` → summary | Contact has `"presence": "eta_only"` | Maps to summary tier: "Arriving in about 15 minutes" (not GPS coords) |
| 8 | **[TST-CORE-367]** Domain-specific tier: `free_busy` → summary | Contact has `"availability": "free_busy"` | Maps to summary tier: "Busy 2-3pm" (not meeting details) |
| 9 | **[TST-CORE-368]** Domain-specific tier: `exact_location` → full | Contact has `"presence": "exact_location"` | Maps to full tier: GPS coordinates and exact ETA |
| 10 | **[TST-CORE-369]** Policy update via PATCH | Admin changes `health` from `"none"` to `"summary"` | `PATCH /v1/contacts/:did/policy` → subsequent requests use updated policy |
| 11 | **[TST-CORE-370]** Bulk policy update | Turn off location for all trusted contacts | `PATCH /v1/contacts/policy/bulk {"filter": {"trust_level": "trusted"}, "policy": {"location": "none"}}` → returns `{"updated": 12}` |
| 12 | **[TST-CORE-371]** Trust level ≠ sharing | Contact is `"trusted"` but no explicit sharing rules | Trusted doesn't auto-share anything — trust and policy are independent |
| 13 | **[TST-CORE-372]** Recognized categories | Phase 1 category list | `presence`, `availability`, `context`, `preferences`, `location`, `health` — extensible |
| 14 | **[TST-CORE-373]** Sharing defaults for new contacts | New contact added, no explicit policy set | Defaults from `config.json "sharing_defaults"`: presence=eta_only, availability=free_busy, context=summary, preferences=full, location=none, health=none |
| 15 | **[TST-CORE-374]** Outbound PII scrub | Share data with `"full"` policy | PII scrubber runs before transmission (even full tier gets scrubbed) |
| 16 | **[TST-CORE-375]** Extensible categories: custom category accepted | `PATCH /v1/contacts/:did/policy {"hobbies": "full"}` | Custom category stored and enforced — system is not limited to the 6 default categories |
| 17 | **[TST-CORE-376]** Extensible categories: custom category enforced at egress | Brain sends payload with `{hobbies: {summary: "...", full: "..."}}`, policy has `hobbies: "summary"` | Core strips to summary — custom categories go through the same egress pipeline |

### 6.2 Sharing Policy API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-377]** GET policy | `GET /v1/contacts/:did/policy` | 200 — returns `{did, name, trust_level, sharing_policy: {presence: "eta_only", ...}}` |
| 2 | **[TST-CORE-378]** PATCH single category | `PATCH /v1/contacts/:did/policy {"location": "exact_location"}` | 200 — only `location` changed, all other categories preserved |
| 3 | **[TST-CORE-379]** PATCH multiple categories | `PATCH /v1/contacts/:did/policy {"health": "summary", "location": "none"}` | 200 — two categories changed, rest preserved |
| 4 | **[TST-CORE-380]** PATCH bulk by trust level | `PATCH /v1/contacts/policy/bulk {"filter": {"trust_level": "trusted"}, "policy": {"location": "none"}}` | 200 — `{"updated": N}` matching contacts updated |
| 5 | **[TST-CORE-381]** PATCH bulk all contacts | `PATCH /v1/contacts/policy/bulk {"filter": {}, "policy": {"location": "none"}}` | 200 — all contacts updated |
| 6 | **[TST-CORE-382]** GET policy for unknown DID | `GET /v1/contacts/did:plc:unknown/policy` | 404 — contact not found |
| 7 | **[TST-CORE-383]** PATCH with invalid tier value | `PATCH ... {"health": "maximum"}` | 400 — unrecognized tier value |
| 8 | **[TST-CORE-384]** Policy stored in contacts table | Inspect identity.sqlite | `sharing_policy` column is JSON blob in `contacts` table |

### 6.3 Egress Pipeline

> Enforcement is at egress, not ingress. Brain sends max detail in tiered structure.
> Core strips based on policy. Brain never needs to know the policy.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-385]** Brain sends tiered payload | Brain calls `POST /v1/dina/send` with `{availability: {summary: "Busy 2-3pm", full: "Meeting with Dr. Patel..."}}` | Core picks correct tier per sharing_policy |
| 2 | **[TST-CORE-386]** Core strips denied categories | Policy has `location: "none"` | Location category entirely removed from outbound payload |
| 3 | **[TST-CORE-387]** Malformed payload → category dropped | Brain sends raw string instead of `{summary, full}` for a category | Malformed = denied — category stripped entirely |
| 4 | **[TST-CORE-388]** Egress enforcement in compiled Go | Inspect code | Sharing policy checked via SQL lookup in Go code — not LLM reasoning. Prompt injection irrelevant |
| 5 | **[TST-CORE-389]** Egress not ingress | Crafted incoming message tries to elicit more data | Incoming message cannot influence egress policy — enforcement is on outbound |
| 6 | **[TST-CORE-390]** Recipient DID resolution | Resolve recipient's service endpoint | DID Document fetched from PLC Directory, endpoint extracted |
| 7 | **[TST-CORE-391]** Egress audit logging | Any outbound data sharing | `INSERT INTO audit_log (..., action='egress_check', contact_did, category, decision, reason)` — every decision logged |
| 8 | **[TST-CORE-392]** Audit includes denied categories | Category blocked by policy | Audit entry: `decision='denied', reason='tier_none'` — even denials are logged |
| 9 | **[TST-CORE-393]** NaCl encryption after policy check | Payload passes egress check | Payload encrypted with `crypto_box_seal` (ephemeral key + recipient X25519) → transmitted |


### 6.4 Intent Evaluation (Agent Gatekeeper)

> Tests the EvaluateIntent interface: agent submits intent → gatekeeper allows/blocks/audits.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-783]** Safe intent allowed | Trusted agent, safe action (fetch_weather) | Allowed, no audit |
| 2 | **[TST-CORE-784]** Risky intent flagged | Trusted agent, risky action (send_email) | Audit entry generated |
| 3 | **[TST-CORE-785]** Blocked intent denied | Untrusted agent, dangerous action (transfer_money) | Denied |
| 4 | **[TST-CORE-786]** Vault read by untrusted denied | Untrusted agent reads vault | Denied |
| 5 | **[TST-CORE-787]** Empty action rejected | Intent with empty action field | Error returned |
| 6 | **[TST-CORE-788]** Empty agent DID rejected | Intent with empty agent DID | Error returned |
| 7 | **[TST-CORE-789]** Decision contains reason | Denied intent | Decision struct includes reason string |
| 8 | **[TST-CORE-790]** Safe intent no audit | Safe intent passes | No audit entry (silent pass) |
| 9 | **[TST-CORE-791]** Mock allow all | MockGatekeeper configured to allow | All intents allowed |
| 10 | **[TST-CORE-792]** Mock deny all | MockGatekeeper configured to deny | All intents denied with audit |

### 6.5 Egress Safety Checks

> Tests the CheckEgress interface: validates outbound data destinations and content.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-793]** Egress to trusted destination | Trusted API URL + safe data | Allowed |
| 2 | **[TST-CORE-794]** Egress to blocked destination | Blocked tracker URL | Denied |
| 3 | **[TST-CORE-795]** Egress with PII blocked | Data containing email + SSN | Denied (raw PII never leaves) |
| 4 | **[TST-CORE-796]** Egress empty destination rejected | Empty URL string | Error returned |
| 5 | **[TST-CORE-797]** Egress nil data allowed | Trusted URL + nil data (health check) | Allowed |
| 6 | **[TST-CORE-798]** Mock egress deny | MockGatekeeper denies all egress | Egress denied |

### 6.6 Trust Ring & Persona Access Control

> Tests agent access to persona vaults based on trust levels and compartment isolation.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-799]** Trusted agent accesses open persona | Trusted agent reads consumer vault | Allowed |
| 2 | **[TST-CORE-800]** Untrusted agent denied locked persona | Untrusted agent reads health vault | Denied |
| 3 | **[TST-CORE-801]** Verified agent restricted persona | Verified (not trusted) agent on professional | Audit triggered, review required |
| 4 | **[TST-CORE-802]** Cross-persona access denied | Consumer-only agent accesses financial | Denied (compartment isolation) |
| 5 | **[TST-CORE-803]** Money action requires trusted ring | Verified agent attempts transfer_money | Denied — requires Verified+Actioned |
| 6 | **[TST-CORE-804]** Data sharing action flagged | Trusted agent shares data externally | Audit entry (risky per Four Laws) |
| 23 | **[TST-CORE-889]** Egress audit 90-day rolling retention policy | Audit entries older than 90 days | Auto-purged by watchdog sweep |
| 24 | **[TST-CORE-890]** Contact `updated_at` refreshed on sharing policy mutation | Update sharing policy for contact | `updated_at` timestamp refreshed in contacts table |
| 25 | **[TST-CORE-891]** Draft confidence score: low → flagged for review | Draft with low confidence score | Flagged for human review, not auto-approved |
| 26 | **[TST-CORE-892]** Agent `draft_only: true` constraint enforced | Agent with draft_only=true attempts direct action | Blocked — agent can only create drafts, not execute |
| 27 | **[TST-CORE-893]** Agent outcomes recorded in Tier 3 for trust scoring | Agent completes action | Outcome recorded in Tier 3 vault for trust scoring |

---

## 7. Transport Layer

### 7.1 Outbox (Reliable Delivery)

> Outbox is in `identity.sqlite` — survives reboot. ULID IDs. Max 5 retries.
> 24-hour TTL. Queue limit: 100 pending messages. Scheduler checks every 30s.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-394]** Enqueue message | New outbound message | Persisted in `outbox` table in identity.sqlite with `pending` status, ULID ID |
| 2 | **[TST-CORE-395]** Outbox schema | Inspect identity.sqlite | `outbox(id TEXT PK, to_did TEXT, payload BLOB, created_at INTEGER, next_retry INTEGER, retries INTEGER, status TEXT)` |
| 3 | **[TST-CORE-396]** Successful delivery | Recipient endpoint responds 200 | Task marked `delivered`, deleted after 1 hour |
| 4 | **[TST-CORE-397]** Delivery failure → retry | Recipient returns 500 | Exponential backoff with jitter: 30s → 1m → 5m → 30m → 2h |
| 5 | **[TST-CORE-398]** Max retries exhausted (5) | 5 consecutive failures (~3 hours) | Status → `failed`, Tier 2 nudge: "Couldn't reach Sancho's Dina. His node may be offline." |
| 6 | **[TST-CORE-399]** User requeue after failure | User approves requeue | Fresh retry count, message re-enqueued |
| 7 | **[TST-CORE-400]** 24-hour TTL | Message pending for >24h without delivery | Expired, deleted regardless of retry count |
| 8 | **[TST-CORE-401]** Queue size limit: 100 | 101st message enqueued | Rejected — "outbox full" error returned to caller |
| 9 | **[TST-CORE-402]** Outbox survives restart | Core crashes and restarts | Pending tasks reloaded from SQLite: `SELECT * FROM outbox WHERE status='pending' AND next_retry < ?` |
| 10 | **[TST-CORE-403]** Scheduler interval: 30 seconds | Core running | Outbox checked every 30s: `next_retry < now() AND status = 'pending'` |
| 11 | **[TST-CORE-404]** Idempotent delivery | Same message delivered twice (retry after timeout) | Recipient deduplicates by message ID |
| 12 | **[TST-CORE-405]** Delivered messages cleanup | Message delivered | Deleted from outbox after 1 hour |
| 13 | **[TST-CORE-406]** Failed messages cleanup | Message failed after 5 retries | Deleted after 24 hours |
| 14 | **[TST-CORE-407]** Priority ordering | High-priority (fiduciary) message queued after low-priority | Fiduciary messages sent first |
| 15 | **[TST-CORE-408]** Payload is pre-encrypted | Inspect outbox payload column | BLOB is NaCl-encrypted — ready to send, no re-encryption on retry |
| 16 | **[TST-CORE-409]** `sending` status during delivery attempt | Message in outbox, delivery in progress | Status transitions: `pending` → `sending` (while HTTP request in flight) → `delivered` (on 200) or back to `pending` with incremented retries (on failure) |
| 17 | **[TST-CORE-410]** User ignores nudge → message expires at 24h TTL | Retries exhausted → user notified → user does nothing | Message remains `failed` → cleanup deletes after 24 hours. No infinite retry loop |
| 18 | **[TST-CORE-805]** Send to unresolvable DID fails | `impl.Send("did:key:z6MkNonexistent", envelope)` | Error returned — DID not resolvable |
| 19 | **[TST-CORE-806]** Send empty envelope rejected | `impl.Send(did, []byte{})` | Error returned — empty payload |
| 20 | **[TST-CORE-807]** Send nil envelope rejected | `impl.Send(did, nil)` | Error returned — nil payload |
| 21 | **[TST-CORE-808]** Mock send records messages | `mock.Send(did, envelope)` | Message recorded in `mock.Sent` slice |
| 22 | **[TST-CORE-809]** Outbox enqueue persists message | `mock.Enqueue(msg)` + `mock.GetByID(id)` | Message persisted with `pending` status, retrievable by ID |


### 7.2 Inbox (3-Valve Ingress)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-411]** Valve 1: IP rate limit | >50 requests/hour from same IP | 429 Too Many Requests |
| 2 | **[TST-CORE-412]** Valve 1: normal traffic | <50 requests/hour from same IP | Accepted to Valve 2 |
| 3 | **[TST-CORE-413]** Valve 1: global rate limit | >1000 requests/hour total (all IPs) | 429 — botnet defense |
| 4 | **[TST-CORE-414]** Valve 1: payload cap | Message body >256KB | 413 Request Entity Too Large (MaxBytesReader) |
| 5 | **[TST-CORE-415]** Valve 1: payload within cap | Message body <256KB | Accepted — DIDComm is JSON metadata, no media |
| 6 | **[TST-CORE-416]** Valve 2: spool cap (persona locked) | Message for locked persona, spool < 500MB | Spooled to `./data/inbox/msg_{ulid}.blob`, 202 Accepted |
| 7 | **[TST-CORE-417]** Valve 2: spool cap exceeded | Spool at 500MB limit | 429 Too Many Requests (reject-new, NOT drop-oldest) |
| 8 | **[TST-CORE-418]** Valve 2: reject-new preserves existing | Spool full → new message arrives | Existing legitimate messages preserved; new message rejected |
| 9 | **[TST-CORE-419]** Valve 3: sweeper on unlock | Locked persona unlocked | Spooled blobs processed FIFO by ULID timestamp |
| 10 | **[TST-CORE-420]** Valve 3: sweeper decrypts + checks DID | Blob decrypted after unlock | Sender DID identified, trust ring checked, contacts verified |
| 11 | **[TST-CORE-421]** Valve 3: sweeper blocklist feedback | Spam DID detected in spool | Source IP added to Valve 1 permanent blocklist |
| 12 | **[TST-CORE-422]** Valve 3: TTL enforcement | Message with TTL=15min, vault locked for 3 hours | After unlock: message stored silently in history, NO user notification (expired) |
| 13 | **[TST-CORE-423]** Valve 3: message within TTL | Message with TTL=30min, vault locked for 10 min | After unlock: message processed normally, notification delivered |
| 14 | **[TST-CORE-424]** Valve 3: blob cleanup | Spool blob processed successfully | Blob file deleted from `./data/inbox/` |
| 15 | **[TST-CORE-425]** Fast path: vault unlocked | Valid message, vault unlocked | Decrypt in-memory → check DID in contacts → per-DID rate limit → process immediately, zero disk I/O |
| 16 | **[TST-CORE-426]** Fast path: per-DID rate limit | Same DID sends >limit within window (unlocked) | 429 — per-DID rate limiting (only possible when unlocked, identity known) |
| 17 | **[TST-CORE-427]** Dead drop: per-DID impossible when locked | Vault locked | No per-DID rate limiting — identity inside encrypted envelope (physics-based defense only) |
| 18 | **[TST-CORE-428]** DID verification on inbound | Message with valid sender DID signature | Accepted |
| 19 | **[TST-CORE-429]** DID verification failure | Message with invalid/missing signature | Rejected with 401 |
| 20 | **[TST-CORE-430]** Unknown sender DID | Message from unresolvable DID | Queued for manual review or rejected per policy |
| 21 | **[TST-CORE-431]** Spool directory is safe | Inspect `./data/inbox/` contents | Only encrypted blobs — attacker with filesystem access sees ciphertext only |
| 22 | **[TST-CORE-432]** DoS while locked | Millions of payloads, vault locked | Valve 1 rejects most (IP rate). Remainder fills spool to 500MB cap. Valve 2 rejects rest (429). Disk safe. |
| 23 | **[TST-CORE-433]** DoS while unlocked | Millions of payloads, vault unlocked | Valve 1 rejects most. Survivors decrypted — unknown DID → dropped. No disk I/O. |
| 24 | **[TST-CORE-810]** Basic inbox receive | `impl.Receive()` on inbox | Returns nil for empty inbox, message bytes for non-empty |
| 25 | **[TST-CORE-811]** Empty inbox returns nil | Mock inbox with no messages | `Receive()` returns nil, no error |
| 26 | **[TST-CORE-812]** Inbox FIFO order | 3 messages enqueued | Received in FIFO order |
| 27 | **[TST-CORE-813]** Inbox spool when locked | Message arrives, persona locked | Message spooled up to SpoolMax |
| 28 | **[TST-CORE-814]** Inbox reject when spool full | Spool at capacity | New message rejected with error |

### 7.3 DID Resolution & Caching

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-434]** Resolve known DID | `did:key:z6Mk...` | DID Document returned from network |
| 2 | **[TST-CORE-435]** Cache hit | Second resolution of same DID within TTL | Returned from cache, no network call |
| 3 | **[TST-CORE-436]** Cache expiry | Resolution after cache TTL | Fresh resolution from network |
| 4 | **[TST-CORE-437]** Unresolvable DID | Non-existent DID | Error returned, not cached |
| 5 | **[TST-CORE-438]** Malformed DID | `did:invalid:!!!` | Validation error |
| 6 | **[TST-CORE-815]** Mock resolve endpoint | `mock.ResolveEndpoint(did)` with pre-configured endpoint | Returns configured endpoint URL |
| 7 | **[TST-CORE-816]** Mock resolve unknown fails | `mock.ResolveEndpoint(unknown_did)` | Error returned |
| 8 | **[TST-CORE-817]** Unresolvable DID not cached | Error result for non-existent DID | Error not cached — next attempt retries network |

### 7.4 Message Format (DIDComm-Compatible)

> Plaintext structure is DIDComm-compatible from day one.
> Phase 1 envelope: `application/dina-encrypted+json` (libsodium crypto_box_seal).
> Phase 2: migrate to standard JWE. Plaintext unchanged.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-439]** Plaintext structure | Create D2D message | `{id: "msg_...", type: "dina/social/arrival", from: "did:plc:...", to: ["did:plc:..."], created_time: unix_ts, body: {...}}` |
| 2 | **[TST-CORE-440]** Message ID format | Inspect message ID | Format: `msg_YYYYMMDD_<random>` — unique, timestamp-prefixed |
| 3 | **[TST-CORE-441]** Message envelope format | Inspect encrypted envelope | `{typ: "application/dina-encrypted+json", from_kid, to_kid, ciphertext: "<base64url>", sig: "<Ed25519>"}` |
| 4 | **[TST-CORE-442]** Ed25519 signature on plaintext | Verify signature | `sig` field is Ed25519 signature over the canonical plaintext. Verification flow: recipient decrypts `ciphertext` via `crypto_box_seal_open` → recovers plaintext → verifies `sig` against `from_kid` public key. Sig is in the outer envelope (visible), but verification requires the plaintext (only recipient has it) |
| 5 | **[TST-CORE-443]** Message categories | Create different types | `dina/social/*`, `dina/commerce/*`, `dina/identity/*`, `dina/trust/*` — all valid |
| 6 | **[TST-CORE-444]** Unknown message type | Receive `dina/unknown/foo` | Accepted and stored (extensible) — brain classifies, no hard rejection |
| 7 | **[TST-CORE-445]** Ephemeral key per message | Send two messages to same recipient | Each uses fresh ephemeral X25519 keypair for `crypto_box_seal` — different ciphertext |
| 8 | **[TST-CORE-446]** `from_kid`/`to_kid` DID fragment format | Inspect envelope `from_kid` and `to_kid` | Format: `did:plc:...#key-1` — DID URL with fragment identifier referencing the correct `verificationMethod` entry in sender/recipient's DID Document |
| 9 | **[TST-CORE-447]** Phase migration invariant: plaintext unchanged | Compare Phase 1 and Phase 2 envelopes for same message | Plaintext `{id, type, from, to, created_time, body}` is IDENTICAL — only the encryption wrapper changes (libsodium → JWE). Application code and message types don't change |
| 10 | **[TST-CORE-818]** Envelope contains required fields | `testutil.TestEnvelope()` | Contains `from`, `to`, `type`, `body` fields |
| 11 | **[TST-CORE-819]** Envelope from field is DID | Inspect envelope `from` field | Contains `did:key:` prefix |
| 12 | **[TST-CORE-820]** Envelope max size rejection | Envelope >1 MiB | Error returned — oversized rejected |
| 13 | **[TST-CORE-821]** Envelope invalid JSON rejected | `{not valid json` | Error returned — malformed payload |

### 7.5 Connection Establishment

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-448]** Full connection flow | Your Dina → Sancho's Dina | Step 1: Resolve DID via PLC Directory → Step 2: Extract endpoint from DID Document → Step 3: Connect → Step 4: Mutual auth → Step 5: Send encrypted |
| 2 | **[TST-CORE-449]** Mutual authentication | Both Dinas present DIDs | Both verify Ed25519 signatures, both must be in each other's contacts list |
| 3 | **[TST-CORE-450]** Contact allowlist check | Message to non-contact DID | Rejected — both sides must have each other in contacts |
| 4 | **[TST-CORE-451]** Endpoint from DID Document | Resolve `did:plc:sancho` | DID Document → `service[0].serviceEndpoint` = `https://sancho-dina.example.com/didcomm` |
| 5 | **[TST-CORE-822]** Envelope encrypted in transit | Inspect wire format | NaCl `crypto_box_seal` encryption verified |
| 6 | **[TST-CORE-823]** Encrypt/decrypt roundtrip | Seal → transmit → open | Plaintext matches after roundtrip |
| 7 | **[TST-CORE-824]** Wrong recipient cannot decrypt | Sealed for A, opened by B | Error — decryption fails |

### 7.6 Relay Fallback (NAT/Firewall)

> For Home Nodes behind NAT/CGNAT that can't accept inbound connections.
> Relay sees only encrypted blob + recipient DID. Cannot read content.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-452]** Relay forward envelope | Message to relay-fronted recipient | `{type: "dina/forward", to: "did:plc:...", payload: "<encrypted blob>"}` — relay peels outer layer, forwards inner |
| 2 | **[TST-CORE-453]** Relay cannot read content | Inspect relay's view | Only recipient DID + encrypted blob — no plaintext access |
| 3 | **[TST-CORE-454]** DID Document points to relay | Recipient behind NAT | DID Document `serviceEndpoint` points to relay, not direct Home Node |
| 4 | **[TST-CORE-455]** User can switch relays | Update DID Document | Change relay endpoint via `did:plc` rotation — messages route to new relay |
| 5 | **[TST-CORE-825]** Direct delivery preferred | Recipient directly reachable | No relay used — direct transport |
| 6 | **[TST-CORE-826]** Relay used when direct fails | Direct delivery timeout | Message routed through relay server |
| 7 | **[TST-CORE-827]** Mock send error | `mock.SendErr` set | Error propagated to caller |
| 8 | **[TST-CORE-894]** Outbox retry backoff includes jitter | Retry after failure | Backoff includes random jitter component, not pure exponential |
| 9 | **[TST-CORE-930]** Message category namespace validation | Message with invalid category namespace | Rejected — category must match allowed namespace pattern |

---

## 8. Task Queue (Outbox Pattern)

> `dina_tasks` table lives in **identity.sqlite** (shared, not persona-partitioned).
> Task IDs are ULIDs. Timeout is 5 minutes. Dead letter after 3 failed attempts.

### 8.1 Task Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-456]** Enqueue task | Core receives event (ingestion, DIDComm, client query) | Row inserted: `{id: ULID, type: "process", payload_json: {...}, status: "pending", attempts: 0, created_at: now()}` |
| 2 | **[TST-CORE-457]** Task ID is ULID | Inspect created task | ID is valid ULID (lexicographically sortable, timestamp-embedded) |
| 3 | **[TST-CORE-458]** Send to brain | Task pending | Core sends `POST brain:8200/api/v1/process {task_id, ...}`, sets `status = "processing"`, `timeout_at = now() + 5min` |
| 4 | **[TST-CORE-459]** Brain ACK (success) | Brain completes task | Brain sends `POST core:8100/v1/task/ack {task_id}` → core deletes task from `dina_tasks` |
| 5 | **[TST-CORE-460]** Brain no-ACK (crash) | Brain crashes, no ACK within 5 min | `timeout_at` expires, task stays `processing` until watchdog resets |
| 6 | **[TST-CORE-461]** Task types | Different event types | Valid types: `process`, `reason`, `embed` — unknown type rejected |
| 7 | **[TST-CORE-462]** Task persistence across restart | Core crashes and restarts | All pending/processing tasks still in `dina_tasks`, re-dispatched |
| 8 | **[TST-CORE-463]** Concurrent workers | Multiple goroutines dequeuing | No duplicate processing (SQLite row-level locking) |
| 9 | **[TST-CORE-828]** Dequeue returns pending task | Enqueue then dequeue | Task returned with `running` status |
| 10 | **[TST-CORE-829]** Dequeue empty returns nil | Empty queue | `Dequeue()` returns nil, no error |
| 11 | **[TST-CORE-830]** Complete task | Enqueue, dequeue, complete | No error on `Complete(id)` |
| 12 | **[TST-CORE-831]** Mock enqueue/dequeue | Mock TaskQueuer | FIFO behavior, correct status transitions |

### 8.2 Watchdog (Timeout Recovery)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-464]** Watchdog detects timed-out task | Task `status = "processing"`, `timeout_at` < now() | Watchdog resets to `status = "pending"`, increments `attempts` |
| 2 | **[TST-CORE-465]** Watchdog runs periodically | Background goroutine | Scans `dina_tasks WHERE status = 'processing' AND timeout_at < now()` every 30s |
| 3 | **[TST-CORE-466]** Watchdog does not touch healthy tasks | Task processing, timeout not expired | Task left alone |
| 4 | **[TST-CORE-467]** Reset task re-dispatched | Watchdog resets task to pending | Next dispatch cycle picks it up, sends to brain again |
| 5 | **[TST-CORE-832]** High priority first | Low then high priority enqueued | High priority dequeued first |
| 6 | **[TST-CORE-833]** Same priority FIFO | Two same-priority tasks | Dequeued in insertion order |
| 7 | **[TST-CORE-834]** Mock priority not enforced | Mock with two priorities | Mock uses simple FIFO (documented limitation) |

### 8.3 Dead Letter & Retry

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-468]** Dead letter after 3 failures | `attempts = 3`, brain fails again | `status = "dead"`, Tier 2 notification: "Brain failed to process event 3 times. Check crash logs." |
| 2 | **[TST-CORE-469]** Dead letter not 5 | `attempts = 4` | Should never happen — dead letter triggers at 3 |
| 3 | **[TST-CORE-470]** Retry backoff | Task fails first time | `attempts` incremented, task reset to pending (no exponential backoff on task queue — outbox has backoff, task queue has simple retry + dead letter) |
| 4 | **[TST-CORE-471]** Task cancellation | Cancel pending task by ID | `status = "cancelled"` |
| 5 | **[TST-CORE-472]** Index on status + timeout | Inspect SQLite schema | `CREATE INDEX idx_tasks_status ON dina_tasks(status, timeout_at)` exists |
| 6 | **[TST-CORE-473]** No silent data loss | Task hits dead letter | User notification via Tier 2 — not silently dropped |
| 7 | **[TST-CORE-835]** Fail task | Task running, failure reported | `Fail(id, reason)` succeeds |
| 8 | **[TST-CORE-836]** Retry increments counter | Task failed then retried | `retries` incremented, status back to pending |
| 9 | **[TST-CORE-837]** Retry non-failed task fails | Task pending (not failed) | `Retry(id)` returns error |
| 10 | **[TST-CORE-838]** Fail non-existent task fails | Non-existent task ID | `Fail(id)` returns error |

### 8.4 Reminder Loop (One-Shot Scheduling)

> Simple Go loop: `vault.NextPendingReminder()` → sleep until due → `notify()` → `MarkFired()`.
> No cron library. No scheduler dependency. Missed reminders fire on startup.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-474]** Store reminder | `POST /v1/vault/store {type: "reminder", trigger_at: "2026-02-21T07:00:00Z", message: "License renewal"}` | Reminder stored in vault with trigger timestamp |
| 2 | **[TST-CORE-475]** Next pending reminder | Two reminders: 7 AM today, 9 AM tomorrow | `NextPendingReminder()` returns 7 AM reminder (`ORDER BY trigger_at LIMIT 1`) |
| 3 | **[TST-CORE-476]** Sleep until trigger time | Reminder due in 30 minutes | Loop sleeps for 30 minutes, then fires notification |
| 4 | **[TST-CORE-477]** Missed reminder on startup | Reminder was due 2 hours ago (server was down) | `time.Until(trigger_at)` is negative → fires immediately on startup |
| 5 | **[TST-CORE-478]** Fire + mark done | Reminder fires | `notify(next)` pushes to client → `vault.MarkFired(next.ID)` → reminder not re-triggered |
| 6 | **[TST-CORE-479]** No pending → sleep 1 minute | No reminders in vault | `NextPendingReminder()` returns nil → loop sleeps 1 minute → checks again |
| 7 | **[TST-CORE-480]** No cron library | Code audit | No `robfig/cron`, no scheduling library — just `time.Sleep` and vault query |
| 8 | **[TST-CORE-481]** Complex scheduling → delegate | User asks "every Monday at 9 AM" | Brain tells user: "Want me to create a recurring calendar event?" → delegates to OpenClaw/Calendar service |
| 9 | **[TST-CORE-839]** Crash recovery re-enqueues running tasks | Core crashes with running tasks | Tasks reset to pending after restart |
| 10 | **[TST-CORE-840]** Retry schedule exponential backoff | Outbox retry | 30s → 1m → 5m → 30m → 2h |
| 11 | **[TST-CORE-841]** Max retries exceeded marks dead letter | 5+ retries exhausted | Task moved to dead-letter state |
| 12 | **[TST-CORE-842]** Persistence across restart | Core restarts | All tasks recoverable from SQLite WAL |
| 13 | **[TST-CORE-933]** Silence rules stored and retrievable from vault | Store silence rule, retrieve | Silence rules persisted in vault, retrievable for enforcement |

---

## 9. WebSocket Protocol

> Full message envelope specification from ARCHITECTURE.md §17 (Infrastructure).
> All messages are JSON with `type`/`id`/`payload`. Responses link via `reply_to`.

### 9.1 Connection Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-482]** WS upgrade on `/ws` | Client connects `wss://dina.local:8100/ws` | HTTP 101 upgrade, connection accepted, 5-second auth timer starts |
| 2 | **[TST-CORE-483]** Auth frame within 5s | Client sends `{"type": "auth", "token": "<CLIENT_TOKEN>"}` | Core validates SHA-256(token) → `{"type": "auth_ok", "device": "phone_pixel7"}`, `last_seen` updated |
| 3 | **[TST-CORE-484]** Auth frame timeout | No auth frame within 5s | Core closes connection — no response sent |
| 4 | **[TST-CORE-485]** Invalid auth frame | Wrong CLIENT_TOKEN in auth frame | `{"type": "auth_fail"}` → core closes connection |
| 5 | **[TST-CORE-486]** Revoked token in auth frame | Previously revoked CLIENT_TOKEN | `{"type": "auth_fail"}` → core closes connection |
| 6 | **[TST-CORE-487]** Auth OK includes device name | Valid auth from "Raj's iPhone" | `auth_ok` response includes `"device": "rajs_iphone"` — device name from pairing |
| 7 | **[TST-CORE-488]** Graceful disconnect | Client sends close frame | Server acknowledges, resources cleaned, device marked offline |
| 8 | **[TST-CORE-489]** Abnormal disconnect | TCP connection drops | Server detects via ping timeout (3 missed pongs), cleans up |

### 9.2 Message Envelope Format (Client → Core)

> All client messages include `type` and `id`. Payload varies by type.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-490]** Query message | `{"type": "query", "id": "req_001", "payload": {"text": "Am I free at 3pm?", "persona": "/personal"}}` | Routed to brain, response returned with `reply_to: "req_001"` |
| 2 | **[TST-CORE-491]** Query with persona field | Query with `"persona": "/financial"` | Core checks persona access (open/restricted/locked) before routing to brain |
| 3 | **[TST-CORE-492]** Command message | `{"type": "command", "id": "req_002", "payload": {"action": "unlock_persona", "persona": "/financial"}}` | Executed by core, result returned with `reply_to: "req_002"` |
| 4 | **[TST-CORE-493]** ACK message | `{"type": "ack", "id": "evt_003"}` | Core removes `evt_003` from missed message buffer — acknowledged receipt |
| 5 | **[TST-CORE-494]** Pong message | `{"type": "pong", "ts": 1708300000}` | Core records pong, resets missed-pong counter for this device |
| 6 | **[TST-CORE-495]** Missing `id` field | `{"type": "query", "payload": {...}}` (no `id`) | Error response: `{"type": "error", "payload": {"code": 400, "message": "missing id field"}}` |
| 7 | **[TST-CORE-496]** Unknown message type | `{"type": "foo", "id": "req_003"}` | Error response with `reply_to: "req_003"`, connection NOT dropped (extensible protocol) |

### 9.3 Message Envelope Format (Core → Client)

> Responses include `reply_to` linking to client `id`. Proactive messages have their own `id`.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-497]** Whisper stream (chunked) | Brain streams response to query | `{"type": "whisper_stream", "reply_to": "req_001", "payload": {"chunk": "Looking at your calendar... "}}` — multiple chunks |
| 2 | **[TST-CORE-498]** Whisper (final response) | Brain completes response | `{"type": "whisper", "reply_to": "req_001", "payload": {"text": "You're free at 3pm.", "sources": ["calendar:event:abc123"]}}` |
| 3 | **[TST-CORE-499]** Proactive whisper (brain-initiated) | Brain detects incoming D2D message | `{"type": "whisper", "id": "evt_003", "payload": {"text": "Sancho just left home.", "trigger": "didcomm:geofence:sancho:departed", "tier": 2}}` — no `reply_to` |
| 4 | **[TST-CORE-500]** System notification | Watchdog detects connector issue | `{"type": "system", "id": "sys_004", "payload": {"level": "warning", "text": "Gmail hasn't synced in 48h. Re-authenticate?"}}` |
| 5 | **[TST-CORE-501]** Error response | Command fails | `{"type": "error", "reply_to": "req_002", "payload": {"code": 403, "message": "/financial requires approval"}}` |
| 6 | **[TST-CORE-502]** Routing logic: `reply_to` = response | Message has `reply_to` field | Client matches to pending request by `id` — this is a response |
| 7 | **[TST-CORE-503]** Routing logic: no `reply_to` = proactive | Message has `id` but no `reply_to` | Client treats as proactive event from brain or system — requires ACK |
| 8 | **[TST-CORE-504]** Whisper stream terminated by final whisper | Brain finishes streaming | Last `whisper_stream` chunk followed by `whisper` message (same `reply_to`) — client knows stream is complete |

### 9.4 Heartbeat Protocol

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-505]** Core sends ping every 30s | Authenticated WS connection idle for 30s | `{"type": "ping", "ts": 1708300000}` sent by core |
| 2 | **[TST-CORE-506]** Client responds with pong | Core sends ping | Client sends `{"type": "pong", "ts": 1708300000}` within 10 seconds |
| 3 | **[TST-CORE-507]** Pong timeout: 10 seconds | Core sends ping, no pong within 10s | Missed pong counter incremented |
| 4 | **[TST-CORE-508]** 3 missed pongs → disconnect | 3 consecutive pings without pong response | Core closes connection, marks device offline |
| 5 | **[TST-CORE-509]** Pong resets counter | 2 missed pongs, then pong received | Counter reset to 0 — connection stays alive |
| 6 | **[TST-CORE-510]** Ping includes timestamp | Inspect ping message | `ts` field is Unix timestamp — client can detect clock drift |

### 9.5 Missed Message Buffer

> Per-device buffer. Max 50 messages, max 5 minutes retention.
> Expired buffer → brain generates fresh briefing instead of replaying stale notifications.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-511]** Client temporarily disconnected | 10 messages arrive during disconnect | Client reconnects, auth succeeds, receives 10 buffered messages in order |
| 2 | **[TST-CORE-512]** Buffer cap: max 50 messages | >50 messages during disconnect | Oldest messages dropped, newest 50 retained, client notified of gap |
| 3 | **[TST-CORE-513]** Buffer ordering preserved | Messages buffered in order | Delivered in original order on reconnect (FIFO) |
| 4 | **[TST-CORE-514]** Buffer TTL: 5 minutes | Client disconnected for 10 minutes | Buffer expired after 5 min — messages gone. Brain generates fresh briefing on reconnect |
| 5 | **[TST-CORE-515]** Client ACKs buffered messages | Client receives buffered messages | Client sends `{"type": "ack", "id": "evt_XXX"}` for each → ACKed messages removed from buffer |
| 6 | **[TST-CORE-516]** Buffer per-device | Device A disconnected, Device B connected | Only Device A's buffer exists — Device B receives messages in real-time |
| 7 | **[TST-CORE-517]** Buffer within TTL: all delivered | Client disconnected for 3 minutes | All buffered messages delivered on reconnect (within 5-min TTL) |
| 8 | **[TST-CORE-518]** Why 5 min, not longer | Design review | If phone is offline for hours, brain generates fresh briefing — replaying stale notifications is worse than summarizing |
| 9 | **[TST-CORE-519]** Reconnection: exponential backoff (client-side) | Client detects disconnect | Client reconnects with backoff: 1s → 2s → 4s → 8s → 16s → max 30s. On reconnect: re-send auth frame |
| 10 | **[TST-CORE-911]** Push notifications: FCM/APNs wake-up payload is data-free | FCM push payload | Payload contains no user data — data-free wake-up only |
| 11 | **[TST-CORE-912]** WebSocket `last_seen` timestamp updated on auth | Client authenticates via WS | `last_seen` field in device_tokens updated to current time |
| 12 | **[TST-CORE-913]** Device push via authenticated WebSocket | Authenticated WS client | Push notifications delivered via WS channel |

---

## 10. Device Pairing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-520]** Generate pairing code | Initiate pairing from admin | 6-digit code generated, valid for 5 minutes |
| 2 | **[TST-CORE-521]** Pair with valid code | New device submits correct code within TTL | CLIENT_TOKEN issued, device registered |
| 3 | **[TST-CORE-522]** Pair with expired code | Code submitted after 5 minutes | 410 Gone — code expired |
| 4 | **[TST-CORE-523]** Pair with wrong code | Incorrect 6-digit code | 401 — pairing failed |
| 5 | **[TST-CORE-524]** Brute-force protection | >3 wrong attempts for same code | Code invalidated, new code required |
| 6 | **[TST-CORE-525]** Code single-use | Use valid code twice | Second attempt fails — code consumed |
| 7 | **[TST-CORE-526]** Concurrent pairing codes | Two codes active simultaneously | Both work independently |

### 10.1 Device Management API

> Architecture §17 defines device management endpoints beyond pairing:
> listing, revoking, token format, response schema. Brain §8.3 tests admin UI
> calls to these; this section tests core's API implementation.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-527]** List paired devices (GET /v1/devices) | Service Signature Auth (or admin session) after 3 devices paired | 200 with array of `{token_id, device_name, last_seen, created_at, revoked}` for each device. `last_seen` reflects most recent WS auth_ok. Architecture §17: "Brain: queries device_tokens via core" — admin UI and brain both need this endpoint |
| 2 | **[TST-CORE-528]** Revoke device (PATCH /v1/devices/{token_id}/revoke) | Admin request to revoke specific device | 200 — `revoked=true` in device_tokens. Next request from that device → 401 immediately. Core §9.1 #5 tests WS-level rejection; this tests the revocation API itself. Architecture §17: "Core sets revoked=true. Next request from iPad → 401. Immediate." |
| 3 | **[TST-CORE-529]** Pair completion response includes node_did + ws_url | Successful pairing via POST /v1/pair/complete | Response body: `{client_token: "...", node_did: "did:plc:...", ws_url: "wss://..."}` — all three fields present. Client needs node_did for identity verification and ws_url for WebSocket connection. Architecture §17 pairing flow step 10 |
| 4 | **[TST-CORE-530]** CLIENT_TOKEN format: 32 bytes, hex-encoded | Inspect token from pair completion | 64 hex chars (0-9a-f) — `crypto/rand` 32 bytes → hex. Architecture §17: "CLIENT_TOKEN is a 32-byte cryptographic random value (hex-encoded, 64 chars)" |
| 5 | **[TST-CORE-895]** Device type (rich/thin) recorded during pairing | Pair new device with type=thin | Device type stored in device_tokens table |
| 6 | **[TST-CORE-896]** mDNS auto-discovery broadcast on LAN | Core starts on LAN | mDNS broadcast enables automatic device discovery |

---

## 11. Brain Client & Circuit Breaker

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-531]** Healthy brain | Brain responds within timeout | Request succeeds |
| 2 | **[TST-CORE-532]** Brain timeout | Brain doesn't respond in 30s | Timeout error, circuit breaker increments failure count |
| 3 | **[TST-CORE-533]** Circuit breaker opens | 5 consecutive failures | Subsequent requests fail-fast without calling brain |
| 4 | **[TST-CORE-534]** Circuit breaker half-open | After cooldown period | Single probe request sent; if success, breaker closes |
| 5 | **[TST-CORE-535]** Circuit breaker closes | Probe request succeeds | Normal traffic resumes |
| 6 | **[TST-CORE-536]** Brain crash recovery | Brain container restarts | Watchdog detects health, circuit breaker resets |

### 11.1 Watchdog

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-537]** Brain healthy | `/v1/health` returns 200 | No action |
| 2 | **[TST-CORE-538]** Brain unhealthy | `/v1/health` fails 3 consecutive times | Alert dispatched, circuit breaker opened |
| 3 | **[TST-CORE-539]** Brain recovery | Health restored after failure | Alert cleared, normal operation |
| 4 | **[TST-CORE-540]** Watchdog interval | Check frequency | Every 10s (configurable) |
| 5 | **[TST-CORE-843]** Send event to brain (mock) | Mock brain returns success | `ProcessEvent()` returns result |
| 6 | **[TST-CORE-844]** Brain returns error (mock) | Mock brain returns error | `ProcessEvent()` returns error |
| 7 | **[TST-CORE-845]** Brain returns malformed JSON | Brain response is invalid JSON | Error returned gracefully |
| 8 | **[TST-CORE-846]** Concurrent requests | 20 goroutines calling ProcessEvent | Thread-safe, no panics |
| 9 | **[TST-CORE-847]** Empty URL returns error | BrainClient with empty URL | Error on any operation |
| 10 | **[TST-CORE-848]** Connection pooling | 10 sequential requests | Reuses HTTP connections |
| 11 | **[TST-CORE-849]** Mock health success | Healthy mock | `Health()` returns nil, `IsAvailable()` true |
| 12 | **[TST-CORE-850]** Mock health failure | Unhealthy mock | `Health()` returns error, `IsAvailable()` false |

---

## 12. Admin Proxy

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-541]** Proxy to brain admin UI | GET `localhost:8100/admin/` | Reverse-proxied to brain:8200/admin/ |
| 2 | **[TST-CORE-542]** Auth required | Unauthenticated request to :8100 | Redirect to login page |
| 3 | **[TST-CORE-543]** Static asset proxying | CSS/JS files | Correctly proxied with right Content-Type |
| 4 | **[TST-CORE-544]** WebSocket upgrade through proxy | WS connection to :8100/ws | Proxied to brain:8200/ws |
| 5 | **[TST-CORE-897]** CSRF token injected as `X-CSRF-Token` in proxied response | Admin proxy response | Response contains `X-CSRF-Token` header with valid CSRF token |

---

## 13. Rate Limiting

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-545]** Below rate limit | Normal request rate | All requests succeed |
| 2 | **[TST-CORE-546]** At rate limit | Exactly at limit | Last request succeeds |
| 3 | **[TST-CORE-547]** Above rate limit | Burst exceeding limit | 429 Too Many Requests |
| 4 | **[TST-CORE-548]** Rate limit reset | Wait for window to pass | Requests succeed again |
| 5 | **[TST-CORE-549]** Per-IP isolation | Two IPs at their limits | Each tracked independently |
| 6 | **[TST-CORE-550]** Rate limit headers | Any response | `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers present |

---

## 14. Configuration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-551]** Load from environment variables | `DINA_DATA_DIR`, `BRAIN_URL` set | Config populated from env |
| 2 | **[TST-CORE-552]** Load from Docker secrets | `/run/secrets/brain_token` | Token read from file |
| 3 | **[TST-CORE-553]** Missing required config | `BRAIN_URL` not set | Startup fails with descriptive error |
| 4 | **[TST-CORE-554]** Default values | Optional config not set | Sensible defaults applied (e.g., spool max 500MB) |
| 5 | **[TST-CORE-555]** Config validation | Invalid port number, negative TTL | Startup fails with validation error |
| 6 | **[TST-CORE-556]** DINA_SPOOL_MAX enforcement | Spool directory exceeds configured max | New spooling rejected (Valve 2 closes) |
| 7 | **[TST-CORE-851]** Partial env vars | Only some env vars set | Missing fields use defaults |
| 8 | **[TST-CORE-852]** Env var type parsing | Numeric env vars | Correctly parsed to int fields |
| 9 | **[TST-CORE-853]** Default security mode | No DINA_MODE set | Defaults to "security" (not "convenience") |
| 10 | **[TST-CORE-854]** Negative session TTL rejected | `SessionTTL = -1` | Validation fails |
| 11 | **[TST-CORE-855]** Load from config.json | `DINA_CONFIG_PATH` set | Config loaded from JSON file |
| 12 | **[TST-CORE-856]** Env overrides config.json | Both config.json and env var set | Env var takes precedence |
| 13 | **[TST-CORE-857]** Docker secret overrides env token | Both `DINA_Service Signature Auth` and `_FILE` set | Secret file takes precedence |
| 14 | **[TST-CORE-898]** Audit log retention configurable via config.json (`retention_days`) | config.json with retention_days=30 | Audit log purge uses configured retention period |
| 15 | **[TST-CORE-899]** Cloud LLM consent flag stored and enforced | consent_cloud_llm=false in config | Cloud LLM routing blocked when consent not given |
| 16 | **[TST-CORE-900]** `DINA_HISTORY_DAYS` config default 365 | No DINA_HISTORY_DAYS set | Default to 365 days of history retention |

---

## 15. API Endpoint Tests

### 15.1 Health & Readiness

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-557]** Liveness probe | `GET /healthz` | 200 OK — HTTP server responding, near-zero cost |
| 2 | **[TST-CORE-558]** Readiness probe: vault healthy | `GET /readyz` | 200 OK — `db.PingContext()` succeeds on identity.sqlite |
| 3 | **[TST-CORE-559]** Readiness probe: vault locked | `GET /readyz` when vault locked (security mode, no passphrase) | 503 — vault not queryable |
| 4 | **[TST-CORE-560]** Readiness probe: SQLite locked | `GET /readyz` when db.PingContext() times out | 503 — database locked or corrupted |
| 5 | **[TST-CORE-561]** Liveness ≠ Readiness | `/healthz` returns 200, `/readyz` returns 503 | Zombie state: process alive but vault unusable — Docker should restart |
| 6 | **[TST-CORE-562]** Docker healthcheck uses `/healthz` | Inspect docker-compose.yml | `wget -q --spider http://localhost:8100/healthz` — liveness check (see §20.2 for full params) |
| 7 | **[TST-CORE-563]** Docker healthcheck params | Inspect compose healthcheck | interval=10s, timeout=3s, retries=3, start_period=5s (per docker-compose.yml §17) |
| 8 | **[TST-CORE-564]** Brain starts after core healthy | `docker compose up` | `dina-brain.depends_on.dina-core.condition: service_healthy` |

### 15.2 Vault API (Architecture Contract)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-565]** Search vault | `POST /v1/vault/query` with persona, q, mode, filters | 200 with items array + pagination |
| 2 | **[TST-CORE-566]** Store item | `POST /v1/vault/store` with persona, type, source, summary, embedding | 201 Created with `{status: "ok", id: "vault_..."}` |
| 3 | **[TST-CORE-567]** Get item by ID | `GET /v1/vault/item/:id` | 200 with full item JSON |
| 4 | **[TST-CORE-568]** Delete item (right to forget) | `DELETE /v1/vault/item/:id` | 200 — item permanently removed |
| 5 | **[TST-CORE-569]** Store crash traceback | `POST /v1/vault/crash` with `{error, traceback, task_id}` | 200 — stored in `crash_log` table in identity.sqlite (encrypted at rest) |
| 6 | **[TST-CORE-570]** ACK task | `POST /v1/task/ack {task_id}` | 200 — task deleted from `dina_tasks` |
| 7 | **[TST-CORE-571]** Vault KV store | `PUT /v1/vault/kv/gmail_cursor {value: "2026-02-20T10:00:00Z"}` | 200 — key-value pair stored in `kv_store` table in identity.sqlite |
| 8 | **[TST-CORE-572]** Vault KV read | `GET /v1/vault/kv/gmail_cursor` | 200 — `{value: "2026-02-20T10:00:00Z"}` returned |
| 9 | **[TST-CORE-573]** Vault KV upsert | `PUT /v1/vault/kv/gmail_cursor` with new value | 200 — `updated_at` updated, old value replaced |
| 10 | **[TST-CORE-574]** Vault KV not found | `GET /v1/vault/kv/nonexistent_key` | 404 |
| 11 | **[TST-CORE-575]** Vault batch store | `POST /v1/vault/store/batch` with 100 items | 201 — all 100 stored in single transaction |
| 12 | **[TST-CORE-576]** Vault batch store exceeds cap | `POST /v1/vault/store/batch` with 200 items | 400 — max 100 items per batch request |

### 15.3 Identity API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-577]** Get own DID | GET `/v1/did` | 200 with DID Document |
| 2 | **[TST-CORE-578]** Create persona | POST `/v1/personas` | 201 with new persona DID |
| 3 | **[TST-CORE-579]** List personas | GET `/v1/personas` | 200 with array |
| 4 | **[TST-CORE-580]** Get contacts | GET `/v1/contacts` | 200 with contact list |
| 5 | **[TST-CORE-581]** Add contact | POST `/v1/contacts` | 201 |
| 6 | **[TST-CORE-582]** Register device | POST `/v1/devices` | 201 |
| 7 | **[TST-CORE-583]** List devices | GET `/v1/devices` | 200 with device array |

### 15.4 Messaging API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-584]** Send message | POST `/v1/msg/send` + recipient DID + payload | 202 Accepted (queued in outbox) |
| 2 | **[TST-CORE-585]** Receive messages | GET `/v1/msg/inbox` | 200 with message array |
| 3 | **[TST-CORE-586]** Acknowledge message | POST `/v1/msg/{id}/ack` | 200 |

### 15.5 Pairing API

> Detailed pairing flow from ARCHITECTURE.md §17 (Client Authentication).
> 6-digit code = short-lived proximity proof. CLIENT_TOKEN = long-lived per-device credential.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-587]** Initiate pairing | POST `/v1/pair/initiate` | 200 — `{"code": "847291", "expires_in": 300}` (5 minutes) |
| 2 | **[TST-CORE-588]** Initiate stores pending pairing | After initiate | Core stores: `pending_pairings[code] = {expires, used: false}` |
| 3 | **[TST-CORE-589]** Complete pairing | POST `/v1/pair/complete` `{"code": "847291", "device_name": "Raj's iPhone"}` | 200 — `{"client_token": "a3f8b2c1d4e5...", "node_did": "did:plc:5qtzkvd...", "ws_url": "wss://192.168.1.42:8100/ws"}` |
| 4 | **[TST-CORE-590]** CLIENT_TOKEN is 32 bytes hex | Inspect `client_token` in response | 64 hex chars (32 bytes from `crypto/rand`) |
| 5 | **[TST-CORE-591]** SHA-256 hash stored, not token | Inspect `device_tokens` table after pairing | `token_hash` = SHA-256(CLIENT_TOKEN) — plaintext token never stored |
| 6 | **[TST-CORE-592]** Pending pairing deleted after complete | After successful complete | `pending_pairings[code]` removed — code cannot be reused |
| 7 | **[TST-CORE-593]** Device name stored | Inspect `device_tokens` after pairing | `device_name: "Raj's iPhone"` stored alongside token hash |
| 8 | **[TST-CORE-594]** Managed hosting: no terminal | Managed signup flow | Pairing code displayed in signup UI — same flow, different presentation |

### 15.6 AT Protocol Discovery

> **Critical for PDS federation.** Core must serve this endpoint or PDS federation silently fails.
> AT Protocol relays use this to find the PDS on port 2583.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-595]** AT Protocol discovery | `GET /.well-known/atproto-did` | 200 — body: `did:plc:abc123...` (plain text, `Content-Type: text/plain`) |
| 2 | **[TST-CORE-596]** Discovery returns root DID | Inspect response body | Root DID from `vault.GetRootDID()` — not persona DID |
| 3 | **[TST-CORE-597]** Discovery unauthenticated | No auth header | 200 — public endpoint, no authentication required (AT Protocol spec) |
| 4 | **[TST-CORE-598]** Discovery available in dev mode | `GET localhost:8100/.well-known/atproto-did` | Returns DID on port 8100 (dev) — production serves on 443 via tunnel |
| 5 | **[TST-CORE-599]** Missing DID (no identity yet) | Fresh install, DID not yet generated | 404 or 503 — not empty 200 |

### 15.7 PII API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-600]** Scrub text | POST `/v1/pii/scrub` + text body | 200 with scrubbed text |
| 2 | **[TST-CORE-901]** `/metrics` Prometheus endpoint requires CLIENT_TOKEN | GET /metrics with Service Signature Auth | 403 — metrics is admin-only; CLIENT_TOKEN required |
| 3 | **[TST-CORE-902]** Sync status API endpoint for admin UI | GET /admin/sync-status | 200 with sync status for connected devices |

---

## 16. Error Handling & Edge Cases

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-601]** Malformed JSON body | `{invalid json` | 400 Bad Request with parse error |
| 2 | **[TST-CORE-602]** Request body too large | >10 MiB body | 413 Payload Too Large |
| 3 | **[TST-CORE-603]** Unknown endpoint | GET `/v1/nonexistent` | 404 Not Found |
| 4 | **[TST-CORE-604]** Method not allowed | DELETE on GET-only endpoint | 405 Method Not Allowed |
| 5 | **[TST-CORE-605]** Content-Type enforcement | POST without `Content-Type: application/json` | 415 Unsupported Media Type |
| 6 | **[TST-CORE-606]** Concurrent vault writes | Two simultaneous writes to same persona vault | Both succeed (WAL mode) or one retries |
| 7 | **[TST-CORE-607]** Disk full | Vault write when disk is full | Graceful error, no corruption |
| 8 | **[TST-CORE-608]** Vault file corruption | SQLCipher file truncated | Detected on open, error reported |
| 9 | **[TST-CORE-609]** Graceful shutdown | SIGTERM received | In-flight requests complete, outbox flushed, connections closed |
| 10 | **[TST-CORE-610]** Panic recovery | Goroutine panics | Recovered by middleware, 500 returned, not a crash |

---

## 17. Security Hardening

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-611]** No VACUUM INTO | Code audit | `VACUUM INTO` never used (plaintext backup CVE) |
| 2 | **[TST-CORE-612]** SQL injection resistance | Malicious input in API fields | Parameterized queries only, no string concatenation |
| 3 | **[TST-CORE-613]** Path traversal | `../../etc/passwd` in file paths | Rejected, path normalized |
| 4 | **[TST-CORE-614]** Header injection | Newlines in header values | Stripped or rejected |
| 5 | **[TST-CORE-615]** Memory zeroization | After key use | Sensitive key material zeroed from memory (Go `memguard` or manual) |
| 6 | **[TST-CORE-616]** TLS enforcement (production) | HTTP request to HTTPS-only endpoint | 301 redirect or connection refused |
| 7 | **[TST-CORE-617]** Docker network isolation | Brain tries to reach PDS directly | Blocked — different Docker networks (bowtie topology) |
| 8 | **[TST-CORE-618]** Secrets not in environment | Inspect `docker inspect` | Secrets mounted as files, not env vars |
| 9 | **[TST-CORE-619]** No plaintext keys on disk | Inspect keystore files | All keys AES-256-GCM wrapped |
| 10 | **[TST-CORE-620]** Constant-time comparisons | All token/hash comparisons | `crypto/subtle.ConstantTimeCompare` used |
| 11 | **[TST-CORE-621]** No plugin loading mechanism | Code audit: grep for `plugin.Open`, dynamic loading, `dlopen` | Zero matches — no dynamic code loading |
| 12 | **[TST-CORE-622]** No plugin API endpoint | Enumerate all registered routes | No plugin/extension registration endpoints |
| 13 | **[TST-CORE-623]** Only two extension points (architecture audit) | Trace all outbound calls from core | NaCl (transport to peers) and HTTP (to brain) only — no third integration |
| 14 | **[TST-CORE-624]** No plaintext vault data on disk | After vault read/write: inspect `DINA_DATA_DIR` | Only `.sqlite` (SQLCipher-encrypted) files, no plaintext dumps, temp files, or swap |
| 15 | **[TST-CORE-625]** Plaintext discarded after processing | Trigger vault read → wait → inspect `/proc/self/maps` or equivalent (test env) | Decrypted data not resident in memory after response sent |
| 16 | **[TST-CORE-626]** Keys in RAM only while needed | After persona lock: dump process memory (test env) | DEK absent from memory after lock/TTL expiry (not just zeroed struct) |
| 17 | **[TST-CORE-627]** SQLCipher library: `mutecomm/go-sqlcipher` (NOT `mattn/go-sqlite3`) | Code audit: inspect go.mod | `github.com/mutecomm/go-sqlcipher` — NOT `mattn/go-sqlite3` (SQLCipher support was never merged into mattn mainline) |
| 18 | **[TST-CORE-628]** CI: raw .sqlite bytes are NOT valid SQLite headers | CI test: open any vault file as plain sqlite3 (no key) | MUST fail to open — if it opens, CI build fails (proves encryption is active) |
| 19 | **[TST-CORE-629]** Serialization: JSON for core↔brain traffic | Inspect all inter-container API calls | JSON (Phase 1, debuggable). No MessagePack/Protobuf until profiling shows it matters |
| 20 | **[TST-CORE-630]** Container image: digest pinning, never `:latest` | Inspect Dockerfiles and docker-compose.yml | All `FROM` statements use `@sha256:...` digest — never `:latest` tag |
| 21 | **[TST-CORE-631]** Container image: Cosign signature | Inspect CI pipeline | Published images signed with Cosign — `cosign verify` passes |
| 22 | **[TST-CORE-632]** SBOM generated | Inspect CI artifacts | `syft` generates SPDX SBOM for each image — enables supply chain auditing |
| 23 | **[TST-CORE-633]** Secrets NEVER in environment variables | `docker inspect dina-core`, check `Env` section | No `Service Signature Auth`, `DINA_PASSPHRASE` in environment — only in `/run/secrets/` (tmpfs) |
| 24 | **[TST-CORE-634]** Secrets tmpfs mount (never on disk) | Inspect `/run/secrets/` inside container | Files mounted as in-memory tmpfs — never touch disk inside container |
| 25 | **[TST-CORE-635]** `GOOGLE_API_KEY` exception documented | Inspect `.env` and docker-compose env | API key in `.env` (not secrets) — it's a revocable cloud key, not a local credential |
| 26 | **[TST-CORE-636]** Docker network: `dina-pds-net` allows outbound | Inspect `docker network inspect dina-pds-net` | Standard bridge (not internal) — PDS needs outbound to reach plc.directory for DID resolution |
| 27 | **[TST-CORE-637]** Docker network: `dina-brain-net` is standard | Inspect `docker network inspect dina-brain-net` | Standard bridge (not internal) — brain needs outbound internet for Gemini/Claude API |
| 28 | **[TST-CORE-638]** External ports: only 8100 + 2583 | Inspect docker-compose port mappings | Only `8100:8100` (core) and `2583:2583` (PDS) exposed to host — brain and llama internal only |
| 29 | **[TST-CORE-903]** No Go `plugin.Open()` or dynamic library loading | Code audit for plugin/dlopen | Zero matches — kernel guarantee against dynamic code loading |
| 30 | **[TST-CORE-904]** Core has no external OAuth token storage | Code audit | No OAuth tokens stored in vault or config — core doesn't do OAuth |
| 31 | **[TST-CORE-905]** No vector clocks, no CRDTs (simplicity code audit) | Code audit for vector clock/CRDT imports | Zero matches — sync uses simple checkpoint, not distributed consensus |

---

## 18. Core ↔ Brain API Contract

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-639]** Core exposes `/v1/vault/query` to brain | Service Signature Auth + query request | 200 with results |
| 2 | **[TST-CORE-640]** Core exposes `/v1/vault/store` to brain | Service Signature Auth + store request | 201 Created |
| 3 | **[TST-CORE-641]** Core exposes `/v1/did/sign` — admin only | Service Signature Auth | 403 — admin endpoint |
| 4 | **[TST-CORE-642]** Core exposes `/v1/did/verify` to brain | Service Signature Auth + verify request | 200 with verification result |
| 5 | **[TST-CORE-643]** Core exposes `/v1/pii/scrub` to brain | Service Signature Auth + text | 200 with scrubbed text |
| 6 | **[TST-CORE-644]** Core exposes `/v1/notify` to brain | Service Signature Auth + push notification | 200 — notification pushed to connected clients |
| 7 | **[TST-CORE-645]** All brain-callable endpoints accept Service Signature Auth | Iterate all non-admin endpoints with Service Signature Auth | All return 200 (not 403) |
| 8 | **[TST-CORE-646]** No other endpoints exist beyond documented set | Enumerate all routes | Exact match with documented API surface — 8 brain-callable families (vault/query, vault/store, did/verify, pii/scrub, notify, msg/send, trust/query, process+reason) plus admin-only endpoints (did/sign, did/rotate, vault/backup, persona/unlock, admin/*) |
| 9 | **[TST-CORE-647]** Core exposes `/v1/msg/send` to brain | Service Signature Auth + encrypted message payload (recipient DID, ciphertext) | 200 — message queued in outbox for Dina-to-Dina delivery. Architecture §03 line 135 lists `msg/send` in Service Signature Auth scope. Brain triggers outbound messages (e.g., sharing a verdict with a contact); core handles encryption envelope and transport |
| 10 | **[TST-CORE-648]** Core exposes `/v1/trust/query` to brain | Service Signature Auth + query (entity, category) | 200 with trust score from local cache or PDS federation. Architecture §03 line 135 lists `trust/query` in Service Signature Auth scope. Brain needs trust data for LLM routing decisions (e.g., which bot to delegate to) and trust ring evaluation |
| 11 | **[TST-CORE-906]** `/v1/vault/crash` rejects requests missing required fields | POST /v1/vault/crash without error/traceback | 400 Bad Request — error and traceback fields required |
| 12 | **[TST-CORE-907]** Vault query full response schema validated | POST /v1/vault/query | Response contains id, type, persona, summary, relevance, pagination |
| 13 | **[TST-CORE-908]** Vault store response ID format (`vault_` prefix) | POST /v1/vault/store | Returned ID starts with `vault_` prefix |
| 14 | **[TST-CORE-909]** Vault query: missing `persona` field → 400 | POST /v1/vault/query without persona | 400 Bad Request |
| 15 | **[TST-CORE-910]** Core calls only documented brain endpoints | Code audit of outbound HTTP calls to brain | Only documented endpoints called — no undocumented brain API usage |

---

## 19. Onboarding Sequence

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-649]** Managed onboarding: "email + password → done" | User enters email + passphrase | Full silent setup completes, Dina starts ingesting |
| 2 | **[TST-CORE-650]** Silent step 1: BIP-39 mnemonic generated | First-run | 24-word mnemonic, 512-bit master seed |
| 3 | **[TST-CORE-651]** Silent step 2: root Ed25519 keypair derived | Master seed | SLIP-0010 `m/9999'/0'/0'` → root keypair |
| 4 | **[TST-CORE-652]** Silent step 3: did:plc registered | Root keypair | DID registered with plc.directory |
| 5 | **[TST-CORE-653]** Silent step 4: per-database DEKs derived | Master seed | HKDF with persona-specific info strings |
| 6 | **[TST-CORE-654]** Silent step 5: password wraps master seed | Passphrase | Argon2id → KEK → AES-256-GCM wrap (key wrapping, not derivation) |
| 7 | **[TST-CORE-655]** Silent step 6: databases created | DEKs | identity.sqlite + personal.sqlite created |
| 8 | **[TST-CORE-656]** Silent step 7: convenience mode set (managed) | Managed hosting | Master seed written to keyfile, `chmod 600` |
| 9 | **[TST-CORE-657]** Silent step 8: brain starts guardian loop | Vault unlocked | Brain receives vault_unlocked event, begins operation |
| 10 | **[TST-CORE-658]** Silent step 9: initial sync triggered | Brain ready | MCP → OpenClaw fetches Gmail/Calendar |
| 11 | **[TST-CORE-659]** One default persona: `/personal` | After setup | Only `/personal` persona exists — no /health, /financial, /citizen |
| 12 | **[TST-CORE-660]** Mnemonic backup deferred to Day 7 | Day 7 after setup | Prompt: "Write down these 24 words" — not shown during onboarding |
| 13 | **[TST-CORE-661]** Sharing rules default to empty | After setup | No sharing policies — default-deny egress |
| 14 | **[TST-CORE-932]** install.sh bootstrap: token gen, dirs, permissions | Run install.sh on fresh system | Service Signature Auth generated, directories created with correct permissions |

---

## 20. Observability & Self-Healing

> A sovereign node must stay alive without human intervention. A running process
> can have a locked SQLite or deadlocked goroutine — Docker won't restart it
> unless the healthcheck catches it.

### 20.1 Health Endpoints

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-662]** `/healthz` liveness: server alive | `GET /healthz` | 200 OK — near-zero cost, no DB call |
| 2 | **[TST-CORE-663]** `/readyz` readiness: vault queryable | `GET /readyz` | `db.PingContext()` with strict timeout → 200 if vault open |
| 3 | **[TST-CORE-664]** `/readyz` failure: vault locked | `GET /readyz` when vault locked (security mode) | 503 — not ready to serve |
| 4 | **[TST-CORE-665]** `/readyz` failure: db deadlocked | `GET /readyz` when SQLite locked | `PingContext` times out → 503 |
| 5 | **[TST-CORE-666]** Zombie detection | `/healthz` → 200, `/readyz` → 503 | Container alive but useless — Docker restarts after 3 consecutive failures |
| 6 | **[TST-CORE-667]** `/healthz` unauthenticated | No auth header | 200 — liveness probes must not require auth |
| 7 | **[TST-CORE-668]** `/readyz` unauthenticated | No auth header | 200 — readiness probes must not require auth |

### 20.2 Docker Healthcheck Configuration

> Values sourced from docker-compose.yml in ARCHITECTURE.md §17 (Infrastructure).

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-669]** Core healthcheck endpoint: `/healthz` | Inspect docker-compose.yml | `test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8100/healthz"]` |
| 2 | **[TST-CORE-670]** Core healthcheck: interval 60s | Inspect compose | `interval: 60s` — check every 60 seconds (brain+PDS+llama all use 30s) |
| 3 | **[TST-CORE-671]** Core healthcheck: timeout 3s | Inspect compose | `timeout: 3s` — fail if response takes >3s |
| 4 | **[TST-CORE-672]** Core healthcheck: retries 3 | Inspect compose | `retries: 3` — restart after 3 consecutive failures (30s of downtime at 10s interval) |
| 5 | **[TST-CORE-673]** Core healthcheck: start_period 20s | Inspect compose | `start_period: 20s` — grace period for boot |
| 6 | **[TST-CORE-674]** Brain healthcheck: `/healthz` | Inspect compose | `test: ["CMD", "wget", "-q", "--spider", "http://localhost:8200/healthz"]`, `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 15s` |
| 7 | **[TST-CORE-675]** PDS healthcheck: `/xrpc/_health` | Inspect compose | `test: ["CMD", "wget", "-q", "--spider", "http://localhost:2583/xrpc/_health"]`, `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 10s` |
| 8 | **[TST-CORE-676]** llama healthcheck: `/health` | Inspect compose | `test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]`, `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 30s` (model loading ~30-45s) |
| 9 | **[TST-CORE-677]** Why `wget` not `curl` | Inspect container image | Minimal Alpine images include `wget` but not `curl` |
| 10 | **[TST-CORE-678]** `restart: always` on all containers | Inspect compose | All services have `restart: always` — containers restart automatically after any failure or host reboot |
| 11 | **[TST-CORE-679]** Brain `depends_on: core: service_healthy` | Inspect compose | Brain won't start until core healthcheck passes — ensures vault subsystem is ready |
| 12 | **[TST-CORE-680]** Core `depends_on: pds: service_started` | Inspect compose | Core starts after PDS container has started (not necessarily healthy — PDS can take time to load repos) |
| 13 | **[TST-CORE-681]** llama `profiles: ["local-llm"]` | `docker compose up` (no profile flag) | llama container NOT started — only started with `docker compose --profile local-llm up` |

### 20.3 Crash Log Storage

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-682]** Crash traceback stored in identity.sqlite | Brain sends `POST /v1/vault/crash` | Row inserted in `crash_log` table: `{id, timestamp, error, traceback, task_id}` |
| 2 | **[TST-CORE-683]** Crash log table schema | Inspect identity.sqlite | `crash_log(id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp, error TEXT, traceback TEXT, task_id TEXT)` |
| 3 | **[TST-CORE-684]** Crash log encrypted at rest | Inspect crash_log via raw file | Not readable — SQLCipher encrypts entire identity.sqlite |
| 4 | **[TST-CORE-685]** Crash log retention: 90 days | Entries older than 90 days | Watchdog deletes old entries (same retention as audit log) |
| 5 | **[TST-CORE-686]** Crash log queryable | Admin queries "crashes from last week" | `SELECT * FROM crash_log WHERE timestamp > datetime('now', '-7 days')` |
| 6 | **[TST-CORE-687]** Crash log included in backup | `dina export` | crash_log table included in identity.sqlite backup |
| 7 | **[TST-CORE-688]** Admin UI displays crash history | GET `/admin/crashes` | Table of recent crashes with error, timestamp, task_id |
| 8 | **[TST-CORE-914]** Docker compose logging rotation config validated | Inspect docker-compose logging section | Max 10MB, 3 files configured for log rotation |
| 9 | **[TST-CORE-915]** Single watchdog sweep cleans both audit AND crash logs | Trigger watchdog sweep | Both audit_log and crash_log entries older than retention purged in single sweep |
| 10 | **[TST-CORE-916]** System watchdog 1-hour interval: connector liveness, disk, brain health | Watchdog tick fires | Checks connector liveness, disk usage, and brain health in single sweep |
| 11 | **[TST-CORE-917]** Data volume layout matches architecture spec | Inspect /var/lib/dina/ | Directory structure matches architecture: identity.sqlite, vault/*.sqlite, spool/ |

---

## 21. Logging Policy

> All containers emit structured JSON to stdout. No file logs.
> PII MUST NOT reach stdout. Enforced by code review and CI linting.

### 21.1 Structured Logging

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-689]** Go core: `slog` structured JSON | Trigger any core operation | JSON log line: `{"time":"...","level":"...","msg":"...","module":"..."}` |
| 2 | **[TST-CORE-690]** Python brain: `structlog` JSON | Trigger any brain operation | JSON log line to stdout |
| 3 | **[TST-CORE-691]** No file logs | Inspect container filesystems after 24h operation | No log files written anywhere — stdout only |
| 4 | **[TST-CORE-692]** Docker log rotation configured | Inspect daemon.json or compose `logging` | Max 10MB, 3 files — prevents storage exhaustion over years |

### 21.2 PII Exclusion from Logs

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-693]** Vault content never logged | Vault read/write operations | Logs contain item IDs, counts, latency — never email bodies, calendar events, contact details |
| 2 | **[TST-CORE-694]** User queries never logged | Client sends "find emails about my divorce" | Log shows: `{persona: "/personal", type: "fts5", results: 3}` — not the query text |
| 3 | **[TST-CORE-695]** Brain reasoning never logged | Brain assembles nudge | Log shows: `{task_id: "abc", step: 3, duration_ms: 150}` — not reasoning output |
| 4 | **[TST-CORE-696]** NaCl plaintext never logged | Decrypt inbound DIDComm message | Log shows: `{sender_did: "did:key:...", persona: "/social"}` — not message content |
| 5 | **[TST-CORE-697]** Passphrase never logged | Login attempt | Log shows: `{event: "login", ip: "...", success: true}` — not passphrase |
| 6 | **[TST-CORE-698]** API tokens never logged | Service Signature Auth or CLIENT_TOKEN in request | Log shows: `{auth: "brain"}` or `{auth: "client"}` — not token value |

### 21.3 CI Banned Log Patterns

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-699]** CI catches `log.*query=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*query.*='` flagged — zero runtime cost, catches bad habits before merge |
| 2 | **[TST-CORE-700]** CI catches `log.*content=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*content.*='` flagged |
| 3 | **[TST-CORE-701]** CI catches `log.*body=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*body.*='` flagged |
| 4 | **[TST-CORE-702]** CI catches `log.*plaintext=` | Code review / CI pipeline | Pattern `r'log\.\w+\(.*plaintext.*='` flagged |
| 5 | **[TST-CORE-703]** CI catches f-string with user data | Code review / CI pipeline | Pattern `r'log\.\w+\(.*f".*{.*user'` flagged |
| 6 | **[TST-CORE-704]** No spaCy NER on log lines | Code review | PII scrubbing is for data path to cloud LLMs, not log output — wrong layer, expensive, unreliable |

### 21.4 Brain Crash Traceback Safety

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-705]** Brain crash: stdout gets sanitized one-liner | Brain crashes with PII in local vars | Docker logs show: `guardian crash: RuntimeError at line 142` — no traceback, no variable values |
| 2 | **[TST-CORE-706]** Brain crash: full traceback to vault | Same crash | Full `traceback.format_exc()` sent to `POST core:8100/api/v1/vault/crash` — encrypted at rest |
| 3 | **[TST-CORE-707]** Brain catch-all wraps main loop | Inspect `brain/src/main.py` | `try: await guardian_loop() except Exception as e:` — logs type + line to stdout, full trace to vault |
| 4 | **[TST-CORE-708]** Crash handler sends task_id | Brain crashes during task | `current_task_id` included in crash report — correlates with `dina_tasks` for debugging |
| 5 | **[TST-CORE-709]** Crash handler re-raises | After logging + vault write | `raise` called — lets Docker restart policy trigger |
| 6 | **[TST-CORE-929]** Spool file naming uses ULID format | Inspect spool directory after message spool | Files named with ULID — sortable, unique, timestamp-embedded |

---

## 22. PDS Integration (AT Protocol)

> Core signs trust records with user's Ed25519 persona key and writes them
> to the AT Protocol PDS. PDS stores signed Merkle repos — cannot forge records.

### 22.1 Record Signing & Publishing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-710]** Sign attestation record | Brain requests `POST /v1/trust/publish` with attestation payload | Core signs with persona key → writes to PDS as `com.dina.trust.attestation` record |
| 2 | **[TST-CORE-711]** Sign outcome report | Brain requests outcome publication | Core signs with Trust Signing Key (HKDF "dina:trust:v1") → writes to PDS |
| 3 | **[TST-CORE-712]** Lexicon validation | Attestation missing required field (`productCategory`) | Core rejects before signing — schema enforced |
| 4 | **[TST-CORE-713]** Record in Merkle repo | Inspect PDS after publish | Record stored in signed Merkle tree — tamper-evident |
| 5 | **[TST-CORE-714]** PDS connection failure | PDS container down | Core queues record in outbox for retry — record not lost |
| 6 | **[TST-CORE-715]** Type B: bundled PDS (default) | docker-compose default | Core writes directly to `pds:2583` container on internal network |
| 7 | **[TST-CORE-716]** Type A: external PDS | Home Node behind CGNAT | Core pushes signed commit to external PDS via outbound HTTPS |
| 8 | **[TST-CORE-717]** Rating range enforcement (0-100) | Attestation with `rating: 101` | Core rejects before signing — Lexicon schema enforces `"minimum": 0, "maximum": 100`. Also test: `rating: -1` → rejected, `rating: 0` → accepted, `rating: 100` → accepted |
| 9 | **[TST-CORE-718]** Verdict is structured object with sub-scores | Attestation with `verdict: "good"` (plain string) | Core rejects — `verdict` must be a `#verdictDetail` ref (object with sub-scores like `build_quality`, `lumbar_support`, `value_for_money`, `durability_estimate`). Also test: valid object → accepted |
| 10 | **[TST-CORE-719]** All 5 required Lexicon fields validated | Attestation missing each field one at a time | Core rejects if ANY of the 5 required fields is missing: `expertDid` (did format), `productCategory` (string), `productId` (string), `rating` (integer 0-100), `verdict` (ref object). Test each omission independently |

### 22.2 Signed Tombstones (Deletion)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-720]** Author deletes own record | User requests deletion of review | Core generates `Tombstone {target, author, sig}` signed by same key → PDS deletes record |
| 2 | **[TST-CORE-721]** Non-author deletion rejected | External request to delete someone else's record | Signature doesn't match author → rejected |
| 3 | **[TST-CORE-722]** Tombstone propagation | Tombstone published to PDS | Relay distributes tombstone to all federated AppViews |
| 4 | **[TST-CORE-723]** Deleted record absent from queries | Record deleted via tombstone | AppView no longer returns record — aggregate scores recomputed without it |
| 5 | **[TST-CORE-918]** `com.dina.trust.bot` and `com.dina.trust.membership` Lexicons validated | Bot/membership Lexicon records | Schema validation passes for bot and membership Lexicon types |
| 6 | **[TST-CORE-919]** Outcome data schema validation (reporter_trust_ring, outcome, satisfaction) | Outcome record payload | Required fields validated: reporter_trust_ring, outcome, satisfaction, issues |
| 7 | **[TST-CORE-920]** Attestation optional fields URI format (sourceUrl, deepLink) | Attestation with sourceUrl and deepLink | URI format validated for optional URL fields |
| 8 | **[TST-CORE-921]** Trust query response includes signed payloads | Query trust endpoint | Response payloads include Ed25519 signatures |
| 9 | **[TST-CORE-922]** DID Document contains DIDComm service endpoint | Resolve DID Document | Service array includes DIDComm endpoint for D2D communication |
| 10 | **[TST-CORE-923]** Outcome and Bot Lexicon signing and validation | Sign outcome/bot Lexicon record | Record signed with Trust Signing Key, signature verifiable |
| 11 | **[TST-CORE-924]** PDS Type A: fallback to external HTTPS push | PDS unreachable on internal network | Fallback to outbound HTTPS push to external PDS |

---

## 23. Portability & Migration

### 23.1 Export Process

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-724]** `dina export` produces encrypted archive | Run on populated instance | `.dina` archive (encrypted tar.gz with Argon2id → AES-256-GCM) |
| 2 | **[TST-CORE-725]** WAL checkpoint before export | Active vault with pending WAL | `PRAGMA wal_checkpoint(TRUNCATE)` on all open databases before archiving |
| 3 | **[TST-CORE-726]** Archive contains correct files | Inspect archive contents | identity.sqlite, vault/*.sqlite, keyfile (convenience only), config.json, manifest.json |
| 4 | **[TST-CORE-727]** manifest.json contents | Inspect manifest | Contains: version, export timestamp, SHA-256 checksums per file |
| 5 | **[TST-CORE-728]** Export excludes Service Signature Auth | Inspect archive | Service Signature Auth not present (per-machine, regenerated by install.sh) |
| 6 | **[TST-CORE-729]** Export excludes CLIENT_TOKEN hashes | Inspect archive | `device_tokens` table excluded — devices re-pair on new machine |
| 7 | **[TST-CORE-730]** Export excludes passphrase | Inspect archive | Passphrase not stored — archive encrypted *with* it, not *containing* it |
| 8 | **[TST-CORE-731]** Export excludes PDS data | Inspect archive | No PDS repo data — PDS re-syncs from relay via AT Protocol |
| 9 | **[TST-CORE-732]** Export excludes Docker secrets | Inspect archive | No `/run/secrets/` contents — regenerated by install.sh |
| 10 | **[TST-CORE-733]** Export while vault locked | Security mode, vault locked | Export still works — files are encrypted on disk, no DEK needed |
| 11 | **[TST-CORE-734]** Database writes resumed after export | Export completes | WAL writes resume, no data loss during export window |

### 23.2 Import Process

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-735]** Import prompts for passphrase | Run `dina import` | Passphrase prompted → Argon2id → decrypt archive |
| 2 | **[TST-CORE-736]** Import with wrong passphrase | Incorrect passphrase | AES-256-GCM decryption fails, import aborted |
| 3 | **[TST-CORE-737]** Import verifies checksums | Valid archive | manifest.json checksums verified against restored files |
| 4 | **[TST-CORE-738]** Import detects corruption | Corrupted archive (flipped bits) | Checksum mismatch → import aborted |
| 5 | **[TST-CORE-739]** Import checks version compatibility | Archive from incompatible version | Rejected with "incompatible archive version" error |
| 6 | **[TST-CORE-740]** Import runs integrity_check | After restoring .sqlite files | `PRAGMA integrity_check` on each database — all pass |
| 7 | **[TST-CORE-741]** Import integrity_check failure | Archive with corrupted .sqlite | integrity_check fails → import aborted, files cleaned up |
| 8 | **[TST-CORE-742]** Import prompts for re-pairing | Successful import | User notified: "Re-pair your devices (6-digit code) and re-configure OpenClaw" |
| 9 | **[TST-CORE-743]** Imported DID matches original | Compare DID pre-export vs post-import | Identical `did:key` — identity preserved across migration |
| 10 | **[TST-CORE-744]** Import on fresh instance | No existing data | Clean restore, all personas and vault items present |
| 11 | **[TST-CORE-745]** Import on instance with existing data | Import when vault already populated | Rejected (or merge with explicit `--force` flag) — no silent overwrite |
| 12 | **[TST-CORE-746]** Import rejects tampered archive | Modified bytes in archive | Integrity error — import aborted |

### 23.3 Cross-Host Migration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-747]** Managed → self-hosted VPS | Export on managed, import on VPS | Identical functionality, all data accessible |
| 2 | **[TST-CORE-748]** Raspberry Pi → Mac Mini | Export on Pi, import on Mac | Same archive, same command, any hardware |
| 3 | **[TST-CORE-749]** Same Docker image across hosting levels | Build once, deploy to managed/VPS/sovereign | Identical startup behavior and API responses |
| 4 | **[TST-CORE-750]** Migration preserves vault search | Export with 10K items → import → search | FTS5 + sqlite-vec results identical post-migration |
| 5 | **[TST-CORE-925]** Import/restore invalidates all device tokens, forces re-pair | Import archive on new machine | All existing device tokens invalidated, devices must re-pair |

---

## 24. Deferred (Phase 2+)

> These scenarios depend on features not yet implemented. Include in active test
> suite when the corresponding phase ships.

### 24.1 ZKP Trust Rings (Identity Verification)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-751]** Ring 1 — Unverified Dina | New DID, no verification | Trust level: `unverified`, very low trust ceiling, small interactions only |
| 2 | **[TST-CORE-752]** Ring 2 — Verified Human (ZKP) | User proves valid government ID via ZKP circuit | Proof that "this is a valid, unique ID number" without revealing number — Sybil prevention |
| 3 | **[TST-CORE-753]** Ring 2 — Phase 1 compromise | Aadhaar e-KYC XML with offline verification | Processed locally on-device, only yes/no attestation stored — not full ZKP (UIDAI doesn't offer ZKP-native API) |
| 4 | **[TST-CORE-754]** Ring 2 — one ID = one verified Dina | Attempt second verification with same government ID | Rejected — prevents Sybil attacks |
| 5 | **[TST-CORE-755]** Ring 3 — Skin in the Game | W3C Verifiable Credentials from LinkedIn, GitHub, business registration | Each credential adds trust weight, reveals only what user chooses |
| 6 | **[TST-CORE-756]** Trust Score formula | Compute trust score | `f(ring_level, time_alive, transaction_anchors, outcome_data, peer_attestations, credential_count)` — composite function |
| 7 | **[TST-CORE-757]** Trust level affects sharing/routing | Unverified contact vs Verified contact | Different default sharing policies applied |

### 24.2 HSM / Secure Enclave Key Generation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-758]** Key generation uses Secure Enclave (iOS) | iOS device setup | Private key generated inside Secure Enclave, never exported |
| 2 | **[TST-CORE-759]** Key generation uses StrongBox (Android) | Android device setup | Private key generated inside StrongBox Keymaster |
| 3 | **[TST-CORE-760]** Key generation uses TPM (desktop) | Desktop/server setup | Private key generated via TPM 2.0 |
| 4 | **[TST-CORE-761]** Fallback: software entropy | No HSM available | `crypto/rand` from OS entropy pool — secure but not hardware-isolated |

### 24.3 Tier 5 Deep Archive (Cold Storage)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-762]** Archive encrypted with Archive Key | Create Tier 5 snapshot | AES-256-GCM with `HKDF("dina:archive:v1")` key — separate from Backup Key |
| 2 | **[TST-CORE-763]** Archive contains Tier 0 + 1 + 3 (NOT Tier 2 or 4) | Inspect archive contents | identity.sqlite (Tier 0) + all persona vaults (Tier 1) + trust/preferences (Tier 3). Tier 2 (index/embeddings) explicitly ABSENT — regenerable from Tier 1. Tier 4 (staging) explicitly ABSENT — ephemeral. Verify by listing archive entries: no embedding tables, no staging tables, no sqlite-vec data |
| 3 | **[TST-CORE-764]** Weekly frequency (configurable) | Check schedule | Default weekly, configurable via config.json |
| 4 | **[TST-CORE-765]** S3 Glacier + Compliance Mode Object Lock | Push to S3 | Object locked — even root user / cloud support cannot delete during retention period |
| 5 | **[TST-CORE-766]** Sovereign: USB/LTO tape | Push to local drive | Physically unplugged after backup — air-gapped |
| 6 | **[TST-CORE-767]** Archive useless without keys | Attacker obtains archive blob | Encrypted blobs — cannot decrypt without master seed |

### 24.4 ZFS/Btrfs File System Snapshots

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-768]** Auto-snapshot every 15 minutes | ZFS on `/var/lib/dina/vault/` | Copy-on-write snapshots — instant, near-zero space cost |
| 2 | **[TST-CORE-769]** Snapshot retention policy | Inspect schedule | 24h of 15-min, 7 days of hourly, 30 days of daily |
| 3 | **[TST-CORE-770]** `zfs rollback` recovery | Corruption detected | `zfs rollback dina/vault@15min_ago` — instant revert |
| 4 | **[TST-CORE-771]** Managed hosting: per-user volumes | Two users on same host | `/var/lib/dina/users/<did>/vault/` — separate ZFS datasets |

### 24.5 Client Cache Sync

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-772]** Phone: recent 6 months cached | Inspect phone vault cache | Only last 6 months of data, encrypted with Client Sync Key |
| 2 | **[TST-CORE-773]** Laptop: configurable cache size | Set cache to "everything" | Full vault replica (or subset) |
| 3 | **[TST-CORE-774]** Thin client: no local cache | Inspect thin client | Zero vault data stored locally — WS relay only |
| 4 | **[TST-CORE-775]** Cache encrypted with Sync Key | Inspect cache on device | Encrypted with `HKDF("dina:sync:v1")` — not raw DEKs |
| 5 | **[TST-CORE-931]** Tier 5 Deep Archive: encrypted snapshot to cold storage with compliance lock | Create Tier 5 archive with compliance lock | Archive encrypted, compliance lock prevents deletion during retention |

---

## 25. Bot Interface

> Dina delegates specialist queries to external bots. Bot queries are sanitized,
> scored, and attribution-validated before results are returned.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-858]** Bot query sanitization: no DID, no medical, no financial in outbound queries | Query containing user DID + medical terms | Sanitized query strips DID and sensitive categories before sending to bot |
| 2 | **[TST-CORE-859]** Bot communication protocol: POST /query schema with bot_signature and attribution | Structured BotQuery payload | Response includes bot_signature and attribution fields per protocol spec |
| 3 | **[TST-CORE-860]** Bot trust scoring: local score tracking, threshold-based routing | Bot with low score | Score tracked locally, queries routed only to bots above threshold |
| 4 | **[TST-CORE-861]** Deep Link attribution validation + penalty for stripping attribution | Bot response with stripped attribution | Attribution validated, penalty applied to bot score for stripping |

---

## 26. Client Sync Protocol

> Checkpoint-based sync between Home Node and client devices.
> Conflict resolution uses last-write-wins. Offline changes queued and replayed.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-862]** Client sends checkpoint, core returns changed items since checkpoint | Client checkpoint=100, server has items 101-105 | Returns items 101-105 with new checkpoint=105 |
| 2 | **[TST-CORE-863]** Real-time vault item push to connected clients via WebSocket | New vault item stored | Push notification sent to all connected sync clients |
| 3 | **[TST-CORE-864]** Conflict resolution: last-write-wins, earlier version logged as recoverable | Two devices update same item | Later write wins, earlier version logged for recovery |
| 4 | **[TST-CORE-865]** Thin client: query via WebSocket, no local cache model | Thin client connects | Queries relayed via WebSocket, no local data stored |
| 5 | **[TST-CORE-866]** Backup scheduling to blob store, configurable frequency | Config: backup_interval=24h, dest=s3 | Backup scheduled at configured frequency to configured destination |
| 6 | **[TST-CORE-867]** New device full sync from zero checkpoint | New device with checkpoint=0 | Full vault contents returned with current checkpoint |
| 7 | **[TST-CORE-868]** Connection drop: client queues changes, syncs on reconnect | Client goes offline, makes changes, reconnects | Offline changes queued and flushed on reconnect |

---

## 27. Digital Estate

> Estate planning with SSS custodian recovery. No Dead Man's Switch — no timer-based
> activation. Estate plan stored in Tier 0 (identity.sqlite).

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-869]** Estate plan stored in Tier 0 (identity.sqlite) | Store estate plan | Plan persisted in identity.sqlite, accessible without persona unlock |
| 2 | **[TST-CORE-870]** Estate recovery: custodian threshold met, per-beneficiary DEK derivation | 3-of-5 custodian shares provided | Master seed reconstructed, per-beneficiary DEKs derived for selective access |
| 3 | **[TST-CORE-871]** No Dead Man's Switch — no timer-based estate activation | Attempt timer-triggered activation | Rejected — estate activation requires explicit custodian action only |
| 4 | **[TST-CORE-872]** Estate `read_only_90_days` access type expires after 90 days | Grant read_only_90_days access | Access expires after 90 days, verified by CheckExpiry |
| 5 | **[TST-CORE-873]** Estate `default_action` enforcement (destroy vs archive) | Estate activated with default_action=destroy | Non-assigned data destroyed per default_action policy |
| 6 | **[TST-CORE-874]** Estate SSS shares reused from identity recovery (same set, not separate) | Compare estate and identity recovery shares | Same SSS share set used for both — no separate estate shares |
| 7 | **[TST-CORE-875]** Estate plan JSON structure validated (trigger, custodians, beneficiaries) | Malformed estate plan JSON | Validation rejects missing required fields |
| 8 | **[TST-CORE-876]** Estate notification list informs contacts on activation | Estate activated | All contacts in notification list receive activation notice |
| 9 | **[TST-CORE-877]** Estate recovery: keys delivered via Dina-to-Dina encrypted channel | Estate activated, keys delivered | Keys sent via D2D encrypted transport, not plaintext |
| 10 | **[TST-CORE-878]** Estate recovery: non-assigned data destroyed per default_action | Estate activated with unassigned personas | Unassigned persona data destroyed or archived per policy |
| 11 | **[TST-CORE-879]** Estate recovery: no timer trigger exists in codebase | Code audit for timer/cron-based activation | Zero timer-based activation code paths — manual custodian-only |

---

## 28. CLI Request Signing (Ed25519)

> Stateless asymmetric auth: CLI signs every HTTP request with Ed25519.
> Canonical payload: `{METHOD}\n{PATH}\n{TIMESTAMP}\n{SHA256_HEX_OF_BODY}`.
> Headers: `X-DID`, `X-Timestamp`, `X-Signature`.
> 5-minute timestamp window prevents replay. Pairing registers a device's
> public key via multibase encoding. Bearer token remains as fallback.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-880]** Valid Ed25519 signature accepted (POST with body) | Signed POST /v1/vault/store with correct key | TokenClient + device identity returned |
| 2 | **[TST-CORE-881]** Valid signature with empty body (GET) | Signed GET /v1/devices with empty body | Accepted — SHA-256 of empty bytes used |
| 3 | **[TST-CORE-882]** Invalid signature rejected (garbage bytes) | 64 zero bytes as signature | Rejected — ed25519.Verify fails |
| 4 | **[TST-CORE-883]** Wrong signing key rejected | Request signed with different Ed25519 key | Rejected — key mismatch |
| 5 | **[TST-CORE-884]** Tampered body rejected | Body changed after signing | Rejected — body hash mismatch |
| 6 | **[TST-CORE-885]** Tampered path rejected | Path changed from /v1/vault/store to /v1/vault/delete | Rejected — canonical payload differs |
| 7 | **[TST-CORE-886]** Tampered method rejected | Method changed from POST to PUT | Rejected — canonical payload differs |
| 8 | **[TST-CORE-887]** Expired timestamp (>5 min) rejected | Timestamp 6 minutes in the past | Rejected — outside 5-min window |
| 9 | **[TST-CORE-888]** Future timestamp (>5 min) rejected | Timestamp 6 minutes in the future | Rejected — outside 5-min window |
| 10 | **[TST-CORE-889]** Timestamp within 5-min window accepted | Timestamp 4 minutes ago | Accepted — within tolerance |
| 11 | **[TST-CORE-890]** Invalid timestamp format rejected | "2026-02-24 10:18:22" (space, no Z) | Rejected — parse error |
| 12 | **[TST-CORE-891]** Unknown DID rejected | did:key:zUnknownDeviceDID... | Rejected — no registered key |
| 13 | **[TST-CORE-892]** Revoked device DID rejected | Previously registered then revoked DID | Rejected — "revoked" error |
| 14 | **[TST-CORE-893]** Malformed signature hex rejected | "not-valid-hex!!!" | Rejected — hex decode error |
| 15 | **[TST-CORE-894]** Pairing with Ed25519 key succeeds | GenerateCode → CompletePairingWithKey | Non-empty device ID and node DID |
| 16 | **[TST-CORE-895]** Pairing with invalid code rejected | CompletePairingWithKey with "invalid-code" | Error returned |
| 17 | **[TST-CORE-896]** Pairing with invalid multibase rejected | Missing z prefix in public_key_multibase | Error returned |
| 18 | **[TST-CORE-897]** Pairing code single-use enforced | Use same code twice with different keys | Second attempt rejected |
| 19 | **[TST-CORE-898]** Paired device appears in device list | CompletePairingWithKey → ListDevices | Device found with correct name, not revoked |
| 20 | **[TST-CORE-899]** Bearer fallback when no X-DID headers | Bearer token auth (no signature headers) | Accepted via existing token auth |

---

## 29. Adversarial & Security (Behavioral)

> These tests exercise failure paths, rejection conditions, and security boundaries
> using real crypto implementations (Ed25519, NaCl, X25519, HKDF, SLIP-0010).
> They verify that the system rejects malformed, spoofed, or adversarial inputs.

### 29.1 Transport Signature Verification

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-934]** SendMessage stores Ed25519 signature in outbox | Send message → check outbox entry | Sig field non-empty, status delivered |
| 2 | **[TST-CORE-935]** Valid signature accepted on receive | Signed+encrypted envelope from known sender | Decrypted message returned, no error |
| 3 | **[TST-CORE-936]** Wrong signature rejected (wrong signer key) | Envelope signed with recipient's key, not sender's | ErrInvalidSignature |
| 4 | **[TST-CORE-937]** Tampered ciphertext rejected (bit flip) | Flip byte in ciphertext after signing | Decryption failure |
| 5 | **[TST-CORE-938]** Empty signature passes (backward compatibility) | Envelope with Sig="" | Message accepted (legacy compat) |

### 29.2 Outbox Retry & Queue Limits

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-939]** ProcessOutbox delivers pending messages | Pending message + working deliverer | Status becomes delivered |
| 2 | **[TST-CORE-940]** Delivery failure marks message failed | Deliverer returns error | Status becomes failed |
| 3 | **[TST-CORE-941]** Retry after transient failure succeeds | Fail → Requeue → Fix deliverer → ProcessOutbox | Message delivered on 2nd attempt |
| 4 | **[TST-CORE-942]** Unresolvable DID marked failed | Unknown DID in outbox message | MarkFailed called, no pending |
| 5 | **[TST-CORE-943]** No deliverer marks all failed | ProcessOutbox with nil deliverer | All messages marked failed |
| 6 | **[TST-CORE-944]** Context cancellation stops ProcessOutbox | Cancel ctx immediately | Returns context.Canceled |
| 7 | **[TST-CORE-945]** Queue limit enforced (reject when full) | Fill outbox to MaxQueue, send one more | Error containing "full" |
| 8 | **[TST-CORE-946]** Retry count increments across attempts | Fail 3 times with requeue between each | ≥4 delivery attempts total |

### 29.3 Ingress 3-Valve Defense

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-947]** IP rate limit rejects excess requests | 5 req/min limit, send 6th | 6th request rejected |
| 2 | **[TST-CORE-948]** Router.Ingest rejects flood via ErrRateLimited | 3 req/min limit, send 4th | ErrRateLimited returned |
| 3 | **[TST-CORE-949]** Dead drop stores when vault locked | Ingest while vault locked | Dead drop count=1, inbox empty |
| 4 | **[TST-CORE-950]** Inbox spools when vault unlocked | Ingest while vault unlocked | Inbox has 1 item, dead drop empty |
| 5 | **[TST-CORE-951]** Spool full rejects new messages (Valve 2) | Fill to 2-blob cap, send 3rd | ErrSpoolFull |
| 6 | **[TST-CORE-952]** Sweeper processes dead drop blobs | Store 2 blobs, run Sweep | 2 swept |
| 7 | **[TST-CORE-953]** ProcessPending sweeps + drains inbox | Ingest 2 while locked, ProcessPending | ≥2 processed |
| 8 | **[TST-CORE-954]** Oversized payload rejected (>256KB) | Payload of 256KB+1 byte | Error returned |
| 9 | **[TST-CORE-955]** SweepFull returns detailed results | 1 valid + 1 empty blob | Processed=2, Delivered≥1 |

### 29.4 Replay & DID Spoofing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-956]** Replayed message (same ID) detected | Send same envelope twice, check inbox | Duplicate msg_id in inbox (app-layer dedup needed) |
| 2 | **[TST-CORE-957]** DID spoofing rejected (FromKID mismatch) | Envelope claiming sender A, signed by B | ErrInvalidSignature |

### 29.5 Prompt Injection Safety

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-958]** SQL injection in message body safely deserialized | `'; DROP TABLE users; --` in Body | Body preserved byte-for-byte |
| 2 | **[TST-CORE-959]** JSON escape injection safely deserialized | Escaped quotes attempting field injection | Body preserved byte-for-byte |
| 3 | **[TST-CORE-960]** Oversized field in body safely deserialized | 10KB repeated "A" in Body | Body preserved byte-for-byte |
| 4 | **[TST-CORE-961]** Null bytes in body safely deserialized | Embedded \x00 in Body | Body preserved byte-for-byte |
| 5 | **[TST-CORE-962]** Nested JSON in body safely deserialized | Deeply nested JSON string in Body | Body preserved byte-for-byte |
| 6 | **[TST-CORE-963]** HTML/XSS in body safely deserialized | `<script>` tag in Body | Body preserved byte-for-byte |

### 29.6 HKDF & Key Derivation Isolation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-964]** Cross-persona DEK isolation (5 personas) | Same seed, 5 persona names | All 10 pairs produce different DEKs |
| 2 | **[TST-CORE-965]** User salt uniqueness | Same seed+persona, different salts | Different DEKs |
| 3 | **[TST-CORE-966]** HKDF determinism | Same inputs twice | Identical DEKs |
| 4 | **[TST-CORE-967]** KeyDeriver persona DEK isolation | DerivePersonaDEK for 3 personas | All DEKs distinct |
| 5 | **[TST-CORE-968]** Signing key index independence | DeriveSigningKey at index 0, 1, 2 | Different keys, cross-verification fails |

### 29.7 SLIP-0010 Path Enforcement

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-969]** Non-hardened path rejected | `m/9999/0` (no apostrophe) | Error: only hardened allowed |
| 2 | **[TST-CORE-970]** BIP-44 purpose 44' forbidden | `m/44'/0'` | Error: forbidden in Dina |
| 3 | **[TST-CORE-971]** Sibling hardened path unlinkability | `m/9999'/1'/0'/0'` vs `m/9999'/1'/1'/0'` | Different keys, cross-sig verification fails |

### 29.8 BIP-39 Recovery Safety

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-972]** Invalid checksum rejected | Corrupt last word of valid mnemonic | Validation error |
| 2 | **[TST-CORE-973]** Wrong word count rejected (12 vs 24) | 12-word mnemonic | Error: expected 24 words |
| 3 | **[TST-CORE-974]** Deterministic seed derivation | Same mnemonic → ToSeed twice | Identical 64-byte seeds |

### 29.9 Persona Gatekeeper & Vault Access

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-975]** Locked persona denied despite gatekeeper allow | CheckAccess for locked persona | Decision.Allowed=false |
| 2 | **[TST-CORE-976]** Locked persona denial audited | CheckAccess for locked persona | Audit entry with persona+requester |
| 3 | **[TST-CORE-977]** Egress denied and audited | EnforceEgress to untrusted DID | allowed=false, audit entry, notification |

### 29.10 Sharing Policy Egress Enforcement

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-978]** Missing policy category denied (default deny) | Payload with "health" but policy only has "location" | health in Denied list |
| 2 | **[TST-CORE-979]** Tier "none" blocks category | Policy health=none | health in Denied list |
| 3 | **[TST-CORE-980]** No policy for contact → all categories denied | Unknown contact DID | All categories denied |
| 4 | **[TST-CORE-981]** Malformed payload (non-TieredPayload) denied | Raw string instead of TieredPayload | Category denied |

## 30. Test System Quality & Infrastructure

> Covers meta-quality of the test system itself: strict-real enforcement,
> contract fidelity, authz bootstrapping, known-bad elimination, traceability,
> CI gates, and data isolation. Based on test_issues.txt code review (2026-02-25).

### 30.1 Strict-Real Mode Enforcement (test_issues #1)

> Status: STRUCTURAL FIX REQUIRED. Real integration/E2E suites silently
> fall back to mocks when real APIs fail, masking regressions.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-982]** `DINA_STRICT_REAL=1` fails on any real API fallback | Set env, run real suite with broken API | Test fails immediately (no mock fallback) |
| 2 | **[TST-CORE-983]** `real_clients.py _try_request()` raises on non-2xx in strict mode | Strict mode + 500 response from core | Exception raised (not `None` return) |
| 3 | **[TST-CORE-984]** `real_nodes.py _api_request()` raises on failure in strict mode | Strict mode + connection timeout | Exception raised (not `None` return) |
| 4 | **[TST-CORE-985]** Mock side-effects disabled in strict-real suites | Strict mode + real API success | No mock state updated alongside real call |
| 5 | **[TST-CORE-986]** All 45 fallback locations (22+22+1) verified strict | Audit `real_clients.py`, `real_nodes.py`, `real_d2d.py` | Zero silent fallback paths in strict mode |

### 30.2 Authz Boundary Correctness (test_issues #2 — FIXED)

> Status: FIXED. `conftest.py` now uses `CLIENT_TOKEN` for admin endpoints
> and `Service Signature Auth` for brain-internal endpoints. No fallback.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-987]** E2E conftest uses CLIENT_TOKEN for persona create/unlock | Inspect `conftest.py:103-116` | `client_token` used (not `brain_token`) |
| 2 | **[TST-CORE-988]** Integration conftest uses CLIENT_TOKEN for admin setup | Inspect `conftest.py:151` | No `client_token or brain_token` fallback |
| 3 | **[TST-CORE-989]** Docker mode fails fast if CLIENT_TOKEN missing | E2E setup without `client_token` secret | Setup fails with clear error (not silent fallback to brain_token) |
| 4 | **[TST-CORE-990]** Matrix test: every admin endpoint rejects Service Signature Auth | Service Signature Auth on `/v1/persona/*`, `/v1/did/sign`, `/v1/pair/*` | 403 on every admin endpoint |

### 30.3 Core↔Brain Contract Verification (test_issues #3, #4 — FIXED)

> Status: FIXED. Health endpoint corrected to `/healthz`, reason request
> changed to `{"prompt":...}`, TaskEvent uses snake_case JSON tags.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-991]** Contract test runs against real core HTTP router | Real core server + real middleware | Actual HTTP responses (not simulated adapter) |
| 2 | **[TST-CORE-992]** Contract test runs against real brain FastAPI app | Real brain app from `create_app()` | Actual brain responses (not mock server) |
| 3 | **[TST-CORE-993]** Core→Brain: `/healthz` returns 200 with status | Core brainclient health probe | 200 with `{"status":"ok"}` (not `/v1/health`) |
| 4 | **[TST-CORE-994]** Core→Brain: `/api/v1/process` accepts `{task_id, type, payload}` | Core sends process event | Brain accepts snake_case fields |
| 5 | **[TST-CORE-995]** Core→Brain: `/api/v1/reason` accepts `{"prompt":...}` | Core sends reason request | Brain accepts `prompt` (not `query`) |
| 6 | **[TST-CORE-996]** Brain→Core: `/v1/vault/query` with persona+q | Brain queries vault | Core returns items array + pagination |
| 7 | **[TST-CORE-997]** Brain→Core: `/v1/pii/scrub` with text body | Brain scrubs text | Core returns scrubbed text + replacement map |
| 8 | **[TST-CORE-998]** JSON schema frozen: golden request/response examples | Compare against golden fixtures | Exact field names, types, status codes match |

### 30.4 Brain Composition Testing (test_issues #5)

> Status: OPEN. Brain API tests bypass `create_app()` composition.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-999]** `create_app()` boot smoke under minimal env | Minimal env (no optional providers) | App starts without crash |
| 2 | **[TST-CORE-1000]** Degraded startup: missing spaCy model | spaCy `en_core_web_sm` absent | App starts with scrubber=None, warning logged |
| 3 | **[TST-CORE-1001]** `/healthz` component status correctness | Health probe after degraded startup | Reports actual component availability |

### 30.5 Known-Bad Behavior Elimination (test_issues #6, #11 — FIXED)

> Status: FIXED. `send_d2d` uses base64-encoded JSON, health endpoint uses
> `/healthz`, authz tokens separated, wiring tests aligned.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1002]** `send_d2d` produces valid JSON (no bytes-in-JSON) | Call `send_d2d` with payload | Request body is valid JSON (base64-encoded, not `.encode()` bytes) |
| 2 | **[TST-CORE-1003]** `wiring_test.go` mock brain serves `/healthz` | Inspect test server routes | `/healthz` (not `/v1/health`) |
| 3 | **[TST-CORE-1004]** `brainclient_test.go` health tests use `/healthz` | Inspect health watchdog tests | Endpoint is `/healthz` |
| 4 | **[TST-CORE-1005]** No `client_token or brain_token` fallback in any conftest | Grep all conftest files | Zero instances of token fallback logic |
| 5 | **[TST-CORE-1006]** Negative assertions for old contracts | `/v1/health` on brain → 404, `query` key in reason → 422 | Old/invalid contracts explicitly rejected |

### 30.6 Data Isolation & Cleanup (test_issues #7)

> Status: OPEN. Stale data leakage masked by mock `_item_map` filtering.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1007]** Hard cleanup per test class in real suites | Real suite with 3 test classes | Each class starts with clean vault state |
| 2 | **[TST-CORE-1008]** Dirty state detector fails on prior-run artifacts | Run tests twice without cleanup | Second run detects and fails on stale data |
| 3 | **[TST-CORE-1009]** Real delete APIs used (not visibility filtering) | Delete via real API in cleanup | Items physically removed (not hidden in mock map) |

### 30.7 Traceability Pipeline (test_issues #8)

> Status: OPEN. `verify_tests.py` measures ID presence, not runtime execution.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1010]** Manifest `total` counts match actual test counts | Parse manifests | `total` field > 0 and matches collected test count |
| 2 | **[TST-CORE-1011]** `pytest --collect-only` maps to plan IDs | Collect integration tests | Every collected test maps to a TST-* ID |
| 3 | **[TST-CORE-1012]** `go test -list` maps to plan IDs | List core tests | Every listed test maps to a TST-CORE-* ID |
| 4 | **[TST-CORE-1013]** CI validates manifest totals are non-zero | CI pipeline | Build fails if any manifest `total` is 0 |

### 30.8 CI Pipeline Gates (test_issues #9)

> Status: OPEN. Default `make test` only runs unit tests; no integration/E2E.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1014]** CI stage: `unit-core` | `go test ./...` | All Go unit tests pass |
| 2 | **[TST-CORE-1015]** CI stage: `unit-brain` | `pytest brain/tests/` | All Python unit tests pass |
| 3 | **[TST-CORE-1016]** CI stage: `contract-core-brain` | Strict real contract tests | Core↔Brain API contracts verified |
| 4 | **[TST-CORE-1017]** CI stage: `integration-real` | Docker-based strict real | Integration tests pass with no mock fallback |
| 5 | **[TST-CORE-1018]** CI stage: `e2e-smoke-real` | Critical path E2E | D2D messaging, vault CRUD, PII scrub verified |

### 30.9 Legacy Test Separation (test_issues #10)

> Status: OPEN. Top-level `tests/test_*.py` target legacy `dina.*` modules.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1019]** Legacy tests in explicit profile | `pytest -m legacy` | Only legacy tests run |
| 2 | **[TST-CORE-1020]** Default pipeline excludes legacy tests | `make test` | Legacy tests not executed in v0.4 quality gates |
| 3 | **[TST-CORE-1021]** Compatibility tests labeled explicitly | Inspect test markers | Required compat tests have `@pytest.mark.compat` |

### 30.10 Security Boundary Real Tests (test_issues #12)

> Status: ENHANCED by E2E suite. D2D messaging, authz matrix, and persona
> isolation verified in Docker multi-node tests.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1022]** Service Signature Auth denied on all admin endpoints (real HTTP) | Real core HTTP server | 403 on every admin endpoint with Service Signature Auth |
| 2 | **[TST-CORE-1023]** CLIENT_TOKEN denied on brain-internal endpoints (real HTTP) | Real brain FastAPI | 403 on `/api/v1/process` with CLIENT_TOKEN |
| 3 | **[TST-CORE-1024]** Locked persona: dead-drop ingress, no reads (real) | Real vault in locked state | Messages spooled, reads return 403 |
| 4 | **[TST-CORE-1025]** Draft-don't-send: no direct send path from brain | Code audit + real test | Brain creates drafts only (no `messages.send`) |
| 5 | **[TST-CORE-1026]** Egress policy enforcement for all categories (real) | Real core with sharing policies | Each category enforced per policy tier |

### 30.11 Crypto/Identity Cross-Process Tests (test_issues #13)

> Status: ENHANCED by D2D E2E fixes. Cross-node NaCl sign/verify/decrypt
> now works end-to-end in Docker multi-node setup.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1027]** Real cross-node D2D: sign → encrypt → POST → decrypt → verify | Alonso sends to Sancho (4-node Docker) | Message decrypted and signature verified by recipient |
| 2 | **[TST-CORE-1028]** DID resolution + endpoint verification (networked) | Resolve `did:plc:sancho` in Docker network | Service endpoint resolves to correct container |
| 3 | **[TST-CORE-1029]** Key rotation tested with real persistence + restart | Rotate key, restart core, verify | New key active, old key rejected |
| 4 | **[TST-CORE-1030]** Ed25519 → X25519 conversion verified across nodes | Two nodes exchange NaCl sealed messages | Conversion consistent — decrypt succeeds cross-node |

---

## 31. Code Review Fix Verification

> Traceability section mapping each of the 21 code review fixes + 4 E2E D2D
> pipeline fixes to their verification tests. Each fix references the original
> issue number and the test IDs that verify it.

### 31.1 D2D Pipeline Fixes (CR-1, E2E-A through E2E-D)

> **CR-1**: `send_d2d` bytes serialization → base64-encoded JSON.
> **E2E-A**: `DrainSpool` + `onEnvelope` immediate decrypt callback.
> **E2E-B**: `SendMessage` sets `msg.From = senderDID`.
> **E2E-C**: `DINA_OWN_DID` env var added to config.
> **E2E-D**: Immediate decrypt on fast path (no 10s background delay).

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1031]** DrainSpool returns all non-expired payloads | Spool 3 messages, drain | 3 payloads returned, spool empty | E2E-A |
| 2 | **[TST-CORE-1032]** DrainSpool skips expired messages | Spool 1 expired + 1 fresh | Only fresh payload returned | E2E-A |
| 3 | **[TST-CORE-1033]** onEnvelope callback fires on fast-path ingest | Ingest envelope with vault unlocked | Callback invoked with envelope bytes | E2E-A |
| 4 | **[TST-CORE-1034]** SendMessage populates msg.From from senderDID | Set senderDID, send message | `msg.From == "did:plc:alonso"` | E2E-B |
| 5 | **[TST-CORE-1035]** DINA_OWN_DID loaded into Config.OwnDID | `DINA_OWN_DID=did:plc:test` | `cfg.OwnDID == "did:plc:test"` | E2E-C |
| 6 | **[TST-CORE-1036]** Immediate decrypt: no 10s delay for D2D | Send D2D, check inbox immediately | Message in inbox within request cycle | E2E-D |
| 7 | **[TST-CORE-1037]** Cross-node D2D: Alonso → Sancho roundtrip | 4-node Docker E2E | Sancho's inbox contains Alonso's message | CR-1,E2E-* |
| 8 | **[TST-CORE-1038]** Cross-node D2D: Sancho → Alonso roundtrip | 4-node Docker E2E | Alonso's inbox contains Sancho's message | CR-1,E2E-* |
| 9 | **[TST-CORE-1039]** Cross-node D2D: multicast (Alonso → all 3) | 4-node Docker E2E | All 3 recipients have message in inbox | CR-1,E2E-* |

### 31.2 Core↔Brain Contract Alignment (CR-12, CR-13, CR-14)

> **CR-12**: TaskEvent JSON tags (snake_case: `task_id`, `type`, `payload`).
> **CR-13**: Reason request uses `prompt` (not `query`); ReasonResult aligned.
> **CR-14**: Health endpoint changed from `/v1/health` to `/healthz`.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1040]** TaskEvent marshals to `{"task_id":"...","type":"...","payload":{}}` | `json.Marshal(TaskEvent{})` | Snake_case keys in JSON output | CR-12 |
| 2 | **[TST-CORE-1041]** ProcessEventRequest accepts `task_id` field | Brain receives `{task_id: "abc"}` | Parsed successfully (not rejected) | CR-12 |
| 3 | **[TST-CORE-1042]** BrainClient.Reason sends `{"prompt":"..."}` | Capture outbound request | Key is `prompt` (not `query`) | CR-13 |
| 4 | **[TST-CORE-1043]** ReasonResult: `{content, model, tokens_in, tokens_out}` | Unmarshal brain response | All 4 fields populated | CR-13 |
| 5 | **[TST-CORE-1044]** BrainClient health check hits `/healthz` | Capture outbound URL | Path is `/healthz` (not `/v1/health`) | CR-14 |
| 6 | **[TST-CORE-1045]** Circuit breaker tracks `/healthz` failures | 5 `/healthz` failures | Circuit opens (fail-fast mode) | CR-14 |

### 31.3 Vault KV Protocol Fix (CR-2)

> **CR-2**: Core KV endpoint speaks JSON — `{"value":"..."}` in both directions.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1046]** PUT KV with JSON body `{"value":"hello"}` | `PUT /v1/vault/kv/mykey` | Stored, GET returns `{"value":"hello"}` | CR-2 |
| 2 | **[TST-CORE-1047]** GET KV returns JSON `{"value":"..."}` | `GET /v1/vault/kv/mykey` | Content-Type: application/json | CR-2 |
| 3 | **[TST-CORE-1048]** PUT KV with raw body (backward compat) | `PUT /v1/vault/kv/mykey` with raw text | Still works (fallback to raw body) | CR-2 |

### 31.4 Search Fallback Fix (CR-15)

> **CR-15**: Hybrid/semantic search falls back to FTS5 with degradation signal.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1049]** Hybrid query returns FTS5 results (not empty) | `POST /v1/vault/query {mode:"hybrid"}` | Results returned via FTS5 fallback | CR-15 |
| 2 | **[TST-CORE-1050]** Degradation signal in response | Hybrid query without sqlite-vec | `degraded_from: "hybrid"` or `X-Search-Mode: fts5` header | CR-15 |
| 3 | **[TST-CORE-1051]** Semantic query returns FTS5 with degradation flag | `POST /v1/vault/query {mode:"semantic"}` | FTS5 results + degradation indicator | CR-15 |

### 31.5 Contact Routes End-to-End (CR-6)

> **CR-6**: Wire contact directory PUT/DELETE through core → admin UI.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1052]** PUT /v1/contacts/{did} updates contact name | `PUT /v1/contacts/did:plc:sancho {name:"Sancho Panza"}` | Contact name updated in identity.sqlite | CR-6 |
| 2 | **[TST-CORE-1053]** DELETE /v1/contacts/{did} removes contact | `DELETE /v1/contacts/did:plc:sancho` | Contact removed from identity.sqlite | CR-6 |
| 3 | **[TST-CORE-1054]** Admin UI update calls core API (not vault hack) | Admin updates contact | `PUT /v1/contacts/{did}` called (not KV write) | CR-6 |

### 31.6 Config & Startup Fixes (CR-10, CR-14)

> **CR-10**: Default core URL port corrected to 8100.
> Config additions: `DINA_OWN_DID`, `DINA_KNOWN_PEERS`.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1055]** Default brain config core URL is `http://core:8100` | No `DINA_CORE_URL` env | Default port 8100 (not 8300) | CR-10 |
| 2 | **[TST-CORE-1056]** DINA_OWN_DID env var loaded | `DINA_OWN_DID=did:plc:test` | `Config.OwnDID == "did:plc:test"` | E2E-C |
| 3 | **[TST-CORE-1057]** DINA_KNOWN_PEERS parsed into peer registry | `DINA_KNOWN_PEERS=did=url=seed,...` | Peers resolvable in DID resolver | E2E-B |

---

### 31.7 Batch 8 Security Fix Verification

> Ingress pipeline resilience, error sanitization, vault validation, CORS, WebSocket upgrader.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1071]** OnEnvelope error falls back to dead-drop | Envelope with decrypt failure | Spooled to dead-drop, not lost | HIGH-03 |
| 2 | **[TST-CORE-1072]** ProcessPending re-spools on error | Pending message, decrypt fails | Message re-spooled for retry | HIGH-03 |
| 3 | **[TST-CORE-1073]** Complete removes in-flight task | Complete task | Task removed from in-flight set | HIGH-06 |
| 4 | **[TST-CORE-1074]** Sweeper has SetTransport | Sweeper instance | SetTransport method callable | HIGH-13 |
| 5 | **[TST-CORE-1075]** Error sanitization hides internal details | Handler error with stack trace | Response has generic message, no internals | MED-02 |
| 6 | **[TST-CORE-1076]** WS components constructable | Instantiate WS hub/handler | No panics, all components created | MED-07 |
| 7 | **[TST-CORE-1077]** DeleteExpired prunes sentIDs | Outbox with expired messages | sentIDs map cleaned up | MED-08 |
| 8 | **[TST-CORE-1078]** VaultStore rejects oversized item | Item exceeding max size | Error returned | MED-10 |
| 9 | **[TST-CORE-1079]** VaultStore rejects invalid type | Item with unknown type | Error returned | MED-10 |
| 10 | **[TST-CORE-1080]** VaultStoreBatch rejects invalid item | Batch with one invalid item | Error returned | MED-10 |
| 11 | **[TST-CORE-1081]** VaultStore accepts valid types | Items with all valid types | All stored successfully | MED-10 |
| 12 | **[TST-CORE-1082]** CORS wildcard sets * no credentials | `AllowOrigin: "*"` | `Access-Control-Allow-Origin: *`, no credentials | LOW-01 |
| 13 | **[TST-CORE-1083]** CORS whitelist sets credentials | `AllowOrigin: "https://app"` | Origin reflected, credentials allowed | LOW-01 |
| 14 | **[TST-CORE-1084]** CORS wildcard preflight returns 204 | OPTIONS request | 204 No Content | LOW-01 |
| 15 | **[TST-CORE-1085]** WS default upgrader secure by default | Default upgrader | Cross-origin rejected | LOW-02 |
| 16 | **[TST-CORE-1086]** WS InsecureSkipVerify enabled | WithInsecureSkipVerify() | All origins accepted | LOW-02 |
| 17 | **[TST-CORE-1087]** WS WithOriginPatterns configurable | WithOriginPatterns("*.test") | Matching origins accepted | LOW-02 |

### 31.8 D2D Sender Signature Delivery (Fix 11)

> JSON wrapper format {"c": ciphertext, "s": signature} for D2D transport.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1088]** SendMessage delivery is JSON wrapper | Send D2D message | Delivered payload is `{"c":"...","s":"..."}` | Fix-11 |
| 2 | **[TST-CORE-1089]** ProcessInbound JSON wrapper valid sig | Valid wrapper + sig | Message decrypted, sig verified | Fix-11 |
| 3 | **[TST-CORE-1090]** ProcessInbound JSON wrapper tampered sig | Wrapper with bad sig | ErrInvalidSignature | Fix-11 |
| 4 | **[TST-CORE-1091]** ProcessInbound JSON wrapper empty sig | Wrapper with empty "s" | Rejected | Fix-11 |
| 5 | **[TST-CORE-1092]** ProcessInbound raw bytes legacy migration | Raw NaCl + DINA_ALLOW_UNSIGNED_D2D | Accepted with warning | Fix-11 |
| 6 | **[TST-CORE-1093]** ProcessInbound raw bytes legacy rejected | Raw NaCl, no override | Rejected | Fix-11 |
| 7 | **[TST-CORE-1094]** ProcessInbound DID spoofing rejected | Valid wrapper, wrong sender DID | Signature verification fails | Fix-11 |
| 8 | **[TST-CORE-1095]** ProcessOutbox uses JSON wrapper | Outbox retry delivery | Retried payload is JSON wrapper | Fix-11 |
| 9 | **[TST-CORE-1096]** Full roundtrip send and receive with sig | Encrypt+sign→deliver→decrypt+verify | Message intact, sig verified | Fix-11 |

---

## 32. Security Fix Verification (Batch 5)

> Verification tests for the 5 remaining security fixes from the security audit
> (Batch 5): nonce cache, transport retention, per-DID rate, pairing cap, well-known.

### 32.1 Nonce Cache Double-Buffer (SEC-MED-11)

> Replaced O(n) per-request nonce eviction with double-buffer generation rotation.
> Two maps (current/previous), rotated every maxClockSkew interval. Safety valve at 100K entries.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1058]** Replay signature rejected | Same signature submitted twice | Second call returns "replayed signature" error | SEC-MED-11 |
| 2 | **[TST-CORE-1059]** Different signatures accepted | Two requests with different bodies | Both accepted (unique signatures) | SEC-MED-11 |
| 3 | **[TST-CORE-1060]** Double-buffer rotation | Advance clock past maxClockSkew, replay old sig | Rejected (timestamp or nonce — defense in depth) | SEC-MED-11 |
| 4 | **[TST-CORE-1061]** Safety valve under load | 1000+ unique signatures in rapid succession | All accepted, no panics, system functional | SEC-MED-11 |

### 32.2 Inbound Message Hard Cap (SEC-MED-09)

> Added maxInboundMessages = 10,000 cap in StoreInbound with FIFO eviction.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1062]** Inbound cap enforced | Store 100 messages | All stored in order, GetInbound returns 100 | SEC-MED-09 |
| 2 | **[TST-CORE-1063]** Clear inbound works | Store 10 messages, clear | GetInbound returns empty list | SEC-MED-09 |

### 32.3 Per-DID Rate Enforcement (SEC-MED-12)

> Wired CheckDIDRate in onEnvelope callback between ProcessInbound and StoreInbound.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1064]** Per-DID rate isolation | 5 requests each from DID-A and DID-B | Both pass independently (separate counters) | SEC-MED-12 |
| 2 | **[TST-CORE-1065]** Rate limit reset after window | Exhaust DID rate, reset counters | DID passes again after reset | SEC-MED-12 |

### 32.4 Pairing Code Hard Cap (SEC-MED-13)

> Added maxPendingCodes=100, immediate delete on use, background purge goroutine.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1066]** Hard cap enforced | Generate 100 codes, attempt 101st | ErrTooManyPendingCodes on 101st | SEC-MED-13 |
| 2 | **[TST-CORE-1067]** CompletePairing frees slot | Fill to cap, complete one pairing | Can generate one more code | SEC-MED-13 |
| 3 | **[TST-CORE-1068]** Purge frees expired slots | Generate 50 codes with 1ms TTL, wait, purge | 50 purged, new codes can be generated | SEC-MED-13 |
| 4 | **[TST-CORE-1069]** Immediate cleanup on use | Complete pairing, re-attempt same code | "invalid" error (code gone, not "already used") | SEC-MED-13 |

### 32.5 WellKnown Idempotency (SEC-MED-14)

> Handle ErrDIDAlreadyExists as success in /.well-known/atproto-did handler.

| # | Scenario | Input | Expected | Fix |
|---|----------|-------|----------|-----|
| 1 | **[TST-CORE-1070]** WellKnown idempotent | Two consecutive GetATProtoDID calls | Both return same DID, no error | SEC-MED-14 |

---

## 33. Additional Architecture-Review Coverage

### 33.1 Deterministic Identity State

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1106]** DID metadata corruption fails closed on startup path | Corrupt persisted DID metadata | Startup or loader returns error, no generation guess |
| 2 | **[TST-CORE-1107]** Root signing generation persists across restart | Rotate deterministic key, restart | Same generation and path reloaded after restart |
| 3 | **[TST-CORE-1108]** Deterministic rotation rejects non-next-generation key | Caller-supplied wrong public key | Rotation denied with clear error |
| 4 | **[TST-CORE-1109]** PLC derivation branch isolated from persona and service branches | Derive multiple branch families | No branch collision or overlapping output |

### 33.2 Vector Security Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1110]** Unlock hydrates in-memory HNSW from encrypted blobs | Persona unlock | Search index materialized in memory only |
| 2 | **[TST-CORE-1111]** Persona lock destroys HNSW index | Persona lock | In-memory index removed; future search requires rehydrate |
| 3 | **[TST-CORE-1112]** No plaintext vector side files exist | Inspect filesystem after indexing | No mmap or plaintext vector artifact on disk |
| 4 | **[TST-CORE-1113]** Restart rebuilds vector index from SQLCipher data | Restart with stored embeddings | Search works after rebuild, no stale side artifact dependency |

### 33.3 Static Deployment and Security Audits

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1114]** Production compose files use no floating `latest` tags | Code/config audit | No `:latest` in release-facing image refs |
| 2 | **[TST-CORE-1115]** No unexpected public routes beyond documented API surface | Route enumeration | Surface matches docs and existing API contract |
| 3 | **[TST-CORE-1116]** No plaintext vector or index artifact patterns in codebase | Code audit | No mmap or vector side-file storage introduced |

---

## 34. Thesis Invariants — Loyalty

> **"Ranking is attributable, inspectable, explainable. User policy overrides vendor defaults."**
> These tests verify that Core enforces loyalty as an architectural constraint,
> not a policy promise. The kernel must make it impossible — not merely inconvenient
> — for external parties to influence what the user sees, trusts, or acts on.

### 34.1 Recommendation Integrity (Core-Enforced)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1117]** Bot response with sponsored content tagged | Bot returns `{sponsored: true, sponsor: "AcmeCorp"}` | Core preserves sponsorship metadata in vault item — never stripped, always inspectable by user |
| 2 | **[TST-CORE-1118]** Bot response without attribution rejected at ingestion | Bot returns recommendation with no `source_url`, no `creator_name` | Core rejects store: unattributed recommendations cannot enter vault |
| 3 | **[TST-CORE-1119]** Deep link preserved through vault store/retrieve cycle | Bot returns `{deep_link: "https://creator.example/review"}` | After store + retrieve, `deep_link` field intact — creator gets traffic |
| 4 | **[TST-CORE-1120]** Vault item provenance chain immutable after storage | Attempt to PATCH `source_url` or `creator_name` on existing vault item | Rejected — provenance fields are write-once, never updatable |
| 5 | **[TST-CORE-1121]** User sharing policy overrides bot-suggested visibility | Bot suggests `{visibility: "public"}`, user policy says `none` for that contact | Egress gatekeeper enforces user policy — bot suggestion ignored |
| 6 | **[TST-CORE-1144]** Sponsorship has zero ranking weight | Two vault items: A (`sponsored: true`, trust_score 0.6), B (unsponsored, trust_score 0.9) → hybrid search query | B ranks above A — `sponsored` flag is metadata for disclosure only, NEVER a ranking input. Core search scoring ignores it entirely |

### 34.2 Agent Sandbox Adversarial

> A compromised or malicious agent must not be able to escape its sandbox.
> These tests simulate actual attack vectors, not just happy-path delegation.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1122]** Agent attempts cross-persona vault query | Agent DID with access to `/consumer` queries `/health` data | 403 — gatekeeper denies cross-persona access for agent identity |
| 2 | **[TST-CORE-1123]** Agent attempts admin endpoint via service signature | Agent's service key on `POST /v1/did/sign` | 403 — admin endpoints reject service signature auth |
| 3 | **[TST-CORE-1124]** Agent attempts to read other agents' data | Agent A queries vault items stored by Agent B | Empty result — agent-scoped data isolation |
| 4 | **[TST-CORE-1125]** Agent attempts rate limit bypass via concurrent requests | 1000 concurrent requests from same agent DID | Rate limiter enforces per-DID limit — excess requests rejected |
| 5 | **[TST-CORE-1126]** Agent attempts to exfiltrate vault via oversized query | Agent queries with `limit: 999999` | Core caps query results to configured maximum (e.g., 100) |
| 6 | **[TST-CORE-1127]** Agent sends malformed intent to bypass gatekeeper | Intent with missing `action` or `target` fields | Rejected with validation error — no partial processing |
| 7 | **[TST-CORE-1128]** Agent attempts credential harvesting via error messages | Agent sends deliberately malformed requests | Error responses contain no internal state, no key material, no vault metadata |
| 8 | **[TST-CORE-1129]** Agent revocation takes immediate effect | Revoke agent DID → agent sends next request | 401 — revoked agent cannot send any further requests |
| 9 | **[TST-CORE-1130]** Agent cannot escalate from task-scoped to full access | Agent with `scope: ["search"]` attempts `POST /v1/vault/store` | 403 — scope enforcement denies write access |
| 10 | **[TST-CORE-1131]** Agent cannot forge `from_did` in outbound D2D messages | Agent submits D2D message with `from_did` set to user's DID | Core overrides `from_did` with agent's actual DID — impersonation impossible |

---

## 35. Thesis Invariants — Silence First

> **"Never push content. Only speak when asked, or when silence would cause harm."**
> These tests verify that Core's notification pipeline enforces the silence protocol
> at the transport level — independent of Brain's classification.

### 35.1 Core-Enforced Notification Discipline

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1132]** WebSocket push requires explicit priority | `POST /v1/notify` with no `priority` field | Rejected — Core refuses to push without classification |
| 2 | **[TST-CORE-1133]** Engagement-tier notification never pushed via WebSocket | `POST /v1/notify {priority: "engagement"}` | Core queues for briefing — WebSocket push not triggered |
| 3 | **[TST-CORE-1134]** Fiduciary notification pushed even during DND | `POST /v1/notify {priority: "fiduciary"}` while user DND is active | WebSocket push sent — fiduciary overrides DND |
| 4 | **[TST-CORE-1135]** Solicited notification deferred during DND | `POST /v1/notify {priority: "solicited"}` while DND active | Not pushed — deferred until DND ends, not dropped |
| 5 | **[TST-CORE-1136]** Notification rate limiting per client | 50 notifications in 1 second to same WebSocket | Core batches or throttles — client never flooded |
| 6 | **[TST-CORE-1137]** Brain cannot bypass priority classification | Brain calls `POST /v1/notify` with `{force_push: true}` | `force_push` field ignored — Core enforces classification-based routing |

---

## 36. Thesis Invariants — Action Integrity

> **"No agent under the Dina Protocol shall ever press Send."**
> Core enforces action boundaries at the API level. Even a fully compromised
> Brain cannot execute irreversible actions without human approval.

### 36.1 Core-Enforced Action Gates

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1138]** Staging items auto-expire after TTL | Store draft in Tier 4 staging, wait 73 hours | Item deleted — expired drafts never linger |
| 2 | **[TST-CORE-1139]** Staging item cannot be executed without user approval | Brain calls hypothetical `POST /v1/staging/execute` | 404 or 403 — no execute endpoint exists, staging is read-only to Brain |
| 3 | **[TST-CORE-1140]** Approval token single-use | User approves action → approval token used → same token resubmitted | Second use rejected — replay prevention on approval |
| 4 | **[TST-CORE-1141]** Approval expires if not acted on | Generate approval, wait past TTL | Approval token invalid — user must re-review |
| 5 | **[TST-CORE-1142]** Batch approvals require individual consent | Brain submits 10 drafts for approval | Each draft gets separate approval token — no bulk approve without review |
| 6 | **[TST-CORE-1143]** Cart handover intent: no payment credentials stored | After cart handover, inspect all vault tiers | Zero records containing UPI PIN, card number, bank password, or wallet private key |

---

## 37. WS2 — Service Discovery Bridge & Config Gate

> Provider-side contract between the workflow_tasks pipeline and the
> schema-driven service protocol. Failure in these paths means a
> terminated task whose response never reaches the requester, or a
> config that advertises a schema the enforcer disagrees with.

### 37.1 Completion Bridge (service_query_execution tasks)

Traces to: `core/internal/service/workflow.go::bridgeServiceQueryCompletion`
and the `payload_type` column introduced in identity migration v14.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1145]** Happy path — completed execution task bridged to D2D response | Task kind=delegation, payload_type=service_query_execution, state=completed, structured Result matches schema snapshot | `status=success` response sent with original `ttl_seconds`; `service_response_sent` event recorded as durability marker |
| 2 | **[TST-CORE-1146]** Result fails schema validation | Completed task where OpenClaw output is missing a required field from the persisted schema snapshot | `status=error` response with `result.error=result_schema_violation` — malformed agent output never reaches wire as success |
| 3 | **[TST-CORE-1147]** Failed execution task bridges to error response | Task transitions completed→failed via `Workflow.Fail()`; `task.Error` carries provider's message | `status=error` response with `result.error=<task.Error>` (NOT wrapped as `{message:…}` and NOT schema-validated — real failure surfaced directly) |
| 4 | **[TST-CORE-1148]** Reconciler finds Python-serialised tasks | Execution task payload uses Python `json.dumps` default spacing (e.g. `"type": "service_query_execution"` with spaces) | Reconciler filters on indexed `payload_type` column — task is found and re-sent despite spacing differences |
| 5 | **[TST-CORE-1149]** Transport send failure leaves no `service_response_sent` event | Sender callback returns error on first attempt | No durability marker written; sweeper re-bridges on next tick; on success marker is recorded, no duplicate sends |

### 37.2 Service Config Gate (`ServiceConfigService.Put`)

Traces to: `core/internal/service/service_config.go::Put` / `canonicalSchemaHash`.

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CORE-1150]** Valid public config accepted | Public config with capability + JSON-Schema-valid params + result + canonical schema_hash | Put succeeds; Get returns the stored config |
| 2 | **[TST-CORE-1151]** Public capability missing capability_schemas entry | is_public=true, capability declared without a matching capability_schemas key | Put rejects — "public capability %q missing capability_schemas entry" |
| 3 | **[TST-CORE-1152]** Capability schema missing schema_hash | capability_schemas entry with empty SchemaHash | Put rejects — "capability %q missing schema_hash" |
| 4 | **[TST-CORE-1153]** Malformed JSON Schema rejected | Params schema with `"type": 42` (illegal) | Put rejects with schema compile error — a broken schema never reaches the store |
| 5 | **[TST-CORE-1154]** Auto policy without mcp_server/mcp_tool accepted | Capability with `response_policy=auto` and empty MCPServer/MCPTool | Put succeeds — under the new architecture OpenClaw executes from the structured payload; MCP routing is no longer required |

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
