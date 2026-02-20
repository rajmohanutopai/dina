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

### 2.2 SLIP-0010 Ed25519 Hardened Derivation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Derive root identity key | Path `m/9999'/0'` | Deterministic Ed25519 keypair |
| 2 | Derive persona N key | Path `m/9999'/N'` (N=1,2,3...) | Unique keypair per persona index |
| 3 | Determinism | Same seed, same path, two runs | Identical keypair both times |
| 4 | Different paths → different keys | `m/9999'/0'` vs `m/9999'/1'` | Different keypairs |
| 5 | Hardened-only enforcement | Attempt non-hardened path `m/9999/0` | Rejected — only hardened derivation allowed |
| 6 | Known test vectors | SLIP-0010 spec test vectors | Output matches published vectors exactly |

### 2.3 HKDF-SHA256 (Vault DEK Derivation)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Derive per-persona DEK | Master seed + persona ID as info | 256-bit key suitable for SQLCipher |
| 2 | Different personas → different DEKs | Same seed, persona "work" vs "personal" | Different keys |
| 3 | Determinism | Same inputs, two derivations | Identical DEK |
| 4 | Known HKDF test vectors | RFC 5869 test vectors | Output matches |

### 2.4 Argon2id (Passphrase Hashing)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Hash passphrase | "correct horse battery staple" | Argon2id hash with embedded salt |
| 2 | Verify correct passphrase | Correct passphrase + stored hash | Verification passes |
| 3 | Verify wrong passphrase | Wrong passphrase + stored hash | Verification fails |
| 4 | Parameters meet minimum | Inspect hash output | time=3, memory=65536 (64 MiB), threads=4 minimum |
| 5 | Unique salts | Hash same passphrase twice | Different hash outputs (random salt) |

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
| 1 | Generate root DID | First-run | `did:key:z6Mk...` from Ed25519 pubkey, persisted to keystore |
| 2 | Load existing DID | Subsequent startup | Same DID as initial generation |
| 3 | DID Document structure | Resolve own DID | Valid W3C DID Document with `authentication`, `keyAgreement`, service endpoints |
| 4 | Multiple persona DIDs | Create personas "work", "personal" | Different DIDs, each derived from unique SLIP-0010 path |

### 3.2 Persona Management

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Create persona | Name "work", tier "restricted" | New SLIP-0010 derived key, new SQLCipher vault file, persona registered |
| 2 | List personas | GET `/v1/personas` | Array of persona objects with name, DID, tier, created_at |
| 3 | Delete persona | DELETE persona by ID | Vault file securely wiped, keys removed, DID deactivated |
| 4 | Persona isolation | Write to persona A, read from persona B | Data not visible across personas |
| 5 | Default persona exists | After first setup | At least one "default" persona |

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

### 3.4 Contact Directory

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Add contact | DID + display name + trust level | Contact stored with per-persona routing rules |
| 2 | Resolve contact DID | Lookup by display name | Returns DID + current service endpoints |
| 3 | Update contact trust level | Change from Unverified → Verified | Trust level updated, sharing policies may change |
| 4 | Delete contact | Remove by DID | Contact removed, associated sharing policies cleaned |
| 5 | Per-persona contact routing | Contact mapped to persona "work" | Messages from contact route to work persona only |

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

### 4.3 Vault Search (FTS5 + sqlite-vec)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Full-text search | Query "battery life review" | FTS5 results ranked by relevance |
| 2 | Vector similarity search | Embedding vector query | Top-K nearest neighbors from sqlite-vec |
| 3 | Hybrid search | Text + vector combined | Merged results with combined ranking |
| 4 | Empty results | Query with no matches | Empty array, not error |
| 5 | Search across persona boundary | Search persona A data from persona B context | No cross-persona results |
| 6 | FTS5 injection | Query `"*" OR 1=1 --` | Safely handled, no SQL injection |

### 4.4 Scratchpad (Brain Cognitive Checkpointing)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Write scratchpad entry | Task ID + checkpoint JSON | Stored in scratchpad table |
| 2 | Read scratchpad | Task ID | Latest checkpoint for that task |
| 3 | Scratchpad TTL | Entry older than 24 hours | Auto-purged by sweeper |
| 4 | Scratchpad size limit | Entry exceeding max size | Rejected |
| 5 | Crash recovery via scratchpad | Brain restarts mid-task | Brain reads scratchpad, resumes from checkpoint |

