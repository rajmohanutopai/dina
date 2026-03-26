
Let me give you a quick overview of what the security model is like. 

We first create a random 256 bit (32 bytes) MASTER SEED . Then we will use a BIP-39 logic to convert it to a 24 word BIP-39 mnemonic (list of words) so that people can take it as backup. This, is the most important data, the root secret. Anyone with this SEED has full access to your data.

Restore is similar, just that user will type in the mnemonic.

The master seed is actually kept within the docker / host (in memory). in disk though, it is kept - but wrapped with KEK (Key Encryption Key).  KEK is created from a different password - which user types in . So, there is master seed and a password both. the password - user has to type it in - but it is much easier because it is not the 24 word thingie - just a single word. the password is the one which we will ask the user to send every time - not the master seed. 

We should not store the password, because then your Master SEED is in risk.

So, the steps are - 
Dina install internally creates master seed and shows to user for safe keeping (after converting to words using BIP-39). Dina also creates the KEK from the password using Argon2id. 
Generate random salt
Argon2id(password, salt) => 32 byte KEK. This is a one way hash and we cannot get the password back from KEK. 

Generate random nonce (for AES-GCM) 
Using KEK and nonce, the master seed is then encrypted using AES-256-GCM algorithm.
Using  AES-256-GCM(KEK, Master Seed, nonce) => wrapped_seed

**Storage**: Only the wrapped_seed, salt, and nonce are stored on disk (and inside the Docker container).

To paraphrase - Master Seed is your identity root. Password / passphrase is the lock/unlock secret for the master seed. You can change your password - it does not matter. It does not change the identity. Changing Master Seed changes the identity.

**The Boot Process**

Let’s walk through what actually happens when the Dina Docker container starts up.

The golden rule here is that the Master Seed never touches the disk in plain text; it is always wrapped. So, during boot, we have to reconstruct it in memory.

Here is the flow: The user provides their password at runtime. We take that password, grab the random salt we saved on disk, and run them through Argon2id. This rebuilds our 32-byte Key Encryption Key (KEK) right there in memory. We then use that KEK, along with a saved nonce, to unwrap the encrypted Master Seed using AES-256-GCM.

At this point, the raw 32-byte Master Seed is securely loaded into isolated memory for the session, ready for derivation.

3. Deriving the Keys (The SLIP-0010 Tree)

With the Master Seed safely in memory, we need to generate our actual operational keys. But as we discussed earlier, we never sign directly with the Master Seed. Instead, we use SLIP-0010 to derive child keys.

