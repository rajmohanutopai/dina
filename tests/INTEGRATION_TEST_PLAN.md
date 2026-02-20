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

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Simple query | Client WS → auth frame → query message → core → brain → LLM → brain → core → WS response | User receives answer within 5s |
| 2 | Query with vault context | Client asks about previous data → brain searches vault → builds context → LLM → response | Response references stored data correctly |
| 3 | Streaming response | Long answer → brain streams → core relays WS chunks | Client receives progressive chunks |
| 4 | Query during brain outage | Client sends query, brain is down | Core returns system error message via WS |

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

---

## 3. Dina-to-Dina Communication

### 3.1 Message Send Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Send message | User composes → brain formats → core encrypts (NaCl seal) → outbox queues → transport delivers | Recipient receives encrypted message |
| 2 | Sharing policy enforcement | Send to contact with `sharing: summary` → brain generates summary → core sends summary only | Raw data never transmitted |
| 3 | PII scrub on egress | Send to contact with `sharing: full` → Tier 1 + Tier 2 PII scrub → encrypted → sent | No PII in transmitted payload |
| 4 | Default-deny egress | Send to contact with no sharing policy | Message blocked, user notified |

### 3.2 Message Receive Flow

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Receive message (open persona) | Inbound → DID verification → decrypt → brain classifies priority → action taken | Message processed based on priority |
| 2 | Receive message (locked persona) | Inbound → DID verification → persona locked → spooled to disk | 202 Accepted, spooled |
| 3 | Spool overflow | Locked persona, spool at 500MB → new message | 503 Service Unavailable |
| 4 | Unknown sender | Message from unresolvable DID | Rejected or quarantined per policy |

### 3.3 Bidirectional Communication

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Two Dina nodes exchange messages | Node A sends to Node B, Node B responds | Full roundtrip: encrypt → deliver → decrypt → process → encrypt → deliver → decrypt |
| 2 | Concurrent bidirectional | Both nodes send simultaneously | Both messages delivered independently |
| 3 | Message ordering | Node A sends 5 messages rapidly | Node B receives in order (outbox FIFO) |

### 3.4 Transport Reliability

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Recipient temporarily down | Send message, recipient offline | Outbox retries: 30s → 1m → 5m → 30m → 2h |
| 2 | Recipient recovers within retry window | Down for 2 minutes, then up | Message delivered on retry |
| 3 | Recipient down beyond max retries | Down for >24h | Message → dead letter, owner notified |
| 4 | Network partition then heal | Bidirectional network drop for 10 min | Both sides retry, messages eventually delivered |
| 5 | Duplicate delivery prevention | Retry delivers message that was already received | Recipient deduplicates by message ID |

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

---

## 5. Docker Networking & Isolation

### 5.1 Bowtie Topology

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Core can reach brain | `docker exec core curl brain:8200/v1/health` | 200 OK |
| 2 | Core can reach PDS | `docker exec core curl pds:2583` (if PDS enabled) | Connection succeeds |
| 3 | Brain CANNOT reach PDS | `docker exec brain curl pds:2583` | Connection refused / no route |
| 4 | PDS CANNOT reach brain | `docker exec pds curl brain:8200` | Connection refused / no route |
| 5 | Only core exposed on host | `curl localhost:8300` from host | 200; `curl localhost:8200` → refused |
| 6 | LLM not exposed (production) | `curl localhost:8080` from host | Connection refused (port not mapped in prod) |

### 5.2 Container Dependencies

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Core waits for brain | Start stack | Core container starts after brain (depends_on) |
| 2 | Brain starts without core | Start brain alone | Brain starts, retries core connection |
| 3 | LLM starts independently | Start LLM alone | Starts, loads model, ready on :8080 |

### 5.3 Volume Mounts

| # | Scenario | Test Method | Expected |
|---|----------|-------------|----------|
| 1 | Vault data persists | Write data → stop stack → start stack → read data | Data present after restart |
| 2 | Model files shared | LLM reads from `/models` mount | Model loaded from `./data/models/` on host |
| 3 | Secret files mounted | Inspect running containers | `/run/secrets/brain_token` present in core and brain |
| 4 | Source mounts (dev mode) | Start with dev compose | Source directories mounted, hot-reload works |

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

---

## 9. Ingestion-to-Vault Pipeline (Full E2E)