### 4.5 Staging Area

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Stage item for review | New item from ingestion | Stored in staging, not main vault |
| 2 | Approve staged item | Admin approves | Moved to main vault |
| 3 | Reject staged item | Admin rejects | Deleted from staging |
| 4 | Auto-approve low-risk items | Item below risk threshold | Automatically promoted to main vault |
| 5 | Staging expiry | Unreviewed items past TTL | Auto-rejected and cleaned up |

### 4.6 Backup

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Online backup | Trigger backup while vault is active | SQLite Online Backup API creates consistent copy |
| 2 | Backup is encrypted | Inspect backup file | SQLCipher-encrypted (not plaintext) |
| 3 | VACUUM INTO not used | Code review / audit | `VACUUM INTO` never called (produces plaintext — CVE) |
| 4 | Backup to different location | Specify backup path | Backup file created at target path |
| 5 | Restore from backup | Replace vault with backup | Data integrity verified, all items present |

### 4.7 Audit Log

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Append audit entry | Action + actor + timestamp | Entry appended, cannot be modified |
| 2 | Append-only enforcement | Attempt UPDATE or DELETE on audit table | Rejected by trigger or constraint |
| 3 | Audit log rotation | Log exceeds 90-day retention | Entries older than 90 days archived/purged per policy |
| 4 | Query audit log | Filter by action type, date range | Correct entries returned |
| 5 | Audit log integrity | Compute hash chain | Each entry's hash includes previous entry hash |

---

## 5. PII Scrubber (Tier 1 — Go Regex)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Scrub email address | "Contact john@example.com" | "Contact [EMAIL_REDACTED]" |
| 2 | Scrub phone number | "Call 555-123-4567" | "Call [PHONE_REDACTED]" |
| 3 | Scrub SSN | "SSN 123-45-6789" | "SSN [SSN_REDACTED]" |
| 4 | Scrub credit card | "Card 4111-1111-1111-1111" | "Card [CC_REDACTED]" |
| 5 | Scrub IP address | "From 192.168.1.1" | "From [IP_REDACTED]" |
| 6 | No PII present | "The weather is nice today" | Unchanged — no redaction |
| 7 | Multiple PII types in one string | "Email john@ex.com, phone 555-1234" | Both redacted |
| 8 | PII at string boundaries | "john@example.com" (entire string) | "[EMAIL_REDACTED]" |
| 9 | Unicode/international formats | "+44 20 7946 0958" (UK phone) | Redacted (configurable patterns) |
| 10 | Performance: large payload | 1 MiB text with scattered PII | Completes within 100ms |

---

## 6. Gatekeeper (Egress / Sharing Policy)

### 6.1 Sharing Policy Enforcement

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Default-deny: no policy exists | Request to share data with unknown contact | Blocked — no data sent |
| 2 | Policy: none | Contact has `sharing: none` for category | No data shared |
| 3 | Policy: summary | Contact has `sharing: summary` | Only LLM-generated summary shared, not raw data |
| 4 | Policy: full | Contact has `sharing: full` | Full data shared (still PII-scrubbed) |
| 5 | Per-contact per-category granularity | Contact A: health=none, work=summary | Health blocked, work summary shared |
| 6 | Policy update | Admin changes policy from none → summary | New requests use updated policy |
| 7 | Outbound PII scrub | Share data with `full` policy | PII scrubber runs before transmission |

### 6.2 Egress Pipeline

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Outbound message construction | Vault data + sharing policy + recipient DID | Correctly scoped payload, PII-scrubbed, encrypted |
| 2 | Recipient DID resolution | Resolve recipient's service endpoint | DID Document fetched, endpoint extracted |
| 3 | Egress audit logging | Any outbound data sharing | Audit entry with recipient, category, tier, timestamp |

---

## 7. Transport Layer

### 7.1 Outbox (Reliable Delivery)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Enqueue message | New outbound message | Persisted in `dina_tasks` table with `pending` status |
| 2 | Successful delivery | Recipient endpoint responds 200 | Task marked `completed`, removed from queue |
| 3 | Delivery failure → retry | Recipient returns 500 | Exponential backoff: 30s → 1m → 5m → 30m → 2h |
| 4 | Max retries exhausted | 5 consecutive failures | Task marked `dead_letter`, notification to owner |
| 5 | 24-hour TTL | Message pending for >24h | Expired, moved to dead letter |
| 6 | Outbox survives restart | Core crashes and restarts | Pending tasks reloaded from SQLite, retried |
| 7 | Idempotent delivery | Same message delivered twice (retry after timeout) | Recipient deduplicates by message ID |
| 8 | Priority ordering | High-priority message queued after low-priority | High-priority sent first |

