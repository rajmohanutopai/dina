# Dina Integration Test Plan

> End-to-end tests spanning dina-core (Go) ↔ dina-brain (Python) ↔ llama.cpp (LLM)
> plus Dina-to-Dina communication, Docker networking, crash recovery, and security boundaries.

---

## 1. Core ↔ Brain Communication

### 1.1 BRAIN_TOKEN Shared Secret

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-001]** Both services share same token | Same `/run/secrets/brain_token` mounted | Core calls brain successfully, brain validates token |
| 2 | **[TST-INT-002]** Token mismatch | Different token files | Core→brain calls return 401, system non-functional |
| 3 | **[TST-INT-003]** Token rotation | Replace token file, restart both | New token accepted after restart |
| 4 | **[TST-INT-004]** Token file permissions | `chmod 600` on secret file | Only container user can read |

### 1.2 Request Flow: Core → Brain

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-005]** Forward user query | Core receives WS query → POST to brain `/v1/process` | Brain processes, returns response |
| 2 | **[TST-INT-006]** Forward inbound message | New Dina-to-Dina message arrives at core | Core delivers to brain for classification |
| 3 | **[TST-INT-007]** Agent intent verification | External agent submits intent via core API | Core forwards to brain guardian for approval |
| 4 | **[TST-INT-008]** Brain timeout | Brain takes >30s | Core circuit breaker opens, returns degraded response |
| 5 | **[TST-INT-009]** Brain crash | Brain container dies | Core watchdog detects, circuit breaker opens, queues requests |
| 6 | **[TST-INT-010]** Brain recovery | Brain container restarts | Watchdog detects health, circuit breaker closes, queued requests processed |

### 1.3 Request Flow: Brain → Core

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-011]** Read vault item | Brain needs context for query | Brain calls core `/v1/vault/items/{id}`, receives data |
| 2 | **[TST-INT-012]** Write vault item | Brain stores processed result | Brain calls core `POST /v1/vault/items`, 201 returned |
| 3 | **[TST-INT-013]** Search vault | Brain builds RAG context | Brain calls core `/v1/vault/search`, results returned |
| 4 | **[TST-INT-014]** Write scratchpad | Brain checkpoints task | Brain calls core `PUT /v1/vault/scratchpad/{task_id}` |
| 5 | **[TST-INT-015]** Send outbound message | Brain decides to notify contact | Brain calls core `POST /v1/msg/send`, message queued in outbox |
| 6 | **[TST-INT-016]** Core unreachable | Core container down | Brain retries with backoff, logs error |

---

## 2. End-to-End User Flows

### 2.1 User Query via WebSocket

> Full message envelope format from ARCHITECTURE.md §17 (WebSocket Protocol).

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-017]** Simple query | Client WS → `{"type":"auth","token":"..."}` → `auth_ok` → `{"type":"query","id":"req_001","payload":{"text":"Am I free at 3pm?","persona":"/personal"}}` → core → brain → LLM → brain → core → `{"type":"whisper","reply_to":"req_001","payload":{...}}` | User receives answer, `reply_to` links to original `id` |
| 2 | **[TST-INT-018]** Query with vault context | Client sends query → brain searches vault → builds context → LLM → `whisper` response with `sources` | Response includes `sources: ["calendar:event:abc123"]` referencing vault data |
| 3 | **[TST-INT-019]** Streaming response | Long answer → brain streams → core relays `{"type":"whisper_stream","reply_to":"req_001","payload":{"chunk":"..."}}` × N → final `whisper` | Client receives progressive chunks, terminated by final `whisper` message |
| 4 | **[TST-INT-020]** Query during brain outage | Client sends query, brain is down | Core returns `{"type":"error","reply_to":"req_001","payload":{"code":503,"message":"brain unavailable"}}` |
| 5 | **[TST-INT-021]** Proactive whisper (no request) | Brain detects incoming D2D event | Core pushes `{"type":"whisper","id":"evt_003","payload":{"text":"...","trigger":"didcomm:...","tier":2}}` — no `reply_to` (brain-initiated) |
| 6 | **[TST-INT-022]** System notification | Watchdog detects issue | Core sends `{"type":"system","id":"sys_004","payload":{"level":"warning","text":"Gmail hasn't synced in 48h."}}` |
| 7 | **[TST-INT-023]** Heartbeat round-trip | Connection idle for 30s | Core sends `{"type":"ping","ts":...}` → client responds `{"type":"pong","ts":...}` within 10s |
| 8 | **[TST-INT-024]** 3 missed pongs → disconnect | Client stops responding to pings | After 3 missed pongs, core closes connection, marks device offline |

### 2.2 User Query via Admin UI

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-025]** Browser → login → dashboard | Browser → core:8100 → login page → Argon2id auth → session cookie → dashboard | Dashboard displays with system status |
| 2 | **[TST-INT-026]** Dashboard → query | Submit query from dashboard → core proxy → brain → LLM → response | Response displayed in UI |
| 3 | **[TST-INT-027]** Session expiry | User idle past session TTL → next request | Redirect to login page |

### 2.3 Device Pairing Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-028]** Full pairing | Admin UI → "Pair Device" → 6-digit code displayed → new device submits code → CLIENT_TOKEN issued → device registered | New device can make authenticated API calls |
| 2 | **[TST-INT-029]** Pairing + immediate use | After pairing → device sends first query via WS | Query processed normally |
| 3 | **[TST-INT-030]** Paired device revocation | Admin revokes device → device tries API call | 401 on next request |

### 2.4 Persona Operations

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-031]** Create persona + store data | Create "work" persona → store item in work vault → verify not in "personal" vault | Data isolated per persona |
| 2 | **[TST-INT-032]** Lock persona + attempt access | Set persona to Locked → try reading vault → 403 → unlock with passphrase → read succeeds | Lock/unlock lifecycle works |
| 3 | **[TST-INT-033]** Locked persona + inbound message | Message arrives for locked persona → spooled → persona unlocked → message processed | 3-valve ingress handles locked personas |
| 4 | **[TST-INT-034]** Delete persona | Delete persona → verify vault wiped → verify DID deactivated → verify keys removed | Complete cleanup |

### 2.5 Onboarding Flow (Managed Hosting)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-035]** Full managed onboarding | User enters email + password | All 10 silent steps complete: mnemonic → SLIP-0010 → did:plc → HKDF → Argon2id wrap → SQLite created → convenience mode → brain starts → initial sync |
| 2 | **[TST-INT-036]** Post-onboarding: system functional | After setup completes | User can query via WS, admin UI accessible, initial data synced |
| 3 | **[TST-INT-037]** Only `/personal` persona exists | After onboarding | Single persona, no /health or /financial until user opts in |
| 4 | **[TST-INT-038]** Day 7: mnemonic backup prompt | 7 days after setup | User prompted to write down 24-word recovery phrase |
| 5 | **[TST-INT-039]** Cloud LLM PII consent (Cloud profile) | Onboarding with Cloud LLM profile | User shown: "Health/financial queries will be processed by cloud LLM. Names, orgs, locations scrubbed. Cloud sees topics, not identities." — must explicitly acknowledge |

### 2.6 Compromised Brain Simulation (E2E)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-040]** Brain with BRAIN_TOKEN: access open persona | Brain queries open persona vault | Data returned — expected damage radius |
| 2 | **[TST-INT-041]** Brain with BRAIN_TOKEN: blocked from locked persona | Brain queries locked persona | 403 from core — cannot access |
| 3 | **[TST-INT-042]** Brain with BRAIN_TOKEN: restricted creates trail | Brain queries restricted persona | Data returned, but audit entry + briefing notification visible to user |
| 4 | **[TST-INT-043]** Brain with BRAIN_TOKEN: cannot call admin endpoints | Brain calls `/v1/did/sign`, `/v1/vault/backup` etc. | 403 on every admin path |
| 5 | **[TST-INT-044]** Brain with BRAIN_TOKEN: PII scrubber enforced | Brain sends data to cloud LLM | Core-side PII gate scrubs before any outbound — brain cannot bypass |

---

## 3. Dina-to-Dina Communication

### 3.1 Connection Establishment (E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-045]** Full connection flow | Node A resolves Node B's DID → PLC Directory → extract endpoint → connect → mutual auth → send encrypted | Message delivered, both sides authenticated |
| 2 | **[TST-INT-046]** Mutual authentication required | Node A not in Node B's contacts | Node B rejects — both must have each other in contacts list |
| 3 | **[TST-INT-047]** DID Document endpoint extraction | Resolve `did:plc:sancho` | DID Document `service[0].serviceEndpoint` = `https://sancho:443/didcomm` |

### 3.2 Message Send Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-048]** Send message | User composes → brain formats tiered payload → `POST /v1/dina/send` → core checks sharing policy → core strips per tier → PII scrub → NaCl encrypt → outbox → deliver | Recipient receives correctly scoped encrypted message |
| 2 | **[TST-INT-049]** Sharing policy: summary tier | Send to contact with `availability: "free_busy"` | Brain sends `{summary: "Busy 2-3pm", full: "Meeting with Dr. Patel..."}` → Core picks summary only |
| 3 | **[TST-INT-050]** Sharing policy: full tier | Send to contact with `preferences: "full"` | Full details shared (still PII-scrubbed) |
| 4 | **[TST-INT-051]** Sharing policy: default-deny | Send to contact with no sharing policy defined | Message blocked — no data sent, user notified |
| 5 | **[TST-INT-052]** PII scrub on egress | Send to contact with `sharing: full` | Tier 1 + Tier 2 PII scrub → encrypted → sent |
| 6 | **[TST-INT-053]** Egress audit trail | Any D2D send | `audit_log` entry: timestamp, contact_did, each category, decision (allowed/denied), reason |

### 3.3 Message Receive Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-054]** Receive message (open persona) | Inbound → DID verification → decrypt → brain classifies priority → action taken | Message processed based on priority |
| 2 | **[TST-INT-055]** Receive message (locked persona) | Inbound → DID verification → persona locked → spooled to disk | 202 Accepted, spooled |
| 3 | **[TST-INT-056]** Spool overflow | Locked persona, spool at 500MB → new message | 429 Too Many Requests (reject-new, NOT drop-oldest) |
| 4 | **[TST-INT-057]** Unknown sender | Message from unresolvable DID | Rejected or quarantined per policy |

### 3.4 Bidirectional Communication

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-058]** Two Dina nodes exchange messages | Node A sends to Node B, Node B responds | Full roundtrip: encrypt → deliver → decrypt → process → encrypt → deliver → decrypt |
| 2 | **[TST-INT-059]** Concurrent bidirectional | Both nodes send simultaneously | Both messages delivered independently |
| 3 | **[TST-INT-060]** Message ordering | Node A sends 5 messages rapidly | Node B receives in order (outbox FIFO) |

### 3.5 The Sancho Moment (Full E2E Flow)

> Architecture's showcase scenario: the complete 9-step flow from geofence trigger to
> "you put the kettle on." Tests the entire D2D pipeline end-to-end.

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-061]** Sancho Moment: complete 9-step flow | (1) Sancho's phone pushes "departing_home" event → (2) Sancho's core checks sharing rules (you're in "close friends") → (3) Resolves your DID via PLC Directory → (4) Connects to your Home Node → (5) Sends `{type: "dina/social/arrival", eta: 15min, context: ["mother_ill"]}` → (6) Your core decrypts → (7) Brain queries vault: last interaction 3 weeks ago, mother was ill, tea preference → (8) Brain assembles nudge: "Sancho is 15 minutes away. His mother was ill. He likes strong chai." → (9) Core pushes notification to phone | Full pipeline works: sharing policy respected, encryption/decryption successful, vault context retrieved, nudge delivered to client |
| 2 | **[TST-INT-062]** Sancho Moment: sharing policy blocks context flag | Sancho's sharing policy has `context: "none"` for you | `context_flags: ["mother_ill"]` stripped at egress — your Dina gets arrival ETA but no context about mother |
| 3 | **[TST-INT-063]** Sancho Moment: your node offline during send | Sancho's Dina sends, your node is down | Message queued in Sancho's outbox, retried on backoff schedule, delivered when your node recovers |

### 3.6 Transport Reliability

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-064]** Recipient temporarily down | Send message, recipient offline | Outbox retries: 30s → 1m → 5m → 30m → 2h (exponential with jitter) |
| 2 | **[TST-INT-065]** Recipient recovers within retry window | Down for 2 minutes, then up | Message delivered on retry |
| 3 | **[TST-INT-066]** Recipient down beyond max retries (5) | Down for >3 hours | Status → `failed`, Tier 2 nudge to user: "Couldn't reach Sancho's Dina" |
| 4 | **[TST-INT-067]** Network partition then heal | Bidirectional network drop for 10 min | Both sides retry, messages eventually delivered |
| 5 | **[TST-INT-068]** Duplicate delivery prevention | Retry delivers message that was already received | Recipient deduplicates by message ID |
| 6 | **[TST-INT-069]** Relay fallback for NAT | Recipient behind CGNAT | DID Document points to relay → sender sends to relay → relay forwards encrypted blob |
| 7 | **[TST-INT-070]** Relay sees only encrypted blob | Inspect relay-forwarded message | Relay sees `{to: "did:plc:...", payload: "<encrypted>"}` — cannot read content |

