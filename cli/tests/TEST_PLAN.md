# Dina CLI — Test Plan

> Python CLI (`dina-cli`): Ed25519 signed requests, device pairing, vault operations, PII scrub/rehydrate.
> Communicates with dina-core via Ed25519 request signing (no bearer tokens).

---

## 1. Ed25519 Keypair & Identity

### 1.1 Keypair Generation & Persistence

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-001]** Generate creates key files | `CLIIdentity.generate()` on empty directory | `ed25519_private.pem` and `ed25519_public.pem` created |
| 2 | **[TST-CLI-002]** Private key permissions | Generated keypair | Private key file mode is `0600` (owner read/write only) |
| 3 | **[TST-CLI-003]** Load existing keypair | Generate then load in fresh instance | DID starts with `did:key:z` — keypair round-trips through PEM |
| 4 | **[TST-CLI-004]** Auto-load on ensure_loaded | Generate, then `ensure_loaded()` without explicit `load()` | DID available — auto-detects existing keypair |
| 5 | **[TST-CLI-005]** Missing keypair raises error | `ensure_loaded()` with no keypair on disk | `FileNotFoundError` with "No keypair found" message |

### 1.2 DID Derivation

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-006]** DID format is did:key:z6Mk | Generated Ed25519 keypair | DID starts with `did:key:z6Mk` (Ed25519 multicodec prefix) |
| 2 | **[TST-CLI-007]** DID is deterministic | Same keypair, call `did()` twice | Identical DID both times |
| 3 | **[TST-CLI-008]** Different keys produce different DIDs | Two independently generated keypairs | `did1 != did2` |

### 1.3 Public Key Multibase

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-009]** Multibase format correct | Generated keypair | Starts with `z` (base58btc), 2-byte Ed25519 multicodec prefix, 32 bytes pubkey |
| 2 | **[TST-CLI-010]** Multibase round-trip | Encode then decode multibase | Decoded public key bytes match original |

### 1.4 Request Signing

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-011]** Sign returns four parts | `sign_request("POST", "/v1/vault/query", body)` | Returns `(did, timestamp, nonce, signature_hex)` — DID starts with `did:key:z`, timestamp is ISO 8601 UTC, nonce is 32 hex chars, sig is 128 hex chars |
| 2 | **[TST-CLI-012]** Signature is verifiable | Sign a request, reconstruct canonical payload | `Ed25519PublicKey.verify()` succeeds — signature matches 6-part canonical payload `{METHOD}\n{PATH}\n{QUERY}\n{TIMESTAMP}\n{NONCE}\n{SHA256(BODY)}` |
| 3 | **[TST-CLI-013]** Empty body signing | `sign_request("GET", "/healthz")` with no body | Uses SHA-256 of empty string — signature verifiable |
| 4 | **[TST-CLI-014]** Different payloads produce different signatures | Sign two requests with different paths/bodies | `sig1 != sig2` |

---

## 2. HTTP Client (DinaClient)

### 2.1 Vault Operations

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-015]** Vault store success | `vault_store("personal", item)` → 200 | Returns `{"item_id": "..."}` |
| 2 | **[TST-CLI-016]** Vault query success | `vault_query("personal", "test")` → 200 | Returns list of items with Summary field |
| 3 | **[TST-CLI-017]** KV get found | `kv_get("mykey")` → 200 | Returns value string |
| 4 | **[TST-CLI-018]** KV get not found | `kv_get("missing")` → 404 | Returns `None` (not exception) |

### 2.2 Error Handling

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-019]** Connection error | Core unreachable | `DinaClientError` with "Cannot reach Dina" message |
| 2 | **[TST-CLI-020]** Auth error (401) | Invalid/expired credentials | `DinaClientError` with "Invalid token" message |

### 2.3 Process Event

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-021]** Process event via Core | `process_event({"type": "agent_intent"})` | Routes through Core (not Brain), returns `{"status": "approved"}` |

### 2.4 Client Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-022]** Context manager | `with DinaClient(config) as client:` | Client usable inside context, cleaned up on exit |

### 2.5 Signature Auth Headers

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-023]** Signing headers set on requests | Any HTTP request via DinaClient | Headers contain `X-DID`, `X-Timestamp`, `X-Signature` |
| 2 | **[TST-CLI-024]** No Bearer token on Core client | Inspect client headers | No `Authorization` header — Ed25519 signing only |

