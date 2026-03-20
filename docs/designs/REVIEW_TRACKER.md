# Engineering Review Tracker

Generated: 2026-03-20
Total source files: ~622 | Reviewed: ~567 (91%)

**Reviewers:**
- **Claude** — Claude Opus 4.6 (primary reviewer, read files via agents)
- **Codex** — OpenAI gpt-5.4 via Codex CLI (independent second opinion, read-only sandbox)

**Status key:**
- COMPLETE — All files in section read and findings documented
- IN PROGRESS — Partially reviewed, findings documented so far
- NOT STARTED — No files read yet
- N/A — Not applicable for code review

---

## Review Summary

| # | Section | Files | Reviewed By | Status | Findings |
|---|---------|-------|-------------|--------|----------|
| **GO CORE** | | **216** | | | |
| 1 | Handlers (non-test) | 22 | Claude + Codex | COMPLETE | GH1-GH13 (Claude) + CXH1-CXH7 (Codex: 1 CRITICAL, 4 HIGH, 2 MED). Key: device allowlist prefix too broad — agents can self-approve. |
| 2 | Handler tests | 5 | Claude | COMPLETE | G05-G07 (test gap findings) |
| 3 | Middleware (auth, cors, rate limit, etc.) | 7 | Claude | COMPLETE | Reviewed via arch audit |
| 4 | Adapters — auth | 3 | Claude + Codex | COMPLETE | FC1, FH1-FH3 (Codex found allowlist gaps) |
| 5 | Adapters — gatekeeper | 2 | Claude | COMPLETE | F09 (PII regex incomplete) |
| 6 | Adapters — vault (SQLCipher) | 11 | Claude | COMPLETE | ~4,200 LOC reviewed (vault/, sqlite/). Encryption correct: DEK via hex URI, cipher_page_size=4096, WAL+TRUNCATE, synchronous=NORMAL. All SQL parameterized (zero injection). HNSW: volatile RAM only, destroyed on lock. Findings: VT1 MEDIUM PRAGMA table_info unsanitized (mitigated by hardcoded tables). VT2 MEDIUM HNSW Add() TOCTOU race. VT3 LOW NaN/Inf not validated in embeddings. VT4 CRITICAL audit hash-chain race on concurrent appends. VT5 CRITICAL reminders missing unique index (ON CONFLICT silently ignored). VT6 CRITICAL staging lease expiry → double-processing if classification >5min. |
| 7 | Adapters — identity | 7 | Claude | COMPLETE | ~3,827 LOC reviewed (identity.go 2144, export.go 216, web.go 75, pairing.go 451, persist.go 130, estate.go 177, portability.go 634). **4-tier persona access CORRECT.** Pairing secure: crypto/rand codes, constant-time token validation, single-use enforcement, atomic persistence. Shamir GF(256) correct. Portability: 4-layer path traversal, AES-256-GCM correct, zero VACUUM INTO. Findings: ID1 CRITICAL persona state NOT atomically persisted (no .tmp+Rename). ID2 MEDIUM DID metadata persist not atomic either. All else PASS. |
| 8 | Adapters — crypto | 10 | Claude | COMPLETE | **Grade: A (Excellent).** All 10 files (1,068 LOC) reviewed. No CVE-level defects. Hardened derivation enforced. Per-persona DEK isolation sound. Forward secrecy via ephemeral NaCl keys. Minor: Argon2id iterations=3 marginal, NaCl nonce derivation non-standard but sound. |
| 9 | Adapters — trust | 3 | Claude (partial) | IN PROGRESS | Cache + resolver read via arch audit |
| 10 | Adapters — websocket | 4 | Claude | COMPLETE | 944 LOC reviewed. Auth: Ed25519-only upgrade, strong. Findings: WS1 no max message size (DoS), WS2 no connection limit, WS3 expired buffers never purged, WS4 silent message drops, WS5 heartbeat timestamp not validated. Concurrency safe. No PII in logs. |
| 11 | Adapters — other | 22 | Claude | COMPLETE | ~4,600 LOC reviewed. **Security-critical adapters: EXCELLENT.** brainclient circuit breaker correct, servicekey fail-closed fortress-grade, transport SSRF protection exemplary (dial-time IP+DNS validation, redirect blocking), trust cache returns copies (no data races), PII regex Tier 1 appropriate. **Infrastructure adapters: MIXED (some stubs/mocks).** Several files are test/mock implementations not used in production (server.go, adminproxy.go, observability.go). Findings: OT1 MEDIUM pds.go signature placeholder (line 52). OT2 LOW taskqueue retry backoff not enforced. OT3 NOTE many infrastructure adapters are test stubs. |
| 12 | Services | 12 | Claude | COMPLETE | All 12 files (2,530 LOC) reviewed. Findings: SV1 HIGH identity.go uses seed[:16] as Argon2 salt (reduces entropy). SV2 HIGH device key registration silently fails if registrar nil. SV3 HIGH device revocation non-atomic (partial revoke possible). SV4 MEDIUM watchdog wired but never Start()'d. SV5 MEDIUM sync ResolveConflict not transactional. Gatekeeper service clean. Migration robust (multi-layer path traversal). Estate Shamir validation correct. Task queue error handling exemplary. |
| 13 | Domain types | 24 | Claude | COMPLETE | 1,120 LOC reviewed. 18+ frozen enum sets define security boundaries. PersonaName/DID type-safe constructors validated at creation. MaxVaultItemSize=10MiB. TrustRing 0-3 with EntityResolutionMode (Blocked/LateBound/Plaintext). 4-tier persona model encoded. Staging provenance server-derived. Findings: DM1 MEDIUM Action in Intent is open string (no enum validation). DM2 LOW Message.Body no size check at domain level. DM3 LOW SearchQuery.Limit unchecked. |
| 14 | Port interfaces | 23 | Claude | COMPLETE | 72 interfaces across 23 files. 61 implemented (85%), 11 unimplemented (15%). VaultReader/Writer split excellent. Crypto: 7 single-method interfaces. Auth: 8 interfaces for 3 auth methods. Findings: PT1 MEDIUM AgentSessionManager port unimplemented (blocks agent safety). PT2 LOW 11 interfaces defined but no adapter (mostly callback types or handler-level logic). Architecture quality 8.5/10. |
| 15 | Ingress pipeline | 4 | Claude | COMPLETE | 875 LOC reviewed. Atomic dead drop writes (temp+rename). Poison pill eviction. Mtime-based stale GC. Findings: IG1 HIGH vault lock TOCTOU race, IG2 HIGH inbox spool no capacity limit (unlocked path), IG3 MEDIUM AllowGlobal O(n) dir scan, IG4 MEDIUM global spool TOCTOU, IG5 LOW fixed-window burst, IG6 LOW silent sweep failures. |
| 16 | Reminder | 1 | Claude | COMPLETE | 122 LOC. Sleep/wake mechanism sound (buffered channel, no pileup). Fire-before-callback order correct. Context cancellation safe. No issues. |
| 17 | Config | 1 | Claude | COMPLETE | 198 LOC. Secrets (MASTER_SEED, SEED_PASSWORD) isolated in main.go not config.go. CLIENT_TOKEN from Docker Secret file. Strict validation (security_mode, rate_limit). No secrets logged. No issues. |
| 18 | Generated types | 2 | Claude | COMPLETE | 1,737 LOC (core 1423 + brain 314). oapi-codegen v2.6.0. All enums have Valid() functions. Timestamps int64 (safe). Required/optional fields correct via omitempty. No issues. |
| 19 | Composition root (main.go) | 1 | Claude | COMPLETE | F05 (DRY), magic strings |
| 20 | Entrypoint (entrypoint.sh) | 1 | Codex | COMPLETE | Secret handling reviewed |
| 21 | Core unit tests | 51 | Claude | COMPLETE | 60,477 LOC, 414+ test functions across 51 files. **Grade: C+ (adequate crypto, critical auth gaps).** Crypto tests EXCELLENT (128 tests, SLIP-0010 hardened enforcement, HKDF isolation, test vectors). PII tests EXCELLENT (28 tests). **CRITICAL GAPS: Zero device-scoped authorization denial tests for approval/audit/notify endpoints (CXH1-CXH5 all untested). F01 HybridSearch gatekeeper bypass untested. F03 replay cache bounds untested. SV1 seed-as-salt untested. ID1 persona state atomicity untested. Path traversal in archive import untested. Embedding NaN/Inf untested.** |
| | | | | | |
| **PYTHON BRAIN** | | **89** | | | |
| 22 | main.py (composition root) | 1 | Claude | COMPLETE | F07 (DRY provider init) |
| 23 | Services — guardian.py | 1 | Claude | COMPLETE | 4,200 LOC reviewed |
| 24 | Services — llm_router.py | 1 | Claude | COMPLETE | Cloud consent, fallback logic |
| 25 | Services — entity_vault.py | 1 | Claude + Codex | COMPLETE | F08 (token collision), FC2 |
| 26 | Services — other (11 files) | 11 | Claude | COMPLETE | 3,415 LOC reviewed. **FC2 CRITICAL confirmed:** enrichment.py sends raw vault content to cloud unscrubbed (no entity_vault param). staging_processor.py vulnerable indirectly (calls enrichment). vault_context.py secure but entity_vault is optional (caller must opt-in). Utility services (nudge, scratchpad, telegram, event_extractor, tier_classifier, trust_scorer) all secure — no cloud egress, excellent PII safety. |
| 27 | Adapters — core_http.py | 1 | Claude | COMPLETE | Retry logic, error classification |
| 28 | Adapters — scrubber_presidio.py | 1 | Claude | COMPLETE | F11 (DRY), Faker seeding |
| 29 | Adapters — LLM providers (5 files) | 5 | Claude | COMPLETE | 1,381 LOC reviewed. **F04 CONFIRMED: All 5 providers lack explicit JSONDecodeError handling.** OpenAI line 171 + OpenRouter line 184 have inline json.loads() that will crash on malformed function arguments. All 5 fall to generic except Exception masking root cause. |
| 30 | Adapters — other | 7 | Claude | COMPLETE | ~1,314 LOC reviewed. MCP stdio: command allowlist enforced, safe env filtering, no shell=True. MCP HTTP: BA1 MEDIUM no auth on HTTP requests (MITM risk on untrusted networks). Signing: Ed25519 correct, nonce/replay/timestamp all sound, key material never logged. Telegram bot: thin adapter, safe delegation. SpaCy scrubber: fail-closed correct, entity vault pattern safe. India recognizers: all 7 patterns correct (Aadhaar first-digit [2-9] verified). EU recognizers: all 6 patterns correct (SWIFT/BIC requires digit to avoid English word false positives). |
| 31 | Domain types | 3 | Claude | COMPLETE | 402 LOC. All frozen=True, slots=True. Immutable post-construction. ScrubResult.replacement_map for ephemeral PII (never persisted). Clean. |
| 32 | Port interfaces | 6 | Claude | COMPLETE | 499 LOC. CoreClient (13 methods, error classification correct). LLMProvider is_local gates PII scrubbing. EntityVault enforces ephemeral lifecycle. 30s MCP timeout. Clean. |
| 33 | Infrastructure | 5 | Claude | COMPLETE | 550 LOC. Logging PII-safe (SS04 enforced). Crash handler splits sanitized one-liner (stderr) from full trace (encrypted vault). BrainConfig frozen=True. Rate limiter uses monotonic time + LRU eviction. Clean. |
| 34 | Brain API routes | 4 | Claude | COMPLETE | 863 LOC reviewed. Ed25519 auth on all routes. Rate limiting on reason+pii. Security headers on all responses. Findings: BR1 CRITICAL pii.py returns original PII in entities list (defeats scrubbing). BR2 HIGH process.py leaks ValueError details. BR3 MEDIUM reason.py approval error as dict not JSONResponse. BR4 MEDIUM provider field not validated. |
| 35 | Admin UI routes | 11 | Claude + Codex | COMPLETE | 1,207 LOC (auth/core) + ~476 LOC (content routes). Auth: session+CSRF strong, cookie flags correct, brute-force throttled. XSS: all templates use escapeHtml(). CRITICAL confirmed: FC1 API keys in KV readable by devices (root cause: device allowlist includes /v1/vault/kv). Content routes: 9/10 security — no critical issues. |
| 36 | Brain unit tests | 31 | Claude | COMPLETE | 31,588 LOC, 347+ test functions. Auth tests EXCELLENT (19 tests, Ed25519 service key, module boundaries). Guardian tests EXCELLENT (153 tests, silence classification, intent review, Anti-Her). PII/entity vault lifecycle STRONG (69 tests). GAPS: FC2 enrichment cloud scrubbing NOT TESTED. BR1 PII route entity values NOT TESTED. BR3 approval error format NOT TESTED. BS2 staging scrubbing order NOT TESTED. F04 JSON parse errors PARTIALLY TESTED (malformed dict yes, corrupt JSON no). |
| | | | | | |
| **TYPESCRIPT APPVIEW** | | **113** | | | |
| 37 | Ingester (Jetstream consumer) | 27 | Claude | COMPLETE | ~2,500 LOC reviewed. **Strong data integrity.** Backpressure: TCP-level pause/resume correct. Cursor safety: min(in-flight, queued, failed) prevents advancement past unprocessed. At-least-once delivery with idempotent upserts. All SQL parameterized (Drizzle ORM, zero injection). 19 handlers: trust edges correct (positive-attestation=0.3, vouch=high1.0/mod0.6/low0.3, endorsement=0.4-0.8, delegation=0.9). Findings: IG-I1 HIGH rate limiter in-memory only (multi-instance bypass). IG-I2 MEDIUM reply+report handlers missing dirty flags. IG-I3 MEDIUM unbounded nested objects in validator. IG-I4 LOW trust edge weight not updated on conflict. |
| 38 | Scorer (9 background jobs) | 16 | Claude | COMPLETE | ~2,200 LOC reviewed. **Grade: B+ (Good).** Trust formula matches spec. Vouch-gating (Fix 12) is excellent Sybil defense. Findings: TS1 MEDIUM sentiment-aggregation missing verified/bilateral multipliers (bug). TS2 MEDIUM slow-burn Sybil attack not detected (48h window). TS3 CRITICAL reviewer-stats N² corroboration loop (perf). TS4 HIGH detect-coordination unbounded load. TS5 HIGH tombstone penalty hits legitimate users. TS6 MEDIUM Sybil only detects already-flagged DIDs. Scheduler concurrency (pg_advisory_lock) correct. |
| 39 | Web/API (xRPC endpoints) | 7 | Claude | COMPLETE | ~700 LOC reviewed. All SQL parameterized (Drizzle ORM). Rate limiting (60 RPM). SWR caching on resolve/search/profile. Zod validation on all endpoints. Findings: XR1 MEDIUM graph.ts string interpolation in statement_timeout (sql.raw pattern). XR2 HIGH getGraph not cached (most expensive query re-executes every request). XR3 MEDIUM unvalidated domain param across 3 endpoints. XR4 MEDIUM no FTS complexity limits. Cursor-based pagination correct. Graph safeguards (100ms timeout, 500 node cap, 100 query budget). |
| 40 | DB queries + schemas | 33 | Claude | COMPLETE | ~1,150 LOC queries + 27 schema files reviewed. All SQL parameterized (Drizzle ORM). Only sql.raw() is graph.ts statement_timeout (compile-time constant). Graph BFS: 4 safeguards (100ms timeout, 500 node cap, 100 query budget, depth≤2). Canonical chain: cycle detection + depth limit 5. All 27 schemas audited: upsert targets match unique constraints, trust edges properly indexed for BFS (from_did, to_did, composite). Dirty flag partial indexes correct. 2 minor missing indexes (media.author_did, subjectClaims.author_did). No critical issues. |
| 41 | Config | 3 | NOT STARTED | NOT STARTED | Zod schemas, constants, lexicons |
| 42 | AppView tests | 27 | NOT STARTED | NOT STARTED | |
| | | | | | |
| **CLI** | | **13** | | | |
| 43 | CLI source | 8 | Claude | COMPLETE | 1,235+276+171+115+77+75+37+6 = ~2,000 LOC. **SECURE.** Ed25519 signing format IDENTICAL to Go Core (verified line-by-line). All requests signed (no unsigned path). Keys stored 0o600, dirs 0o700. Argon2id params match Core. BIP-39 mnemonic verified. Pairing ceremony correct. No findings. |
| 44 | CLI tests | 5 | Claude | COMPLETE | ~330 LOC, 61+ tests. Covers: signing (14), client (13), commands (28+), sessions (6). Comprehensive — all critical paths tested. |
| | | | | | |
| **ADMIN CLI** | | **8** | | | |
| 45 | Admin CLI source + tests | 8 | Claude | COMPLETE | ~1,959 LOC (5 source + wrapper + 3 tests). Unix socket-only auth (no tokens). Passphrase via hide_input. 62 tests. Findings: AC1 HIGH no socket permission validation. AC2 HIGH dina-admin wrapper echoes API keys (read -r not -rs). AC3 HIGH plaintext passphrase in seed_password file. AC4 MEDIUM .env permissions unchecked after API key append. |
| | | | | | |
| **INTEGRATION/E2E/RELEASE/SYSTEM TESTS** | | **120** | | | |
| 46 | Integration tests | 44 | Claude | COMPLETE | 53,387 LOC, 714+ tests across 44 files. Security tests: 150 tests (security, safety_layer, persona_tiers, pii_scrubber, audit, compliance, staging). Feature tests: 249 tests (d2d, trust_network, anti_her, silence_tiers, migration, crash_recovery, chaos). **SAME PATTERN: Functional correctness strong, adversarial boundary testing weak.** FC1 NOT TESTED anywhere. F01 NOT TESTED. VT5/VT6 NOT TESTED. CXH1 partially tested (persona_tiers has approval flow but not self-approval attack). FC2 partially tested (pii_scrubber validates scrubbing but not enrichment bypass). |
| 47 | E2E tests | 31 | Claude | COMPLETE | ~18K LOC, 126 tests across 24 suites. Agent safety EXCELLENT (6 E2E + 3 sandbox tests). D2D signature verification EXCELLENT (spoofing, impersonation, unknown DIDs all tested). Persona tier isolation GOOD (cross-persona blocked, but HybridSearch tier gap remains). CXH1 partially tested via approval lifecycle. FC1 NOT TESTED. F01 PARTIALLY (tier gate tested, hybrid-specific gap). F02 WELL TESTED. |
| 48 | Release tests | 29 | Claude | COMPLETE | ~5.1K LOC, 140 tests (REL-001..REL-028). Shipping gate STRONG for functional correctness: install, vault, auth, Four Laws, deployment boundary all pass. **Authorization boundary NOT VALIDATED:** CXH1 zero tests, FC1 zero tests, FC2 partial, F01 zero tests. Release tests validate happy-path auth (valid=200, invalid=401) but NOT endpoint-scope enforcement (device calls admin endpoint). |
| 49 | System tests (user stories) | 16 | Claude | COMPLETE | ~10.7K LOC, 106 tests across 14 stories. Full stack (2×Core+Brain, PLC, PDS, AppView, Postgres). Stories 01-10 + thesis invariants 11-14 all validated. Agent Gateway (story 05) comprehensive: safe/moderate/high/blocked intents, pairing, revocation. Persona Wall (story 04) validates cross-persona blocking + minimal disclosure. Agent Sandbox (story 14) validates perimeter defense + identity binding. |
| | | | | | |
| **INFRASTRUCTURE** | | **~40** | | | |
| 50 | Scripts + top-level shells | 38 | Claude | COMPLETE | ~7,500 LOC reviewed. **install.sh: SECURE.** Legacy MASTER_SEED rejection enforced. Seed zeroed after use. Passphrase via read -rs. Mnemonic on alternate screen. Secrets via env vars not argv. Argon2id params match Go. SLIP-0010 service key derivation correct. .env chmod 600. Two-mode startup (max-security/server). **Test infra: SECURE.** DINA_TEST_MODE=true set. Docker isolation via project names. Cleanup via signal handlers + atexit. No hardcoded production credentials. No findings for install scripts. No findings for test scripts. |
| 51 | Docker configs | 6 | Codex (partial) | IN PROGRESS | docker-compose.yml reviewed; FL1 found |
| 52 | OpenAPI specs | 3 | NOT STARTED | NOT STARTED | core-api.yaml, brain-api.yaml, schemas.yaml |
| | | | | | |
| **DOCUMENTATION** | | **~20** | | | |
| 53 | README.md | 1 | Claude | COMPLETE | D05 (missing "What Works Today") |
| 54 | ARCHITECTURE.md | 1 | Claude | COMPLETE | Full read, 2100+ lines |
| 55 | SECURITY.md | 1 | Claude + Codex | COMPLETE | D03 (CLIENT_TOKEN gap) |
| 56 | Walkthroughs (4 files) | 4 | Claude | COMPLETE | Core, Brain, Security, AppView |
| 57 | ROADMAP.md | 1 | Claude | COMPLETE | D01 (stale statuses) |
| 58 | TODO.md | 1 | Claude | COMPLETE | D02 (stale items) |