---

## 4. LLM Integration

### 4.1 Local LLM (llama.cpp)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-071]** Brain → local LLM completion | Brain sends prompt to llm:8080 | Response returned, brain processes |
| 2 | **[TST-INT-072]** Local LLM timeout | LLM takes >60s (large prompt) | Brain times out, falls back to cloud or errors |
| 3 | **[TST-INT-073]** Local LLM crash | llama.cpp container dies | Brain detects, routes to cloud fallback (if configured) |
| 4 | **[TST-INT-074]** Model file missing | `/models/gemma-3n.gguf` absent | llama.cpp container fails to start, brain operates without local LLM |

### 4.2 Cloud LLM (with PII Protection)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-075]** Entity vault scrub → cloud call → rehydrate | Text with PII → scrub → send to cloud → response → rehydrate | Cloud LLM never sees PII, user sees full response |
| 2 | **[TST-INT-076]** Cloud LLM rate limited | Too many requests | Brain backs off, retries or falls back to local |
| 3 | **[TST-INT-077]** Cloud LLM returns PII tokens | Response contains `[PERSON_REDACTED]` | Tokens rehydrated from entity vault |
| 4 | **[TST-INT-078]** Cloud LLM unavailable | API returns 503 | Fallback to local LLM |

### 4.3 Full PII Pipeline (3-Tier E2E)

> Verifies the full PII scrubbing pipeline: Brain → Core Tier 1 (regex) → Brain Tier 2 (spaCy) →
> optional Tier 3 (llama) → cloud LLM → rehydrate.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-079]** Full Tier 1+2 pipeline | Text with email + person name + org | Core scrubs email (`[EMAIL_1]`), brain scrubs name/org (`[PERSON_1]`, `[ORG_1]`). Combined replacement map has all three. Cloud sees only tokens |
| 2 | **[TST-INT-080]** Replacement map round-trip | Scrub → cloud LLM call → response with tokens → rehydrate | All `[TOKEN_N]` tokens replaced with originals. User sees full names. Cloud never saw them |
| 3 | **[TST-INT-081]** Sensitive persona: health query via Entity Vault | "What did Dr. Sharma say about blood sugar at Apollo Hospital?" | Tier 1: no structured PII. Tier 2: `[PERSON_1]`, `[ORG_1]`. Cloud: "What did [PERSON_1] say about blood sugar at [ORG_1]?" — health *topic* visible, identity scrubbed |
| 4 | **[TST-INT-082]** PII scrubbing always local | Network capture on core + brain during scrub | Zero outbound HTTP calls for PII detection — scrubbing is regex (Go) + spaCy (Python), never cloud |
| 5 | **[TST-INT-083]** Tier 3 with local LLM profile | `--profile local-llm`, indirect reference | Tier 1+2+3 all run → highly indirect reference caught by llama NER |
| 6 | **[TST-INT-084]** Tier 3 absent gracefully | Cloud-only profile, indirect reference | Tiers 1+2 catch most PII. Indirect reference may pass — documented residual risk |

---

## 5. Docker Networking & Isolation

### 5.1 Bowtie Topology

> Core is the hub ("knot"). Brain and PDS are the loops. They never touch each other.
> Three Docker networks: `dina-public` (standard), `dina-brain-net` (standard), `dina-pds-net` (internal).

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | **[TST-INT-085]** Core can reach brain | `docker exec core wget -q --spider brain:8200/healthz` | 200 OK (both on `dina-brain-net`) |
| 2 | **[TST-INT-086]** Core can reach PDS | `docker exec core wget -q --spider pds:2583/xrpc/_health` | 200 OK (both on `dina-pds-net`) |
| 3 | **[TST-INT-087]** Brain CANNOT reach PDS | `docker exec brain wget -q --spider pds:2583` | Connection refused / no route — no shared network |
| 4 | **[TST-INT-088]** PDS CANNOT reach brain | `docker exec pds wget -q --spider brain:8200` | Connection refused / no route — no shared network |
| 5 | **[TST-INT-089]** Only core + PDS exposed on host | `curl localhost:8100` from host | 200; `curl localhost:8200` → refused; `curl localhost:2583` → PDS responds |
| 6 | **[TST-INT-090]** LLM not exposed (production) | `curl localhost:8080` from host | Connection refused — port not mapped in docker-compose |
| 7 | **[TST-INT-091]** Brain can reach internet (outbound) | `docker exec brain wget -q --spider https://api.google.com` | Connection succeeds — `dina-brain-net` is standard bridge (not internal) |
| 8 | **[TST-INT-092]** PDS cannot reach internet (outbound) | `docker exec pds wget -q --spider https://example.com` | Connection refused — `dina-pds-net` is `internal: true` (relay initiates inbound to PDS) |
| 9 | **[TST-INT-093]** Brain can reach `host.docker.internal` | `docker exec brain wget -q --spider http://host.docker.internal:3000` | OpenClaw on host reachable via `extra_hosts` directive |

### 5.2 Observability & Health (End-to-End)

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | **[TST-INT-094]** Core `/healthz` returns 200 | `docker exec core wget --spider http://localhost:8100/healthz` | 200 OK — HTTP server alive |
| 2 | **[TST-INT-095]** Core `/readyz` returns 200 (vault open) | `docker exec core wget --spider http://localhost:8100/readyz` | 200 OK — `db.PingContext()` succeeds |
| 3 | **[TST-INT-096]** Core `/readyz` returns 503 (vault locked) | Security mode, no passphrase provided yet | 503 — not ready |
| 4 | **[TST-INT-097]** Docker restarts unhealthy core | Block `/healthz` (simulate hang) | After 3 consecutive failures at 10s interval (30s), Docker kills + restarts core container |
| 5 | **[TST-INT-098]** Brain starts only after core healthy | `docker compose up` with slow core startup | Brain waits at `depends_on: core: condition: service_healthy` |
| 11 | **[TST-INT-099]** PDS healthcheck: `/xrpc/_health` | `docker exec pds wget --spider http://localhost:2583/xrpc/_health` | 200 OK — PDS serving AT Protocol |
| 12 | **[TST-INT-100]** PDS healthcheck params | Inspect compose healthcheck for PDS | `interval: 30s`, `timeout: 5s`, `retries: 3`, `start_period: 10s` |
| 6 | **[TST-INT-101]** Structured JSON logs from core | `docker logs core` | Every line is valid JSON with `time`, `level`, `msg`, `module` fields |
| 7 | **[TST-INT-102]** Structured JSON logs from brain | `docker logs brain` | Every line is valid JSON (structlog) |
| 8 | **[TST-INT-103]** No PII in any container log | Store PII data → query → grep all container logs | Zero matches for test PII values — only IDs, counts, latency logged |
| 9 | **[TST-INT-104]** Brain crash traceback in vault | Kill brain mid-task → restart → query crash_log | Crash entry in identity.sqlite with error type + full traceback |
| 10 | **[TST-INT-105]** Brain crash stdout has no PII | Kill brain mid-task → inspect Docker logs | Only sanitized one-liner: `guardian crash: RuntimeError at line 142` |
| 13 | **[TST-INT-106]** Docker log rotation configured | Inspect `docker-compose.yml` logging config for all services | Every service has `logging: {driver: "json-file", options: {max-size: "10m", max-file: "3"}}` — prevents storage exhaustion on unattended sovereign nodes (Section 04 §Observability). Without rotation, a crash loop filling stdout could fill disk and brick the Home Node |
| 14 | **[TST-INT-107]** Zombie state: healthcheck endpoint choice | Architecture note — Section 04 vs Section 17 discrepancy | Section 04 recommends Docker healthcheck use `/readyz` (catches zombie state: vault locked/corrupted but process alive). Section 17 uses `/healthz` (only catches process hang). Core §15.1 #5 expects Docker to restart on zombie state, but §5.2 #4 tests `/healthz` which wouldn't detect it. **Resolution needed**: if zombie detection is required, Docker healthcheck should use `/readyz`; if not, Core §15.1 #5 description should be updated. Current tests match Section 17 (`/healthz`) |

### 5.3 Boot Sequence (End-to-End)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-108]** Security mode boot: full stack | config.json `mode: "security"` | Core starts → prompts client → passphrase → vault unlocks → brain notified → system ready |
| 2 | **[TST-INT-109]** Convenience mode boot: full stack | config.json `mode: "convenience"`, keyfile present | Core starts → reads keyfile → vault auto-unlocks → brain notified → system ready |
| 3 | **[TST-INT-110]** Security mode: vault locked → dead drop active | Reboot in security mode, no passphrase yet | Core starts, brain starts, D2D messages spooled to inbox, WS clients get "vault locked" system message |
| 4 | **[TST-INT-111]** Security mode: late unlock | Vault locked for 2 hours → user provides passphrase | Vault unlocks → sweeper processes spool → brain catches up → full service restored |
| 5 | **[TST-INT-112]** Boot order: identity.sqlite before persona vaults | Either mode | identity.sqlite opened first (gatekeeper needs contacts), then personal.sqlite, other personas remain closed |
| 6 | **[TST-INT-113]** Brain receives vault_unlocked | Vault opens | Core sends `POST brain:8200/v1/process {event: "vault_unlocked"}`, brain initializes |

### 5.4 Container Dependencies

> Dependency chain: PDS starts first → Core starts after PDS (service_started) →
> Brain starts after Core is healthy (service_healthy). llama is independent.

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | **[TST-INT-114]** Core depends on PDS started | `docker compose up` | Core container starts after PDS has started (`depends_on: pds: condition: service_started`) |
| 2 | **[TST-INT-115]** Brain depends on core healthy | `docker compose up` | Brain starts only after core's healthcheck passes (`depends_on: core: condition: service_healthy`) |
| 3 | **[TST-INT-116]** Brain starts without core | Start brain alone | Brain starts, retries core connection with backoff |
| 4 | **[TST-INT-117]** LLM starts independently | Start LLM alone | Starts, loads model, ready on :8080 — no dependencies |
| 5 | **[TST-INT-118]** Full startup order | `docker compose up` fresh | PDS → Core → (core healthy) → Brain. All containers in `restart: unless-stopped` |

### 5.5 Volume Mounts & Data Layout

> Data volumes from docker-compose.yml §17. Brain is stateless — all state lives in core's vault.

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | **[TST-INT-119]** Vault data persists | Write data → stop stack → start stack → read data | Data present after restart |
| 2 | **[TST-INT-120]** Model files shared | LLM reads from `/models` mount | Model loaded from `./data/models/` on host |
| 3 | **[TST-INT-121]** Secret files mounted (tmpfs) | Inspect running containers | `/run/secrets/brain_token` present in core and brain, mounted as tmpfs (never on disk in container) |
| 4 | **[TST-INT-122]** Source mounts (dev mode) | Start with dev compose | Source directories mounted, hot-reload works |
| 5 | **[TST-INT-123]** Core data volume layout | Inspect `./data/` on host | `identity.sqlite`, `vault/personal.sqlite`, `keyfile` (convenience), `inbox/`, `config.json` — all at expected paths |
| 6 | **[TST-INT-124]** Brain is stateless | Stop brain → restart brain | Brain loads all state from core vault via API — no local database, no state files |
| 7 | **[TST-INT-125]** PDS data separate | Inspect `./data/pds/` | AT Protocol repo data in own directory — PDS manages its own storage |
| 8 | **[TST-INT-126]** llama models directory | Inspect `./data/models/` | GGUF model files stored here — auto-downloaded on first start if missing |

### 5.6 Bootstrap Script (`install.sh`)

