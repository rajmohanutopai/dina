# Architecture Gap Tracker

> Cross-reference of architecture documents (`docs/architecture/`) against test plans and test code.
> Each gap is a specific behavior described in architecture that has no corresponding test.

**Status legend:** CLOSED = test written and passing | OPEN = needs test | SKIP = not testable or deferred

---

## HIGH Severity Gaps (15 total — all CLOSED)

All closed in `tests/integration/test_arch_validation.py` (TST-INT-590 through TST-INT-604).

| # | ID | Section | Gap | Status |
|---|-----|---------|-----|--------|
| H1 | TST-INT-590 | §1 | Plaintext only in memory, never at rest | CLOSED |
| H2 | TST-INT-591 | §2 | Export archive encrypted with AES-256-GCM | CLOSED |
| H3 | TST-INT-592 | §3 | Go Core makes zero external API calls | CLOSED |
| H4 | TST-INT-593 | §5 | SSS share rotation without changing master key | CLOSED |
| H5 | TST-INT-594 | §5 | SSS shard per-custodian NaCl encryption | CLOSED |
| H6 | TST-INT-595 | §5 | SSS recovery manifest on PDS | CLOSED |
| H7 | TST-INT-596 | §10 | Bot query contains no user DID | CLOSED |
| H8 | TST-INT-597 | §10 | Query sanitization strips all persona data | CLOSED |
| H9 | TST-INT-598 | §10 | Bot POST /query wire format matches spec | CLOSED |
| H10 | TST-INT-599 | §7 | Telegram connector via Bot API with token | CLOSED |
| H11 | TST-INT-600 | §8 | Outcome report payload matches architecture spec | CLOSED |
| H12 | TST-INT-601 | §8 | AppView Phase 1 single Go binary + PostgreSQL | CLOSED |
| H13 | TST-INT-602 | §13 | Encrypted snapshots and restore | CLOSED |
| H14 | TST-INT-603 | §16 | Deepgram Nova-3 WebSocket STT with fallback | CLOSED |
| H15 | TST-INT-604 | §17 | STT available in all deployment profiles | CLOSED |

---

## MEDIUM Severity Gaps (60 total — all CLOSED)

All closed in `tests/integration/test_arch_medium_1.py` (TST-INT-605 through TST-INT-634) and `tests/integration/test_arch_medium_2.py` (TST-INT-635 through TST-INT-664).

### §1-6: Home Node, Sidecar, Data Flow, Identity, Storage (18 gaps)

| # | ID | Section | Gap | Status |
|---|-----|---------|-----|--------|
| M1 | TST-INT-605 | §2.2 | IP rate limit 50 req/hr per IP, global 1000 req/hr, 256KB payload cap | CLOSED |
| M2 | TST-INT-606 | §2.2 | Per-DID rate limit only when vault unlocked; locked = IP-only | CLOSED |
| M3 | TST-INT-607 | §2.2 | Sweeper Valve 3: spam DID source IP added to Valve 1 blocklist | CLOSED |
| M4 | TST-INT-608 | §2.2 | TTL-expired messages stored silently in history, no notification | CLOSED |
| M5 | TST-INT-609 | §2.1 | Boot opens only identity + personal; other persona DBs closed | CLOSED |
| M6 | TST-INT-610 | §2.3 | Import rejects manifest checksum mismatch + incompatible version | CLOSED |
| M7 | TST-INT-611 | §2.3 | Export excludes device_tokens, BRAIN_TOKEN, passphrase | CLOSED |
| M8 | TST-INT-612 | §4 | include_content defaults false; true includes body_text | CLOSED |
| M9 | TST-INT-614 | §4 | Hybrid search: relevance = 0.4 fts5 + 0.6 cosine | CLOSED |
| M10 | TST-INT-615 | §4 | Dead letter after 3 failures + Tier 2 notification | CLOSED |
| M11 | TST-INT-616 | §4 | Watchdog resets processing task after 5-minute timeout | CLOSED |
| M12 | TST-INT-617 | §4 | Scratchpad auto-expires after 24 hours | CLOSED |
| M13 | TST-INT-618 | §6 | Backup key and Archive key are independent HKDF derivations | CLOSED |
| M14 | TST-INT-619 | §6 | Client Sync key + Trust Signing key HKDF derivations | CLOSED |
| M15 | TST-INT-620 | §6 | Argon2id defaults: 128MB memory, 3 iterations, 4 parallelism | CLOSED |
| M16 | TST-INT-613 | §4 | Vault query pagination: has_more + next_offset wire format | CLOSED |
| M17 | TST-INT-621 | §6 | kv_store sync cursor survives brain restart | CLOSED |
| M18 | TST-INT-622 | §5 | Restricted persona audit entry exact schema + daily briefing count | CLOSED |

### §7-10: Ingestion, Trust, D2D, Bot Interface (22 gaps)

