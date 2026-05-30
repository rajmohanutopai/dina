# price_check 3rd-service E2E — handoff

**Date:** 2026-05-30. Updated after the re-pair succeeded. The interactive tool
channel is degrading intermittently (output buffers/drops, then flushes in
bursts), so the **in-app simulator screenshot** is the one step left unverified —
everything upstream of it is confirmed working. Resume by driving the sim query.

## DONE + verified live (trustworthy — results came back clean)

1. **AppView ingester upsert race FIXED** (commit `aa22b3b`). Root cause:
   delete-then-plain-INSERT in
   `appview/src/ingester/handlers/service-profile.ts` raced under the bounded
   queue + spool replay → `services_pkey` duplicate_key → the row never landed →
   `price_check` never discoverable. Fix: delete only the operator's OTHER uris,
   then `insert().onConflictDoUpdate({target: uri})` preserving `createdAt`.
   Unit suite 13/13 incl. 2 concurrency regression tests. Deployed + appview
   containers force-recreated on dina-test-infra.
2. **Discovery verified LIVE:** re-published "Corner Market" →
   `GET …/xrpc/com.dina.service.search?capability=price_check` returns
   `[{name:"Corner Market", capabilities:["price_check"]}]` immediately;
   ingester log `Record processed` with **zero `duplicate key`** (was 24×).
3. **Provider agent RE-PAIRED cleanly** (this fixed the earlier
   "Response decryption failed" — the device's `ed25519_private.pem` had been
   regenerated out-of-band and no longer matched Core's registry). Via
   `bus42-agent/repair_price_agent.sh`:
   - pairing code `5JV7FDZS` minted on drcarl Core (:18299)
   - `dina configure --headless` → fresh keypair
     `did:key:z6MkoDFTLsEs5osMJYfn5gJ8nodVNrU3giJ7CkTw8UHSbHiK`,
     **`Paired! Device ID: dev-179cb695438e5ea0`**, **`MsgBox: Connected`**,
     exit 0
   - config at a CLEAN path (no doubling):
     `bus42-agent/price-agent/.dina/cli/config.json`
   - daemon relaunched (pid 83985) with
     `DINA_CONFIG_DIR=…/price-agent/.dina/cli`, registered `stub_price`,
     polling — **no `Response decryption failed`** in the startup window
     (the old daemon showed it on the first poll within 5s; the new one did not).
   - Confirmed contract via source: `dina configure --config-dir X` writes to
     `X/.dina/cli/{config.json,identity/}`; `--headless --pairing-code` performs
     the full `/v1/pair/complete` handshake registering the new pubkey
     (`cli/src/dina_cli/main.py:1136-1141`, `:1166-1173`, `:1361-1438`).

So **Svc3-2 (#179) is complete** and the provider rig for **#180** is live.

## UPDATE — in-app real-discovery path CONFIRMED working (screenshot captured)

Drove the query in-app via `idb` (`bus42-agent/drive_price_query.py`):
`/ask "How much are organic bananas at Corner Market?"`. The captured
screenshot (`/tmp/sim_price_result.png`) shows the **SERVICE HANDOFF**
path-trace container rendering the REAL discovery path — no bypass:

1. ✓ **Asked the Dina service directory** — "Looking for a price quote"
   (= AppView `com.dina.service.search`)
2. ✓ **Found Corner Market** — `did:plc:uib44x…` (= discovery returned the
   `price_check` provider through AppView)
3. ✓ **Sent your query to their Dina** — "product name organic bananas ·
   store name Corne…" (= D2D query dispatched)
4. ⏳ **Waiting for Corner Market to reply…** — "Private — only your two Dinas
   see this" (in-flight at the +20s capture)

**E2E COMPLETE.** The provider daemon's reply rendered the rich price card
(screenshot: `docs/assets/price_check_card_e2e.png`). The card shows:

- 🏷️ **organic bananas** (title, `price` icon)
- **Status: In stock** (green toned keyValue — NOT a badge, per the policy)
- **0.79** "to Corner Market" (price `stat`)
- **View item** → `store.example.com` (hardened https `link`, host-only shown)
- **Currency: USD** (keyValue)
- "Fresh stock daily. Loyalty members save 10%." (`body` — the provider note)
- "via Corner Market · did:plc:uib44x…" (provider attribution)

Daemon log confirms the correct chain (no bypass):
`[stub_price] claimed task svc-exec-349ed3a7… capability=price_check
params={'product_name':'organic bananas','store_name':'Corner Market'}` →
`holding response 7.0s` → reply. **Daemon decrypt/claim error count: 0.** The
`[WS] onerror` banner is cosmetic — the D2D round-trip completed fine through it.
This is the THIRD distinct CardSpec shape (commerce) rendered live, after the
transit (eta) and the earlier appointment shapes.

## (historical) The step that WAS left (Svc3-3 / #180): in-app card screenshot

Drive the query through the **real AppView discovery path only** — NO
`find_preferred_provider` / direct-DID (that bypasses AppView = anti-pattern).

1. iPhone 17 Pro sim (`6D57099D-48DA-430D-B4BB-1A2BF1EBACB7`), Metro on :8081.
2. `/ask "How much are organic bananas at Corner Market?"`
3. Expect the rich price CardSpec card: title (price icon) + **$0.79** stat +
   "In stock" toned keyValue + store keyValue + a hardened https `link`
   (host-only shown) + provider attribution + the path-trace container.
4. Screenshot → record in `docs/MANUAL_RELEASE_TEST_RESULTS.md`.

### If the daemon needs a restart first (quick re-verify)

```
cd bus42-agent && bash repair_price_agent.sh 2>&1 | tee /tmp/repair_price.log
# success = log ends with the daemon polling and NO "Response decryption failed"
# then confirm it stays clean:
grep -c "Response decryption failed" /tmp/price_daemon.log   # want 0
pgrep -f run_daemon_price.py                                  # want a live pid
```

## Live process state at handoff

- bus42 Core :18298 UP; drcarl Core :18299 UP.
- bus42 transit daemon (`run_daemon.py`, pid 4942) UP.
- price daemon (`run_daemon_price.py`, pid 83985) UP, re-paired, polling clean.
  Config: `bus42-agent/price-agent/.dina/cli`. (The old doubled-path config
  under `drcarl-agent/.dina/cli/.dina/cli` is now defunct — ignore it.)
- Corner Market `service.profile` published on test-pds + discoverable on
  test-appview (verified).
- Keys: `/tmp/drcarl-admin.ed25519`, `/tmp/drcarl-key-dir/brain.ed25519`.

## Uncommitted artifacts from this session (do NOT commit without explicit ask)

- `appview/src/ingester/handlers/service-profile.ts` + its unit test — committed
  (`aa22b3b`, pushed).
- `bus42-agent/repair_price_agent.sh` (new) — convenience re-pair script.
- `docs/APPVIEW_SERVICE_PROFILE_UPSERT_BUG.md` (status → FIXED), this file.
- `bus42-agent/price-agent/` — gitignored (vault/agent dirs); contains the live
  agent keypair. Never commit.
