# Full Test Session — 2026-03-23 Round 3

## Complete Command Coverage Test Results

### dina CLI Commands

| Command | Status | Notes |
|---------|--------|-------|
| `dina status` | PASS | Shows paired, DID, reachable |
| `dina configure` | PASS | (tested during setup) |
| `dina session start --name` | PASS | Returns ses_xxx (Name) active |
| `dina session start` (no name) | PASS | Auto-generates SName-DDMMMHHMM:SS |
| `dina session list` | PASS | Shows active sessions with grants |
| `dina session end <id>` | PASS | Fixed — accepts both ID and name |
| `dina session end <name>` | PASS | Works |
| `dina remember --session` | PASS | status: stored for general persona |
| `dina remember` (sensitive) | PASS | status: needs_approval with preview |
| `dina remember` (no --session) | PASS | Error: Missing option '--session' |
| `dina remember-status <id>` | PASS | Shows stored after approval |
| `dina remember-status <bad-id>` | PASS | Error: HTTP 404 |
| `dina ask --session` | PASS | Correct answers with real names |
| `dina ask` (cross-reference) | PASS | Combines data across items |
| `dina ask` (unapproved) | PASS | Clear approval message with command |
| `dina ask` (no --session) | PASS | Error: Missing option '--session' |
| `dina ask-status <bad-id>` | PASS | Error: HTTP 404 |
| `dina scrub` (no PII) | PASS | Text unchanged |
| `dina scrub` (structured PII) | PASS | Phone, email → tokens |
| `dina scrub` (gov IDs) | PASS | Aadhaar, PAN → tokens |
| `dina scrub` (names - V1 gap) | PASS | Names pass through (by design) |
| `dina scrub ""` | PASS | Error: text is required |
| `dina rehydrate` | PASS | Full round-trip works |
| `dina validate` (safe) | PASS | status: approved, risk: SAFE |
| `dina validate` (risky) | PASS | status: pending_approval, risk: MODERATE |
| `dina validate` (no --session) | PASS | Error: Missing option '--session' |
| `dina validate-status` | PASS | Shows pending_approval status |
| `dina audit` | ISSUE | Entries have empty action/summary/source fields |
| `dina draft` | PASS | Returns draft_id, status: pending_review |
| `dina task` | PASS | Error: OpenClaw not configured (expected — no OpenClaw) |
| `dina unpair` | SKIP | Not tested (would break pairing) |

### dina-admin Commands

| Command | Status | Notes |
|---------|--------|-------|
| `dina-admin status` | PASS | core healthy, personas, LLM info |
| `dina-admin persona list` | PASS | Shows name, tier, open/locked |
| `dina-admin persona create` | SKIP | Not tested (would create permanent persona) |
| `dina-admin persona unlock` | SKIP | Not tested (v1 auto-open) |
| `dina-admin device list` | PASS | Shows tok-1 with DID |
| `dina-admin device pair` | PASS | Generates 6-digit code |
| `dina-admin device revoke` | SKIP | Not tested (would break pairing) |
| `dina-admin identity show` | PASS | DID document with verification method |
| `dina-admin identity sign` | PASS | Returns hex signature |
| `dina-admin model list` | PASS | Active + available models, embed models |
| `dina-admin model set` | SKIP | Interactive — not testable non-interactively |
| `dina-admin approvals` | PASS | Lists with reason, preview, session |
| `dina-admin approvals approve` | PASS | Approved → data accessible |
| `dina-admin approvals deny` | SKIP | Help verified, not tested live |
| `dina-admin intent list` | ISSUE | HTTP 301 redirect — endpoint path issue |
| `dina-admin security status` | PASS | Shows auto-start mode |
| `dina-admin trace <req_id>` | PASS | Shows request timeline with timings |
| `dina-admin vault list` | PASS | Paginated listing works |
| `dina-admin vault search` | PASS | Keyword search works |
| `dina-admin vault search` (no results) | PASS | "No items found" |
| `dina-admin vault delete` | PASS | Deletes item |
| `dina-admin vault delete` (bad id) | ISSUE | Returns "Deleted" for nonexistent ID (should 404) |

---

## Issues Found

### Issue 14: LOW — `dina audit` entries have empty fields
```
{'action': '', 'summary': '', 'source': '', 'timestamp': '2026-03-23T15:50:47Z'}
```
Audit entries are created but action/summary/source are empty. Either the entries
are being created without populating these fields, or the CLI isn't displaying
the right fields from the response.

### Issue 15: LOW — `dina-admin intent list` returns 301
```
Error: HTTP 301: Moved Permanently
```
The intent proposals endpoint has a trailing-slash redirect issue.

### Issue 16: LOW — `dina-admin vault delete` succeeds for nonexistent IDs
```
$ dina-admin vault delete nonexistent-id --persona general --yes
Deleted: nonexistent-id from general
```
Core returns 204 for any DELETE regardless of whether the item exists.
Should return 404 for unknown IDs.
