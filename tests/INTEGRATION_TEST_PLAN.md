# Dina Integration Test Plan

> End-to-end tests spanning dina-core (Go) ↔ dina-brain (Python) ↔ llama.cpp (LLM)
> plus Dina-to-Dina communication, Docker networking, crash recovery, and security boundaries.

---

## 1. Core ↔ Brain Communication

### 1.1 BRAIN_TOKEN Shared Secret

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Both services share same token | Same `/run/secrets/brain_token` mounted | Core calls brain successfully, brain validates token |
| 2 | Token mismatch | Different token files | Core→brain calls return 401, system non-functional |
| 3 | Token rotation | Replace token file, restart both | New token accepted after restart |
| 4 | Token file permissions | `chmod 600` on secret file | Only container user can read |

### 1.2 Request Flow: Core → Brain

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Forward user query | Core receives WS query → POST to brain `/v1/process` | Brain processes, returns response |
| 2 | Forward inbound message | New Dina-to-Dina message arrives at core | Core delivers to brain for classification |
| 3 | Agent intent verification | External agent submits intent via core API | Core forwards to brain guardian for approval |
| 4 | Brain timeout | Brain takes >30s | Core circuit breaker opens, returns degraded response |
| 5 | Brain crash | Brain container dies | Core watchdog detects, circuit breaker opens, queues requests |
| 6 | Brain recovery | Brain container restarts | Watchdog detects health, circuit breaker closes, queued requests processed |

### 1.3 Request Flow: Brain → Core

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | Read vault item | Brain needs context for query | Brain calls core `/v1/vault/items/{id}`, receives data |
| 2 | Write vault item | Brain stores processed result | Brain calls core `POST /v1/vault/items`, 201 returned |
| 3 | Search vault | Brain builds RAG context | Brain calls core `/v1/vault/search`, results returned |
| 4 | Write scratchpad | Brain checkpoints task | Brain calls core `PUT /v1/vault/scratchpad/{task_id}` |
| 5 | Send outbound message | Brain decides to notify contact | Brain calls core `POST /v1/msg/send`, message queued in outbox |
| 6 | Core unreachable | Core container down | Brain retries with backoff, logs error |

---

## 2. End-to-End User Flows

### 2.1 User Query via WebSocket

> Full message envelope format from ARCHITECTURE.md §17 (WebSocket Protocol).

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Simple query | Client WS → `{"type":"auth","token":"..."}` → `auth_ok` → `{"type":"query","id":"req_001","payload":{"text":"Am I free at 3pm?","persona":"/personal"}}` → core → brain → LLM → brain → core → `{"type":"whisper","reply_to":"req_001","payload":{...}}` | User receives answer, `reply_to` links to original `id` |
| 2 | Query with vault context | Client sends query → brain searches vault → builds context → LLM → `whisper` response with `sources` | Response includes `sources: ["calendar:event:abc123"]` referencing vault data |
| 3 | Streaming response | Long answer → brain streams → core relays `{"type":"whisper_stream","reply_to":"req_001","payload":{"chunk":"..."}}` × N → final `whisper` | Client receives progressive chunks, terminated by final `whisper` message |
| 4 | Query during brain outage | Client sends query, brain is down | Core returns `{"type":"error","reply_to":"req_001","payload":{"code":503,"message":"brain unavailable"}}` |
| 5 | Proactive whisper (no request) | Brain detects incoming D2D event | Core pushes `{"type":"whisper","id":"evt_003","payload":{"text":"...","trigger":"didcomm:...","tier":2}}` — no `reply_to` (brain-initiated) |
| 6 | System notification | Watchdog detects issue | Core sends `{"type":"system","id":"sys_004","payload":{"level":"warning","text":"Gmail hasn't synced in 48h."}}` |
| 7 | Heartbeat round-trip | Connection idle for 30s | Core sends `{"type":"ping","ts":...}` → client responds `{"type":"pong","ts":...}` within 10s |
| 8 | 3 missed pongs → disconnect | Client stops responding to pings | After 3 missed pongs, core closes connection, marks device offline |

### 2.2 User Query via Admin UI

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Browser → login → dashboard | Browser → core:8100 → login page → Argon2id auth → session cookie → dashboard | Dashboard displays with system status |
| 2 | Dashboard → query | Submit query from dashboard → core proxy → brain → LLM → response | Response displayed in UI |
| 3 | Session expiry | User idle past session TTL → next request | Redirect to login page |

### 2.3 Device Pairing Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Full pairing | Admin UI → "Pair Device" → 6-digit code displayed → new device submits code → CLIENT_TOKEN issued → device registered | New device can make authenticated API calls |
| 2 | Pairing + immediate use | After pairing → device sends first query via WS | Query processed normally |
| 3 | Paired device revocation | Admin revokes device → device tries API call | 401 on next request |

### 2.4 Persona Operations

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Create persona + store data | Create "work" persona → store item in work vault → verify not in "personal" vault | Data isolated per persona |
| 2 | Lock persona + attempt access | Set persona to Locked → try reading vault → 403 → unlock with passphrase → read succeeds | Lock/unlock lifecycle works |
| 3 | Locked persona + inbound message | Message arrives for locked persona → spooled → persona unlocked → message processed | 3-valve ingress handles locked personas |
| 4 | Delete persona | Delete persona → verify vault wiped → verify DID deactivated → verify keys removed | Complete cleanup |

### 2.5 Onboarding Flow (Managed Hosting)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Full managed onboarding | User enters email + password | All 10 silent steps complete: mnemonic → SLIP-0010 → did:plc → HKDF → Argon2id wrap → SQLite created → convenience mode → brain starts → initial sync |
| 2 | Post-onboarding: system functional | After setup completes | User can query via WS, admin UI accessible, initial data synced |
| 3 | Only `/personal` persona exists | After onboarding | Single persona, no /health or /financial until user opts in |
| 4 | Day 7: mnemonic backup prompt | 7 days after setup | User prompted to write down 24-word recovery phrase |
| 5 | Cloud LLM PII consent (Cloud profile) | Onboarding with Cloud LLM profile | User shown: "Health/financial queries will be processed by cloud LLM. Names, orgs, locations scrubbed. Cloud sees topics, not identities." — must explicitly acknowledge |

### 2.6 Compromised Brain Simulation (E2E)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Brain with BRAIN_TOKEN: access open persona | Brain queries open persona vault | Data returned — expected damage radius |
| 2 | Brain with BRAIN_TOKEN: blocked from locked persona | Brain queries locked persona | 403 from core — cannot access |
| 3 | Brain with BRAIN_TOKEN: restricted creates trail | Brain queries restricted persona | Data returned, but audit entry + briefing notification visible to user |
| 4 | Brain with BRAIN_TOKEN: cannot call admin endpoints | Brain calls `/v1/did/sign`, `/v1/vault/backup` etc. | 403 on every admin path |
| 5 | Brain with BRAIN_TOKEN: PII scrubber enforced | Brain sends data to cloud LLM | Core-side PII gate scrubs before any outbound — brain cannot bypass |

---

## 3. Dina-to-Dina Communication

### 3.1 Connection Establishment (E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Full connection flow | Node A resolves Node B's DID → PLC Directory → extract endpoint → connect → mutual auth → send encrypted | Message delivered, both sides authenticated |
| 2 | Mutual authentication required | Node A not in Node B's contacts | Node B rejects — both must have each other in contacts list |
| 3 | DID Document endpoint extraction | Resolve `did:plc:sancho` | DID Document `service[0].serviceEndpoint` = `https://sancho:443/didcomm` |

### 3.2 Message Send Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Send message | User composes → brain formats tiered payload → `POST /v1/dina/send` → core checks sharing policy → core strips per tier → PII scrub → NaCl encrypt → outbox → deliver | Recipient receives correctly scoped encrypted message |
| 2 | Sharing policy: summary tier | Send to contact with `availability: "free_busy"` | Brain sends `{summary: "Busy 2-3pm", full: "Meeting with Dr. Patel..."}` → Core picks summary only |
| 3 | Sharing policy: full tier | Send to contact with `preferences: "full"` | Full details shared (still PII-scrubbed) |
| 4 | Sharing policy: default-deny | Send to contact with no sharing policy defined | Message blocked — no data sent, user notified |
| 5 | PII scrub on egress | Send to contact with `sharing: full` | Tier 1 + Tier 2 PII scrub → encrypted → sent |
| 6 | Egress audit trail | Any D2D send | `audit_log` entry: timestamp, contact_did, each category, decision (allowed/denied), reason |