> Run once before `docker compose up`. Generates secrets, creates directories, sets permissions.

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | **[TST-INT-127]** Creates required directories | Run `install.sh` on fresh system | `secrets/`, `data/vault/`, `data/inbox/`, `data/pds/`, `data/models/` all exist |
| 2 | **[TST-INT-128]** Generates BRAIN_TOKEN | Inspect `secrets/brain_token.txt` after install | 64 hex chars (32 bytes from `openssl rand -hex 32`) |
| 3 | **[TST-INT-129]** Prompts for passphrase | Run `install.sh` interactively | `read -s -p` prompts without echo — passphrase written to `secrets/dina_passphrase.txt` |
| 4 | **[TST-INT-130]** Sets file permissions | Inspect after install | `chmod 700 secrets`, `chmod 600 secrets/*` — only owner can access |
| 5 | **[TST-INT-131]** Idempotent: re-run safe | Run `install.sh` twice | Second run: `mkdir -p` succeeds (no error), existing secrets NOT overwritten (or prompts to confirm) |
| 6 | **[TST-INT-132]** docker compose up after install | `./install.sh && docker compose up -d` | All 3 containers start successfully — secrets mounted, vault initialized |

### 5.7 Secret Management Rules

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | **[TST-INT-133]** Secrets never in `docker inspect` output | `docker inspect dina-core` → check `Config.Env` | No `BRAIN_TOKEN`, `DINA_PASSPHRASE` in environment section |
| 2 | **[TST-INT-134]** Secrets at `/run/secrets/` inside container | `docker exec dina-core cat /run/secrets/brain_token` | Token present and readable by container process |
| 3 | **[TST-INT-135]** `GOOGLE_API_KEY` in `.env` (exception) | Inspect brain container env | API key visible in env — acceptable because it's a revocable cloud key, not a local credential |
| 4 | **[TST-INT-136]** `.gitignore` blocks secrets directory | `git status` after creating secrets | `secrets/` directory not tracked by git |
| 5 | **[TST-INT-137]** `BRAIN_TOKEN` shared by core and brain | Compare token in both containers | Identical value — same file mounted to both |

---

## 6. Crash Recovery & Resilience

### 6.1 Core Crash Recovery

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-138]** Core crash with pending outbox | Core has 5 messages in outbox → crash → restart | All 5 messages retried on startup |
| 2 | **[TST-INT-139]** Core crash during vault write | Write interrupted mid-transaction | SQLite WAL ensures atomicity, no corruption |
| 3 | **[TST-INT-140]** Core crash with active WS connections | 3 clients connected → crash → restart | Clients detect disconnect, reconnect, receive buffered messages |
| 4 | **[TST-INT-141]** Core crash with locked persona spool | Spooled messages for locked persona → crash → restart | Spool files intact, processed on unlock |

### 6.2 Brain Crash Recovery

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-142]** Brain crash mid-task | Guardian processing multi-step task → crash → restart | Reads scratchpad checkpoint, resumes from last step |
| 2 | **[TST-INT-143]** Brain crash with no checkpoint | Crash before first checkpoint | Task restarted from scratch |
| 3 | **[TST-INT-144]** Brain crash during LLM call | Waiting for LLM response → crash → restart | LLM call abandoned, task restarted (or resumed from checkpoint) |
| 4 | **[TST-INT-145]** Brain crash with pending briefing | Briefing generation in progress → crash → restart | Briefing re-generated from source data |

### 6.3 LLM Crash Recovery

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-146]** LLM crash during inference | llama.cpp dies mid-response | Brain times out, retries or falls back to cloud |
| 2 | **[TST-INT-147]** LLM OOM | Large prompt causes OOM kill | Docker restarts container, brain retries after watchdog detects recovery |
| 3 | **[TST-INT-148]** Corrupted model file | GGUF file corrupted | llama.cpp fails to load, brain operates in degraded mode |

### 6.4 Full Stack Crash

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-149]** Power loss simulation | `docker compose kill` (SIGKILL all) → `docker compose up` | All services recover, vault intact, outbox retried |
| 2 | **[TST-INT-150]** Disk full recovery | Fill disk → services fail → free space → restart | Services resume, data integrity maintained |

---

## 7. Security Boundary Tests

### 7.1 Data Flow Boundaries

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-151]** Raw vault data never reaches cloud LLM | Network capture during cloud LLM call | Only scrubbed text in request body |
| 2 | **[TST-INT-152]** PII never in outbound messages | Capture Dina-to-Dina message, decrypt | No PII in payload (Tier 1 + Tier 2 scrubbed) |
| 3 | **[TST-INT-153]** Vault DEK never leaves core | Inspect brain container memory/network | Brain never receives or stores DEKs |
| 4 | **[TST-INT-154]** Master seed never transmitted | Network capture all interfaces | Seed never appears in any network traffic |
| 5 | **[TST-INT-155]** Agent never sees full vault | Agent requests data | Agent receives answer to question, never raw vault items |

### 7.2 Cross-Persona Isolation

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-156]** Persona A data not in Persona B queries | Store in A, search from B | No results from A appear in B's search |
| 2 | **[TST-INT-157]** Persona A DEK cannot decrypt Persona B | Try A's DEK on B's vault file | `SQLITE_NOTADB` error |
| 3 | **[TST-INT-158]** Contact routing respects personas | Message for persona A contact | Routed to persona A only |
| 4 | **[TST-INT-159]** Admin can list all personas | Admin API call | All personas visible to admin |
| 5 | **[TST-INT-160]** Locked persona DEK not in RAM | Dump core process memory (test environment) | DEK absent when persona locked |
| 6 | **[TST-INT-161]** Sibling key cryptographic unlinkability | Derive persona 1 and persona 2 keys from same seed | No mathematical relationship between sibling keys — cannot derive one from the other (hardened derivation) |
| 7 | **[TST-INT-162]** Breach containment: one persona compromised | Attacker has `/health` DEK | Cannot read `/financial` data — different DEK, different file, different HKDF info string |
| 8 | **[TST-INT-163]** `GetPersonasForContact()` excludes locked | Dr. Patel has data in `/health` (locked) and `/social` (open) | Query returns only `/social` — locked personas invisible |
| 9 | **[TST-INT-164]** Cross-persona parallel reads | Brain requests 3 personas simultaneously | Core queries each open DB independently, returns separate JSON responses — no shared query context |

### 7.3 Authentication Boundaries

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-165]** No unauthenticated API access | Hit every endpoint without token | All return 401 (except health) |
| 2 | **[TST-INT-166]** BRAIN_TOKEN cannot perform admin actions | Use BRAIN_TOKEN on admin endpoints | 403 |
| 3 | **[TST-INT-167]** CLIENT_TOKEN cannot perform brain actions | Use CLIENT_TOKEN on brain endpoints | 403 |
| 4 | **[TST-INT-168]** Expired session cannot access admin | Use expired session cookie | 401, redirect to login |
| 5 | **[TST-INT-169]** Revoked device cannot access anything | Revoked CLIENT_TOKEN | 401 on all endpoints |

### 7.4 Network Attack Surface

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-170]** Port scan from external | Scan host ports | Only 8300 (and 8100 for admin) open |
| 2 | **[TST-INT-171]** Brain not accessible from outside Docker | `curl localhost:8200` from host | Connection refused |
| 3 | **[TST-INT-172]** Inter-container isolation | Brain → PDS, PDS → Brain | Both fail (bowtie network topology) |
| 4 | **[TST-INT-173]** Rate limiting on public endpoint | 200 requests/s to :8300 | Rate limiter triggers, 429 responses |
| 5 | **[TST-INT-174]** TLS certificate validation | HTTPS endpoint with invalid cert | Rejected (no insecure skip) |

### 7.5 Cryptographic Integrity

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-175]** Message tampering detected | Modify ciphertext of Dina-to-Dina message | Decryption fails (NaCl authenticated encryption) |
| 2 | **[TST-INT-176]** Replay attack prevention | Replay captured message | Rejected by message ID deduplication |
| 3 | **[TST-INT-177]** DID spoofing | Message with forged sender DID | Signature verification fails |
| 4 | **[TST-INT-178]** Key rotation | Rotate signing key, old messages still verifiable | Old signatures valid with old pubkey, new messages use new key |
| 5 | **[TST-INT-179]** Forward secrecy (Phase 2+) | Compromise current key | Past messages remain confidential (once Noise XX implemented) |
| 6 | **[TST-INT-180]** `did:plc` rotation: DID preserved | Rotate signing key via PLC Directory | Same `did:plc` identifier — contacts don't need to update anything |
| 7 | **[TST-INT-181]** `did:plc` → `did:web` escape | Simulate PLC Directory adversarial | Signed rotation op redirects to `did:web` endpoint — identity portable without PLC Directory |
| 8 | **[TST-INT-182]** BIP-39 recovery restores full identity | Enter 24-word mnemonic on new device | Same root DID, same persona DIDs, same vault DEKs — full sovereignty restored |

### 7.6 Data Sovereignty on Disk

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-183]** No plaintext vault files on disk | After vault operations: scan `DINA_DATA_DIR` for non-SQLCipher files | Only `.sqlite` (encrypted) files — no `.json`, `.csv`, `.tmp` with raw data |
| 2 | **[TST-INT-184]** Hosting provider sees only encrypted blobs | Read all files in data volume as raw bytes | No human-readable PII, no plaintext vault content |
| 3 | **[TST-INT-185]** No plaintext in container temp directories | Inspect `/tmp`, `/var/tmp` inside all containers | No vault data, no decrypted keys |
| 4 | **[TST-INT-186]** No plaintext in Docker layer cache | `docker history` + layer inspection | No secrets baked into image layers |
| 5 | **[TST-INT-187]** Logs contain no vault content | Grep all container logs for known test vault values | Zero matches — logs reference IDs only, not content |
| 6 | **[TST-INT-188]** FTS5 index encrypted by SQLCipher | Hex-dump persona `.sqlite` file, search for known plaintext | FTS5 index is inside SQLCipher database — `unicode61` tokens encrypted at rest, not searchable in raw bytes |
| 7 | **[TST-INT-189]** sqlite-vec embeddings encrypted | Hex-dump persona `.sqlite` file | Vector embeddings stored inside encrypted database — opaque bytes on disk |
| 8 | **[TST-INT-190]** WAL file encrypted | Inspect `-wal` file during active writes | SQLCipher WAL is encrypted with same key — no plaintext leakage in journal |

### 7.7 Multi-Tenant Isolation (Managed Hosting)

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-191]** Per-user SQLite isolation | Two users on same host, separate containers | Separate vault files, separate DEKs, no shared database |
| 2 | **[TST-INT-192]** User A compromise doesn't expose User B | Attacker has User A's DEK | Cannot decrypt User B's vault (different DEK, different file) |
| 3 | **[TST-INT-193]** No shared state between user containers | Inspect mounted volumes, IPC, shared memory | Zero shared writable state between user instances |
| 4 | **[TST-INT-194]** Container escape doesn't grant vault access | Escape to host (simulated in test env) | Vault files encrypted — attacker gets ciphertext only |

### 7.8 Encryption Architecture (E2E)