| # | Flow | Steps | Expected |
|---|------|-------|----------|
| 1 | Email ingestion | Gmail connector fires → metadata fetch → category filter → regex filter → LLM classify → full download → PII scrub → vault store | Relevant emails in vault, PII-free |
| 2 | Calendar sync | Calendar connector → events fetched → dedup → vault store | Events stored, duplicates rejected |
| 3 | Multi-connector sync | Gmail + Calendar + RSS fire concurrently | All run independently, no interference |
| 4 | Ingestion with locked persona | Email for locked persona | Staged or spooled until persona unlocked |
| 5 | Ingestion dedup across restart | Ingest → restart → re-ingest same data | No duplicates in vault (content hash) |

---

## 10. Reputation Graph Integration

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Publish reputation record | Brain creates reputation attestation → core publishes to PDS | Record in AT Protocol PDS with signed Merkle repo |
| 2 | Query reputation | Look up agent/contact reputation | Score returned from Reputation Graph |
| 3 | Reputation affects routing | Two MCP agents available, different reputations | Higher-reputation agent selected |
| 4 | Reputation affects trust tier | Contact accumulates positive reputation | Trust level can be upgraded (Unverified → Verified) |
| 5 | Reputation tampering | Modified reputation record | Signature verification fails, record rejected |

---

## 11. Upgrade & Migration

| # | Scenario | Setup | Expected |
|---|----------|-------|----------|
| 1 | Schema migration on upgrade | New version with schema change → start | DDL migrations applied automatically |
| 2 | Data preserved across upgrade | Store data → upgrade → read data | All data intact |
| 3 | Rollback after failed migration | Migration fails mid-way | Database rolled back to pre-migration state |
| 4 | Config format change | New version expects new env vars | Clear error if old format detected |

---

## 12. Performance & Load Tests

### 12.1 Throughput

| # | Test | Load | Target |
|---|------|------|--------|
| 1 | Concurrent WebSocket connections | 100 clients, each sending 1 query/s | All queries answered within 10s |
| 2 | Vault write throughput | 1000 items/s | All stored without error |
| 3 | Vault search under load | 100 concurrent searches, 100K items | P99 < 200ms |
| 4 | Inbound message handling | 50 Dina-to-Dina messages/s | All processed (spooled if persona locked) |
| 5 | Outbox drain rate | 1000 queued messages | All delivered within 5 minutes (healthy recipients) |

### 12.2 Latency

| # | Test | Flow | Target |
|---|------|------|--------|
| 1 | Query-to-response (local LLM) | WS query → core → brain → llama → brain → core → WS response | P50 < 3s, P99 < 10s |
| 2 | Query-to-response (cloud LLM) | WS query → core → brain → PII scrub → cloud → rehydrate → core → WS response | P50 < 5s, P99 < 15s |
| 3 | Message send latency | User sends message → outbox → delivered | P50 < 2s (recipient online) |
| 4 | Pairing completion | Code displayed → device submits → token issued | < 3s |

### 12.3 Resource Usage

| # | Test | Setup | Target |
|---|------|-------|--------|
| 1 | Core memory usage | Idle with 10K vault items | < 100 MiB RSS |
| 2 | Brain memory usage | Idle with spaCy model loaded | < 300 MiB RSS |
| 3 | LLM memory usage | Loaded with 4-bit quantized model | < 4 GiB RSS |
| 4 | Disk usage growth | 10K vault items + 1K messages | < 500 MiB total |
| 5 | Spool disk usage | Locked persona, max spool | Exactly 500 MiB cap (DINA_SPOOL_MAX) |

---

## 13. Chaos Engineering

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

## 14. Compliance & Privacy

| # | Scenario | Verification | Expected |
|---|----------|--------------|----------|
| 1 | No PII in any log file | Grep all container logs for PII patterns | Zero matches |
| 2 | No PII in error messages | Trigger errors with PII input | Error messages contain redacted text only |
| 3 | Audit trail completeness | Perform 100 operations | All 100 appear in audit log with correct metadata |
| 4 | Data deletion (right to erasure) | Delete all data for persona | Vault wiped, audit entries indicate deletion, no residue |
| 5 | Data export (portability) | Export all vault data for persona | Complete JSON/CBOR export with all items |
| 6 | Consent tracking | Review all outbound data flows | Each flow has corresponding sharing policy consent |

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