### 3.3 Message Receive Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Receive message (open persona) | Inbound → DID verification → decrypt → brain classifies priority → action taken | Message processed based on priority |
| 2 | Receive message (locked persona) | Inbound → DID verification → persona locked → spooled to disk | 202 Accepted, spooled |
| 3 | Spool overflow | Locked persona, spool at 500MB → new message | 429 Too Many Requests (reject-new, NOT drop-oldest) |
| 4 | Unknown sender | Message from unresolvable DID | Rejected or quarantined per policy |

### 3.4 Bidirectional Communication

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Two Dina nodes exchange messages | Node A sends to Node B, Node B responds | Full roundtrip: encrypt → deliver → decrypt → process → encrypt → deliver → decrypt |
| 2 | Concurrent bidirectional | Both nodes send simultaneously | Both messages delivered independently |
| 3 | Message ordering | Node A sends 5 messages rapidly | Node B receives in order (outbox FIFO) |

### 3.5 Transport Reliability

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Recipient temporarily down | Send message, recipient offline | Outbox retries: 30s → 1m → 5m → 30m → 2h (exponential with jitter) |
| 2 | Recipient recovers within retry window | Down for 2 minutes, then up | Message delivered on retry |
| 3 | Recipient down beyond max retries (5) | Down for >3 hours | Status → `failed`, Tier 2 nudge to user: "Couldn't reach Sancho's Dina" |
| 4 | Network partition then heal | Bidirectional network drop for 10 min | Both sides retry, messages eventually delivered |
| 5 | Duplicate delivery prevention | Retry delivers message that was already received | Recipient deduplicates by message ID |
| 6 | Relay fallback for NAT | Recipient behind CGNAT | DID Document points to relay → sender sends to relay → relay forwards encrypted blob |
| 7 | Relay sees only encrypted blob | Inspect relay-forwarded message | Relay sees `{to: "did:plc:...", payload: "<encrypted>"}` — cannot read content |

---

## 4. LLM Integration

### 4.1 Local LLM (llama.cpp)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Brain → local LLM completion | Brain sends prompt to llm:8080 | Response returned, brain processes |
| 2 | Local LLM timeout | LLM takes >60s (large prompt) | Brain times out, falls back to cloud or errors |
| 3 | Local LLM crash | llama.cpp container dies | Brain detects, routes to cloud fallback (if configured) |
| 4 | Model file missing | `/models/gemma-3n.gguf` absent | llama.cpp container fails to start, brain operates without local LLM |

### 4.2 Cloud LLM (with PII Protection)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Entity vault scrub → cloud call → rehydrate | Text with PII → scrub → send to cloud → response → rehydrate | Cloud LLM never sees PII, user sees full response |
| 2 | Cloud LLM rate limited | Too many requests | Brain backs off, retries or falls back to local |
| 3 | Cloud LLM returns PII tokens | Response contains `[PERSON_REDACTED]` | Tokens rehydrated from entity vault |
| 4 | Cloud LLM unavailable | API returns 503 | Fallback to local LLM |

### 4.3 Full PII Pipeline (3-Tier E2E)

> Verifies the full PII scrubbing pipeline: Brain → Core Tier 1 (regex) → Brain Tier 2 (spaCy) →
> optional Tier 3 (llama) → cloud LLM → rehydrate.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Full Tier 1+2 pipeline | Text with email + person name + org | Core scrubs email (`[EMAIL_1]`), brain scrubs name/org (`[PERSON_1]`, `[ORG_1]`). Combined replacement map has all three. Cloud sees only tokens |
| 2 | Replacement map round-trip | Scrub → cloud LLM call → response with tokens → rehydrate | All `[TOKEN_N]` tokens replaced with originals. User sees full names. Cloud never saw them |
| 3 | Sensitive persona: health query via Entity Vault | "What did Dr. Sharma say about blood sugar at Apollo Hospital?" | Tier 1: no structured PII. Tier 2: `[PERSON_1]`, `[ORG_1]`. Cloud: "What did [PERSON_1] say about blood sugar at [ORG_1]?" — health *topic* visible, identity scrubbed |
| 4 | PII scrubbing always local | Network capture on core + brain during scrub | Zero outbound HTTP calls for PII detection — scrubbing is regex (Go) + spaCy (Python), never cloud |
| 5 | Tier 3 with local LLM profile | `--profile local-llm`, indirect reference | Tier 1+2+3 all run → highly indirect reference caught by llama NER |
| 6 | Tier 3 absent gracefully | Cloud-only profile, indirect reference | Tiers 1+2 catch most PII. Indirect reference may pass — documented residual risk |

---

## 5. Docker Networking & Isolation

### 5.1 Bowtie Topology

> Core is the hub ("knot"). Brain and PDS are the loops. They never touch each other.
> Three Docker networks: `dina-public` (standard), `dina-brain-net` (standard), `dina-pds-net` (internal).

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Core can reach brain | `docker exec core wget -q --spider brain:8200/healthz` | 200 OK (both on `dina-brain-net`) |
| 2 | Core can reach PDS | `docker exec core wget -q --spider pds:2583/xrpc/_health` | 200 OK (both on `dina-pds-net`) |
| 3 | Brain CANNOT reach PDS | `docker exec brain wget -q --spider pds:2583` | Connection refused / no route — no shared network |
| 4 | PDS CANNOT reach brain | `docker exec pds wget -q --spider brain:8200` | Connection refused / no route — no shared network |
| 5 | Only core + PDS exposed on host | `curl localhost:8100` from host | 200; `curl localhost:8200` → refused; `curl localhost:2583` → PDS responds |
| 6 | LLM not exposed (production) | `curl localhost:8080` from host | Connection refused — port not mapped in docker-compose |
| 7 | Brain can reach internet (outbound) | `docker exec brain wget -q --spider https://api.google.com` | Connection succeeds — `dina-brain-net` is standard bridge (not internal) |
| 8 | PDS cannot reach internet (outbound) | `docker exec pds wget -q --spider https://example.com` | Connection refused — `dina-pds-net` is `internal: true` (relay initiates inbound to PDS) |
| 9 | Brain can reach `host.docker.internal` | `docker exec brain wget -q --spider http://host.docker.internal:3000` | OpenClaw on host reachable via `extra_hosts` directive |

### 5.2 Observability & Health (End-to-End)

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Core `/healthz` returns 200 | `docker exec core wget --spider http://localhost:8100/healthz` | 200 OK — HTTP server alive |
| 2 | Core `/readyz` returns 200 (vault open) | `docker exec core wget --spider http://localhost:8100/readyz` | 200 OK — `db.PingContext()` succeeds |
| 3 | Core `/readyz` returns 503 (vault locked) | Security mode, no passphrase provided yet | 503 — not ready |
| 4 | Docker restarts unhealthy core | Block `/healthz` (simulate hang) | After 3 consecutive failures at 10s interval (30s), Docker kills + restarts core container |
| 5 | Brain starts only after core healthy | `docker compose up` with slow core startup | Brain waits at `depends_on: core: condition: service_healthy` |
| 11 | PDS healthcheck: `/xrpc/_health` | `docker exec pds wget --spider http://localhost:2583/xrpc/_health` | 200 OK — PDS serving AT Protocol |
| 12 | PDS healthcheck params | Inspect compose healthcheck for PDS | `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 10s` |
| 6 | Structured JSON logs from core | `docker logs core` | Every line is valid JSON with `time`, `level`, `msg`, `module` fields |
| 7 | Structured JSON logs from brain | `docker logs brain` | Every line is valid JSON (structlog) |
| 8 | No PII in any container log | Store PII data → query → grep all container logs | Zero matches for test PII values — only IDs, counts, latency logged |
| 9 | Brain crash traceback in vault | Kill brain mid-task → restart → query crash_log | Crash entry in identity.sqlite with error type + full traceback |
| 10 | Brain crash stdout has no PII | Kill brain mid-task → inspect Docker logs | Only sanitized one-liner: `guardian crash: RuntimeError at line 142` |

### 5.3 Boot Sequence (End-to-End)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Security mode boot: full stack | config.json `mode: "security"` | Core starts → prompts client → passphrase → vault unlocks → brain notified → system ready |
| 2 | Convenience mode boot: full stack | config.json `mode: "convenience"`, keyfile present | Core starts → reads keyfile → vault auto-unlocks → brain notified → system ready |
| 3 | Security mode: vault locked → dead drop active | Reboot in security mode, no passphrase yet | Core starts, brain starts, D2D messages spooled to inbox, WS clients get "vault locked" system message |
| 4 | Security mode: late unlock | Vault locked for 2 hours → user provides passphrase | Vault unlocks → sweeper processes spool → brain catches up → full service restored |
| 5 | Boot order: identity.sqlite before persona vaults | Either mode | identity.sqlite opened first (gatekeeper needs contacts), then personal.sqlite, other personas remain closed |
| 6 | Brain receives vault_unlocked | Vault opens | Core sends `POST brain:8200/v1/process {event: "vault_unlocked"}`, brain initializes |