> End-to-end verification that the encryption architecture described in Layer 1 holds
> across the full stack: master seed → HKDF → per-persona DEKs → SQLCipher.

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-195]** Full key derivation chain | BIP-39 → master seed → HKDF("dina:vault:identity:v1") → open identity.sqlite | Database opens successfully, contacts readable |
| 2 | **[TST-INT-196]** Different HKDF info → different DEK | Derive keys for identity + personal with same seed | Two different 256-bit keys — identity DEK cannot open personal.sqlite |
| 3 | **[TST-INT-197]** SLIP-0010 keys independent from HKDF DEKs | Compare signing key `m/9999'/0'` with HKDF("dina:vault:identity:v1") | Different key material — signing key ≠ vault DEK |
| 4 | **[TST-INT-198]** Per-persona file isolation | Store data in `/personal`, attempt to read with `/health` DEK | `SQLITE_NOTADB` — wrong key |
| 5 | **[TST-INT-199]** Locked persona: DEK never derived | Lock persona, dump core process memory | HKDF not called for locked persona — key material absent from RAM |
| 6 | **[TST-INT-200]** Key wrapping roundtrip | Passphrase → Argon2id → KEK → wrap seed → unwrap seed → derive DEKs → open vault | Full roundtrip succeeds — same data accessible |
| 7 | **[TST-INT-201]** Passphrase change: no re-encryption | Change passphrase → verify vault files unchanged | Vault `.sqlite` files untouched — only `wrapped_seed.bin` changes (re-wrapped with new KEK) |
| 8 | **[TST-INT-202]** Convenience mode keyfile → same DEKs | Compare DEKs derived from keyfile vs passphrase-unwrapped seed | Identical DEKs — same master seed, same derivation |
| 9 | **[TST-INT-203]** SQLCipher PRAGMAs enforced across stack | Open any persona vault, inspect PRAGMAs | `cipher_page_size=4096`, `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000` |
| 10 | **[TST-INT-204]** Backup + Archive keys separate from vault DEKs | Derive backup, archive, sync, trust keys | All different from each other and from vault DEKs — 6+ distinct keys from same seed |
| 11 | **[TST-INT-205]** `user_salt` uniqueness across nodes | Set up two Dina instances with SAME BIP-39 mnemonic | Different `user_salt` generated → different HKDF outputs → Node A's vault DEKs ≠ Node B's vault DEKs — Node B cannot open Node A's persona files |
| 12 | **[TST-INT-206]** `user_salt` preserved in export/import | Export from Node A → import on Node B | Same `user_salt` → same DEKs → vault files open correctly on Node B |
| 13 | **[TST-INT-207]** Exactly one root identity enforced | Set up Dina → attempt second first-run setup | Second setup rejected — `did:plc` already registered, root keypair already exists |
| 14 | **[TST-INT-208]** SLIP-0010 persona index mapping E2E | Create all default personas → inspect signing keys | Consumer (`m/9999'/1'`), professional (`m/9999'/2'`), social (`m/9999'/3'`) — each persona's public key matches deterministic derivation from seed + index |

### 7.9 Data Corruption Immunity (E2E)

> End-to-end verification of the 5-level corruption immunity stack:
> WAL → Pre-flight snapshot → ZFS → Off-site backup → Deep Archive.

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-209]** Protection 1: WAL survives power loss | Write 100 items → `SIGKILL` core mid-write → restart | All committed items present, incomplete write rolled back automatically by SQLite |
| 2 | **[TST-INT-210]** Protection 1b: Single-writer pattern under load | 50 concurrent brain API calls (writes + reads) | Writes serialized via single write connection, reads unblocked, no `SQLITE_BUSY` errors |
| 3 | **[TST-INT-211]** Protection 1b: Writes to different personas independent | Bulk-ingest into `/personal` while querying `/health` | No lock contention — different `.sqlite` files, fully independent |
| 4 | **[TST-INT-212]** Protection 2: Pre-flight backup before migration | Trigger schema migration | `sqlcipher_export()` backup created BEFORE DDL, `PRAGMA integrity_check` passes, migration committed |
| 5 | **[TST-INT-213]** Protection 2: Integrity failure → auto-rollback | Simulate corruption after DDL (before commit) | Transaction rolled back, vault restored from pre-flight backup, user alerted |
| 6 | **[TST-INT-214]** Protection 2: VACUUM INTO never used | Code audit + CI/CD check | No `VACUUM INTO` in codebase — `sqlcipher_export()` is the only backup method |
| 7 | **[TST-INT-215]** Protection 2: CI plaintext detection | Open backup as standard SQLite (no key) | File MUST NOT open — if it opens, build fails (catches VACUUM INTO regression) |
| 8 | **[TST-INT-216]** Protection 4: Off-site backup encrypted | Trigger off-site backup, inspect uploaded blob | Encrypted with Backup Key — hosting provider sees opaque bytes |
| 9 | **[TST-INT-217]** Full stack crash recovery | `docker compose kill -s SIGKILL` (all containers) → `docker compose up` | All services recover, vault intact (WAL rollback), outbox retried, no data loss |
| 10 | **[TST-INT-218]** Batch ingestion atomicity | Brain sends 100-item batch, core killed mid-transaction | Either all 100 committed or zero committed — no partial batch |

---

## 8. Digital Estate (SSS Custodian Recovery)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-219]** Custodian threshold met | 3 of 5 custodians submit valid SSS shares | Estate mode activated, master seed reconstructed |
| 2 | **[TST-INT-220]** Below threshold | 2 of 5 custodians submit shares | Estate NOT activated — insufficient shares |
| 3 | **[TST-INT-221]** Invalid share submitted | 2 valid shares + 1 corrupted | Reconstruction fails, estate not activated |
| 4 | **[TST-INT-222]** Beneficiary key derivation | Estate activated for beneficiary A | Beneficiary receives keys for scoped personas only |
| 5 | **[TST-INT-223]** Beneficiary cannot access other personas | Beneficiary A tries persona not assigned to them | Access denied — key derivation only for assigned personas |
| 6 | **[TST-INT-224]** Estate plan stored in Tier 0 | Inspect identity.sqlite | `estate_plan` JSON in identity.sqlite (Tier 0) with `trigger`, `custodian_threshold`, `beneficiaries[]`, `default_action` |
| 7 | **[TST-INT-225]** Access type: `full_decrypt` | Beneficiary daughter receives `/persona/social` + `/persona/health` with `full_decrypt` | Per-beneficiary HKDF-derived keys for specified personas — full read/write access |
| 8 | **[TST-INT-226]** Access type: `read_only_90_days` | Colleague receives `/persona/professional` with `read_only_90_days` | Time-limited read-only access — keys expire after 90 days |
| 9 | **[TST-INT-227]** Default action: `destroy` | Estate fully executed, all beneficiary keys delivered | Remaining non-assigned data destroyed per `default_action: "destroy"` |
| 10 | **[TST-INT-228]** Keys delivered via D2D | Estate activates | Per-beneficiary decryption keys delivered via Dina-to-Dina encrypted channel (beneficiaries must have Dina) |
| 11 | **[TST-INT-229]** Manual trigger with recovery phrase | Next-of-kin provides physical recovery phrase + death certificate | Estate activated via manual verification — the primary human-initiated trigger for estate recovery |
| 12 | **[TST-INT-230]** SSS custodian coordination | 3 of 5 custodians present shares (some physical QR, some digital via D2D) | Estate activated when custodian threshold met — no single custodian can trigger alone. Shares are collected and verified; reconstruction requires the configured threshold (e.g., 3-of-5) |
| 13 | **[TST-INT-231]** Destruction gated on delivery confirmation | Estate activated, 2 of 3 beneficiaries reachable, 1 offline | Core does NOT execute `default_action: "destroy"` until ALL beneficiary key deliveries are confirmed via D2D acknowledgment. Offline beneficiary's keys remain in outbox with infinite retry. Destruction is irrecoverable — if data is destroyed before a beneficiary receives their persona DEKs, that data is permanently lost. Architecture §14 line 49: destroy is step 5 (last), after step 4 (deliver keys). Ordering is mandatory, not advisory |
| 14 | **[TST-INT-232]** Root seed NEVER in estate key payload | Estate activated, inspect D2D messages to beneficiaries | Each beneficiary receives ONLY the individual persona DEKs for their assigned personas — NOT the root seed, NOT the master key, NOT the wrapped_seed.bin. Architecture §14 line 47: "per-beneficiary decryption keys (derived from root, **limited to specified personas**)." If root seed were transmitted, any single beneficiary could derive ALL persona DEKs via HKDF, violating per-beneficiary scoping. Daughter with `/social` + `/health` keys CANNOT derive `/financial` DEK |

---

## 9. Ingestion-to-Vault Pipeline (Full E2E)

### 9.1 MCP Delegation Pattern

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-233]** Email ingestion (full pipeline) | Brain→MCP→OpenClaw→Gmail API→metadata fetch→category filter→regex filter→LLM classify→full download→PII scrub→`POST core/v1/vault/store` | Relevant emails in vault with PII scrubbed, thin records for skipped |
| 2 | **[TST-INT-234]** Calendar sync | Brain→MCP→OpenClaw→Calendar API→events fetched→dedup→vault store | Events stored, duplicates rejected |
| 3 | **[TST-INT-235]** Contacts sync | Brain→MCP→OpenClaw→People API/CardDAV→daily sync | Contacts in identity.sqlite, merged with existing |
| 4 | **[TST-INT-236]** Multi-connector sync | Gmail + Calendar + Contacts fire concurrently | All run independently, no interference |
| 5 | **[TST-INT-237]** Ingestion with locked persona | Email for locked persona | Staged or spooled until persona unlocked |
| 6 | **[TST-INT-238]** Ingestion dedup across restart | Ingest → restart → re-ingest same data | No duplicates in vault (Gmail message ID upsert) |
| 7 | **[TST-INT-239]** Cursor continuity across restart | Brain syncs → restarts → syncs again | Reads cursor from `GET core/v1/vault/kv/gmail_cursor` → resumes from exact point |
| 8 | **[TST-INT-240]** Calendar data fields preserved E2E | Calendar sync E2E | Events stored with: title, start/end time, attendees, location, description, recurrence rules — all fields queryable |
| 9 | **[TST-INT-241]** Contact data fields preserved E2E | Contacts sync E2E | Contacts stored with: name, phone numbers, emails, notes, relationships — all fields in identity.sqlite |
| 10 | **[TST-INT-242]** Calendar write operations E2E | User: "Book 2 PM Tuesday" | Brain→MCP→OpenClaw→Calendar API `events.insert` — write operation goes through MCP, not local vault. Local vault cache updated after write |
| 11 | **[TST-INT-243]** Calendar rolling window E2E | Calendar sync with vault query | Brain syncs -1 month to +1 year window. User asks "Am I free at 4 PM?" → brain queries local vault (zero network) → instant answer |

### 9.2 Telegram Connector (Bot API → Core)

> Telegram connector runs server-side on the Home Node via the official Bot API.
> Goes through MCP like other connectors. Uses BRAIN_TOKEN authentication.

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-244]** Telegram message ingestion | Bot API receives message on Home Node → forwards via MCP to core | Message stored in vault via core, brain notified |
| 2 | **[TST-INT-245]** Telegram uses BRAIN_TOKEN | Bot API connector communicates with core via MCP | Authenticated with BRAIN_TOKEN (server-side connector), not CLIENT_TOKEN |
| 3 | **[TST-INT-246]** Telegram full message+media | Voice note, photo, or document message | Full message content including media (text, photos, documents, voice notes) ingested |
| 4 | **[TST-INT-247]** Telegram no history | Add Dina bot to Telegram chat | Only new messages from when bot is added — no history before bot joins |
| 5 | **[TST-INT-248]** Telegram Bot API token revocation | Bot token revoked or invalidated | Connector handles gracefully — logs auth error, transitions to EXPIRED. Tier 2 notification: "Telegram bot token expired, please reconfigure" |
| 6 | **[TST-INT-249]** Telegram supports media attachments | Telegram message with photo/video/document | Full media content ingested alongside text. Media stored as metadata + summary in vault |

### 9.3 Ingestion Security Rules (E2E)

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-250]** Core never calls external APIs during ingestion | Network capture on core container during Gmail sync | Zero outbound HTTP from core — all fetching is Brain→MCP→OpenClaw |
| 2 | **[TST-INT-251]** Data encrypted immediately | Brain stores item via `POST /v1/vault/store` | Core writes directly to SQLCipher database — no plaintext staging file |
| 3 | **[TST-INT-252]** OpenClaw sandboxed | OpenClaw compromised (simulated) | Cannot read vault, keys, or personas — has no access to core APIs |
| 4 | **[TST-INT-253]** Brain scrubs before cloud LLM | Brain sends data to cloud LLM for triage | PII scrubbed (Tier 1 + Tier 2) before any cloud call |
| 5 | **[TST-INT-254]** OAuth tokens not in Dina | Inspect all vault tables + core config + brain config | Zero Gmail/Calendar OAuth tokens — all in OpenClaw |
| 6 | **[TST-INT-255]** Telegram connector uses BRAIN_TOKEN | Telegram Bot API on Home Node | Authenticated via MCP with BRAIN_TOKEN — server-side connector |
| 7 | **[TST-INT-256]** Attachment metadata only in vault | Email with PDF attachment ingested | Vault contains `{filename, size, mime_type, source_id}` + summary — no binary blob |
| 8 | **[TST-INT-257]** Sync status visible in admin UI | Navigate to admin dashboard | Last sync time, items ingested, OpenClaw state visible |