Which are the child keys?
1. did:plc (or public DID docuement)
2. node signing key
3. per persona encryption keys
4. backup keys

   Master Seed (32 bytes)
    └─ SLIP-0010 purpose tree (all under m/9999')
    │   ├─ m/9999'/0'/0'      →  Root Ed25519 signing key gen 0
    │   │                          └─ Public key  →  did:plc (identity)
    │   │                          └─ Private key →  IdentitySigner (in memory only)
    │   ├─ m/9999'/1'/0'/0'   →  Consumer persona signing key gen 0
    │   ├─ m/9999'/1'/1'/0'   →  Professional persona signing key gen 0
    │   ├─ m/9999'/1'/N'/0'   →  (scales to thousands of personas)
    │   ├─ m/9999'/2'/0'      →  secp256k1 PLC rotation key gen 0
    │   └─ m/9999'/3'/0'      →  Core service auth key
    └─ HKDF per-persona DEKs (vault encryption)
        ├─ HKDF("personal")   →  Personal Persona DEK
        ├─ HKDF("work")       →  Work Persona DEK
        └─ ...


We use SLIP-0010 algo/tree with hardened (cannot get original back) derivation under purpose `m/9999'`. The top-level branches separate concerns: `0'` for root signing (with generations underneath: `m/9999'/0'/0'` gen 0, `m/9999'/0'/1'` gen 1), `1'` for persona signing keys (with persona index and generation: `m/9999'/1'/<index>'/<gen>'`), `2'` for secp256k1 PLC recovery keys, and `3'` for service auth keys. This design lets personas scale to thousands without ever colliding with root, PLC, or service keys.

A 64-byte Private Key: We immediately wrap this in our IdentitySigner and keep it strictly locked in memory. Its only job is to sign data. 

A 32-byte Public Key: This is what we expose to the world so they can verify our signatures.

Creating the DID (did:plc)
We use AT Proto as the base for our network. 
AT Proto has a did:plc registry where we store our decentralized identifier, along with the public key.

How do we get a decentralized identifier out of a public key? We take that 32-byte public key, hash it with SHA-256, extract the first 16 bytes, encode it into base58, and prepend did:plc:. That string becomes our permanent public address.

Publishing the DID Document
Finally, we need a way for external parties (other Dinas, or App View etc) to actually find our public key. So, we wrap our public key in a Multikey format (adding a specific Ed25519 prefix) and publish it inside our DID Document. The public key is checked by Relay to validate that it is indeed from the proper did:plc (because did:plc was originally created from public key)

If we change public key, we update the DID document, but our original did:plc remains - that does not change. That is our identity in AT Proto network.

This is not done by us though. We bring up AT Proto's PDS as a separate container
  Core asks PDS to create an account. PDS generates the repo signing key, builds and signs the genesis operation, and publishes the DID document to the PLC Directory. The DID document contains the public key and points back to the PDS as the service endpoint. Core never directly interacts with the PLC Directory for publishing — PDS is the intermediary.


Talking to AT Proto

- Core submits content — calls com.atproto.repo.createRecord via XRPC. Core never signs AT Proto repo commits.
- PDS signs commits — PDS owns a separate repo signing key per account. It maintains the signed Merkle tree. This key is generated during com.atproto.server.createAccount, never by Core. PDS is not our code.
- Core's Ed25519 key is for D2D messaging and DID auth — not for AT Proto repo signing. Different key, different purpose.
- PDS generates its own repo signing key during account creation
- Core's identity key and PDS's repo signing key are separate keys with separate jobs
- Core authenticates to PDS via JWT (from createSession), then submits record content. PDS signs the commit.


**Boundaries and Trust**

Now that we have covered how the Master Seed wakes up and derives the various personas during boot, we need to look at how the moving parts of Dina actually talk to each other.

The core philosophy of Dina's runtime architecture is simple: Core is the public gatekeeper, and Brain is the internal reasoning engine. To make this secure, we divide the system into three strict trust planes.

1. The Three Planes of Trust

Instead of using a single type of password or token for everything, Dina uses specific cryptographic tools depending on where the request is coming from.

The Root Secret Plane: This is the foundation. It is controlled by your Master Seed and your Seed Passphrase. This plane dictates your ultimate cryptographic identity and your ability to decrypt data.

The Client Device Plane: This is how you, as a user, interact with Core from the outside. Every paired device—like your CLI or a future mobile app—generates its own local Ed25519 keypair. The private key never leaves your device. Core only knows the public key.

The Local Privileged Plane: This is how internal services (like the Python Brain talking to the Go Core) authenticate. Each service has its own Ed25519 keypair, derived deterministically from the master seed via SLIP-0010 at install time (`install.sh`). Private keys are isolated by separate Docker bind mounts — Core's private key never exists in Brain's container filesystem and vice versa. On the host, `secrets/service_keys/` is split into `core/` (bind-mounted only to Core as `/run/secrets/service_keys/private`), `brain/` (bind-mounted only to Brain as `/run/secrets/service_keys/private`), and `public/` (bind-mounted to both containers as `/run/secrets/service_keys/public`). Each container sees only its own private key under `private/` and both services' public keys under `public/`. At runtime, services only load existing keys — they never generate new key material. Every inter-service request is cryptographically signed using the sender's private key and verified by the receiver using the sender's known public key.

Admin Web UI - This is a specific interface where we connect using CLIENT_TOKEN-backed session auth on the admin surface.

2. How Core and Brain Communicate (The Service Key Model)

When the Python Brain needs to ask the Go Core for a piece of data from the vault, it does not send a bearer token or a shared secret.

Instead, Core and Brain each have their own Ed25519 keypair, derived deterministically from the master seed at install time via SLIP-0010 (at `m/9999'/3'/0'` for Core, `m/9999'/3'/1'` for Brain). Private keys are isolated by separate Docker bind mounts — each container's `/run/secrets/service_keys/private/` contains only its own private key, while `/run/secrets/service_keys/public/` (shared to both containers) holds both services' public keys. Core's private key never exists in Brain's container filesystem and vice versa. At runtime, both services load existing keys only — they never generate new key material. When Brain calls Core (or vice versa), the caller signs each request using a canonical format:

```
{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256_HEX(BODY)}
```

The signature and metadata are transmitted via three HTTP headers: `X-DID` (the caller's public key identifier), `X-Timestamp` (current time), and `X-Signature` (the Ed25519 signature over the canonical payload).

The receiver verifies the signature against the known public key, checks that the timestamp is within a 5-minute window, and maintains a double-buffer nonce cache to prevent replay attacks. If any check fails, the request is rejected.

This provides a massive security benefit: there are no shared secrets to leak, no tokens to accidentally commit to source control, and no way for an external attacker to forge a valid signed request without the private key.

3. Separating the "Who" from the "Why"

By using Ed25519 service keys for internal services, we cleanly separate two concepts that often get dangerously mixed up in software design: Authentication and Purpose.

Authentication (The Who): The Ed25519 signature definitively proves who is calling. Core verifies it is the Brain (and vice versa) by checking the signature against the known public key.

Request Purpose (The Why): Once the identity is proven via signature verification, the Brain just needs to explain why it is calling by passing internal metadata headers (e.g., brain_task or agent_review).

This keeps the architecture incredibly clean. We don't need a dozen different tokens for a dozen different internal roles -- just one keypair per service.

4. External Access: CLI and Admin

With the internal services locked down via Ed25519 service keys, here is how external commands get through the gatekeeper.

The CLI (Device Proof-of-Possession)
When you use the CLI, it does not use your Master Seed, and it does not send a password.
When you first set it up, the CLI generates a local keypair and registers the public half with Core. For every command you type after that, the CLI signs the request payload locally with its private key and attaches the signature. Core verifies the signature, confirms the device's permissions, and executes the command.

The Local Operator (dina-admin)
The dina-admin tool is not a normal client; it is a local operator utility. You run it directly on the host machine (or via SSH). Because it runs locally, it talks to Core over a dedicated local admin Unix socket. In this model, your access to the host machine's operating system is your admin authentication. There are no remote admin passwords floating around the network.

5. The Network Boundary (PDS and D2D)

Finally, when Dina reaches out to the public internet, we rely on the cryptographic boundaries we established during the boot process.

AT Protocol Publishing: Dina holds a completely separate secp256k1 (k256) rotation key. When publishing public records, Dina submits the raw data to the PDS, and the PDS uses its own hosting keys to sign the actual repository commits on the AT Protocol network.

Dina-to-Dina (D2D) Messaging: For direct agent-to-agent communication, the network is treated as zero-trust. Dina signs the plaintext message with its local Ed25519 key, wraps it in an anonymous NaCl sealed box using the recipient's public key, and fires it off. The receiving node decrypts it, verifies the DID signature, checks for replay attacks, and processes the message.

**More Details**

Let's review the four distinct types of tokens utilized in Dina and trace how they flow through the system.

1. Master Seed (we discussed)
2. Service Keys (Ed25519)

Each service (Core and Brain) has its own Ed25519 keypair, derived deterministically from the master seed at install time via SLIP-0010. Private keys are isolated by separate Docker bind mounts: on the host, `secrets/service_keys/core/` is mounted only to Core and `secrets/service_keys/brain/` only to Brain (each as `/run/secrets/service_keys/private/`), while `secrets/service_keys/public/` is mounted to both containers (as `/run/secrets/service_keys/public/`). There is no shared secret — each side only knows the other's public key, and neither side can access the other's private key at the filesystem level. At runtime, services load existing keys and fail if they are missing — no key generation occurs. Every inter-service request is signed using the canonical format: `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{SHA256_HEX(BODY)}`, transmitted via X-DID, X-Timestamp, and X-Signature headers. The receiver verifies the signature, enforces a 5-minute timestamp window, and uses a double-buffer nonce cache for replay protection.


3. CLIENT_TOKEN

Generated during device pairing (`crypto/rand.Read()`, 32 bytes). Two uses:
- **Admin web UI**: used as a login password — browser POSTs it to `/admin/login`, gets a session cookie back.


4. CLI Authentication - CLI authenticates exclusively via Ed25519 request signing (X-DID + X-Timestamp + X-Signature headers). During `dina configure`, the CLI generates an Ed25519 keypair and registers the public key via the pairing ceremony. No shared secret is exchanged.

4. Admin Session Boundary

Admin UI actions run on the admin app surface with CLIENT_TOKEN-backed session auth. Core remains the gatekeeper for privileged operations.

6. Persona Approval Flow

When a request targets a sensitive persona that is not currently open, the gatekeeper does not simply return a generic 403. Instead, it returns a structured denial that includes an `approval_id` — a unique identifier the caller can use to track and complete the approval process.

Here is how the flow works:

**Denial with approval_id:** When Brain or an agent requests access to a sensitive persona (e.g., `/health`), Core's gatekeeper checks the persona's access tier via `AccessPersona()`. If the persona requires approval (no active grant exists), Core returns `ErrApprovalRequired` and creates an approval request. The 403 response includes the `approval_id` so the caller can track the approval lifecycle. Any staging items that were part of the denied request are marked `pending_unlock` via `MarkPendingApproval` — the classified data (persona, type, metadata) is preserved so nothing is lost during the wait.

**Approval:** Both `/v1/persona/approve` and `/v1/approvals/{id}/approve` resolve to the same approval path in Core. When the approval is granted, `completeApproval()` does two things: it opens the persona vault (derives the DEK, opens the database file) AND drains any pending staging items that were waiting on that persona. This means data that arrived while the persona was closed is not lost — it flows into the vault as soon as access is granted.

**v1 auto-open for sensitive personas:** In v1, sensitive personas use policy-gated auto-open for authorized requests. Instead of requiring a passphrase from the user, Core checks the request against the persona's access policy. If the requester (Brain, agent with session grant, or user) is authorized by policy, Core auto-opens the persona — derives the DEK and opens the database transparently. This removes the friction of passphrase prompts for sensitive personas while maintaining the approval gate. Locked personas (reserved for future high-stakes use cases) still require explicit human action and remain fully closed (DEK not in RAM) until unlocked.

**Session-scoped access control:** Staging resolve operations enforce `X-Session` and `X-Agent-DID` headers. Core's middleware injects these into the request context, and `AccessPersona()` calls `hasActiveGrant(personaID, sessionID, agentDID)` — a triple-bound check that requires all three to match. An agent cannot access staging items from another agent's session, even if both target the same persona. Brain's `core_http.py` attaches these headers on every `staging_resolve`, `staging_resolve_multi`, and `vault_query` call that originates from a session-bearing request.

**Device callers blocked from approval mutations.** `ApprovalHandler.HandleApprove` and `HandleDeny` check the caller type and reject `agent`-type callers with 403. A paired device cannot approve its own access requests — only admin-scoped callers (CLIENT_TOKEN or admin service key) can mutate approvals. This prevents a compromised agent from self-granting access to sensitive personas.

**Multi-target resolve.** When content spans multiple personas (e.g., a health-related email that also affects financial planning), the resolve request carries a `targets` array. The handler calls `AccessPersona()` for each target independently. Accessible targets are stored via `ResolveMulti`; denied targets get their own pending rows via `CreatePendingCopy` with deterministic IDs (`{staging_id}-{persona}`). Each persona's outcome (stored vs. pending_unlock) is independent — errors on secondary targets do not prevent other targets from being processed. Denied targets drain independently after approval.

7. Staging Pipeline Security

Every memory-producing flow — CLI, connectors, Telegram, Dina-to-Dina, admin imports — enters the vault through the staging inbox. Nothing bypasses it.

**Provenance derivation.** Ingress provenance fields (`ingress_channel`, `origin_did`, `origin_kind`, `producer_id`) are server-derived from the authenticated request context (caller type, agent DID, token kind, device role). External callers cannot spoof provenance. Only Brain — authenticated via its service key — can forward provenance for Telegram and D2D flows, because those messages arrive at Brain first and are forwarded to Core's staging inbox on behalf of the original sender. Connectors must always supply `connector_id`.

**Enrichment validation.** Before resolve, the handler validates that items arrive fully enriched with `enrichment_status=ready`, `content_l0`, `content_l1`, and `embedding`. Incomplete items are hard-rejected — no partial records reach the vault. This prevents Brain from storing classification stubs or corrupted entries.

**Auto-open failure semantics.** `EnsureVaultOpen` (`staging.go:ensureOpen`) distinguishes two failure modes. `ErrPersonaLocked` is expected for locked-tier personas — it returns nil so `Resolve()` proceeds and marks the item `pending_unlock`. Any other error (DEK derivation failure, vault I/O error) is treated as infrastructure failure — the handler aborts with HTTP 500. This prevents DEK bugs or disk errors from being silently misreported as "please approve access."

**Session enforcement on resolve.** Every staging resolve and multi-resolve call carries `X-Session` and `X-Agent-DID` headers. Core's middleware extracts these and passes them to `AccessPersona()`, which calls `hasActiveGrant()` with the triple binding. Items ingested by agents carry `session` and `origin_did` in their metadata JSON; the staging processor extracts these and forwards them as headers on the resolve call.

8. Persona Access Tiers (4-Tier Gatekeeper)

Core enforces a 4-tier access model with canonical persona names:

| Tier | Boot State | Users | Brain | Agents | Canonical Name |
|------|-----------|-------|-------|--------|----------------|
| **Default** | Auto-open | Free | Free | Free | `general` |
| **Standard** | Auto-open | Free | Free | Session grant | `work` |
| **Sensitive** | Closed | Confirm | Approval | Approval | `health`, `finance` |
| **Locked** | Closed | Passphrase | Denied | Denied | Reserved (future) |

Default and standard personas auto-open at boot. Sensitive personas use v1 policy-gated auto-open: authorized requests (`EnsureVaultOpen`) transparently derive the DEK and open the database — no passphrase prompt. The approval gate and audit trail remain. Locked personas keep the DEK out of RAM entirely; Brain gets `403 Persona Locked` and must wait for explicit human unlock via `POST /v1/persona/unlock`.

Brain never invents persona names. The `PersonaRegistry` queries Core's `GET /v1/personas` at startup and caches canonical names, tiers, and lock states. Aliases (e.g., `financial` -> `finance`, `medical` -> `health`) are resolved by the `PersonaSelector` during classification.

9. Rate Limiting

Core implements a two-layer rate limiting design applied to all HTTP endpoints.

**Ingress rate limiter** (`ingress.RateLimiter`): Per-IP token bucket — each IP gets `ipRate` tokens per `ipWindow`. When the window elapses, the bucket refills. A second valve checks global spool capacity via `AllowGlobal()` — if the dead drop spool exceeds `spoolMaxBlobs`, new messages are rejected with 429. Memory is capped at 10,000 IP buckets with a background purge loop running every 5 minutes.

**Middleware rate limiter** (`middleware.RateLimit`): Wraps any HTTP handler. Extracts the client IP via `clientIP()`, which implements rightmost-trusted proxy parsing: walks `X-Forwarded-For` right-to-left, skipping IPs in configured `TrustedProxies` CIDR ranges, returns the first non-trusted IP. If no trusted proxies are configured, `RemoteAddr` is used directly — safe default against IP spoofing. Returns HTTP 429 when the bucket is empty.

Per-DID rate limiting is only possible when the vault is unlocked (the sender's DID is inside the NaCl encrypted envelope). When locked, Core cannot identify the sender, so ingress defense is physics-based (IP addresses, disk quotas).

Tests set `DINA_RATE_LIMIT=100000` to effectively disable rate limiting during test runs.

10. Telegram Bot Security

Telegram is both a data connector and a full admin channel (approve/deny requests, receive nudges). Three files implement it following hexagonal architecture: port (`telegram.py`), adapter (`telegram_bot.py`), service (`telegram.py`).

**Owner-only access.** Two gates: (1) Allowlist gate — only Telegram user IDs listed in `DINA_TELEGRAM_ALLOWED_USERS` can initiate pairing. (2) Pairing gate — an allowed user sends `/start`, and the service persists their user ID to Core's KV store (`telegram_paired_users`). Paired users survive Brain restarts.

**Core validates all mutations.** The Telegram service calls Core's approval API like any other client — Core enforces its own authorization checks. A bug in the Telegram service cannot bypass Core's approval logic.

**No secrets in Telegram messages.** Approval prompts show agent DID and persona name, not vault contents or keys. Error messages to Telegram are generic; detailed errors are logged server-side only. Markdown special characters are escaped to prevent formatting injection.

**Graceful degradation.** If `python-telegram-bot` is not installed or the token is invalid, Brain starts normally with Telegram disabled. Approvals fall back to the admin dashboard or CLI.

11. Device Pairing Security

Device pairing uses single-use 6-digit codes as short-lived physical proximity proofs. The code space is 100000-999999.

**Code generation:** Core generates a 32-byte cryptographic secret (`crypto/rand`), derives a 6-digit numeric code via `SHA-256(secret) -> BigEndian uint32 -> mod 900000 + 100000`. Collision detection retries up to 5 times against live (non-expired, non-used) pending codes. Codes expire after 5 minutes.

**Hard cap:** A maximum of 100 pending codes prevents memory exhaustion (SEC-MED-13). Codes are single-use and deleted immediately on completion — not just marked used.

**Constant-time comparison.** `ValidateToken()` iterates all non-revoked devices with constant-time hash comparison (`crypto/subtle`) — no timing oracle. Device records are persisted to a JSON file and reloaded on startup.

**Two completion paths:** Key-based (Ed25519 public key via `public_key_multibase`) and token-based (CLIENT_TOKEN for admin web UI). An optional `role` field distinguishes `"user"` from `"agent"` devices.

12. PII Scrubber (V1: 2-Tier Deterministic Pipeline)

Raw data never leaves the Home Node unscrubbed. The V1 PII scrubber uses deterministic patterns and an allow-list — no NER.

**Tier 1 — Regex (Go core, always):** Fast pattern matching via `POST /v1/pii/scrub`. Catches structured PII: credit cards, phone numbers, Aadhaar/SSN, emails, bank accounts. Sub-millisecond.

**Tier 2 — Presidio pattern recognizers (Python brain, always):** Deterministic pattern matchers (EmailRecognizer, PhoneRecognizer, CreditCardRecognizer, SSN, Aadhaar, PAN, IFSC, UPI, EU IDs, etc.) catch structured PII that Go regex may miss. spaCy NER is **disabled** in V1 — it produced too many false positives in real data (B12 tagged as ORG, biryani as PERSON, Raju as ORG, pet names as PERSON). An allow-list (`brain/config/pii_allowlist.yaml`) post-filters all Presidio results: medical terms (B12, A1C, HbA1c, CBC...), financial abbreviations, immigration codes, technical acronyms, food names.

**V1 known gap:** Names and addresses in free text are NOT detected. This is an accepted trade-off — deterministic patterns with zero false positives are preferred over NER with frequent false positives on Indian names, medical terms, and food.

**V2 plan:** GLiNER (~300M params, local) for contextual NER, with an LLM adjudicator for ambiguous cases via a privacy gateway pattern.

Entities are replaced with opaque indexed tokens (`[PERSON_1]`, `[ORG_1]`, etc.) before sending to cloud LLMs. Rehydration matches both bracketed `[PERSON_1]` and bare `PERSON_1` forms (LLMs sometimes strip brackets). The de-sanitizer restores originals in the response. Why not use a cloud LLM for PII scrubbing? Circular dependency — sending unscrubbed text to a cloud API for detection constitutes the leak. PII scrubbing must always be local.

13. OpenAPI Codegen and Contract Security

The Core-Brain HTTP interface is defined by OpenAPI specs in `api/`. The specs are the source of truth for the HTTP boundary — security-relevant schemas (persona access types, approval request/response shapes, staging statuses, auth headers) are defined once and code-generated into both Go and Python.

```
api/
  components/schemas.yaml     Shared enums (17) + domain types (15+)
  core-api.yaml               Core's ~50 endpoints (hand-authored, source of truth)
  brain-api.yaml              Brain's 3 endpoints (extracted from FastAPI)
```

**Ownership rule:** Core spec is hand-authored and generates Python client types. Brain spec is extracted from FastAPI/Pydantic and generates Go client types. Never feed generated types back into the owning service. This prevents type drift between the two services where mismatched field names or missing validation could create security gaps.

**CI drift gate:** `make check-generate` compares generated code against the committed spec. If they diverge, CI fails — preventing deployed services from silently using stale types.

**Wire format:** All JSON uses `snake_case`. All domain types that cross HTTP carry `json:"snake_case"` tags.


>> Some normal questions and answers
**What is BIP-39**
It is pretty straightforward. It takes 256 bits, does checksum, adds it (so that checksum check happens always) - so 256+8 264 bits, divides by 11 - to get 24 words. 11 => means there are 2048 options (2^11) - so, we have a menmonic table of 2048 english words. 

**Why this complex ed25519 seed? Why not just random.random()**
import secrets
#  32 bytes (256 bits) - Ed25519 Seed: Cryptographically Secure Pseudo-Random Number Generator (CSPRNG)
ed25519_seed = secrets.token_bytes(32)

Not random.random because secrets is more secure. random.random is not very secure because it uses predictable RNG (Mersenne Twister) - example think of a RNG which only uses starting time as input - so, someone can write a program to generate secrets for every millisecond, (because wallets contain a lot of money). secrets library uses lots of random variables like cpu temp at that time etc also which makes it impossible to recreate

**What is the difference between salt and nonce**

Conceptually similar - both are random viewable texts added at the start before hashing/encryption. But usage is fundamentally different. If you reuse your salt across other passwords, it is not very dangerous. Maybe security is weakened a bit. But if you reuse the nonce, it is as good as you Master SEED is out (nonce is number used only once - and it is absolutely important that it is unique)

**Why Argon2id**
Because it is computationally expensive hash function, which makes it more resistant to cracking

**Why It does not use the Master Seed directly to sign**
It’s a fair question: if the Master Seed is the absolute root of our identity, why not just use it to sign everything directly?

The short answer is blast radius. We want the ability to rotate our operational keys without burning our identity to the ground or making all our saved data unreadable.

Let me explain a bit more about how we split this up. In Dina, we essentially have two different types of derived keys doing two very different jobs: Signing Keys (for proving who we are to the outside world) and Data Encryption Keys, or DEKs (for locking up our local vaults).

The Memory Scraping Reality
As we touched on earlier, the Master Seed is treated like radioactive material. During boot, it’s kept in memory just long enough to spawn these derived child keys, and then it is completely wiped. So, even if the absolute worst happens and a hacker manages to scrape the container's active memory, they are only walking away with the temporary derived keys—never the Master Seed itself.

Changing the Locks (Rotating the DEK)
Think about what happens if you want to rotate your DEK. Because your Master Seed is safely tucked away, the process is straightforward: you generate your new DEK, unlock the vault using your current DEK, apply the new one, and lock it back up. It’s exactly like changing the locks on your front door. The house (your data) is still yours, and it's perfectly safe.

Keeping Your History Alive (Rotating Signing Keys)
The same philosophy applies to our signing keys, and this is where the AT Protocol really shines.

If a signing key feels compromised, you simply swap it out and update your AT Protocol registry (did:plc) to broadcast your new Public Key. From that moment on, AppViews will check any new data you produce against this new key.

But what about the data you signed last year? Because the AT Protocol is temporal (time-aware), your historical data is completely fine. When an AppView checks an old signature, it looks at the registry's timeline and says, "Ah, this was signed with the Public Key that was officially active during that specific start and end time." By isolating the Master Seed, we get the agility to swap out our keys whenever we need to, without ever orphaning our past or losing our data.