### 5.4 Container Dependencies

> Dependency chain: PDS starts first → Core starts after PDS (service_started) →
> Brain starts after Core is healthy (service_healthy). llama is independent.

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Core depends on PDS started | `docker compose up` | Core container starts after PDS has started (`depends_on: pds: condition: service_started`) |
| 2 | Brain depends on core healthy | `docker compose up` | Brain starts only after core's healthcheck passes (`depends_on: core: condition: service_healthy`) |
| 3 | Brain starts without core | Start brain alone | Brain starts, retries core connection with backoff |
| 4 | LLM starts independently | Start LLM alone | Starts, loads model, ready on :8080 — no dependencies |
| 5 | Full startup order | `docker compose up` fresh | PDS → Core → (core healthy) → Brain. All containers in `restart: unless-stopped` |

### 5.5 Volume Mounts & Data Layout

> Data volumes from docker-compose.yml §17. Brain is stateless — all state lives in core's vault.

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Vault data persists | Write data → stop stack → start stack → read data | Data present after restart |
| 2 | Model files shared | LLM reads from `/models` mount | Model loaded from `./data/models/` on host |
| 3 | Secret files mounted (tmpfs) | Inspect running containers | `/run/secrets/brain_token` present in core and brain, mounted as tmpfs (never on disk in container) |
| 4 | Source mounts (dev mode) | Start with dev compose | Source directories mounted, hot-reload works |
| 5 | Core data volume layout | Inspect `./data/` on host | `identity.sqlite`, `vault/personal.sqlite`, `keyfile` (convenience), `inbox/`, `config.json` — all at expected paths |
| 6 | Brain is stateless | Stop brain → restart brain | Brain loads all state from core vault via API — no local database, no state files |
| 7 | PDS data separate | Inspect `./data/pds/` | AT Protocol repo data in own directory — PDS manages its own storage |
| 8 | llama models directory | Inspect `./data/models/` | GGUF model files stored here — auto-downloaded on first start if missing |

### 5.6 Bootstrap Script (`install.sh`)

> Run once before `docker compose up`. Generates secrets, creates directories, sets permissions.

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Creates required directories | Run `install.sh` on fresh system | `secrets/`, `data/vault/`, `data/inbox/`, `data/pds/`, `data/models/` all exist |
| 2 | Generates BRAIN_TOKEN | Inspect `secrets/brain_token.txt` after install | 64 hex chars (32 bytes from `openssl rand -hex 32`) |
| 3 | Prompts for passphrase | Run `install.sh` interactively | `read -s -p` prompts without echo — passphrase written to `secrets/dina_passphrase.txt` |
| 4 | Sets file permissions | Inspect after install | `chmod 700 secrets`, `chmod 600 secrets/*` — only owner can access |
| 5 | Idempotent: re-run safe | Run `install.sh` twice | Second run: `mkdir -p` succeeds (no error), existing secrets NOT overwritten (or prompts to confirm) |
| 6 | docker compose up after install | `./install.sh && docker compose up -d` | All 3 containers start successfully — secrets mounted, vault initialized |

### 5.7 Secret Management Rules

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Secrets never in `docker inspect` output | `docker inspect dina-core` → check `Config.Env` | No `BRAIN_TOKEN`, `DINA_PASSPHRASE` in environment section |
| 2 | Secrets at `/run/secrets/` inside container | `docker exec dina-core cat /run/secrets/brain_token` | Token present and readable by container process |
| 3 | `GOOGLE_API_KEY` in `.env` (exception) | Inspect brain container env | API key visible in env — acceptable because it's a revocable cloud key, not a local credential |
| 4 | `.gitignore` blocks secrets directory | `git status` after creating secrets | `secrets/` directory not tracked by git |
| 5 | `BRAIN_TOKEN` shared by core and brain | Compare token in both containers | Identical value — same file mounted to both |

---

## 6. Crash Recovery & Resilience

### 6.1 Core Crash Recovery

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Core crash with pending outbox | Core has 5 messages in outbox → crash → restart | All 5 messages retried on startup |
| 2 | Core crash during vault write | Write interrupted mid-transaction | SQLite WAL ensures atomicity, no corruption |
| 3 | Core crash with active WS connections | 3 clients connected → crash → restart | Clients detect disconnect, reconnect, receive buffered messages |
| 4 | Core crash with locked persona spool | Spooled messages for locked persona → crash → restart | Spool files intact, processed on unlock |

### 6.2 Brain Crash Recovery

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Brain crash mid-task | Guardian processing multi-step task → crash → restart | Reads scratchpad checkpoint, resumes from last step |
| 2 | Brain crash with no checkpoint | Crash before first checkpoint | Task restarted from scratch |
| 3 | Brain crash during LLM call | Waiting for LLM response → crash → restart | LLM call abandoned, task restarted (or resumed from checkpoint) |
| 4 | Brain crash with pending briefing | Briefing generation in progress → crash → restart | Briefing re-generated from source data |

### 6.3 LLM Crash Recovery

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | LLM crash during inference | llama.cpp dies mid-response | Brain times out, retries or falls back to cloud |
| 2 | LLM OOM | Large prompt causes OOM kill | Docker restarts container, brain retries after watchdog detects recovery |
| 3 | Corrupted model file | GGUF file corrupted | llama.cpp fails to load, brain operates in degraded mode |

### 6.4 Full Stack Crash

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Power loss simulation | `docker compose kill` (SIGKILL all) → `docker compose up` | All services recover, vault intact, outbox retried |
| 2 | Disk full recovery | Fill disk → services fail → free space → restart | Services resume, data integrity maintained |

---

## 7. Security Boundary Tests

### 7.1 Data Flow Boundaries

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Raw vault data never reaches cloud LLM | Network capture during cloud LLM call | Only scrubbed text in request body |
| 2 | PII never in outbound messages | Capture Dina-to-Dina message, decrypt | No PII in payload (Tier 1 + Tier 2 scrubbed) |
| 3 | Vault DEK never leaves core | Inspect brain container memory/network | Brain never receives or stores DEKs |
| 4 | Master seed never transmitted | Network capture all interfaces | Seed never appears in any network traffic |
| 5 | Agent never sees full vault | Agent requests data | Agent receives answer to question, never raw vault items |

### 7.2 Cross-Persona Isolation

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Persona A data not in Persona B queries | Store in A, search from B | No results from A appear in B's search |
| 2 | Persona A DEK cannot decrypt Persona B | Try A's DEK on B's vault file | `SQLITE_NOTADB` error |
| 3 | Contact routing respects personas | Message for persona A contact | Routed to persona A only |
| 4 | Admin can list all personas | Admin API call | All personas visible to admin |
| 5 | Locked persona DEK not in RAM | Dump core process memory (test environment) | DEK absent when persona locked |
| 6 | Sibling key cryptographic unlinkability | Derive persona 1 and persona 2 keys from same seed | No mathematical relationship between sibling keys — cannot derive one from the other (hardened derivation) |
| 7 | Breach containment: one persona compromised | Attacker has `/health` DEK | Cannot read `/financial` data — different DEK, different file, different HKDF info string |
| 8 | `GetPersonasForContact()` excludes locked | Dr. Patel has data in `/health` (locked) and `/social` (open) | Query returns only `/social` — locked personas invisible |
| 9 | Cross-persona parallel reads | Brain requests 3 personas simultaneously | Core queries each open DB independently, returns separate JSON responses — no shared query context |

### 7.3 Authentication Boundaries

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | No unauthenticated API access | Hit every endpoint without token | All return 401 (except health) |
| 2 | BRAIN_TOKEN cannot perform admin actions | Use BRAIN_TOKEN on admin endpoints | 403 |
| 3 | CLIENT_TOKEN cannot perform brain actions | Use CLIENT_TOKEN on brain endpoints | 403 |
| 4 | Expired session cannot access admin | Use expired session cookie | 401, redirect to login |
| 5 | Revoked device cannot access anything | Revoked CLIENT_TOKEN | 401 on all endpoints |

### 7.4 Network Attack Surface

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Port scan from external | Scan host ports | Only 8300 (and 8100 for admin) open |
| 2 | Brain not accessible from outside Docker | `curl localhost:8200` from host | Connection refused |
| 3 | Inter-container isolation | Brain → PDS, PDS → Brain | Both fail (bowtie network topology) |
| 4 | Rate limiting on public endpoint | 200 requests/s to :8300 | Rate limiter triggers, 429 responses |
| 5 | TLS certificate validation | HTTPS endpoint with invalid cert | Rejected (no insecure skip) |

