# Test Specification

Every test function in Dina has a structured `TRACE` comment on the line immediately above it. The function name stays clean and human-readable. All metadata lives in the TRACE comment as JSON.

## Format

```python
# TRACE: {"suite":"BRAIN","case":"0270","section":"08","subsection":"01","scenario":"01","sectionName":"Admin UI","title":"dashboard_loads"}
def test_dashboard_loads():
```

```go
// TRACE: {"suite":"CORE","case":"0101","section":"01","subsection":"01","scenario":"01","sectionName":"Authentication & Authorization","title":"service_key_ed25519_signing"}
func Test_service_key_ed25519_signing(t *testing.T) {
```

```typescript
// TRACE: {"suite":"APPVIEW","case":"0033","section":"01","subsection":"02","scenario":"01","sectionName":"Ingester Handlers","title":"ingester_handles_attestation"}
it("ingester handles attestation", () => {
```

## Fields

| Field | Required | Format | Purpose |
|-------|----------|--------|---------|
| `suite` | Yes | `BRAIN\|CLI\|ADMIN\|INT\|E2E\|INST\|REL\|CORE\|APPVIEW\|SYSTEM` | Which test suite |
| `case` | Yes | Zero-padded 4 digits (`0270`) | Unique test plan ID within the suite |
| `section` | Yes | Zero-padded 2 digits (`08`) | Section number — drives report grouping |
| `sectionName` | Yes | Human-readable (`Admin UI`) | Section title in the report |
| `subsection` | No | Zero-padded 2 digits (`01`) | Subsection within the section |
| `scenario` | No | Zero-padded 2 digits (`01`) | Scenario within the subsection |
| `title` | Yes | snake_case | Short description of what the test validates |

## Rules

1. **One line, immediately above the function.** No blank lines between TRACE and def/func/it.
2. **Valid JSON.** Parseable by `json.loads()` / `JSON.parse()` / Go `json.Unmarshal`.
3. **Function name is clean.** No plan IDs, no section numbers in the function name. The function name is `test_<description>` — nothing else.
4. **Case IDs are unique within a suite.** `BRAIN:0270` is unique. `CORE:0270` is a different test.
5. **Section numbers are stable.** Once section 08 is "Admin UI", it stays "Admin UI". New sections get the next number.
6. **Comment prefix by language:**
   - Python: `# TRACE: {...}`
   - Go: `// TRACE: {...}`
   - TypeScript: `// TRACE: {...}`
   - Shell: `# TRACE: {...}`

## Traceability Check

One check for all languages, all suites:

```
Does the line immediately above the test function start with "# TRACE:" or "// TRACE:"?
```

- Yes → tagged. Parse JSON for suite, case, section.
- No → untagged. Fails traceability gate.

No regex hacks, no "look back 5 lines", no pattern variations per suite.

## Report Generation

The test runner reads TRACE comments to build the grouped report:

```
Section 8: Admin UI — 33 tests, 33 pass
Section 9: Configuration — 10 tests, 10 pass
```

It groups by `section` + `sectionName`, counts by `suite`, and links to `case` for drill-down.

## Sections by Suite

### BRAIN
| Section | Name |
|---------|------|
| 01 | Authentication & Authorization |
| 02 | Guardian Loop (Core AI Reasoning) |
| 03 | PII Scrubber (Tier 2) |
| 04 | LLM Router (Multi-Provider) |
| 05 | Sync Engine (Ingestion Pipeline) |
| 06 | MCP Client (Agent Delegation) |
| 07 | Core Client (HTTP Client) |
| 08 | Admin UI |
| 09 | Configuration |
| 10 | API Endpoints |
| 11 | Error Handling & Resilience |
| 12 | Scratchpad (Cognitive Checkpointing) |
| 13 | Crash Traceback Safety |
| 14 | Embedding Generation |
| 15 | Silence Classification |
| 16 | Anti-Her Enforcement |
| 17 | Thesis: Human Connection |
| 18 | Thesis: Silence First |
| 19 | Thesis: Pull Economy |
| 20 | Thesis: Action Integrity |
| 21 | Deferred (Phase 2+) |
| 22 | Voice STT Integration |
| 23 | Code Review Fix Verification |
| 24 | Architecture Review Coverage |
| 25 | Channel Parity & Resilience |

### CORE
| Section | Name |
|---------|------|
| 01 | Authentication & Authorization |
| 02 | Key Derivation & Cryptography |
| 03 | Identity (DID) |
| 04 | Vault (SQLCipher) |
| 05 | PII Scrubber (Tier 1 — Go Regex) |
| 06 | Gatekeeper (Egress / Sharing Policy) |
| 07 | Transport Layer |
| 08 | Task Queue (Outbox Pattern) |
| 09 | WebSocket Protocol |
| 10 | Device Pairing |
| 11 | Brain Client & Circuit Breaker |
| 12 | Admin Proxy |
| 13 | Rate Limiting |
| 14 | Configuration |
| 15 | API Endpoint Tests |
| 16 | Error Handling & Edge Cases |
| 17 | Security Hardening |
| 18 | Core-Brain API Contract |
| 19 | Onboarding Sequence |
| 20 | Observability & Self-Healing |
| 21 | Logging Policy |
| 22 | PDS Integration (AT Protocol) |
| 23 | Portability & Migration |
| 24 | Deferred (Phase 2+) |
| 25 | Bot Interface |
| 26 | Client Sync Protocol |
| 27 | Digital Estate |
| 28 | CLI Request Signing |
| 29 | Adversarial & Security |
| 30 | Test System Quality |
| 31 | Code Review Fix Verification |
| 32 | Security Fix Verification |
| 33 | Architecture Review Coverage |
| 34 | Thesis: Loyalty |
| 35 | Thesis: Silence First |
| 36 | Thesis: Action Integrity |

### INT (Integration)
| Section | Name |
|---------|------|
| 01 | Core-Brain Communication |
| 02 | End-to-End User Flows |
| 03 | Dina-to-Dina Communication |
| 04 | LLM Integration |
| 05 | Docker Networking & Isolation |
| 06 | Crash Recovery & Resilience |
| 07 | Security Boundary Tests |
| 08 | Digital Estate |
| 09 | Ingestion-to-Vault Pipeline |
| 10 | Data Flow Patterns |
| 11 | Trust Network Integration |
| 12 | Upgrade & Migration |
| 14 | Chaos Engineering |
| 15 | Compliance & Privacy |
| 16 | Deferred (Phase 2+) |
| 17 | Architecture Validation |
| 18 | Architecture Validation — Medium |
| 19 | Thesis: Loyalty |
| 20 | Thesis: Human Connection |
| 21 | Thesis: Silence First |
| 22 | Thesis: Pull Economy |
| 23 | Thesis: Action Integrity |
| 24 | Async Approval Flow |

## Migration

For each test function:

1. Add `# TRACE: {...}` on the line above
2. Keep the function name as-is (or clean it up)
3. Run the traceability checker to verify

The `docs/issues/all_tests.md` file tracks migration status for all 5,595 tests.