---

## Findings Summary by Reviewer

### Claude Findings (from architectural review + handler deep dive)

| ID | Severity | Component | Summary |
|----|----------|-----------|---------|
| F01 | HIGH | vault.go | HybridSearch bypasses gatekeeper |
| F02 | HIGH | transport.go | Sig verification uses only first DID key |
| F03 | HIGH | transport.go | Replay cache unbounded memory |
| F04 | HIGH | LLM adapters | Malformed JSON crash risk |
| F05 | MEDIUM | vault.go | Auth gauntlet duplicated 5x |
| F06 | MEDIUM | transport.go | Key conversion duplicated 4x |
| F07 | MEDIUM | main.py | Provider init duplicated 4x |
| F08 | MEDIUM | entity_vault.py | Token rehydration no origin check |
| F09 | MEDIUM | gatekeeper.go | PII regex incomplete |
| F10 | MEDIUM | auth.go + gatekeeper | Magic strings for trust/token kinds |
| F11-F15 | LOW | Various | DRY, complexity, config |
| GH1 | HIGH | reason.go:73 | Raw Brain error leaked to CLI |
| GH2 | HIGH | approval.go:40 | Silent JSON parse failure on approve |
| GH3 | MEDIUM | vault.go:529 | KV PUT no body size limit |
| GH4 | MEDIUM | approval.go | Raw service errors in responses |
| GH5 | MEDIUM | admin.go:60 | Brain URL exposed in sync-status |
| GH6 | MEDIUM | errors.go:14 | JSON injection in clientError() |
| GH7 | MEDIUM | persona.go:318 | Silent ListPending failure |
| GH8 | MEDIUM | persona.go:345 | Silent DEK error + type assertion |
| GH9 | MEDIUM | persona.go:381 | Race on approval revocation |
| GH10 | MEDIUM | staging.go:291 | O(n) scan on every resolve |
| GH11 | MEDIUM | export.go:165 | Import path not validated |
| GH12-13 | LOW | device/agent/msg | Multibase deferred, fragile error matching |
| D01-D05 | DOC | Various | Stale ROADMAP, TODO, README gaps |
| G01-G07 | TEST | Various | Missing test coverage |