### 7.5 Cryptographic Integrity

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Message tampering detected | Modify ciphertext of Dina-to-Dina message | Decryption fails (NaCl authenticated encryption) |
| 2 | Replay attack prevention | Replay captured message | Rejected by message ID deduplication |
| 3 | DID spoofing | Message with forged sender DID | Signature verification fails |
| 4 | Key rotation | Rotate signing key, old messages still verifiable | Old signatures valid with old pubkey, new messages use new key |
| 5 | Forward secrecy (Phase 2+) | Compromise current key | Past messages remain confidential (once Noise XX implemented) |
| 6 | `did:plc` rotation: DID preserved | Rotate signing key via PLC Directory | Same `did:plc` identifier — contacts don't need to update anything |
| 7 | `did:plc` → `did:web` escape | Simulate PLC Directory adversarial | Signed rotation op redirects to `did:web` endpoint — identity portable without PLC Directory |
| 8 | BIP-39 recovery restores full identity | Enter 24-word mnemonic on new device | Same root DID, same persona DIDs, same vault DEKs — full sovereignty restored |

### 7.6 Data Sovereignty on Disk

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | No plaintext vault files on disk | After vault operations: scan `DINA_DATA_DIR` for non-SQLCipher files | Only `.sqlite` (encrypted) files — no `.json`, `.csv`, `.tmp` with raw data |
| 2 | Hosting provider sees only encrypted blobs | Read all files in data volume as raw bytes | No human-readable PII, no plaintext vault content |
| 3 | No plaintext in container temp directories | Inspect `/tmp`, `/var/tmp` inside all containers | No vault data, no decrypted keys |
| 4 | No plaintext in Docker layer cache | `docker history` + layer inspection | No secrets baked into image layers |
| 5 | Logs contain no vault content | Grep all container logs for known test vault values | Zero matches — logs reference IDs only, not content |
| 6 | FTS5 index encrypted by SQLCipher | Hex-dump persona `.sqlite` file, search for known plaintext | FTS5 index is inside SQLCipher database — `unicode61` tokens encrypted at rest, not searchable in raw bytes |
| 7 | sqlite-vec embeddings encrypted | Hex-dump persona `.sqlite` file | Vector embeddings stored inside encrypted database — opaque bytes on disk |
| 8 | WAL file encrypted | Inspect `-wal` file during active writes | SQLCipher WAL is encrypted with same key — no plaintext leakage in journal |

### 7.7 Multi-Tenant Isolation (Managed Hosting)

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Per-user SQLite isolation | Two users on same host, separate containers | Separate vault files, separate DEKs, no shared database |
| 2 | User A compromise doesn't expose User B | Attacker has User A's DEK | Cannot decrypt User B's vault (different DEK, different file) |
| 3 | No shared state between user containers | Inspect mounted volumes, IPC, shared memory | Zero shared writable state between user instances |
| 4 | Container escape doesn't grant vault access | Escape to host (simulated in test env) | Vault files encrypted — attacker gets ciphertext only |

### 7.8 Encryption Architecture (E2E)

> End-to-end verification that the encryption architecture described in Layer 1 holds
> across the full stack: master seed → HKDF → per-persona DEKs → SQLCipher.

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Full key derivation chain | BIP-39 → master seed → HKDF("dina:vault:identity:v1") → open identity.sqlite | Database opens successfully, contacts readable |
| 2 | Different HKDF info → different DEK | Derive keys for identity + personal with same seed | Two different 256-bit keys — identity DEK cannot open personal.sqlite |
| 3 | SLIP-0010 keys independent from HKDF DEKs | Compare signing key `m/9999'/0'` with HKDF("dina:vault:identity:v1") | Different key material — signing key ≠ vault DEK |
| 4 | Per-persona file isolation | Store data in `/personal`, attempt to read with `/health` DEK | `SQLITE_NOTADB` — wrong key |
| 5 | Locked persona: DEK never derived | Lock persona, dump core process memory | HKDF not called for locked persona — key material absent from RAM |
| 6 | Key wrapping roundtrip | Passphrase → Argon2id → KEK → wrap seed → unwrap seed → derive DEKs → open vault | Full roundtrip succeeds — same data accessible |
| 7 | Passphrase change: no re-encryption | Change passphrase → verify vault files unchanged | Vault `.sqlite` files untouched — only `wrapped_seed.bin` changes (re-wrapped with new KEK) |
| 8 | Convenience mode keyfile → same DEKs | Compare DEKs derived from keyfile vs passphrase-unwrapped seed | Identical DEKs — same master seed, same derivation |
| 9 | SQLCipher PRAGMAs enforced across stack | Open any persona vault, inspect PRAGMAs | `cipher_page_size=4096`, `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000` |
| 10 | Backup + Archive keys separate from vault DEKs | Derive backup, archive, sync, reputation keys | All different from each other and from vault DEKs — 6+ distinct keys from same seed |

### 7.9 Data Corruption Immunity (E2E)

> End-to-end verification of the 5-level corruption immunity stack:
> WAL → Pre-flight snapshot → ZFS → Off-site backup → Deep Archive.

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Protection 1: WAL survives power loss | Write 100 items → `SIGKILL` core mid-write → restart | All committed items present, incomplete write rolled back automatically by SQLite |
| 2 | Protection 1b: Single-writer pattern under load | 50 concurrent brain API calls (writes + reads) | Writes serialized via single write connection, reads unblocked, no `SQLITE_BUSY` errors |
| 3 | Protection 1b: Writes to different personas independent | Bulk-ingest into `/personal` while querying `/health` | No lock contention — different `.sqlite` files, fully independent |
| 4 | Protection 2: Pre-flight backup before migration | Trigger schema migration | `sqlcipher_export()` backup created BEFORE DDL, `PRAGMA integrity_check` passes, migration committed |
| 5 | Protection 2: Integrity failure → auto-rollback | Simulate corruption after DDL (before commit) | Transaction rolled back, vault restored from pre-flight backup, user alerted |
| 6 | Protection 2: VACUUM INTO never used | Code audit + CI/CD check | No `VACUUM INTO` in codebase — `sqlcipher_export()` is the only backup method |
| 7 | Protection 2: CI plaintext detection | Open backup as standard SQLite (no key) | File MUST NOT open — if it opens, build fails (catches VACUUM INTO regression) |
| 8 | Protection 4: Off-site backup encrypted | Trigger off-site backup, inspect uploaded blob | Encrypted with Backup Key — hosting provider sees opaque bytes |
| 9 | Full stack crash recovery | `docker compose kill -s SIGKILL` (all containers) → `docker compose up` | All services recover, vault intact (WAL rollback), outbox retried, no data loss |
| 10 | Batch ingestion atomicity | Brain sends 100-item batch, core killed mid-transaction | Either all 100 committed or zero committed — no partial batch |

---

## 8. Digital Estate (Dead Man's Switch)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Owner responds to challenge | Configurable interval passes → challenge sent | Owner responds → timer reset |
| 2 | Owner misses first challenge | First challenge unanswered | Second challenge sent (1 week later) |
| 3 | Owner misses all challenges | 3 challenges over 2 weeks unanswered | Digital estate activated |
| 4 | Beneficiary key derivation | Estate activated for beneficiary A | Beneficiary receives keys for scoped personas only |
| 5 | Beneficiary cannot access other personas | Beneficiary A tries persona not assigned to them | Access denied — key derivation only for assigned personas |
| 6 | False positive prevention | Owner on vacation (auto-reply configured) | Challenge deferred by auto-reply or manual pre-configuration |
| 7 | Estate cancellation | Owner returns after partial activation | Estate deactivated, all beneficiary keys revoked |
| 8 | Estate plan stored in Tier 0 | Inspect identity.sqlite | `estate_plan` JSON in identity.sqlite (Tier 0) with `trigger`, `switch_interval_days`, `beneficiaries[]`, `default_action` |
| 9 | Access type: `full_decrypt` | Beneficiary daughter receives `/persona/social` + `/persona/health` with `full_decrypt` | Per-beneficiary HKDF-derived keys for specified personas — full read/write access |
| 10 | Access type: `read_only_90_days` | Colleague receives `/persona/professional` with `read_only_90_days` | Time-limited read-only access — keys expire after 90 days |
| 11 | Default action: `destroy` | Estate fully executed, all beneficiary keys delivered | Remaining non-assigned data destroyed per `default_action: "destroy"` |
| 12 | Keys delivered via D2D | Estate activates | Per-beneficiary decryption keys delivered via Dina-to-Dina encrypted channel (beneficiaries must have Dina) |
| 13 | Configurable switch interval | `switch_interval_days: 180` | Challenge sent every 180 days instead of default 90 |
| 14 | Alternative trigger: manual with recovery phrase | Next-of-kin provides physical recovery phrase + death certificate | Estate activated via manual verification — no dead man's switch needed |
| 15 | Alternative trigger: multi-beneficiary threshold | 2 of 3 beneficiaries attest to death | Estate activated when threshold met — no single beneficiary can trigger alone |