### 9.4 Startup Sync & Living Window (E2E)

> Fast sync (30 days) → "Ready" in seconds → background backfill (365 days).
> User queries preempt backfill.

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-258]** Fast sync: ready in seconds | Fresh install → first connect → Brain syncs last 30 days | System reports "Ready" after fast sync — user can query immediately |
| 2 | **[TST-INT-259]** Background backfill | After fast sync | Brain fetches remaining 335 days in batches of 100. Progress visible in admin: "Gmail sync: 2400/8000 (30%)" |
| 3 | **[TST-INT-260]** User query preempts backfill | User sends query during backfill | Backfill pauses, query processed with full priority, backfill resumes when idle |
| 4 | **[TST-INT-261]** Time horizon enforced | Backfill reaches 365-day boundary | Historian stops — no data older than `DINA_HISTORY_DAYS` downloaded |
| 5 | **[TST-INT-262]** Cold archive pass-through | User asks for 2022 invoice (beyond horizon) | Local search → not found → Brain→MCP→OpenClaw searches Gmail API directly → results shown → NOT saved to vault |
| 6 | **[TST-INT-263]** OpenClaw outage during backfill | OpenClaw goes down mid-backfill | Brain state → DEGRADED/OFFLINE, cursor preserved, backfill resumes when OpenClaw recovers |

---

## 10. Data Flow Patterns (E2E)

> Tests the four data flow patterns from the architecture: writing (ingestion, brain-generated,
> embeddings), reading (simple search, semantic search, agentic multi-step), and the ownership
> boundaries (core = vault keeper, brain = analyst, llama = calculator).

### 10.1 Writing Patterns

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-264]** Ingestion: brain → MCP → core | Brain → MCP → OpenClaw → Gmail API → structured JSON → brain classifies content → `POST core/v1/vault/store {persona: "personal"}` → core stores | Item in vault with correct persona, PII-scrubbed |
| 2 | **[TST-INT-265]** Content routing by brain | Email "Your lab results" from Dr. Patel | Brain classifies as health content (Phase 2: → `/health`, Phase 1: → `/personal`) |
| 3 | **[TST-INT-266]** Same contact, different personas | Dr. Patel sends lab results AND cricket chat | Brain routes lab results → `/health`, cricket → `/social` (Phase 2) — contacts don't belong to personas |
| 4 | **[TST-INT-267]** Brain-generated data stored via core | Brain creates draft/staging/relationship | `POST core/v1/vault/store {type: "draft"}` — brain never writes SQLite directly |
| 5 | **[TST-INT-268]** Sync cursor stored as KV | Brain finishes Gmail sync | `PUT core/v1/vault/kv/gmail_cursor {timestamp: "2026-02-18T10:30:00Z"}` — next sync resumes from cursor |
| 6 | **[TST-INT-269]** Batch ingestion: 5000-email initial sync | Brain fetches 5000 emails via MCP → triages in batches → `POST core/v1/vault/store/batch` (100 items per request) | 50 batch requests, each as single transaction — ~50x faster than individual writes, minimal WAL bloat |
| 7 | **[TST-INT-270]** Batch ingestion: concurrent reads unblocked | Brain batch-ingests into `/personal` while user queries via WS | User queries hit read pool (no blocking) — write connection serializes batch inserts independently |
| 8 | **[TST-INT-271]** Staging area: draft lifecycle | Brain creates draft → user reviews in admin UI → approves | Draft stored in staging (Tier 4) → moved to main vault on approval, staging entry deleted |
| 9 | **[TST-INT-272]** Staging area: 72-hour expiry | Brain creates cart handover intent, user ignores | After 72 hours, staging item auto-deleted by core sweeper |

### 10.2 Embedding Pipeline (E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-273]** Embedding via local llama | Brain ingests item → calls `llama:8080` for embedding → `POST core/v1/vault/store {type: "embedding", vector: [...], source_id: "..."}` | 768-dim vector stored in sqlite-vec |
| 2 | **[TST-INT-274]** Embedding via cloud (no llama) | Brain ingests item, llama absent → calls `gemini-embedding-001` (PII-scrubbed) → sends to core | Vector stored, PII never reached cloud |
| 3 | **[TST-INT-275]** Core doesn't understand embeddings | Inspect core behavior | Core executes sqlite-vec INSERT — doesn't interpret vector, just stores it |
| 4 | **[TST-INT-276]** Semantic search uses stored embedding | Store item + embedding → later search for similar concept | sqlite-vec cosine similarity finds the item |
| 5 | **[TST-INT-277]** Embedding model migration: full re-index | Change embedding model config → restart | Core detects mismatch in `embedding_model` metadata → drops sqlite-vec index → brain re-embeds all items in background batches → new vectors stored |
| 6 | **[TST-INT-278]** FTS5 available during re-indexing | Trigger embedding model migration → query during re-index | FTS5 keyword search works normally — only semantic search temporarily unavailable |
| 7 | **[TST-INT-279]** Re-index scale | 50K items, ~25MB vectors | Full rebuild completes (~2-3h local llama, ~5min cloud API) — no dual-index needed |

### 10.3 Reading Patterns (E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-280]** Simple FTS5 search (fast path) | Client WS: "find emails from Sancho" → core → FTS5 query → results → client | Brain not involved, sub-10ms, core handles alone |
| 2 | **[TST-INT-281]** Semantic search (brain orchestrates) | Client WS: "what was that deal Sancho was worried about?" → core → `POST brain/v1/reason` → brain generates embedding → `POST core/v1/vault/query {vector: [...]}` → brain merges FTS5 + cosine → LLM reasons → answer → core → client | Full semantic pipeline, brain drives, core serves |
| 3 | **[TST-INT-282]** Hybrid search merge | Brain requests both FTS5 and semantic results | Results merged + deduplicated, `relevance = 0.4 × fts5_rank + 0.6 × cosine_similarity` |
| 4 | **[TST-INT-283]** Agentic multi-step search | Sancho's Dina sends "arriving in 15 minutes" → core receives DIDComm → brain guardian loop → Step 1: relationship query → Step 2: message history → Step 3: upcoming events → Step 4: LLM assembles nudge → Step 5: core pushes to phone via WS | Full 5-step agentic flow with checkpoints between steps |
| 5 | **[TST-INT-284]** Fast path vs brain path routing | Simple keyword query vs complex reasoning query | Core routes simple queries directly (FTS5), complex queries to brain |

### 10.4 Ownership Boundary Verification

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-285]** Brain never opens SQLite | Network capture + filesystem audit | Brain accesses vault only via HTTP API to core — no SQLite file handles |
| 2 | **[TST-INT-286]** Core never generates embeddings | Code audit + runtime trace | Core stores vectors but never calls LLM for embedding generation |
| 3 | **[TST-INT-287]** Core never calls external APIs | Network capture on core container | Zero outbound calls to Gmail, Calendar, OpenClaw — core is sovereign kernel |
| 4 | **[TST-INT-288]** Brain never talks to clients directly | Network capture on brain container | No WebSocket connections from brain — core mediates all client communication |
| 5 | **[TST-INT-289]** llama is stateless | Kill llama → restart → query | No state lost — llama has no database, no business logic |
| 6 | **[TST-INT-290]** OAuth tokens not in Dina | Inspect all vault tables + core config | OAuth tokens live in OpenClaw — core never holds external API credentials |
| 7 | **[TST-INT-291]** Brain is stateless (verified) | Stop brain → delete brain container → recreate → start | Brain loads all state from core vault — no data loss. Brain has no database, no persistent files |

### 10.5 Action Layer (Draft-Don't-Send & Cart Handover E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | **[TST-INT-292]** Draft-Don't-Send: full flow | Email arrives → brain classifies as low-risk → `drafts.create` via MCP/OpenClaw → staging item in Tier 4 → user notified → user reviews in Gmail → user sends | Draft created, never auto-sent. User has full control. |
| 2 | **[TST-INT-293]** Cart Handover: full flow | Brain recommends product → generates payment intent → staging item in Tier 4 → user taps [Pay Now] → OS opens payment app → user authorizes → outcome recorded | Dina never touches money. OS deep link handles payment. Outcome in Tier 3. |
| 3 | **[TST-INT-294]** Agent delegation: form-fill via MCP | Brain detects license renewal → delegates to OpenClaw `form_fill` with `{draft_only: true}` → agent fills forms → stored in staging → user reviews | Agent respects `draft_only` constraint. No auto-submission. |
| 4 | **[TST-INT-295]** Reminder loop: missed reminder on reboot | Reminder due 1 hour ago, core was down → core restarts → reminder fires immediately | `time.Until(trigger_at)` negative → immediate fire. No lost reminders. |
| 5 | **[TST-INT-296]** Action layer never bypasses staging | All action types (drafts, carts, form-fills) | Everything goes through Tier 4 staging — user always gets a review gate |

---

## 11. Trust Network Integration

### 11.1 PDS Record Publishing

> Core signs records with user's Ed25519 key and publishes to PDS.
> Type B (bundled PDS, default): writes directly. Type A (external PDS): pushes outbound.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-297]** Publish expert attestation | Brain creates attestation → core signs with persona key → writes to PDS | Record in AT Protocol PDS with valid `com.dina.trust.attestation` Lexicon |
| 2 | **[TST-INT-298]** Publish outcome report | Dina records purchase outcome → anonymized → signed → PDS | `com.dina.trust.outcome` record — no user identity, only category + outcome |
| 3 | **[TST-INT-299]** Record signature valid | Fetch published record from PDS | Ed25519 signature verifies against author's DID Document public key |
| 4 | **[TST-INT-300]** PDS cannot forge records | Inspect PDS data | PDS has no signing keys — stores signed Merkle repo, cannot create/modify records |
| 5 | **[TST-INT-301]** Type B: bundled PDS in docker-compose | `docker compose up` | PDS container runs alongside core + brain, serves `com.dina.trust.*` records |
| 6 | **[TST-INT-302]** Type A: external PDS push | Home Node behind CGNAT (no inbound traffic) | Core pushes signed commits to external PDS via outbound HTTPS — zero inbound traffic to home node |
| 7 | **[TST-INT-303]** Custom Lexicon validation | Publish record with wrong schema | PDS or core rejects — all 5 required fields enforced (`expertDid`, `productCategory`, `productId`, `rating`, `verdict`) |

### 11.2 Record Integrity & Deletion

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-304]** Trust tampering detected | Modify published record bytes | Signature verification fails — Merkle tree integrity broken |
| 2 | **[TST-INT-305]** Author deletes own review (signed tombstone) | User sends deletion signed by same key | `Tombstone {target, author, sig}` — record removed from PDS, tombstone propagates |
| 3 | **[TST-INT-306]** Non-author cannot delete review | Chair Company sends deletion for user's review | Signature doesn't match author → rejection — only keyholder can delete |
| 4 | **[TST-INT-307]** Outcome data exact anonymized fields — no PII | Inspect published outcome record | Exact fields per Section 08 `com.dina.trust.outcome` Lexicon: `{type: "outcome_report", reporter_trust_ring, reporter_age_days, product_category, product_id, purchase_verified, purchase_amount_range, time_since_purchase_days, outcome, satisfaction, issues, timestamp, signature}` — 13 fields total. Zero user identity (no DID, no name). Zero seller identity (only trust ring). reporter_trust_ring/age_days are the submitting Dina's ring level and age. purchase_amount_range uses bucketed format (e.g. "50000-100000_INR"). satisfaction is categorical (positive/negative/neutral). issues is an array (empty if none) |
| 5 | **[TST-INT-308]** Aggregate scores computed not stored | Query product trust | Score computed from individual signed records — any AppView computes same score deterministically |
| 6 | **[TST-INT-309]** Outcome data lifecycle E2E | Cart handover → weeks → follow-up → anonymized record → PDS | Full flow: (1) purchase via cart handover — Brain records `{product_category, seller_dina_id, price, timestamp}`, (2) weeks/months later Brain asks "How's that chair?", (3) user responds or Brain infers (still using? returned?), (4) anonymized outcome record created with Section 08 Lexicon fields (13 fields: type, reporter_trust_ring, reporter_age_days, product_category, product_id, purchase_verified, purchase_amount_range, time_since_purchase_days, outcome, satisfaction, issues, timestamp, signature), (5) signed with Trust Signing Key (HKDF "dina:trust:v1"), (6) submitted to Trust Network via PDS |
| 7 | **[TST-INT-310]** Outcome report full Lexicon field validation | Inspect each field of published outcome record | Validate every field matches `com.dina.trust.outcome` Lexicon constraints: `type` = "outcome_report" (string literal), `reporter_trust_ring` = integer (1-3), `reporter_age_days` = integer (≥0), `product_category` = string, `product_id` = string, `purchase_verified` = boolean, `purchase_amount_range` = string (bucketed format e.g. "50000-100000_INR"), `time_since_purchase_days` = integer (≥0), `outcome` = string enum (still_using/returned/broken/gifted), `satisfaction` = string enum (positive/negative/neutral), `issues` = array of strings (may be empty), `timestamp` = datetime ISO-8601, `signature` = Ed25519 hex string |