### Codex Findings (from independent full-codebase review)

| ID | Severity | Component | Summary |
|----|----------|-----------|---------|
| FC1 | CRITICAL | settings.py + auth.go | API keys in KV readable by any paired device |
| FC2 | CRITICAL | enrichment.py + llm_router | Background enrichment sends raw vault to cloud unscrubbed |
| FH1 | HIGH | auth.go:1119 | Devices can forge audit entries via /v1/audit/append |
| FH2 | HIGH | auth.go:1120 | Devices can approve/deny requests via /v1/approvals/* |
| FH3 | HIGH | auth.go:1176 | Brain can create personas (POST /v1/personas in allowlist) |
| FH4 | HIGH | docker-compose:28 | Core binds all interfaces, plain HTTP, no TLS |
| FH5 | HIGH | login.py:75 | Admin sessions in process-local dict, breaks on restart |
| FM1 | MEDIUM | install.sh:723 | API keys in plaintext .env + container env (secret sprawl) |
| FM2 | MEDIUM | entity_vault.py:234 | Rehydration token collision (overlaps F08) |
| FM3 | MEDIUM | transport.go:73 | Replay + inbox in-memory only (overlaps F03) |
| FM4 | MEDIUM | main.py:551 | Background loops swallow exceptions silently |
| FM5 | MEDIUM | conftest.py + auth_test | Missing negative auth tests for dangerous paths |
| FL1 | LOW | docker-compose-release | Ships with DINA_TEST_MODE=true + hardcoded seeds |

### Codex Go Handler Review (auth allowlist cross-reference)

| ID | Severity | Summary |
|----|----------|---------|
| CXH1 | CRITICAL | Devices can approve/deny approvals — prefix `/v1/approvals` matches approve/deny paths + JSON decode error silently ignored → empty body approves. Agent can self-approve its own access. auth.go:1120, approval.go:23,40 |
| CXH2 | HIGH | Devices can forge audit entries — prefix `/v1/audit` matches POST append. auth.go:1119, audit.go:27 |
| CXH3 | HIGH | Devices can broadcast arbitrary notifications — `/v1/notify` on device allowlist, no caller check. auth.go:1117, notify.go:61 |
| CXH4 | HIGH | Brain errors leaked verbatim to /api/v1/reason callers — raw Brain response bodies in errors can leak vault content. reason.go:73, brainclient.go:359 |
| CXH5 | HIGH | Brain can create personas (not just list) — `/v1/personas` prefix matches POST. auth.go:1198, persona.go:64 |
| CXH6 | MEDIUM | `/admin/sync-status` unauthenticated — auth middleware skips all `/admin/*`. admin.go:51 |
| CXH7 | MEDIUM | Export/import leak filesystem paths via err.Error(). export.go:109-172 |

---

## Coverage by Component

```
GO CORE (216 files)
  ████████░░░░░░░░░░░░  ~40% reviewed (handlers, middleware, key services)
  Remaining: adapters (crypto, ws, sqlite, pds, plc), domain, ports, core tests

PYTHON BRAIN (89 files)
  ██████░░░░░░░░░░░░░░  ~30% reviewed (main, guardian, router, entity_vault, core_http, presidio)
  Remaining: 10 services, 7 adapters, routes, admin UI, brain tests

TYPESCRIPT APPVIEW (113 files)
  ░░░░░░░░░░░░░░░░░░░░  0% reviewed (entire component unread at code level)

CLI (13 files)
  ██░░░░░░░░░░░░░░░░░░  ~10% (Codex partial read of main.py)

ADMIN CLI (8 files)
  ░░░░░░░░░░░░░░░░░░░░  0% reviewed

TESTS (120 files)
  ██░░░░░░░░░░░░░░░░░░  ~5% (conftest files only)

INFRASTRUCTURE (~40 files)
  ████░░░░░░░░░░░░░░░░  ~20% (install.sh, docker-compose, entrypoint)

DOCUMENTATION (~20 files)
  ████████████████████  100% reviewed
```

---

## Priority for Remaining Reviews

| Priority | Component | Files | Rationale |
|----------|-----------|-------|-----------|
| **P0** | Go adapters — crypto (6) | 6 | Key derivation correctness is existential |
| **P1** | Brain admin routes (11) | 11 | Codex found FC1 here; more may be hiding |
| **P2** | AppView trust score + ingester (43) | 43 | Entire trust network unreviewed |
| **P3** | Go adapters — sqlite/vault (8) | 8 | Data storage correctness |
| **P4** | Brain services — remaining (10) | 10 | Enrichment, sync, nudge, domain classifier |
| **P5** | Go domain types + ports (47) | 47 | Contract correctness |
| **P6** | Test files (120+) | 120 | Validate test quality |
| **P7** | CLI + Admin CLI (21) | 21 | User-facing tool correctness |
| **P8** | AppView DB + handlers (33) | 33 | SQL injection, data integrity |
| **P9** | Infrastructure (40) | 40 | Deploy safety, secret management |