---

## 9. Ingestion-to-Vault Pipeline (Full E2E)

### 9.1 MCP Delegation Pattern

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Email ingestion (full pipeline) | Brain→MCP→OpenClaw→Gmail API→metadata fetch→category filter→regex filter→LLM classify→full download→PII scrub→`POST core/v1/vault/store` | Relevant emails in vault with PII scrubbed, thin records for skipped |
| 2 | Calendar sync | Brain→MCP→OpenClaw→Calendar API→events fetched→dedup→vault store | Events stored, duplicates rejected |
| 3 | Contacts sync | Brain→MCP→OpenClaw→People API/CardDAV→daily sync | Contacts in identity.sqlite, merged with existing |
| 4 | Multi-connector sync | Gmail + Calendar + Contacts fire concurrently | All run independently, no interference |
| 5 | Ingestion with locked persona | Email for locked persona | Staged or spooled until persona unlocked |
| 6 | Ingestion dedup across restart | Ingest → restart → re-ingest same data | No duplicates in vault (Gmail message ID upsert) |
| 7 | Cursor continuity across restart | Brain syncs → restarts → syncs again | Reads cursor from `GET core/v1/vault/kv/gmail_cursor` → resumes from exact point |

### 9.2 WhatsApp Connector (Android → Core)

> WhatsApp bypasses MCP — phone pushes directly to Core via DIDComm.
> Uses CLIENT_TOKEN authentication, not BRAIN_TOKEN.

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | WhatsApp message push | Android NotificationListenerService captures message → encrypts → DIDComm push to core | Message stored in vault via core, brain notified |
| 2 | WhatsApp uses CLIENT_TOKEN | Phone pushes to core | Authenticated with CLIENT_TOKEN (device token), not BRAIN_TOKEN |
| 3 | WhatsApp text-only | Voice note notification | Text transcript of notification only — no media attached |
| 4 | WhatsApp no history | Install Dina, connect WhatsApp | Only new messages from install date — no history before Dina |

### 9.3 Ingestion Security Rules (E2E)

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Core never calls external APIs during ingestion | Network capture on core container during Gmail sync | Zero outbound HTTP from core — all fetching is Brain→MCP→OpenClaw |
| 2 | Data encrypted immediately | Brain stores item via `POST /v1/vault/store` | Core writes directly to SQLCipher database — no plaintext staging file |
| 3 | OpenClaw sandboxed | OpenClaw compromised (simulated) | Cannot read vault, keys, or personas — has no access to core APIs |
| 4 | Brain scrubs before cloud LLM | Brain sends data to cloud LLM for triage | PII scrubbed (Tier 1 + Tier 2) before any cloud call |
| 5 | OAuth tokens not in Dina | Inspect all vault tables + core config + brain config | Zero Gmail/Calendar OAuth tokens — all in OpenClaw |
| 6 | Phone connectors use CLIENT_TOKEN | WhatsApp push from phone | Authenticated WebSocket with CLIENT_TOKEN — bypasses MCP |
| 7 | Attachment metadata only in vault | Email with PDF attachment ingested | Vault contains `{filename, size, mime_type, source_id}` + summary — no binary blob |
| 8 | Sync status visible in admin UI | Navigate to admin dashboard | Last sync time, items ingested, OpenClaw state visible |

### 9.4 Startup Sync & Living Window (E2E)

> Fast sync (30 days) → "Ready" in seconds → background backfill (365 days).
> User queries preempt backfill.

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Fast sync: ready in seconds | Fresh install → first connect → Brain syncs last 30 days | System reports "Ready" after fast sync — user can query immediately |
| 2 | Background backfill | After fast sync | Brain fetches remaining 335 days in batches of 100. Progress visible in admin: "Gmail sync: 2400/8000 (30%)" |
| 3 | User query preempts backfill | User sends query during backfill | Backfill pauses, query processed with full priority, backfill resumes when idle |
| 4 | Time horizon enforced | Backfill reaches 365-day boundary | Historian stops — no data older than `DINA_HISTORY_DAYS` downloaded |
| 5 | Cold archive pass-through | User asks for 2022 invoice (beyond horizon) | Local search → not found → Brain→MCP→OpenClaw searches Gmail API directly → results shown → NOT saved to vault |
| 6 | OpenClaw outage during backfill | OpenClaw goes down mid-backfill | Brain state → DEGRADED/OFFLINE, cursor preserved, backfill resumes when OpenClaw recovers |

---

## 10. Data Flow Patterns (E2E)

> Tests the four data flow patterns from the architecture: writing (ingestion, brain-generated,
> embeddings), reading (simple search, semantic search, agentic multi-step), and the ownership
> boundaries (core = vault keeper, brain = analyst, llama = calculator).

### 10.1 Writing Patterns

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Ingestion: brain → MCP → core | Brain → MCP → OpenClaw → Gmail API → structured JSON → brain classifies content → `POST core/v1/vault/store {persona: "personal"}` → core stores | Item in vault with correct persona, PII-scrubbed |
| 2 | Content routing by brain | Email "Your lab results" from Dr. Patel | Brain classifies as health content (Phase 2: → `/health`, Phase 1: → `/personal`) |
| 3 | Same contact, different personas | Dr. Patel sends lab results AND cricket chat | Brain routes lab results → `/health`, cricket → `/social` (Phase 2) — contacts don't belong to personas |
| 4 | Brain-generated data stored via core | Brain creates draft/staging/relationship | `POST core/v1/vault/store {type: "draft"}` — brain never writes SQLite directly |
| 5 | Sync cursor stored as KV | Brain finishes Gmail sync | `PUT core/v1/vault/kv/gmail_cursor {timestamp: "2026-02-18T10:30:00Z"}` — next sync resumes from cursor |
| 6 | Batch ingestion: 5000-email initial sync | Brain fetches 5000 emails via MCP → triages in batches → `POST core/v1/vault/store/batch` (100 items per request) | 50 batch requests, each as single transaction — ~50x faster than individual writes, minimal WAL bloat |
| 7 | Batch ingestion: concurrent reads unblocked | Brain batch-ingests into `/personal` while user queries via WS | User queries hit read pool (no blocking) — write connection serializes batch inserts independently |
| 8 | Staging area: draft lifecycle | Brain creates draft → user reviews in admin UI → approves | Draft stored in staging (Tier 4) → moved to main vault on approval, staging entry deleted |
| 9 | Staging area: 72-hour expiry | Brain creates cart handover intent, user ignores | After 72 hours, staging item auto-deleted by core sweeper |

### 10.2 Embedding Pipeline (E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Embedding via local llama | Brain ingests item → calls `llama:8080` for embedding → `POST core/v1/vault/store {type: "embedding", vector: [...], source_id: "..."}` | 768-dim vector stored in sqlite-vec |
| 2 | Embedding via cloud (no llama) | Brain ingests item, llama absent → calls `gemini-embedding-001` (PII-scrubbed) → sends to core | Vector stored, PII never reached cloud |
| 3 | Core doesn't understand embeddings | Inspect core behavior | Core executes sqlite-vec INSERT — doesn't interpret vector, just stores it |
| 4 | Semantic search uses stored embedding | Store item + embedding → later search for similar concept | sqlite-vec cosine similarity finds the item |
| 5 | Embedding model migration: full re-index | Change embedding model config → restart | Core detects mismatch in `embedding_model` metadata → drops sqlite-vec index → brain re-embeds all items in background batches → new vectors stored |
| 6 | FTS5 available during re-indexing | Trigger embedding model migration → query during re-index | FTS5 keyword search works normally — only semantic search temporarily unavailable |
| 7 | Re-index scale | 50K items, ~25MB vectors | Full rebuild completes (~2-3h local llama, ~5min cloud API) — no dual-index needed |