| # | ID | Section | Gap | Status |
|---|-----|---------|-----|--------|
| M19 | TST-INT-623 | §7 | Voice memo: transcript stored, audio discarded | CLOSED |
| M20 | TST-INT-624 | §7 | Fiduciary override beats regex pre-filter for security alerts | CLOSED |
| M21 | TST-INT-625 | §7 | Pass 2a subject patterns: all 4 produce thin records | CLOSED |
| M22 | TST-INT-626 | §7 | Backfill pauses for user query, resumes from same cursor | CLOSED |
| M23 | TST-INT-627 | §7 | Cold archive pass-through: results never written to vault | CLOSED |
| M24 | TST-INT-628 | §7 | OpenClaw recovery resumes from exact cursor, no gap/dupes | CLOSED |
| M25 | TST-INT-629 | §7 | Phone connectors require CLIENT_TOKEN, not BRAIN_TOKEN | CLOSED |
| M26 | TST-INT-630 | §8 | Attestation lexicon rejects missing fields + out-of-range rating | CLOSED |
| M27 | TST-INT-631 | §8 | Consensus check: AppView censorship detection by count mismatch | CLOSED |
| M28 | TST-INT-632 | §8 | PDS spot-check discrepancy downgrades AppView trust | CLOSED |
| M29 | TST-INT-633 | §8 | Tombstone with correct DID but invalid signature rejected | CLOSED |
| M30 | TST-INT-634 | §8 | Merkle root deterministic + inclusion proof valid | CLOSED |
| M31 | TST-INT-635 | §9 | Malformed tiered payload category dropped, not errored | CLOSED |
| M32 | TST-INT-636 | §9 | Trusted contact + empty sharing_policy = no data shared | CLOSED |
| M33 | TST-INT-637 | §9 | Egress audit log: 90-day rolling retention purge | CLOSED |
| M34 | TST-INT-638 | §9 | Outbox message TTL 24h: expired messages dropped | CLOSED |
| M35 | TST-INT-639 | §9 | Bulk sharing policy update: applies only to filter-matching contacts | CLOSED |
| M36 | TST-INT-640 | §9 | New contact without policy gets 6-field security defaults | CLOSED |
| M37 | TST-INT-641 | §10 | Bot query includes response_format + max_sources with types | CLOSED |
| M38 | TST-INT-642 | §10 | Bot response missing attribution results in trust penalty | CLOSED |
| M39 | TST-INT-643 | §10 | Bot auto-routing threshold boundary (at/below) | CLOSED |
| M40 | TST-INT-644 | §10 | Bot-to-bot referral declined when referred bot below threshold | CLOSED |

### §11-18: Intelligence, Action, Client Sync, Estate, Infra (20 gaps)

| # | ID | Section | Gap | Status |
|---|-----|---------|-----|--------|
| M41 | TST-INT-645 | §11 | PII scrub failure blocks sensitive persona cloud route | CLOSED |
| M42 | TST-INT-646 | §11 | Entity Vault lifecycle: destroyed after rehydration | CLOSED |
| M43 | TST-INT-648 | §12 | Payment intent expires 12h (shorter than draft 72h) | CLOSED |
| M44 | TST-INT-649 | §12 | Agent draft_only constraint prevents send | CLOSED |
| M45 | TST-INT-650 | §12 | Reminder loop: negative sleep fires immediately (missed reminders) | CLOSED |
| M46 | TST-INT-652 | §13 | Conflict resolution: same-item offline modification (last-write-wins) | CLOSED |
| M47 | TST-INT-653 | §13/§17 | Missed message buffer: 50 max, 5-min TTL, ACK removes | CLOSED |
| M48 | TST-INT-654 | §17 | 3 missed pongs closes connection, marks device offline | CLOSED |
| M49 | TST-INT-655 | §17 | WebSocket auth frame 5-second timeout closes connection | CLOSED |
| M50 | TST-INT-657 | §17 | GET /.well-known/atproto-did returns did:plc for PDS federation | CLOSED |
| M51 | TST-INT-658 | §17 | PDS network internal: true prevents outbound internet | CLOSED |
| M52 | TST-INT-663 | §16 | Watchdog ticker: breach triggers Tier 2 system message | CLOSED |
| M53 | TST-INT-659 | §17 | Pairing code single-use: second attempt rejected | CLOSED |
| M54 | TST-INT-662 | §14 | read_only_90_days access expires server-side after 90 days | CLOSED |
| M55 | TST-INT-660 | §15 | Brain cannot directly reach PDS container (network isolation) | CLOSED |
| M56 | TST-INT-661 | §16 | ZFS/Btrfs copy-on-write snapshots every 15 min (managed hosting) | CLOSED |
| M57 | TST-INT-664 | §17 | Docker log rotation: all services max-size: 10m, max-file: 3 | CLOSED |
| M58 | TST-INT-647 | §11 | Simple lookup routes to FTS5, no LLM invoked | CLOSED |
| M59 | TST-INT-656 | §17 | WebSocket reconnect exponential backoff caps at 30s | CLOSED |
| M60 | TST-INT-651 | §12 | Cart handover outcome recorded in Tier 3 after completion | CLOSED |

---

## LOW Severity Gaps

_Tracked separately — not targeted for immediate closure._
