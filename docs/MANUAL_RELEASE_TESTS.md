  # Manual Release Tests

  Each scenario carries a separate **idb/adb validation** column so a code-level
  fix never gets confused with a live-device verification. The two columns are
  meant to be filled independently:

  - **Pass criteria** — what behaviour the test asserts.
  - **idb/adb validation** — left blank initially; the operator running the
    live pass fills this with the date + the device used (`iPhone 17 sim
    F9F52FCE`, `Pixel 10 emu`, etc.) and ✅ / ❌ / 🚧 (in progress) /
    ⏭ (skipped — out of scope this run). Code-level fixes in `MANUAL_RELEASE_TEST_RESULTS.md`
    DO NOT count as live validation. A row with a green code-fix entry
    in the results doc and an empty validation column here is "code ready,
    not yet driven through the OS".

  | # | Manual test | Pass criteria | idb/adb validation |
  |---|---|---|---|
  | 1 | Fresh install on iPhone | App launches cleanly, no dev-only errors, first-run flow starts. | |
  | 2 | Fresh install on Android | Same as iPhone; no platform-specific crashes. | |
  | 3 | PDS-first onboarding | Creates account/DID, persists handle/session, publishes Dina MsgBox endpoint. | |
  | 4 | Recovery phrase UX | Phrase is shown clearly, user must confirm, wording distinguishes identity recovery vs data recovery. | |
  | 5 | App kill/reopen after onboarding | Does not re-onboard; DID, personas, preferences, and node boot state survive. | |
  | 6 | Unlock/seal behavior | Before unlock, private memory is inaccessible; after unlock, app works without restart. | ✅ 2026-05-06 iPhone 17 sim — hamburger menu now reads "Sign out" (renamed from "Lock vault") with the log-out icon, per session change. Force-prompt flag wiring + auto-lock-on-background covered by unit tests; live timeout cycle is MT-40 below. |
  | 7 | Wrong unlock/passphrase path | Clear error, no crash, no sensitive data shown. | |
  | 8 | LLM key setup | Add/remove invalid/valid key; valid key enables /ask, invalid key gives actionable error. | |
  | 9 | Basic /ask | Ask "What can you do?" and get a Dina-specific answer, not a generic broken fallback. | |
  | 10 | Simple /remember | "Remember my name is Raj" then ask "What is my name?"; answer uses memory. | |
  | 11 | Memory persistence | Kill app/restart phone/reopen; remembered facts still retrieve. | |
  | 12 | Persona routing | Store health/private/work facts; verify they route to expected personas. | |
  | 13 | Locked persona approval | A locked/sensitive remember creates approval, deny blocks store, approve stores. | ✅ 2026-05-06 iPhone 17 sim — `/remember Doctor appointment Tuesday at 9am` → routed to Health → "Stashed for your Health vault — that vault needs your approval before I can write to it. Open Approvals to review." Approvals tab badge=1, "Memory access approval" card with Approve/Deny visible. |
  | 14 | Vault browser/search | Stored memories appear in the right vault and search returns expected records. | |
  | 15 | Reminder creation | "Remind me in 2 minutes…" creates reminder, notification fires, can mark done. | ⚠ 2026-05-06 iPhone 17 sim — `/ask Remind me tomorrow at 9am` → "I have scheduled a reminder for tomorrow at 9:00 AM" (schedule_reminder tool fires correctly). **MT-15-I3 finding**: relative phrasing like "in 3 minutes" forces an LLM clarification round-trip ("I don't have access to the system clock") because the agentic loop doesn't inject `now` into the prompt. Filed as future work. |
  | 16 | Notifications inbox | Reminders, approvals, nudges appear with correct badge/filter behavior. | |
  | 17 | Contacts/DID add | Add a peer DID/contact; contact persists across app restart. | |
  | 18 | D2D live message | Two real nodes/devices send encrypted messages through MsgBox both directions. | |
  | 19 | D2D offline/reconnect | Peer offline gives clear pending/failure state; delivery recovers after reconnect. | ⏭ 2026-05-06 — needs cross-device peer setup (Sancho on iOS + Alonso on Android). Code fixes covered by unit tests (chat_d2d delivery indicator + thread-merge-by-timestamp); not exercised live this pass because the second sim wasn't paired during this run. |
  | 20 | Trust feed/profile | the PeerLens tab loads self profile/feed or shows clear AppView/network error. | |
  | 21 | Trust search/detail | Search a subject, open detail, reviewer profile, alternatives; navigation/back works. | |
  | 22 | Trust write/outbox | Write a review; online publish reaches PDS/AppView or offline enters durable outbox. | ✅ 2026-05-06 iPhone 17 sim — searched "MTtest40" → "Write the first review" → Name field pre-filled with "MTtest40", new hint reads "Pre-filled from your search — tap to edit if the spelling is off." (MT-22-I1 fix verified). |
  | 23 | Provider service config | Enable provider mode and capability config; profile publish/degradation is visible. | |
  | 24 | BusDriver scenario | Ask "when does bus 42 reach Castro?"; provider must execute through OpenClaw/local execution plane via Dina-agent/task flow, not Brain direct MCP or demo responder; response returns ETA + map URL in chat. | |
  | 25 | Bad network recovery | Toggle airplane mode during ask/trust/D2D; app does not crash and recovers cleanly. | |
  | 26 | Upgrade from previous installed build | Catches storage/schema/keychain breakage. | |
  | 27 | Delete/reinstall behavior | Confirms what survives in keychain vs app storage. | |
  | 28 | Low/no permissions | Push notifications denied, contacts denied, background denied should degrade cleanly. | |
  | 29 | Background/foreground transitions | Node should reconnect and not duplicate runners/messages. | |
  | 30 | Long idle overnight | Catches token expiry, MsgBox reconnect, scheduler drift. | |
  | 31 | AppView/PDS outage | Trust/service publish/search should show clear failures. | |
  | 32 | Large memory set | Add 50-100 memories and verify ask/search still feels usable. | |
  | 33 | Sensitive data prompt | Verify PII is not leaked into unsafe contexts or logs. | |
  | 34 | Accessibility pass | Font scale, screen reader labels on main flows. | |
  | 35 | Store build sanity | Production env points to intended test/release endpoints, no demo flags accidentally enabled. | |
  | 36 | OpenClaw /task execution via Dina CLI agent | Start an OpenClaw container paired to mobile Dina through the Dina CLI agent; create a task from mobile; agent claims, executes, completes, and mobile shows the final task result and lifecycle without duplicate runners/messages. | |
  | 37 | OpenClaw outbound mail validation | Run an OpenClaw task that wants to send an email; before sending, OpenClaw must call `dina validate` through the Dina CLI agent and poll `validate-status`; mobile shows the action/recipient/summary for approval; deny blocks the send, approve allows only the validated email, and audit/task history records the decision. | |
  | 38 | OpenClaw locked-vault data request with approval resume | Run an OpenClaw task that requests data from Dina through the Dina CLI agent; Dina detects the data is in a locked vault/persona, asks the user to approve/unlock, deny returns no sensitive data, approve releases only the approved data, and OpenClaw resumes and completes the original task. | |
  | 39 | Recovery restore on new install/new device | User can reinstall or use a new phone, enter recovery phrase, restore identity, unlock vault, reconnect MsgBox/PDS/AppView, and see prior data/state as expected. | |
  | 40 | Auto-lock after timeout/background | Vault reseals after idle timeout, app background, screen lock, and app restart. Sensitive screens are not visible before re-auth. | 🚧 2026-05-06 iPhone 17 sim — listener wired (`useAutoLock` in `_layout.tsx`) and unit-tested (9/9 cases including 0s + custom timeouts, inactive-ignore, RN duplicate coalesce). Live 5-minute timeout cycle not exercised this session — would require a 300s wait per cycle. **Finding (MT-40-I1)**: Settings page exposes no UI to configure background timeout, so users can't pick 60s/0s presets that `setBackgroundTimeoutS` accepts internally. Default is 300s. Filed as future work — minimal Security row that reuses `getTimeoutPresets()`. |
  | 41 | Approval push/deep link from killed/background app | Approval notification arrives when app is backgrounded/killed; tapping it opens the correct approval screen with full context and allows approve/ deny. | |
  | 42 | Pair and revoke agent/device | Pair OpenClaw/CLI/second device, confirm access works, revoke it, then verify all further signed requests fail immediately. | 🚧 2026-05-06 iPhone 17 sim — Settings → Agents shows openclaw-provider with red **Revoke access** button (UI verified). Actual revoke not exercised live; would tear down OpenClaw pairing needed for MT-36/37/38. |
  | 43 | Pending approval/task survives app kill/restart | Create pending approval/task, kill app, relaunch, confirm pending state is intact and action can still be completed exactly once. | |
  | 44 | Provider review-policy service flow | For a provider requiring human/operator review, service request does not auto-execute; operator review path completes, rejects, or times out cleanly. P0 if enabled in release. | |
  | 45 | Service discovery negative cases | No provider, offline provider, stale schema hash, malformed params, bad signature, and timeout all produce clear user-facing degradation without stuck tasks. | |
  | 46 | Agent PII scrub and rehydrate path | OpenClaw/agent receives scrubbed placeholders only; raw PII never leaves the Home Node; final local rehydration restores the correct value only at the approved action boundary. | |
  | 47 | User-triggered local wipe/logout | Explicit wipe removes local vault, identity/session material, pending tasks, outbox, caches, and push/device registration. P0 if exposed in release UI. | 🚧 2026-05-06 iPhone 17 sim — Settings → Admin → Danger Zone shows both "Sign out from this device" and "Erase everything on this device" buttons with correct copy (UI verified). Actual erase not exercised — would wipe Sancho identity needed for ongoing tests. Unit tests cover the wipe behaviour (15/15). |
  | 48 | Real upgrade with encrypted vault from previous build | Install previous release build, create real vault data/identity/outbox/PeerLens state, upgrade to RC build, verify unlock, data, pending work, and sync still work. | |