### 10.3 Reading Patterns (E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Simple FTS5 search (fast path) | Client WS: "find emails from Sancho" → core → FTS5 query → results → client | Brain not involved, sub-10ms, core handles alone |
| 2 | Semantic search (brain orchestrates) | Client WS: "what was that deal Sancho was worried about?" → core → `POST brain/v1/reason` → brain generates embedding → `POST core/v1/vault/query {vector: [...]}` → brain merges FTS5 + cosine → LLM reasons → answer → core → client | Full semantic pipeline, brain drives, core serves |
| 3 | Hybrid search merge | Brain requests both FTS5 and semantic results | Results merged + deduplicated, `relevance = 0.4 × fts5_rank + 0.6 × cosine_similarity` |
| 4 | Agentic multi-step search | Sancho's Dina sends "arriving in 15 minutes" → core receives DIDComm → brain guardian loop → Step 1: relationship query → Step 2: message history → Step 3: upcoming events → Step 4: LLM assembles nudge → Step 5: core pushes to phone via WS | Full 5-step agentic flow with checkpoints between steps |
| 5 | Fast path vs brain path routing | Simple keyword query vs complex reasoning query | Core routes simple queries directly (FTS5), complex queries to brain |

### 10.4 Ownership Boundary Verification

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | Brain never opens SQLite | Network capture + filesystem audit | Brain accesses vault only via HTTP API to core — no SQLite file handles |
| 2 | Core never generates embeddings | Code audit + runtime trace | Core stores vectors but never calls LLM for embedding generation |
| 3 | Core never calls external APIs | Network capture on core container | Zero outbound calls to Gmail, Calendar, OpenClaw — core is sovereign kernel |
| 4 | Brain never talks to clients directly | Network capture on brain container | No WebSocket connections from brain — core mediates all client communication |
| 5 | llama is stateless | Kill llama → restart → query | No state lost — llama has no database, no business logic |
| 6 | OAuth tokens not in Dina | Inspect all vault tables + core config | OAuth tokens live in OpenClaw — core never holds external API credentials |
| 7 | Brain is stateless (verified) | Stop brain → delete brain container → recreate → start | Brain loads all state from core vault — no data loss. Brain has no database, no persistent files |

### 10.5 Action Layer (Draft-Don't-Send & Cart Handover E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Draft-Don't-Send: full flow | Email arrives → brain classifies as low-risk → `drafts.create` via MCP/OpenClaw → staging item in Tier 4 → user notified → user reviews in Gmail → user sends | Draft created, never auto-sent. User has full control. |
| 2 | Cart Handover: full flow | Brain recommends product → generates payment intent → staging item in Tier 4 → user taps [Pay Now] → OS opens payment app → user authorizes → outcome recorded | Dina never touches money. OS deep link handles payment. Outcome in Tier 3. |
| 3 | Agent delegation: form-fill via MCP | Brain detects license renewal → delegates to OpenClaw `form_fill` with `{draft_only: true}` → agent fills forms → stored in staging → user reviews | Agent respects `draft_only` constraint. No auto-submission. |
| 4 | Reminder loop: missed reminder on reboot | Reminder due 1 hour ago, core was down → core restarts → reminder fires immediately | `time.Until(trigger_at)` negative → immediate fire. No lost reminders. |
| 5 | Action layer never bypasses staging | All action types (drafts, carts, form-fills) | Everything goes through Tier 4 staging — user always gets a review gate |

---

## 11. Reputation Graph Integration

### 11.1 PDS Record Publishing

> Core signs records with user's Ed25519 key and publishes to PDS.
> Type B (bundled PDS, default): writes directly. Type A (external PDS): pushes outbound.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Publish expert attestation | Brain creates attestation → core signs with persona key → writes to PDS | Record in AT Protocol PDS with valid `com.dina.reputation.attestation` Lexicon |
| 2 | Publish outcome report | Dina records purchase outcome → anonymized → signed → PDS | `com.dina.reputation.outcome` record — no user identity, only category + outcome |
| 3 | Record signature valid | Fetch published record from PDS | Ed25519 signature verifies against author's DID Document public key |
| 4 | PDS cannot forge records | Inspect PDS data | PDS has no signing keys — stores signed Merkle repo, cannot create/modify records |
| 5 | Type B: bundled PDS in docker-compose | `docker compose up` | PDS container runs alongside core + brain, serves `com.dina.reputation.*` records |
| 6 | Type A: external PDS push | Home Node behind CGNAT (no inbound traffic) | Core pushes signed commits to external PDS via outbound HTTPS — zero inbound traffic to home node |
| 7 | Custom Lexicon validation | Publish record with wrong schema | PDS or core rejects — required fields enforced (`expertDid`, `productCategory`, `rating`, `verdict`) |

### 11.2 Record Integrity & Deletion

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Reputation tampering detected | Modify published record bytes | Signature verification fails — Merkle tree integrity broken |
| 2 | Author deletes own review (signed tombstone) | User sends deletion signed by same key | `Tombstone {target, author, sig}` — record removed from PDS, tombstone propagates |
| 3 | Non-author cannot delete review | Chair Company sends deletion for user's review | Signature doesn't match author → rejection — only keyholder can delete |
| 4 | Outcome data has no PII | Inspect published outcome record | Contains `reporter_trust_ring`, `product_category`, `outcome` — zero user identity or product specifics |
| 5 | Aggregate scores computed not stored | Query product reputation | Score computed from individual signed records — any AppView computes same score deterministically |

### 11.3 Reputation in Agent Decisions

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Reputation affects agent routing | Two MCP agents available, different reputation scores | Higher-reputation agent selected |
| 2 | Reputation affects trust tier | Contact accumulates positive outcome data | Trust level can be upgraded (Unverified → Verified) |
| 3 | Cold start: web search fallback (Phase 1) | No reputation data available | Brain→MCP→OpenClaw: web search for reviews + user context from vault → nudge with personal context applied |
| 4 | Gradual reputation activation | First reputation data appears in network | Brain includes reputation data alongside web search — transition invisible to user |

### 11.4 PDS Topology & Availability

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | PDS down: records already replicated | Bundled PDS container stops | Records already crawled by relay — reputation data still queryable via AppView |
| 2 | PDS migration (account portability) | User migrates from pds.dina.host to self-hosted PDS | `did:plc` rotation points to new PDS — all records transferred, identity preserved |
| 3 | Foundation PDS stores only reputation data | Inspect `pds.dina.host` content | Only `com.dina.reputation.*` records — no private vault data ever touches it |
| 4 | Relay crawls PDS via delta sync | PDS publishes new record → relay crawls | Merkle Search Tree diff — only new records transferred (few KB), not entire repo |

### 11.5 AT Protocol Discovery (E2E)

> Core must serve `GET /.well-known/atproto-did` for PDS federation to work.
> Without this, AT Protocol relays cannot find the PDS — federation silently fails.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Discovery → PDS federation | Core running with DID, PDS on port 2583 | `GET :8100/.well-known/atproto-did` returns `did:plc:abc123...` → relay resolves DID → discovers PDS at `:2583` → crawls successfully |
| 2 | Discovery endpoint available unauthenticated | No auth header | 200 with DID — public endpoint per AT Protocol spec |
| 3 | Discovery returns plain text DID | Inspect response | `Content-Type: text/plain`, body is bare DID string (not JSON) |
| 4 | Missing discovery → PDS federation fails | Remove `/.well-known/atproto-did` handler | Relay cannot find PDS — no records crawled, no federation |

---

## 12. Upgrade & Migration

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Schema migration on upgrade | New version with schema change → start | DDL migrations applied automatically |
| 2 | Data preserved across upgrade | Store data → upgrade → read data | All data intact |
| 3 | Rollback after failed migration | Migration fails mid-way | Database rolled back to pre-migration state |
| 4 | Config format change | New version expects new env vars | Clear error if old format detected |
| 5 | `dina export` → `dina import` roundtrip | Export from Node A, import on Node B | All vault data, personas, keys, contacts intact |
| 6 | Export/import preserves DID identity | Compare DID before and after migration | Same `did:key` — identity portable |
| 7 | Migration between hosting levels | Export from managed → import on self-hosted VPS | Identical functionality, all data accessible |
| 8 | Same Docker image across hosting levels | Run same image on managed, VPS, sovereign box | Identical startup behavior and API responses |
| 9 | Import rejects tampered archive | Modify archive bytes | Import fails with integrity/checksum error |
| 10 | Schema migration: identity.sqlite | Add new column to `contacts` table | Pre-flight backup → DDL in transaction → `PRAGMA integrity_check` → commit — data preserved |
| 11 | Schema migration: persona vault | Add new column to `vault_items` | Same pre-flight protocol — each persona file migrated independently |
| 12 | Schema migration: partial failure | Migration succeeds on `personal.sqlite`, fails on `health.sqlite` | `health.sqlite` rolled back to backup — `personal.sqlite` migration committed (independent files) |
| 13 | FTS5 rebuild after schema change | FTS5 content table altered | FTS5 index rebuilt (`INSERT INTO vault_items_fts(vault_items_fts) VALUES('rebuild')`) — search works after migration |

---

## 13. Performance & Load Tests

### 13.1 Throughput