### 2.6 Body Extraction

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-025]** JSON body serialized compactly | `json={"key": "value"}` kwarg | Body is compact JSON bytes, Content-Type set |
| 2 | **[TST-CLI-026]** String content as bytes | `content="hello"` kwarg | Body is `b"hello"` |
| 3 | **[TST-CLI-027]** Empty body | No content kwargs | Body is `b""` |

---

## 3. CLI Commands

### 3.1 remember

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-028]** Remember (JSON output) | `dina --json remember "Buy milk"` | Exit 0, JSON with `stored: true`, id starts with `mem_` |
| 2 | **[TST-CLI-029]** Remember (human output) | `dina remember "Buy milk"` | Exit 0, output contains `stored: True` |
| 3 | **[TST-CLI-030]** Remember with category | `dina --json remember "Alice bday" --category relationship` | Exit 0, vault_store called with `category: "relationship"` in metadata |

### 3.2 recall

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-031]** Recall (JSON output) | `dina --json recall "milk"` | Exit 0, JSON array with content field |
| 2 | **[TST-CLI-032]** Recall empty result | `dina --json recall "nonexistent"` | Exit 0, empty JSON array `[]` |

### 3.3 validate

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-033]** Validate approved (safe action) | `dina --json validate read_email "Read inbox"` | Exit 0, status `approved`, id starts with `val_` |
| 2 | **[TST-CLI-034]** Validate pending (risky action) | `dina --json validate delete_emails "Delete 247 emails"` | Exit 0, status `pending_approval`, dashboard_url present |
| 3 | **[TST-CLI-035]** Fallback: safe action when Core down | Core unreachable, action `search` | Exit 0, status `approved` — safe actions auto-approve offline |
| 4 | **[TST-CLI-036]** Fallback: risky action when Core down | Core unreachable, action `send_email` | Exit 0, status `pending_approval` — risky actions need approval even offline |

### 3.4 validate-status

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-037]** Status found | `dina --json validate-status val_abc12345` | Exit 0, status from KV store |
| 2 | **[TST-CLI-038]** Status not found | `dina --json validate-status val_missing` | Non-zero exit code |

### 3.5 scrub

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-039]** Scrub (JSON output) | `dina --json scrub "john@ex.com sent a message"` | Exit 0, scrubbed text with `[EMAIL_1]`, session ID starts with `sess_` |

### 3.6 rehydrate

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-040]** Rehydrate (JSON output) | `dina --json rehydrate "[PERSON_1] at [ORG_1]" --session sess_abc` | Exit 0, tokens replaced with original values |

### 3.7 draft

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-041]** Draft (JSON output) | `dina --json draft "Hello!" --to alice@ex.com --channel email` | Exit 0, status `pending_review`, draft_id starts with `drf_` |

### 3.8 sign

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-042]** Sign data locally | `dina --json sign "I approve the budget"` | Exit 0, `signed_by` is `did:key:z*`, signature is 128 hex chars, timestamp present |

### 3.9 audit

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-043]** Audit (JSON output) | `dina --json audit --limit 5` | Exit 0, JSON array of activity items |

### 3.10 Error & Configuration

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-044]** Missing keypair aborts | CLI invoked without generated keypair | Non-zero exit code |
| 2 | **[TST-CLI-045]** Configure generates keypair | `dina configure` with prompts | `_configure_signature` called, config saved with device_name |
| 3 | **[TST-CLI-046]** Configure help | `dina configure --help` | Exit 0, shows "Set up connection" |

---

## 4. PII Session Store

### 4.1 Session Lifecycle

| # | Scenario | Input | Expected |
|---|----------|-------|----------|
| 1 | **[TST-CLI-047]** New session ID format | `SessionStore.new_id()` | ID starts with `sess_`, 13 chars total (5 prefix + 8 hex) |
| 2 | **[TST-CLI-048]** Save and load round-trip | Save 3 entities, load by session ID | Loaded entities have correct `token` and `value` — `[EMAIL_1]`, `[PHONE_1]`, `[EMAIL_2]` |
| 3 | **[TST-CLI-049]** Python-style keys accepted | Entities with lowercase `type`/`value` keys | Parsed correctly — `[PERSON_1]`, `[ORG_1]` |
| 4 | **[TST-CLI-050]** Rehydrate replaces tokens | `[PERSON_1] at [ORG_1]` with session mapping | Returns `"Dr. Sharma at Apollo Hospital recommends dietary changes"` |
| 5 | **[TST-CLI-051]** Load missing session | Non-existent session ID | `FileNotFoundError` raised |
| 6 | **[TST-CLI-052]** Atomic write (no temp files) | Save then list directory | Exactly one `.json` file, no `.tmp` leftovers |