### 11.3 Trust in Agent Decisions

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-311]** Trust affects agent routing | Two MCP agents available, different trust scores | Higher-trust agent selected |
| 2 | **[TST-INT-312]** Trust affects trust tier | Contact accumulates positive outcome data | Trust level can be upgraded (Unverified → Verified) |
| 3 | **[TST-INT-313]** Cold start: web search fallback (Phase 1) | No trust data available | Brain→MCP→OpenClaw: web search for reviews + user context from vault → nudge with personal context applied |
| 4 | **[TST-INT-314]** Gradual trust activation | First trust data appears in network | Brain includes trust data alongside web search — transition invisible to user |
| 5 | **[TST-INT-315]** Cold start: personal context enrichment | Brain searches web for "best office chair" — user vault has back pain history, 10+ hour sitting, ₹50-80K budget | Brain synthesizes web results with personal vault context: "Based on web reviews and your back issues, the Steelcase Leap or Herman Miller Aeron. The Aeron is within your budget at ₹72,000." — vault data applied, not just raw web results |

### 11.4 PDS Topology & Availability

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-316]** PDS down: records already replicated | Bundled PDS container stops | Records already crawled by relay — trust data still queryable via AppView |
| 2 | **[TST-INT-317]** PDS migration (account portability) | User migrates from pds.dina.host to self-hosted PDS | `did:plc` rotation points to new PDS — all records transferred, identity preserved |
| 3 | **[TST-INT-318]** Foundation PDS stores only trust data | Inspect `pds.dina.host` content | Only `com.dina.trust.*` records — no private vault data ever touches it |
| 4 | **[TST-INT-319]** Relay crawls PDS via delta sync | PDS publishes new record → relay crawls | Merkle Search Tree diff — only new records transferred (few KB), not entire repo |

### 11.5 AT Protocol Discovery (E2E)

> Core must serve `GET /.well-known/atproto-did` for PDS federation to work.
> Without this, AT Protocol relays cannot find the PDS — federation silently fails.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-320]** Discovery → PDS federation | Core running with DID, PDS on port 2583 | `GET :8100/.well-known/atproto-did` returns `did:plc:abc123...` → relay resolves DID → discovers PDS at `:2583` → crawls successfully |
| 2 | **[TST-INT-321]** Discovery endpoint available unauthenticated | No auth header | 200 with DID — public endpoint per AT Protocol spec |
| 3 | **[TST-INT-322]** Discovery returns plain text DID | Inspect response | `Content-Type: text/plain`, body is bare DID string (not JSON) |
| 4 | **[TST-INT-323]** Missing discovery → PDS federation fails | Remove `/.well-known/atproto-did` handler | Relay cannot find PDS — no records crawled, no federation |

---

## 12. Upgrade & Migration

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-324]** Schema migration on upgrade | New version with schema change → start | DDL migrations applied automatically |
| 2 | **[TST-INT-325]** Data preserved across upgrade | Store data → upgrade → read data | All data intact |
| 3 | **[TST-INT-326]** Rollback after failed migration | Migration fails mid-way | Database rolled back to pre-migration state |
| 4 | **[TST-INT-327]** Config format change | New version expects new env vars | Clear error if old format detected |
| 5 | **[TST-INT-328]** `dina export` → `dina import` roundtrip | Export from Node A, import on Node B | All vault data, personas, keys, contacts intact |
| 6 | **[TST-INT-329]** Export/import preserves DID identity | Compare DID before and after migration | Same `did:key` — identity portable |
| 7 | **[TST-INT-330]** Migration between hosting levels | Export from managed → import on self-hosted VPS | Identical functionality, all data accessible |
| 8 | **[TST-INT-331]** Same Docker image across hosting levels | Run same image on managed, VPS, sovereign box | Identical startup behavior and API responses |
| 9 | **[TST-INT-332]** Import rejects tampered archive | Modify archive bytes | Import fails with integrity/checksum error |
| 10 | **[TST-INT-333]** Schema migration: identity.sqlite | Add new column to `contacts` table | Pre-flight backup → DDL in transaction → `PRAGMA integrity_check` → commit — data preserved |
| 11 | **[TST-INT-334]** Schema migration: persona vault | Add new column to `vault_items` | Same pre-flight protocol — each persona file migrated independently |
| 12 | **[TST-INT-335]** Schema migration: partial failure | Migration succeeds on `personal.sqlite`, fails on `health.sqlite` | `health.sqlite` rolled back to backup — `personal.sqlite` migration committed (independent files) |
| 13 | **[TST-INT-336]** FTS5 rebuild after schema change | FTS5 content table altered | FTS5 index rebuilt (`INSERT INTO vault_items_fts(vault_items_fts) VALUES('rebuild')`) — search works after migration |
| 14 | **[TST-INT-337]** Import invalidates all device tokens | Export from Node A (3 paired devices) → import on Node B → attempt WS auth with old CLIENT_TOKENs | All old tokens rejected (401) — devices must re-pair with Node B. Architecture §17 token lifecycle: "Re-pair: after import/restore, all tokens invalidated → re-pair required." If tokens survive import, devices paired to Node A could authenticate to Node B — security gap when migrating between hosting providers |

---

## 13. Performance & Load Tests

### 13.1 Throughput

| # | Test | Load | Target |
|---|------|------|--------|
| 1 | **[TST-INT-338]** Concurrent WebSocket connections | 100 clients, each sending 1 query/s | All queries answered within 10s |
| 2 | **[TST-INT-339]** Vault write throughput | 1000 items/s | All stored without error |
| 3 | **[TST-INT-340]** Vault search under load | 100 concurrent searches, 100K items | P99 < 200ms |
| 4 | **[TST-INT-341]** Inbound message handling | 50 Dina-to-Dina messages/s | All processed (spooled if persona locked) |
| 5 | **[TST-INT-342]** Outbox drain rate | 1000 queued messages | All delivered within 5 minutes (healthy recipients) |

### 13.2 Latency

| # | Test | Flow | Target |
|---|------|------|--------|
| 1 | **[TST-INT-343]** Query-to-response (local LLM) | WS query → core → brain → llama → brain → core → WS response | P50 < 3s, P99 < 10s |
| 2 | **[TST-INT-344]** Query-to-response (cloud LLM) | WS query → core → brain → PII scrub → cloud → rehydrate → core → WS response | P50 < 5s, P99 < 15s |
| 3 | **[TST-INT-345]** Message send latency | User sends message → outbox → delivered | P50 < 2s (recipient online) |
| 4 | **[TST-INT-346]** Pairing completion | Code displayed → device submits → token issued | < 3s |

### 13.3 Resource Usage

| # | Test | Setup | Target |
|---|------|-------|--------|
| 1 | **[TST-INT-347]** Core memory usage | Idle with 10K vault items | < 100 MiB RSS |
| 2 | **[TST-INT-348]** Brain memory usage | Idle with spaCy model loaded | < 300 MiB RSS |
| 3 | **[TST-INT-349]** LLM memory usage | Loaded with 4-bit quantized model | < 4 GiB RSS |
| 4 | **[TST-INT-350]** Disk usage growth | 10K vault items + 1K messages | < 500 MiB total |
| 5 | **[TST-INT-351]** Spool disk usage | Locked persona, max spool | Exactly 500 MiB cap (DINA_SPOOL_MAX) |

---

## 14. Chaos Engineering

| # | Scenario | Method | Expected |
|---|----------|--------|----------|
| 1 | **[TST-INT-352]** Kill brain randomly | `docker kill brain` at random intervals | Core degrades gracefully, recovers when brain restarts |
| 2 | **[TST-INT-353]** Kill core randomly | `docker kill core` at random intervals | Brain retries connection, recovers when core restarts |
| 3 | **[TST-INT-354]** Network partition brain↔core | `iptables` drop between containers | Both detect failure, core opens circuit breaker, brain retries |
| 4 | **[TST-INT-355]** Slow network | `tc` add 500ms latency | System remains functional, timeouts may trigger on extreme latency |
| 5 | **[TST-INT-356]** CPU pressure | `stress-ng` on host | Responses slower but correct, no data loss |
| 6 | **[TST-INT-357]** Memory pressure | Limit container memory to 50% | OOM kills handled by Docker restart policy |
| 7 | **[TST-INT-358]** Disk I/O saturation | `fio` stress on data volume | Write latency increases, WAL handles correctly |

---

## 15. Compliance & Privacy

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | **[TST-INT-359]** No PII in any log file | Grep all container logs for PII patterns | Zero matches |
| 2 | **[TST-INT-360]** No PII in error messages | Trigger errors with PII input | Error messages contain redacted text only |
| 3 | **[TST-INT-361]** Audit trail completeness | Perform 100 operations | All 100 appear in audit log with correct metadata |
| 4 | **[TST-INT-362]** Data deletion (right to erasure) | Delete all data for persona | Vault wiped, audit entries indicate deletion, no residue |
| 5 | **[TST-INT-363]** Data export (portability) | Export all vault data for persona | Complete JSON/CBOR export with all items |
| 6 | **[TST-INT-364]** Consent tracking | Review all outbound data flows | Each flow has corresponding sharing policy consent |

---

## 16. Deferred (Phase 2+)

> These scenarios depend on features not yet implemented (rich client sync,
> on-device LLM, Confidential Computing). Include in active test suite when
> the corresponding phase ships.

### 16.1 Client Device Model

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-365]** Home Node available when all clients offline | Disconnect all client devices | Home Node continues accepting D2D messages, running sync, serving API |
| 2 | **[TST-INT-366]** Client device offline doesn't affect Home Node | Kill phone client mid-session | Home Node operations uninterrupted, WS cleanup only |
| 3 | **[TST-INT-367]** Rich client: local vault cache syncs on reconnect | Client goes offline → makes local changes → reconnects | Local changes synced to Home Node, conflicts resolved |
| 4 | **[TST-INT-368]** Rich client: on-device LLM works offline | Client disconnected, user sends query | On-device model processes locally, limited capability |
| 5 | **[TST-INT-369]** Rich client: full sync on reconnection | Client offline for 24h → reconnects | Vault delta sync, missed messages delivered, state converged |
| 6 | **[TST-INT-370]** Thin client: no local storage | Inspect thin client after session | No vault data cached locally — WS relay only |
| 7 | **[TST-INT-371]** Thin client: inoperable without Home Node | Home Node down, thin client attempts query | Error displayed — no offline capability |
| 8 | **[TST-INT-372]** Multiple rich clients sync consistently | Two phones with local caches, both edit vault | Conflict resolution produces consistent state on both |
| 9 | **[TST-INT-373]** Sync protocol: checkpoint mechanism | Rich client sends "last sync checkpoint = timestamp X" | Home Node responds with all `vault_items` changed since X |
| 10 | **[TST-INT-374]** Sync protocol: client uploads local items | Phone captures Telegram messages while offline → reconnects | Client sends locally-created items to Home Node → Home Node applies and acknowledges |
| 11 | **[TST-INT-375]** Conflict resolution: last-write-wins | Phone edits note offline, laptop edits same note offline, both reconnect | Home Node accepts later-timestamped write, earlier one logged as recoverable version |
| 12 | **[TST-INT-376]** Conflict resolution: user review | Two conflicting edits | User can view "sync conflicts" view and choose preferred version |
| 13 | **[TST-INT-377]** Most data is append-only | Ingested emails, calendar events | No conflict — ingestion is immutable append, conflicts only for user-editable data |
| 14 | **[TST-INT-378]** New device = full sync | Pair new phone → connect | Full vault sync from Home Node — new device gets complete local cache |
| 15 | **[TST-INT-379]** Corrupted client cache → re-sync | Client SQLite cache corrupted | Delete local cache → full re-sync from Home Node. Home Node is authoritative |
| 16 | **[TST-INT-380]** Ongoing real-time push | Client connected via WS | Home Node pushes new items to connected clients in real-time. Client pushes local items immediately |
| 17 | **[TST-INT-381]** Home Node failure: rich client offline read | Home Node down, rich client has cache | User can read cached data, do local searches, use on-device LLM. Cannot ingest or receive D2D |