| # | Test | Load | Target |
|---|------|------|--------|
| 1 | Concurrent WebSocket connections | 100 clients, each sending 1 query/s | All queries answered within 10s |
| 2 | Vault write throughput | 1000 items/s | All stored without error |
| 3 | Vault search under load | 100 concurrent searches, 100K items | P99 < 200ms |
| 4 | Inbound message handling | 50 Dina-to-Dina messages/s | All processed (spooled if persona locked) |
| 5 | Outbox drain rate | 1000 queued messages | All delivered within 5 minutes (healthy recipients) |

### 13.2 Latency

| # | Test | Flow | Target |
|---|------|------|--------|
| 1 | Query-to-response (local LLM) | WS query → core → brain → llama → brain → core → WS response | P50 < 3s, P99 < 10s |
| 2 | Query-to-response (cloud LLM) | WS query → core → brain → PII scrub → cloud → rehydrate → core → WS response | P50 < 5s, P99 < 15s |
| 3 | Message send latency | User sends message → outbox → delivered | P50 < 2s (recipient online) |
| 4 | Pairing completion | Code displayed → device submits → token issued | < 3s |

### 13.3 Resource Usage

| # | Test | Setup | Target |
|---|------|-------|--------|
| 1 | Core memory usage | Idle with 10K vault items | < 100 MiB RSS |
| 2 | Brain memory usage | Idle with spaCy model loaded | < 300 MiB RSS |
| 3 | LLM memory usage | Loaded with 4-bit quantized model | < 4 GiB RSS |
| 4 | Disk usage growth | 10K vault items + 1K messages | < 500 MiB total |
| 5 | Spool disk usage | Locked persona, max spool | Exactly 500 MiB cap (DINA_SPOOL_MAX) |

---

## 14. Chaos Engineering

| # | Scenario | Method | Expected |
|---|----------|--------|----------|
| 1 | Kill brain randomly | `docker kill brain` at random intervals | Core degrades gracefully, recovers when brain restarts |
| 2 | Kill core randomly | `docker kill core` at random intervals | Brain retries connection, recovers when core restarts |
| 3 | Network partition brain↔core | `iptables` drop between containers | Both detect failure, core opens circuit breaker, brain retries |
| 4 | Slow network | `tc` add 500ms latency | System remains functional, timeouts may trigger on extreme latency |
| 5 | CPU pressure | `stress-ng` on host | Responses slower but correct, no data loss |
| 6 | Memory pressure | Limit container memory to 50% | OOM kills handled by Docker restart policy |
| 7 | Disk I/O saturation | `fio` stress on data volume | Write latency increases, WAL handles correctly |

---

## 15. Compliance & Privacy

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | No PII in any log file | Grep all container logs for PII patterns | Zero matches |
| 2 | No PII in error messages | Trigger errors with PII input | Error messages contain redacted text only |
| 3 | Audit trail completeness | Perform 100 operations | All 100 appear in audit log with correct metadata |
| 4 | Data deletion (right to erasure) | Delete all data for persona | Vault wiped, audit entries indicate deletion, no residue |
| 5 | Data export (portability) | Export all vault data for persona | Complete JSON/CBOR export with all items |
| 6 | Consent tracking | Review all outbound data flows | Each flow has corresponding sharing policy consent |

---

## 16. Deferred (Phase 2+)

> These scenarios depend on features not yet implemented (rich client sync,
> on-device LLM, Confidential Computing). Include in active test suite when
> the corresponding phase ships.

### 16.1 Client Device Model

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Home Node available when all clients offline | Disconnect all client devices | Home Node continues accepting D2D messages, running sync, serving API |
| 2 | Client device offline doesn't affect Home Node | Kill phone client mid-session | Home Node operations uninterrupted, WS cleanup only |
| 3 | Rich client: local vault cache syncs on reconnect | Client goes offline → makes local changes → reconnects | Local changes synced to Home Node, conflicts resolved |
| 4 | Rich client: on-device LLM works offline | Client disconnected, user sends query | On-device model processes locally, limited capability |
| 5 | Rich client: full sync on reconnection | Client offline for 24h → reconnects | Vault delta sync, missed messages delivered, state converged |
| 6 | Thin client: no local storage | Inspect thin client after session | No vault data cached locally — WS relay only |
| 7 | Thin client: inoperable without Home Node | Home Node down, thin client attempts query | Error displayed — no offline capability |
| 8 | Multiple rich clients sync consistently | Two phones with local caches, both edit vault | Conflict resolution produces consistent state on both |
| 9 | Sync protocol: checkpoint mechanism | Rich client sends "last sync checkpoint = timestamp X" | Home Node responds with all `vault_items` changed since X |
| 10 | Sync protocol: client uploads local items | Phone captures WhatsApp messages while offline → reconnects | Client sends locally-created items to Home Node → Home Node applies and acknowledges |
| 11 | Conflict resolution: last-write-wins | Phone edits note offline, laptop edits same note offline, both reconnect | Home Node accepts later-timestamped write, earlier one logged as recoverable version |
| 12 | Conflict resolution: user review | Two conflicting edits | User can view "sync conflicts" view and choose preferred version |
| 13 | Most data is append-only | Ingested emails, calendar events | No conflict — ingestion is immutable append, conflicts only for user-editable data |
| 14 | New device = full sync | Pair new phone → connect | Full vault sync from Home Node — new device gets complete local cache |
| 15 | Corrupted client cache → re-sync | Client SQLite cache corrupted | Delete local cache → full re-sync from Home Node. Home Node is authoritative |
| 16 | Ongoing real-time push | Client connected via WS | Home Node pushes new items to connected clients in real-time. Client pushes local items immediately |
| 17 | Home Node failure: rich client offline read | Home Node down, rich client has cache | User can read cached data, do local searches, use on-device LLM. Cannot ingest or receive D2D |

### 16.2 Confidential Computing (Managed Hosting)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Enclave attestation verified by client | Home Node in AMD SEV-SNP / Intel TDX / Nitro Enclave | Client verifies attestation report before trusting node |
| 2 | Host root cannot read enclave memory | Root attacker on managed host | Plaintext keys/data invisible — hardware-enforced isolation |
| 3 | Enclave-sealed keys | Keys sealed to enclave measurement | Non-extractable even by hosting operator |

### 16.3 Progressive Disclosure Timeline

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Day 1: email + calendar ingestion, basic nudges | Onboarding complete | Functional, no multi-persona, no sharing rules |
| 2 | Day 7: mnemonic backup prompt | 7 days post-setup | User prompted to write down 24 words |
| 3 | Day 14: WhatsApp connector prompt | 14 days post-setup | "Want to connect WhatsApp too?" |
| 4 | Day 30: persona compartments prompt | 30 days post-setup | "Separate health and financial data?" |
| 5 | Month 3: power user discovery | 90 days post-setup | Personas, sharing rules, self-hosting visible in settings |

### 16.4 Local LLM Profile

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | `--profile local-llm` adds llama container | `docker compose --profile local-llm up` | 4 containers: core, brain, pds, llama |
| 2 | Without profile: 3 containers only | `docker compose up` | core, brain, pds — no llama |
| 3 | Brain routes to llama:8080 when available | llama running, brain sends completion | Response from local model |
| 4 | Brain falls back to cloud when llama absent | llama not started | Brain uses cloud LLM API (PII-scrubbed) |
| 5 | PII scrubbing without llama | No Tier 3 (LLM NER) | Regex (core Tier 1) + spaCy NER (brain Tier 2) still catch structured + contextual PII |

### 16.5 Multi-Lane Ingress Tiers

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Community tier: Tailscale Funnel | Node behind Tailscale Funnel | Accessible at `https://node.tailnet.ts.net`, auto-TLS, DID Document points to this URL |
| 2 | Production tier: Cloudflare Tunnel | Node behind `cloudflared` | Accessible at custom domain, WAF + geo-blocking active, DID Document updated |
| 3 | Sovereign tier: Yggdrasil mesh | Node on Yggdrasil network | Stable IPv6 from node public key, censorship-resistant, DID Document points to IPv6 |
| 4 | Tier change → DID rotation | Switch from Community → Production | Signed `did:plc` rotation operation updates service endpoint |
| 5 | Multiple tiers simultaneously | Tailscale + Cloudflare + Yggdrasil active | All three ingress paths work, same Dina identity |
| 6 | Wildcard relay (Foundation) | Node registers at `*.dina.host` via `frp` | Free secure subdomain, replaces Tailscale dependency for Community tier |

### 16.6 Forward Secrecy (Noise XX)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Noise XX handshake | Two Dina nodes establish session | Mutual authentication + forward-secret session keys |
| 2 | Key compromise doesn't expose past messages | Current session key leaked | Previously captured ciphertexts remain confidential |
| 3 | Session ratchet | Long-lived session | Keys rotate periodically, limiting exposure window |