### 7.2 Inbox (3-Valve Ingress)

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Valve 1: IP rate limit | >100 requests/min from same IP | 429 Too Many Requests |
| 2 | Valve 1: normal traffic | <100 requests/min | Accepted to Valve 2 |
| 3 | Valve 2: spool cap (persona locked) | Message for locked persona, spool < 500MB | Spooled to disk, 202 Accepted |
| 4 | Valve 2: spool cap exceeded | Spool at 500MB limit | 503 Service Unavailable |
| 5 | Valve 3: sweeper on unlock | Locked persona unlocked | Spooled messages processed in order |
| 6 | Valve 3: sweeper ordering | Multiple spooled messages | Processed FIFO by receive timestamp |
| 7 | DID verification on inbound | Message with valid sender DID signature | Accepted |
| 8 | DID verification failure | Message with invalid/missing signature | Rejected with 401 |
| 9 | Unknown sender DID | Message from unresolvable DID | Queued for manual review or rejected per policy |

### 7.3 DID Resolution & Caching

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Resolve known DID | `did:key:z6Mk...` | DID Document returned from network |
| 2 | Cache hit | Second resolution of same DID within TTL | Returned from cache, no network call |
| 3 | Cache expiry | Resolution after cache TTL | Fresh resolution from network |
| 4 | Unresolvable DID | Non-existent DID | Error returned, not cached |
| 5 | Malformed DID | `did:invalid:!!!` | Validation error |

---

## 8. Task Queue

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Enqueue task | Task type + payload + priority | Stored in `dina_tasks` SQLite table |
| 2 | Dequeue next task | Worker polls | Highest-priority, oldest pending task returned |
| 3 | Task completion | Worker marks task done | Status → completed, completion timestamp set |
| 4 | Task failure | Worker reports error | Retry count incremented, re-queued with backoff |
| 5 | Task persistence across restart | Core restarts | All pending tasks still in queue |
| 6 | Concurrent workers | Multiple goroutines dequeuing | No duplicate processing (row-level locking) |
| 7 | Dead letter after max retries | Task fails 5 times | Moved to dead letter, alert generated |
| 8 | Task cancellation | Cancel pending task by ID | Status → cancelled |

---

## 9. WebSocket Protocol

### 9.1 Connection Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Auth frame within 5s | Client sends auth frame with valid CLIENT_TOKEN | Connection upgraded, authenticated |
| 2 | Auth frame timeout | No auth frame within 5s | Connection closed by server |
| 3 | Invalid auth frame | Wrong CLIENT_TOKEN in auth frame | Connection closed with error code |
| 4 | Graceful disconnect | Client sends close frame | Server acknowledges, resources cleaned |
| 5 | Abnormal disconnect | TCP connection drops | Server detects via ping timeout, cleans up |

### 9.2 Message Types

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Query message | `{type: "query", payload: "..."}` | Routed to brain, response returned |
| 2 | Command message | `{type: "command", action: "..."}` | Executed by core, result returned |
| 3 | Whisper (non-streaming) | Brain sends whisper | Client receives complete whisper message |
| 4 | Whisper stream | Brain streams response | Client receives chunked whisper_stream messages |
| 5 | System message | Core status change | Client receives system notification |
| 6 | Ping/Pong keepalive | Ping from either side | Pong response, connection kept alive |
| 7 | Unknown message type | `{type: "foo"}` | Error response, connection not dropped |

### 9.3 Missed Message Buffer

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Client temporarily disconnected | 10 messages arrive during disconnect | Client reconnects, receives up to 50 buffered messages |
| 2 | Buffer overflow | >50 messages during disconnect | Oldest messages dropped, client notified of gap |
| 3 | Buffer ordering | Messages buffered in order | Delivered in original order on reconnect |

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

### 15.1 Health

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Health check | GET `/v1/health` | 200 `{"status": "ok", "brain": "ok"|"degraded"}` |
| 2 | Brain down | GET `/v1/health` when brain unreachable | 200 `{"status": "degraded", "brain": "unreachable"}` |

### 15.2 Vault API

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Store item | POST `/v1/vault/items` + JSON body | 201 Created with item ID |
| 2 | Get item | GET `/v1/vault/items/{id}` | 200 with item JSON |
| 3 | Search | GET `/v1/vault/search?q=...` | 200 with results array |
| 4 | Write scratchpad | PUT `/v1/vault/scratchpad/{task_id}` | 200 |
| 5 | Read scratchpad | GET `/v1/vault/scratchpad/{task_id}` | 200 with checkpoint JSON |

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

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Start pairing | POST `/v1/pair/start` | 200 with 6-digit code |
| 2 | Complete pairing | POST `/v1/pair/complete` + code | 200 with CLIENT_TOKEN |

### 15.6 PII API

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