### 16.2 Confidential Computing (Managed Hosting)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-382]** Enclave attestation verified by client | Home Node in AMD SEV-SNP / Intel TDX / Nitro Enclave | Client verifies attestation report before trusting node |
| 2 | **[TST-INT-383]** Host root cannot read enclave memory | Root attacker on managed host | Plaintext keys/data invisible — hardware-enforced isolation |
| 3 | **[TST-INT-384]** Enclave-sealed keys | Keys sealed to enclave measurement | Non-extractable even by hosting operator |

### 16.3 Progressive Disclosure Timeline

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-385]** Day 1: email + calendar ingestion, basic nudges | Onboarding complete | Functional, no multi-persona, no sharing rules |
| 2 | **[TST-INT-386]** Day 7: mnemonic backup prompt | 7 days post-setup | User prompted to write down 24 words |
| 3 | **[TST-INT-387]** Day 14: Telegram connector prompt | 14 days post-setup | "Want to connect Telegram too?" |
| 4 | **[TST-INT-388]** Day 30: persona compartments prompt | 30 days post-setup | "Separate health and financial data?" |
| 5 | **[TST-INT-389]** Month 3: power user discovery | 90 days post-setup | Personas, sharing rules, self-hosting visible in settings |

### 16.4 Local LLM Profile

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-390]** `--profile local-llm` adds llama container | `docker compose --profile local-llm up` | 4 containers: core, brain, pds, llama |
| 2 | **[TST-INT-391]** Without profile: 3 containers only | `docker compose up` | core, brain, pds — no llama |
| 3 | **[TST-INT-392]** Brain routes to llama:8080 when available | llama running, brain sends completion | Response from local model |
| 4 | **[TST-INT-393]** Brain falls back to cloud when llama absent | llama not started | Brain uses cloud LLM API (PII-scrubbed) |
| 5 | **[TST-INT-394]** PII scrubbing without llama | No Tier 3 (LLM NER) | Regex (core Tier 1) + spaCy NER (brain Tier 2) still catch structured + contextual PII |

### 16.5 Multi-Lane Ingress Tiers

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-395]** Community tier: Tailscale Funnel | Node behind Tailscale Funnel | Accessible at `https://node.tailnet.ts.net`, auto-TLS, DID Document points to this URL |
| 2 | **[TST-INT-396]** Production tier: Cloudflare Tunnel | Node behind `cloudflared` | Accessible at custom domain, WAF + geo-blocking active, DID Document updated |
| 3 | **[TST-INT-397]** Sovereign tier: Yggdrasil mesh | Node on Yggdrasil network | Stable IPv6 from node public key, censorship-resistant, DID Document points to IPv6 |
| 4 | **[TST-INT-398]** Tier change → DID rotation | Switch from Community → Production | Signed `did:plc` rotation operation updates service endpoint |
| 5 | **[TST-INT-399]** Multiple tiers simultaneously | Tailscale + Cloudflare + Yggdrasil active | All three ingress paths work, same Dina identity |
| 6 | **[TST-INT-400]** Wildcard relay (Foundation) | Node registers at `*.dina.host` via `frp` | Free secure subdomain, replaces Tailscale dependency for Community tier |

### 16.6 Forward Secrecy (Noise XX)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-401]** Noise XX handshake | Two Dina nodes establish session | Mutual authentication + forward-secret session keys |
| 2 | **[TST-INT-402]** Key compromise doesn't expose past messages | Current session key leaked | Previously captured ciphertexts remain confidential |
| 3 | **[TST-INT-403]** Session ratchet | Long-lived session | Keys rotate periodically, limiting exposure window |

### 16.7 Trust AppView (Phase 2+)

> The AppView is a read-only indexer that consumes the AT Protocol firehose,
> filters for `com.dina.trust.*` records, and serves a query API.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-404]** Firehose consumer filters correctly | AppView connected to relay | Only `com.dina.trust.*` and `com.dina.identity.attestation` records indexed — all other Lexicons discarded |
| 2 | **[TST-INT-405]** Cryptographic verification on every record | Signed record arrives in firehose | AppView verifies Ed25519 signature against author's DID Document — unsigned/invalid records rejected |
| 3 | **[TST-INT-406]** Query API: trust by DID | `GET /v1/trust?did=did:plc:abc` | Returns aggregate score + individual signed records |
| 4 | **[TST-INT-407]** Query API: product trust | `GET /v1/product?id=herman_miller_aeron_2025` | Returns product score, review count, individual signed reviews |
| 5 | **[TST-INT-408]** Query API: bot scores | `GET /v1/bot?did=did:plc:xyz` | Returns bot trust score, accuracy history |
| 6 | **[TST-INT-409]** Signed payloads in API responses | Any query response | Includes raw signed record payloads alongside computed scores — enables client-side verification |
| 7 | **[TST-INT-410]** Aggregate scores deterministic | Two AppViews process same firehose | Both compute identical product ratings and trust composites |
| 8 | **[TST-INT-411]** Cursor tracking: crash recovery | AppView crashes mid-firehose consumption | Worker persists `seq` number (cursor) — on restart, resumes from last committed seq, zero data loss. No duplicate indexing, no gaps |

### 16.8 Three-Layer Verification (Phase 3)

> When multiple AppViews exist, agents verify the AppView's honesty.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-412]** Layer 1: Cryptographic proof | AppView returns trust record | Agent verifies Ed25519 signature against author's public key — AppView cannot fake records |
| 2 | **[TST-INT-413]** Layer 2: Consensus check (anti-censorship) | Agent queries two AppViews | Provider A returns 5 reviews, Provider B returns 50 → agent detects censorship, alerts user |
| 3 | **[TST-INT-414]** Layer 3: Direct PDS spot-check | Random 1-in-100 audit | Agent bypasses AppView, resolves DID to PDS, fetches records via `com.atproto.repo.listRecords` — discrepancies downgrade AppView trust |
| 4 | **[TST-INT-415]** Dishonest AppView abandoned | AppView caught censoring | Agent switches to competitor AppView — AppView is infrastructure, not gatekeeper |

### 16.9 Timestamp Anchoring (Phase 3)

> Periodic Merkle root hash anchored to L2 chain for tamper-proof timestamps.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-416]** Merkle root hash to L2 | 1000 signed reviews this week | Single Merkle root → anchored to L2 (Base/Arbitrum) in one transaction |
| 2 | **[TST-INT-417]** Merkle proof verification | "Was this review in this week's batch?" | Check Merkle proof against on-chain root — verifiable |
| 3 | **[TST-INT-418]** Hash reveals nothing | Inspect on-chain hash | Content-free — hash is meaningless without original data (privacy preserved) |
| 4 | **[TST-INT-419]** Deletion + anchoring compatible | User deletes review via tombstone | Review removed from federation — on-chain hash orphaned, doesn't prevent deletion |

### 16.10 Bot Interface Protocol (Phase 2+)

> Specialist bots register with the Trust Network and expose a standard query API.
> Phase 1 uses OpenClaw as the sole external intelligence source.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-420]** Bot query format | Brain sends `POST bot/query` with `{query, requester_trust_ring, response_format, max_sources}` | Bot returns structured recommendations with sources, confidence, and `bot_signature` |
| 2 | **[TST-INT-421]** Bot signature verification | Bot response includes `bot_did` + `bot_signature` | Brain verifies Ed25519 signature against bot's DID Document — forged responses rejected |
| 3 | **[TST-INT-422]** Attribution mandatory | Bot response includes recommendations | Every source has `creator_name`, `source_url` — missing attribution → trust penalty |
| 4 | **[TST-INT-423]** Deep Link pattern default | Bot response with `deep_link` + `deep_link_context` | Brain presents source links to user — drives traffic to original creator, not extraction |
| 5 | **[TST-INT-424]** Bot trust: auto-route on low score | Bot accuracy drops below threshold | Brain automatically routes next query to next-best bot — no manual intervention |
| 6 | **[TST-INT-425]** Bot trust scoring factors | Inspect bot score computation | `f(response_accuracy, response_time, uptime, user_ratings, consistency, age, peer_endorsements)` — all factors weighted |
| 7 | **[TST-INT-426]** Bot discovery: decentralized registry | Brain needs specialist bot | Queries Trust Network for bots in relevant domain, selects highest-trust |
| 8 | **[TST-INT-427]** Bot-to-bot recommendation | Bot says "This is outside my domain" | Redirects to specialist bot DID — Brain follows chain if trust is sufficient |
| 9 | **[TST-INT-428]** Requester anonymity: trust ring only, no identity | Inspect `POST bot/query` request payload | Request contains `requester_trust_ring: 2` (integer) but NO user DID, no name, no Home Node URL, no persona path, no session ID — zero identifying information. Architecture §10: "anonymous — just the ring level." The bot knows the requester is trust ring 2 but cannot determine WHO is asking. If the request accidentally includes the DID alongside the trust ring, the bot can cross-reference queries and build a profile — breaking the anonymity guarantee |

### 16.11 Push Notifications (Phase 1.5)

> When client is disconnected from WebSocket, Home Node uses platform push to wake it up.
> Push payload contains NO data — just "wake up and connect to your Home Node."

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-429]** Android: FCM wake-only push | Client disconnected, new D2D message arrives | Home Node sends FCM notification with empty data payload — phone wakes, connects WS, receives message |
| 2 | **[TST-INT-430]** iOS: APNs wake-only push | Client disconnected, new D2D message arrives | Home Node sends APNs notification — same wake-only pattern |
| 3 | **[TST-INT-431]** Push payload contains NO user data | Capture FCM/APNs payload | Zero content — no message text, no sender, no preview. Only signal: "connect to your Home Node" |
| 4 | **[TST-INT-432]** While WS connected: no push needed | Client connected via WS | All notifications via WS push — FCM/APNs not used while connected |
| 5 | **[TST-INT-433]** Phase 2: UnifiedPush (no Google dependency) | Android with UnifiedPush configured | Self-hosted push gateway — no FCM required |

### 16.12 Deployment Profiles (E2E)

> All profiles share identical vault, identity, messaging, and persona layers.
> Only inference backends differ.

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-434]** Cloud LLM profile: 3 containers | `docker compose up -d` (default) | core, brain, pds running. No llama. Brain routes to cloud API |
| 2 | **[TST-INT-435]** Local LLM profile: 4 containers | `docker compose --profile local-llm up -d` | core, brain, pds, llama all running. Brain auto-detects llama:8080 |
| 3 | **[TST-INT-436]** Profile switch: cloud → local | Start cloud → `docker compose --profile local-llm up -d` | llama starts, brain detects and routes locally. Vault unchanged |
| 4 | **[TST-INT-437]** Profile switch: local → cloud | Stop with profile → start without | llama stops, brain falls back to cloud. Vault unchanged |
| 5 | **[TST-INT-438]** Always-local guarantees | Either profile | PII regex (core), vault crypto (core), DID signing (core), persona enforcement (core) — never leave Home Node |
| 6 | **[TST-INT-439]** Sensitive persona rule enforced | Health query, cloud profile (no llama) | Entity Vault scrubbing mandatory — Tier 1+2 strip identifiers, cloud sees topics only. Requires user consent at setup |

---

## 17. Architecture Validation (Cross-Cutting)

> Tests derived from deep validation of architecture documents against existing test coverage.
> Each test closes a HIGH severity gap identified during architecture review.

### 17.1 Plaintext Lifecycle & Export Encryption (§1, §2)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-590]** Plaintext only in memory, never at rest | Vault processes data then completes | After vault query, plaintext not persisted to disk — only encrypted data at rest |
| 2 | **[TST-INT-591]** Export archive encrypted with AES-256-GCM | Create export archive from vault | Archive encrypted with Argon2id(passphrase) → AES-256-GCM. No plaintext tar.gz on disk |

### 17.2 Core API Boundary (§3)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-592]** Go Core makes zero external API calls | Inspect all Core API call log | All calls are local Docker network only — no OAuth, no Gmail, no external service calls |