### 16.7 Reputation AppView (Phase 2+)

> The AppView is a read-only indexer that consumes the AT Protocol firehose,
> filters for `com.dina.reputation.*` records, and serves a query API.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Firehose consumer filters correctly | AppView connected to relay | Only `com.dina.reputation.*` and `com.dina.identity.attestation` records indexed — all other Lexicons discarded |
| 2 | Cryptographic verification on every record | Signed record arrives in firehose | AppView verifies Ed25519 signature against author's DID Document — unsigned/invalid records rejected |
| 3 | Query API: reputation by DID | `GET /v1/reputation?did=did:plc:abc` | Returns aggregate score + individual signed records |
| 4 | Query API: product reputation | `GET /v1/product?id=herman_miller_aeron_2025` | Returns product score, review count, individual signed reviews |
| 5 | Query API: bot scores | `GET /v1/bot?did=did:plc:xyz` | Returns bot trust score, accuracy history |
| 6 | Signed payloads in API responses | Any query response | Includes raw signed record payloads alongside computed scores — enables client-side verification |
| 7 | Aggregate scores deterministic | Two AppViews process same firehose | Both compute identical product ratings and trust composites |

### 16.8 Three-Layer Verification (Phase 3)

> When multiple AppViews exist, agents verify the AppView's honesty.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Layer 1: Cryptographic proof | AppView returns reputation record | Agent verifies Ed25519 signature against author's public key — AppView cannot fake records |
| 2 | Layer 2: Consensus check (anti-censorship) | Agent queries two AppViews | Provider A returns 5 reviews, Provider B returns 50 → agent detects censorship, alerts user |
| 3 | Layer 3: Direct PDS spot-check | Random 1-in-100 audit | Agent bypasses AppView, resolves DID to PDS, fetches records via `com.atproto.repo.listRecords` — discrepancies downgrade AppView trust |
| 4 | Dishonest AppView abandoned | AppView caught censoring | Agent switches to competitor AppView — AppView is infrastructure, not gatekeeper |

### 16.9 Timestamp Anchoring (Phase 3)

> Periodic Merkle root hash anchored to L2 chain for tamper-proof timestamps.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Merkle root hash to L2 | 1000 signed reviews this week | Single Merkle root → anchored to L2 (Base/Arbitrum) in one transaction |
| 2 | Merkle proof verification | "Was this review in this week's batch?" | Check Merkle proof against on-chain root — verifiable |
| 3 | Hash reveals nothing | Inspect on-chain hash | Content-free — hash is meaningless without original data (privacy preserved) |
| 4 | Deletion + anchoring compatible | User deletes review via tombstone | Review removed from federation — on-chain hash orphaned, doesn't prevent deletion |

### 16.10 Bot Interface Protocol (Phase 2+)

> Specialist bots register with the Reputation Graph and expose a standard query API.
> Phase 1 uses OpenClaw as the sole external intelligence source.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Bot query format | Brain sends `POST bot/query` with `{query, requester_trust_ring, response_format, max_sources}` | Bot returns structured recommendations with sources, confidence, and `bot_signature` |
| 2 | Bot signature verification | Bot response includes `bot_did` + `bot_signature` | Brain verifies Ed25519 signature against bot's DID Document — forged responses rejected |
| 3 | Attribution mandatory | Bot response includes recommendations | Every source has `creator_name`, `source_url` — missing attribution → reputation penalty |
| 4 | Deep Link pattern default | Bot response with `deep_link` + `deep_link_context` | Brain presents source links to user — drives traffic to original creator, not extraction |
| 5 | Bot reputation: auto-route on low score | Bot accuracy drops below threshold | Brain automatically routes next query to next-best bot — no manual intervention |
| 6 | Bot reputation scoring factors | Inspect bot score computation | `f(response_accuracy, response_time, uptime, user_ratings, consistency, age, peer_endorsements)` — all factors weighted |
| 7 | Bot discovery: decentralized registry | Brain needs specialist bot | Queries Reputation Graph for bots in relevant domain, selects highest-reputation |
| 8 | Bot-to-bot recommendation | Bot says "This is outside my domain" | Redirects to specialist bot DID — Brain follows chain if trust is sufficient |

### 16.11 Push Notifications (Phase 1.5)

> When client is disconnected from WebSocket, Home Node uses platform push to wake it up.
> Push payload contains NO data — just "wake up and connect to your Home Node."

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Android: FCM wake-only push | Client disconnected, new D2D message arrives | Home Node sends FCM notification with empty data payload — phone wakes, connects WS, receives message |
| 2 | iOS: APNs wake-only push | Client disconnected, new D2D message arrives | Home Node sends APNs notification — same wake-only pattern |
| 3 | Push payload contains NO user data | Capture FCM/APNs payload | Zero content — no message text, no sender, no preview. Only signal: "connect to your Home Node" |
| 4 | While WS connected: no push needed | Client connected via WS | All notifications via WS push — FCM/APNs not used while connected |
| 5 | Phase 2: UnifiedPush (no Google dependency) | Android with UnifiedPush configured | Self-hosted push gateway — no FCM required |

### 16.12 Deployment Profiles (E2E)

> All profiles share identical vault, identity, messaging, and persona layers.
> Only inference backends differ.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Cloud LLM profile: 3 containers | `docker compose up -d` (default) | core, brain, pds running. No llama. Brain routes to cloud API |
| 2 | Local LLM profile: 4 containers | `docker compose --profile local-llm up -d` | core, brain, pds, llama all running. Brain auto-detects llama:8080 |
| 3 | Profile switch: cloud → local | Start cloud → `docker compose --profile local-llm up -d` | llama starts, brain detects and routes locally. Vault unchanged |
| 4 | Profile switch: local → cloud | Stop with profile → start without | llama stops, brain falls back to cloud. Vault unchanged |
| 5 | Always-local guarantees | Either profile | PII regex (core), vault crypto (core), DID signing (core), persona enforcement (core) — never leave Home Node |
| 6 | Sensitive persona rule enforced | Health query, cloud profile (no llama) | Entity Vault scrubbing mandatory — Tier 1+2 strip identifiers, cloud sees topics only. Requires user consent at setup |

---

## Appendix A: Test Environment Setup

### Docker Compose (test)

```yaml
# docker-compose.test.yml — isolated test environment
services:
  core:
    build: ./core
    environment:
      - DINA_DATA_DIR=/data
      - BRAIN_URL=http://brain:8200
      - DINA_LOG_LEVEL=debug
    volumes:
      - test-data:/data
    secrets:
      - brain_token

  brain:
    build: ./brain
    environment:
      - CORE_URL=http://core:8300
      - LLM_URL=http://llm:8080
      - DINA_LOG_LEVEL=debug
    secrets:
      - brain_token

  llm:
    image: ghcr.io/ggerganov/llama.cpp:server
    volumes:
      - ./data/models:/models
    command: ["--model", "/models/test-model.gguf", "--port", "8080", "--host", "0.0.0.0"]

volumes:
  test-data:

secrets:
  brain_token:
    file: ./secrets/brain_token
```

### Test Harness Tools

- **Go**: `go test` with `httptest.Server` for core unit/integration tests
- **Python**: `pytest` + `httpx.AsyncClient` + `pytest-asyncio` for brain tests
- **E2E**: `docker compose -f docker-compose.test.yml up` + test runner hitting APIs
- **Chaos**: `pumba` or `tc` for network fault injection
- **Load**: `k6` or `vegeta` for throughput/latency testing
- **Security**: `trivy` for container scanning, `gosec` for Go static analysis

## Appendix B: Test Priority Matrix

| Priority | Category | Rationale |
|----------|----------|-----------|
| P0 (Critical) | Authentication, key derivation, vault encryption, PII scrubbing | Security-critical: failure means data exposure |
| P0 (Critical) | Persona isolation, sharing policy enforcement | Privacy-critical: failure means unauthorized data access |
| P1 (High) | Core↔brain communication, crash recovery, outbox reliability | Reliability-critical: failure means data loss or service outage |
| P1 (High) | WebSocket protocol, device pairing, DID verification | User-facing: failure means broken user experience |
| P2 (Medium) | Admin UI, briefing generation, ingestion pipeline | Functional: failure degrades capability but doesn't expose data |
| P2 (Medium) | Docker networking, rate limiting, configuration | Operational: failure affects deployment but not core logic |
| P3 (Low) | Performance benchmarks, chaos engineering, reputation graph | Quality: failure affects non-functional requirements |
| P3 (Low) | Digital estate, upgrade/migration | Edge case: important but infrequent scenarios |
