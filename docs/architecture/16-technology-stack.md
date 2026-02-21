> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Technology Stack Summary

| Component | Technology | Why |
|-----------|-----------|-----|
| **Home Node (dina-core)** | | |
| Core runtime | Go + net/http (HTTP server) | Fast compilation, single static binary, excellent crypto stdlib, goroutines for concurrency. Pure sovereign kernel — no external API calls, no OAuth, no connector code. |
| Database | SQLite + SQLCipher + FTS5 (via `mutecomm/go-sqlcipher` with CGO) | Battle-tested, per-persona encrypted `.sqlite` files (`identity.sqlite`, `personal.sqlite`, `health.sqlite`, etc.). Each file has its own HKDF-derived DEK. No separate DB server. SQLCipher provides transparent whole-database AES-256 encryption. FTS5 tokenizer: `unicode61 remove_diacritics 1` (multilingual — Hindi, Tamil, Kannada, etc.). Porter stemmer forbidden (English-only). Phase 3: ICU tokenizer for CJK. **Not** `mattn/go-sqlite3` — SQLCipher support was never merged into mainline mattn; it only exists in forks. `mutecomm/go-sqlcipher` embeds SQLCipher directly. CI must assert raw `.sqlite` bytes are not valid SQLite headers (proving encryption is active). |
| Vector search | Phase 1: vectors stored and queried in dina-brain (Python, sqlite-vec). Phase 2: sqlite-vec in core via CGO. | Brain handles embeddings initially; core handles structured/FTS queries. Clean separation. |
| PII scrubbing | Three tiers: (1) Regex in Go core (always), (2) spaCy NER in Python brain (always, ~15MB model), (3) LLM NER via llama:8080 (optional, `--profile local-llm`). | Tier 1+2 catch structured + contextual PII in all profiles. Tier 3 adds LLM-based detection for edge cases. |
| Client ↔ Node protocol | Authenticated WebSocket (TLS + CLIENT_TOKEN auth frame) | Encrypted channel, per-device Bearer token proves identity. SHA-256 hash stored in `device_tokens` table. |
| Home Node ↔ Home Node | Phase 1: libsodium `crypto_box_seal` (ephemeral sender keys) + DIDComm-shaped plaintext. Phase 2: full JWE (ECDH-1PU). Phase 3: Noise XX sessions for full forward secrecy. | Sender FS from day one. Full FS in Phase 3. Plaintext format is DIDComm-compatible throughout — migration is encryption-layer only. |
| **Home Node (dina-brain)** | | |
| Brain runtime | Python + Google ADK (v1.25+, Apache 2.0) | Model-agnostic agent framework, multi-agent orchestration |
| PII scrubbing (Tier 2) | spaCy + `en_core_web_sm` (~15MB) | Statistical NER: person names, orgs, locations. Always available, milliseconds on CPU. Upgrade to `en_core_web_md` (~50MB) for better accuracy. |
| Text LLM (Online) | Gemini 2.5 Flash Lite API ($0.10/$0.40 per 1M tokens) | Cheapest Gemini model, 1M context, native function calling + JSON mode, 305+ t/s |
| Text LLM (Local) | llama (llama.cpp) + Gemma 3n E4B GGUF (~3GB RAM) | OpenAI-compatible API on port 8080, CPU/Apple Silicon inference. Optional via `--profile local-llm`. |
| Voice STT (Online) | Deepgram Nova-3 ($0.0077/min, WebSocket streaming) | ~150-300ms latency, purpose-built real-time STT. Fallback: Gemini Flash Lite Live API. |
| Voice STT (Local, future) | whisper.cpp + Whisper Large v3 Turbo (~3GB) | 4.4% WER, battle-tested. Not in Phase 1 — deferred until local LLM profile is stable. |
| Cloud LLM (escalation) | User's choice (Gemini 2.5 Flash/Pro, Claude, GPT-4) | For complex reasoning that Flash Lite can't handle. Goes through PII scrubber. |
| Agent orchestration | Google ADK Sequential/Parallel/Loop agents | Multi-step reasoning, tool calling with retries |
| External agent integration | MCP (Model Context Protocol) | Connect to OpenClaw and other child agents. No plugins — agents are external processes. |
| Embeddings (Online) | `gemini-embedding-001` ($0.01/1M tokens) | 768/3072 dims, 100+ languages |
| Embeddings (Local) | EmbeddingGemma 308M (GGUF) via llama:8080 | ~300MB RAM, 100+ languages, Matryoshka dims. Available with `--profile local-llm`. |
| **Container orchestration** | | |
| Default (cloud LLM) | docker-compose (3 containers: core, brain, pds). | 2GB RAM minimum. Cloud LLM for reasoning, regex + spaCy NER PII scrubbing. |
| With local LLM | docker-compose (4 containers: core, brain, pds, llama). `--profile local-llm`. | 8GB RAM minimum. Mac Mini M4 (16GB) recommended. Three-tier PII scrubbing (regex + spaCy + LLM NER), full offline LLM. |
| Managed hosting | docker-compose or Fly.io | Same containers, orchestrated by hosting operator |
| **Identity & Crypto** | | |
| Identity | W3C DIDs (`did:plc` via PLC Directory) | Open standard, globally resolvable, key rotation, 30M+ identities, Go implementation available. Escape hatch: rotation op to `did:web`. |
| Key management | SLIP-0010 HD derivation (Ed25519), BIP-39 mnemonic | Proven, Ed25519-compatible |
| Vault encryption | SQLCipher (AES-256-CBC per page, transparent) | Per-persona file encryption (`identity.sqlite`, `personal.sqlite`, `health.sqlite`, etc.). Each file has its own DEK. FTS5/sqlite-vec indices encrypted transparently within each file. |
| Wire encryption (Phase 1) | libsodium: X25519 + XSalsa20-Poly1305 (`crypto_box_seal`) | Ephemeral sender keys, ISC license, available in every language |
| Wire encryption (Phase 3) | Noise XX: X25519 + ChaChaPoly + SHA256 | Full forward secrecy for always-on Home Node sessions |
| Key wrapping / archive | AES-256-GCM, X25519, Ed25519 | Industry standard for key wrapping, archive snapshots |
| Identity key derivation | SLIP-0010 (hardened Ed25519 HD paths) | Ed25519-compatible, no unsafe public derivation. Go: `stellar/go/exp/crypto/derivation` |
| Vault key derivation | HKDF-SHA256 (from master seed, per-persona info strings) | Per-persona DEKs: `HKDF(info="dina:vault:personal:v1")`, `HKDF(info="dina:vault:health:v1")`, etc. |
| Key storage (Home Node) | Key Wrapping: Passphrase → Argon2id (KEK) → AES-256-GCM wraps Master Seed | Standard key wrapping. Passphrase change re-wraps seed without re-encrypting any database. Per-persona DEKs derived at runtime via HKDF. |
| Key storage (client) | Secure Enclave (iOS), StrongBox (Android), TPM (desktop) | Hardware-backed where available |
| **Client Devices** | | |
| Android client | Kotlin + Jetpack Compose | Native Android client |
| iOS client | Swift + SwiftUI (Phase 3) | Native iOS client |
| Desktop client | Tauri 2 (Rust + WebView, v2.10+) or Wails (Go + WebView) | Cross-platform, tiny binaries, native performance |
| On-device LLM (rich clients) | LiteRT-LM (Android), llama.cpp (desktop) | Latency-sensitive tasks: quick classification, offline drafting |
| Thin clients (glasses, watch) | Web-based via authenticated WebSocket | No local processing, streams from Home Node |
| **Infrastructure** | | |
| DID resolution | PLC Directory (`did:plc`), `did:web` escape hatch | `did:plc`: proven at 30M+ scale, key rotation, Go implementation (`bluesky-social/indigo`). `did:web`: sovereignty escape if PLC Directory becomes adversarial — rotation op transitions transparently. |
| Push to clients | FCM/APNs (Phase 1), UnifiedPush (Phase 2) | Wake clients when Home Node has updates |
| Backup | Any blob storage (S3, Backblaze, NAS) | Encrypted snapshots of Home Node vault |
| Reputation Graph (PDS) | AT Protocol PDS (bundled by default — Split Sovereignty). Custom Lexicons (`com.dina.reputation.*`). Signed tombstones for deletion. | PDS always in docker-compose (port 2583). Type A variation: home users behind CGNAT push to external PDS (`pds.dina.host`). See Layer 3 "PDS Hosting: Split Sovereignty". |
| Reputation Graph (AppView) | Go + PostgreSQL 16 (`pg_trgm`). `indigo` firehose consumer. Phase 1: single monolith (0–1M users). Phase 3: sharded cluster (ScyllaDB + Kafka + K8s). | Read-only indexer. Signature verification on every record. Three-layer trust-but-verify: cryptographic proof, consensus check, direct PDS spot-check. AppView is a commodity — anyone can run one. See Layer 3 "Reputation AppView". |
| Reputation Graph (timestamps) | L2 Merkle root anchoring (Phase 3). Base or Polygon. | Provable "this existed before this date" for dispute resolution. Not needed until real money flows through the system. |
| ZKP | Semaphore V4 (PSE/Ethereum Foundation) | Production-proven (World ID), off-chain proof generation |
| Serialization | JSON (Phase 1), MessagePack or Protobuf (Phase 2) | JSON is debuggable and sufficient for core↔brain traffic volume. Binary serialization deferred until profiling shows it matters. |
| Containerization | Docker + docker-compose | Single-command Home Node deployment: `docker compose up -d` |
| Supply chain | Digest pinning (`@sha256:...`, never `:latest`), Cosign image signing, SBOM (`syft`, SPDX) | Pinning prevents breakage, signing prevents tampering, SBOM enables auditing. Reproducible builds skipped (too hard with Python/CUDA). See [SECURITY.md](SECURITY.md). |
| **Observability** | | |
| Watchdog | Internal Go ticker (1-hour interval) | Checks connector liveness, disk usage, brain health. Breaches inject Tier 2 system messages into user's notification stream. No external monitoring stack. Zero extra RAM. |
| Health probes | `/healthz` (liveness), `/readyz` (readiness) | Docker kills and restarts zombie containers automatically |
| Logging | Go `slog` + Python `structlog` → JSON to stdout | No file logs; Docker log rotation handles retention. **PII policy:** log metadata only (persona, type, count, error code). Never log vault content, queries, or plaintext. Brain crash tracebacks → encrypted vault, not stdout. CI linter rejects banned patterns. |
| Self-healing | `restart: always` + healthcheck + dependency chain | Brain waits for core; all containers auto-recover |
| Metrics (optional) | `/metrics` (Prometheus format, protected by `CLIENT_TOKEN`) | For power users with existing homelab dashboards. Not required for default operation. |
| **Data Safety** | | |
| Database config | WAL mode + `synchronous=NORMAL` | Crash-safe atomic writes |
| Migration safety | `sqlcipher_export()` + `PRAGMA integrity_check` | Pre-flight snapshot before every schema change. **Never `VACUUM INTO`** — creates unencrypted copies on SQLCipher (CVE-level vulnerability). |
| File system (managed hosting) | ZFS or Btrfs | Copy-on-write snapshots every 15 min |
| Off-site backup | Encrypted snapshots to S3/Backblaze | Covers disk failure, theft |
| Deep archive (Tier 5) | AWS Glacier Deep Archive (Object Lock) or physical drive | Immutable cold storage — survives ransomware |
| **Managed Hosting** | | |
| Tenancy model | Per-persona `.sqlite` files per user (Phase 1: `identity.sqlite` + `personal.sqlite`) | Per-file crypto isolation, trivial portability (`rm persona.sqlite`), true right-to-delete. Multi-tenant: `/var/lib/dina/users/<did>/` (future). |
| Confidential computing | AWS Nitro Enclaves / AMD SEV-SNP / Intel TDX | Operator cannot read enclave memory, even with root access |
| System database | SQLite or Postgres (tiny) | Routing, auth, billing only — no personal data. Separate from user vaults. |

---