### 17.3 SSS Share Rotation & Custodian Encryption (§5)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-593]** SSS share rotation without changing master key | Rotate shares | New shares generated with new polynomial, master key unchanged, old shares invalid |
| 2 | **[TST-INT-594]** SSS shard per-custodian NaCl encryption | Split and encrypt shares | Each share encrypted with custodian's public key — only correct custodian can decrypt |
| 3 | **[TST-INT-595]** SSS recovery manifest on PDS | Publish recovery manifest | Manifest on PDS contains only custodian DIDs, never actual shares, is signed |

### 17.4 Bot Query Anonymity & Sanitization (§10)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-596]** Bot query contains no user DID | Inspect POST /query payload | No user_did, user_name, home_node_url, persona_path, session_id in payload |
| 2 | **[TST-INT-597]** Query sanitization strips all persona data | Query with PII attached | PII, medical details, financial info stripped — only abstracted requirements remain |
| 3 | **[TST-INT-598]** Bot POST /query wire format matches spec | Send query to review bot | Request has query/trust_ring/response_format/max_sources; response has recommendations/sources/bot_signature/bot_did |

### 17.5 Telegram Connector Server-Side (§7)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-599]** Telegram connector via Bot API with token | Configure Telegram connector | Server-side Bot API, requires bot_token, ingests full messages+media, routes to persona |

### 17.6 Outcome Lexicon & AppView (§8)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-600]** Outcome report payload matches architecture spec | Submit outcome report | All required fields present: reporter_trust_ring, reporter_age_days, product_id, purchase_verified, outcome, satisfaction, signature. No PII |
| 2 | **[TST-INT-601]** AppView Phase 1 is single Go binary + PostgreSQL | Inspect AppView configuration | Phase 1: Go binary, PostgreSQL 16 + pg_trgm, single VPS. Sharding/Kafka deferred |

### 17.7 Disaster Recovery (§13)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-602]** Encrypted snapshots and restore | Create backup, restore to new node | Snapshot encrypted, restore succeeds with correct passphrase, fails with wrong one |

### 17.8 Voice STT Integration (§16, §17)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-603]** Deepgram Nova-3 WebSocket STT with fallback | Primary STT fails | Deepgram used first (150-300ms latency), falls back to Gemini Flash Lite when unavailable |
| 2 | **[TST-INT-604]** STT available in all deployment profiles | Check all profiles | Deepgram Nova-3 available in cloud, local-llm, and hybrid profiles — not profile-dependent |

---

## 18. Architecture Validation — MEDIUM Severity Gaps

> MEDIUM severity gaps from deep validation of all 18 architecture documents.
> Each test closes a specific protocol detail, security property, or wire format
> requirement that was described in architecture but had no test coverage.

### 18.1 Dead Drop Ingress (§2)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-605]** IP rate limit 50/hr + global 1000/hr + 256KB payload cap | Exceed limits | 51st req from same IP → 429; oversized payload → 413 |
| 2 | **[TST-INT-606]** Per-DID rate limit only when vault unlocked | Locked vs unlocked vault | Locked: IP-only limits. Unlocked: per-DID limit enforced |
| 3 | **[TST-INT-607]** Sweeper Valve 3 retroactive IP blocklisting | Spam DID detected | Source IP added to Valve 1 blocklist, future requests rejected |
| 4 | **[TST-INT-608]** TTL-expired message stored silently, no notification | Message expires in spool | Stored in vault history with "expired_silent" status, no user notification |

### 18.2 Boot Sequence (§2)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-609]** Boot opens only identity + personal DBs | Node boots | Only identity.sqlite + personal.sqlite open; health/financial closed; brain notified with exact `{event: "vault_unlocked"}` |

### 18.3 Import/Export Security (§2)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-610]** Import rejects tampered/incompatible archives | Tampered archive | Checksum mismatch → rejected |
| 2 | **[TST-INT-611]** Export excludes secrets | Create export | No device_tokens, BRAIN_TOKEN, or passphrase in archive |

### 18.4 Vault Query API (§4)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-612]** `include_content` defaults false → summary only | Query without flag | Items have summary, no body_text. With flag=true: body_text included |
| 2 | **[TST-INT-613]** Pagination wire format: `has_more` + `next_offset` | 25 items, limit=20 | First page: has_more=true, next_offset=20. Last page: has_more=false |
| 3 | **[TST-INT-614]** Hybrid search relevance: `0.4 × fts5 + 0.6 × cosine` | Known scores | Verify exact formula produces correct relevance values |

### 18.5 Task Queue (§4)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-615]** Dead letter after 3 failures + Tier 2 notification | Task fails 3 times | Status="dead", Tier 2 notification: "Brain failed to process an event 3 times" |
| 2 | **[TST-INT-616]** Watchdog resets processing task after 5-min timeout | Task stuck 5+ min | Watchdog resets status to "pending"; at 4 min no reset |

### 18.6 Scratchpad & KV Store (§4, §6)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-617]** Scratchpad auto-expires after 24 hours | Old checkpoint | Entry older than 24h deleted; fresh entry survives |
| 2 | **[TST-INT-621]** KV store sync cursor survives brain restart | Save cursor, restart | Cursor value retrievable after restart |

### 18.7 HKDF Key Derivation (§6)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-618]** Backup key ≠ Archive key (independent HKDF) | Derive both | Different info strings → different keys; both deterministic |
| 2 | **[TST-INT-619]** Sync key + Trust key derived independently | Derive all 4 | All 4 keys distinct from each other |
| 3 | **[TST-INT-620]** Argon2id defaults: 128MB, 3 iter, 4 parallel | Check params | Default matches OWASP 2024 minimum; overrides respected |

### 18.8 Restricted Persona Audit (§5)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-622]** Audit entry exact JSON schema for restricted access | Access restricted persona | Entry has ts, persona, action, requester, query_type, reason fields |

### 18.9 Ingestion Layer (§7)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-623]** Voice memo: transcript stored, audio not in SQLite | Ingest voice memo | Vault has transcript text only; no binary audio blob |
| 2 | **[TST-INT-624]** Fiduciary override beats regex pre-filter | Security alert from noreply@ | Classified Tier 1 despite noreply@ sender pattern |
| 3 | **[TST-INT-625]** Pass 2a subject patterns → thin records | 4 pattern subjects | `[Product Update]`, `Weekly digest`, `OTP`, `verification code` → Tier 3 |
| 4 | **[TST-INT-626]** Backfill pauses for user query, resumes same cursor | Query during backfill | Cursor unchanged after user query processed |
| 5 | **[TST-INT-627]** Cold archive pass-through: no vault writes | Search cold data | Results returned but vault write count unchanged |
| 6 | **[TST-INT-628]** OpenClaw recovery resumes exact cursor position | Outage + recovery | Cursor values identical before and after outage |
| 7 | **[TST-INT-629]** Phone connector requires CLIENT_TOKEN auth | Phone pushes data | CLIENT_TOKEN accepted; BRAIN_TOKEN rejected for phone connector |

### 18.10 Trust Network (§8)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-630]** Attestation lexicon: missing fields + out-of-range rating rejected | Invalid attestation | Missing expertDid → rejected; rating=101 → rejected; valid → accepted |
| 2 | **[TST-INT-631]** AppView censorship detection by count mismatch | Two AppViews disagree | 5 vs 50 records → censorship alert triggered |
| 3 | **[TST-INT-632]** PDS spot-check discrepancy downgrades AppView trust | Missing records | AppView trust score decremented on discrepancy |
| 4 | **[TST-INT-633]** Tombstone: correct DID + invalid signature rejected | Forged tombstone | Matching DID but wrong Ed25519 signature → rejection |
| 5 | **[TST-INT-634]** Merkle root deterministic + inclusion proof valid | Same record set | Two computations → identical root; proof verifiable |

### 18.11 D2D Sharing Policy (§9)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-635]** Malformed tiered payload category dropped silently | Raw string value | Category with string (not dict) dropped; dict value passes |
| 2 | **[TST-INT-636]** Trusted contact + empty policy = no data | Trusted, policy={} | egress_check returns {} regardless of offered categories |
| 3 | **[TST-INT-637]** Egress audit log: 90-day rolling retention | Old entries | Entries >90 days purged; recent entries preserved |
| 4 | **[TST-INT-638]** Outbox message TTL 24h: expired dropped | Old message | Message >24h old flagged as expired |
| 5 | **[TST-INT-639]** Bulk policy update applies only to filter-matching contacts | 2 trusted + 1 unverified | Update returns 2; unverified contact unchanged |
| 6 | **[TST-INT-640]** New contact gets 6-field security defaults | Add without policy | Policy matches DEFAULT_POLICY exactly |

### 18.12 Bot Interface (§10)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-641]** Bot query wire format: response_format + max_sources types | Query bot | Fields present with correct types (str, int) |
| 2 | **[TST-INT-642]** Missing attribution → trust penalty | Source without creator_name | Violation detected |
| 3 | **[TST-INT-643]** Bot routing threshold boundary | At/below threshold | At threshold: used. Below: auto-route to alternative |
| 4 | **[TST-INT-644]** Bot-to-bot referral: low-trust referred bot declined | Referral to low-score bot | Referral declined |

### 18.13 Intelligence Layer (§11)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-645]** PII scrub failure blocks sensitive persona cloud route | Scrub fails | Cloud route refused; error returned to user |
| 2 | **[TST-INT-646]** Entity vault destroyed after rehydration | Request lifecycle | Entity vault dict empty/cleared after rehydration |
| 3 | **[TST-INT-647]** Simple lookup routes to FTS5, no LLM invoked | Simple search | LLMTarget.NONE returned; no LLM call |

### 18.14 Action Layer (§12)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-648]** Payment intent expires 12h (shorter than draft 72h) | Create both | Payment intent expires first |
| 2 | **[TST-INT-649]** Agent draft_only constraint prevents send | Agent tries send | Downgraded to draft |
| 3 | **[TST-INT-650]** Reminder: negative sleep fires immediately on reboot | Missed reminder | Fires immediately, not skipped |
| 4 | **[TST-INT-651]** Cart handover outcome recorded in Tier 3 | Payment confirmed | Outcome in vault tier 3, not tier 4 |

### 18.15 Client Sync (§13)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-652]** Conflict resolution: last-write-wins + recoverable version | Two offline edits | Later timestamp wins; earlier logged as recoverable |
| 2 | **[TST-INT-653]** Missed message buffer: 50 max, 5-min TTL, ACK removes | Buffer operations | 51st dropped; TTL expires; ACK removes specific message |

### 18.16 WebSocket Protocol (§17)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-654]** 3 missed pongs → disconnect + device offline | Miss 3 pongs | Connection closed, status "closed_missed_pongs" |
| 2 | **[TST-INT-655]** Auth frame 5-second timeout closes connection | No auth within 5s | Connection closed, status "closed_auth_timeout" |
| 3 | **[TST-INT-656]** Reconnect backoff: 1, 2, 4, 8, 16, 30, 30 | Reconnect attempts | Exact sequence verified; caps at 30s |

### 18.17 Infrastructure & Deployment (§17)

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | **[TST-INT-657]** `GET /.well-known/atproto-did` returns did:plc | Serve endpoint | Returns identity DID as text/plain |
| 2 | **[TST-INT-658]** PDS network `internal: true` — no outbound internet | Network config | PDS cannot make outbound connections |
| 3 | **[TST-INT-659]** Pairing code single-use: second attempt rejected | Use code twice | First: success. Second: returns None (used) |
| 4 | **[TST-INT-660]** Brain cannot directly reach PDS container | Network topology | No shared Docker network between brain and PDS |
| 5 | **[TST-INT-661]** Managed hosting: 15-min filesystem snapshots | Snapshot config | Interval = 15 minutes |
| 6 | **[TST-INT-662]** Estate `read_only_90_days` expires server-side | 90 days elapsed | Access denied after expiry |
| 7 | **[TST-INT-663]** Watchdog breach → Tier 2 system message | Health check fails | Tier 2 notification with warning level + text |
| 8 | **[TST-INT-664]** Docker log rotation: all services `max-size: 10m, max-file: 3` | Compose config | All 4 services have correct logging driver config |

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
| P3 (Low) | Performance benchmarks, chaos engineering, trust network | Quality: failure affects non-functional requirements |
| P3 (Low) | Digital estate, upgrade/migration | Edge case: important but infrequent scenarios |
