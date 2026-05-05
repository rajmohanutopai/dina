  | # | Manual test | Pass criteria |
  |---|---|---|
  | 1 | Fresh install on iPhone | App launches cleanly, no dev-only errors, first-run flow starts. |
  | 2 | Fresh install on Android | Same as iPhone; no platform-specific crashes. |
  | 3 | PDS-first onboarding | Creates account/DID, persists handle/session, publishes Dina MsgBox endpoint. |
  | 4 | Recovery phrase UX | Phrase is shown clearly, user must confirm, wording distinguishes identity recovery vs data recovery. |
  | 5 | App kill/reopen after onboarding | Does not re-onboard; DID, personas, preferences, and node boot state survive. |
  | 6 | Unlock/seal behavior | Before unlock, private memory is inaccessible; after unlock, app works without restart. |
  | 7 | Wrong unlock/passphrase path | Clear error, no crash, no sensitive data shown. |
  | 8 | LLM key setup | Add/remove invalid/valid key; valid key enables /ask, invalid key gives actionable error. |
  | 9 | Basic /ask | Ask “What can you do?” and get a Dina-specific answer, not a generic broken fallback. |
  | 10 | Simple /remember | “Remember my name is Raj” then ask “What is my name?”; answer uses memory. |
  | 11 | Memory persistence | Kill app/restart phone/reopen; remembered facts still retrieve. |
  | 12 | Persona routing | Store health/private/work facts; verify they route to expected personas. |
  | 13 | Locked persona approval | A locked/sensitive remember creates approval, deny blocks store, approve stores. |
  | 14 | Vault browser/search | Stored memories appear in the right vault and search returns expected records. |
  | 15 | Reminder creation | “Remind me in 2 minutes…” creates reminder, notification fires, can mark done. |
  | 16 | Notifications inbox | Reminders, approvals, nudges appear with correct badge/filter behavior. |
  | 17 | Contacts/DID add | Add a peer DID/contact; contact persists across app restart. |
  | 18 | D2D live message | Two real nodes/devices send encrypted messages through MsgBox both directions. |
  | 19 | D2D offline/reconnect | Peer offline gives clear pending/failure state; delivery recovers after reconnect. |
  | 20 | Trust feed/profile | Trust tab loads self profile/feed or shows clear AppView/network error. |
  | 21 | Trust search/detail | Search a subject, open detail, reviewer profile, alternatives; navigation/back works. |
  | 22 | Trust write/outbox | Write a review; online publish reaches PDS/AppView or offline enters durable outbox. |
  | 23 | Provider service config | Enable provider mode and capability config; profile publish/degradation is visible. |
  | 24 | BusDriver scenario | Ask “when does bus 42 reach Castro?”; demo or live path returns ETA in chat. |
  | 25 | Bad network recovery | Toggle airplane mode during ask/trust/D2D; app does not crash and recovers cleanly. |
  | 26 | Upgrade from previous installed build | Catches storage/schema/keychain breakage. |
  | 27 | Delete/reinstall behavior | Confirms what survives in keychain vs app storage. |
  | 28 | Low/no permissions | Push notifications denied, contacts denied, background denied should degrade cleanly. |
  | 29 | Background/foreground transitions | Node should reconnect and not duplicate runners/messages. |
  | 30 | Long idle overnight | Catches token expiry, MsgBox reconnect, scheduler drift. |
  | 31 | AppView/PDS outage | Trust/service publish/search should show clear failures. |
  | 32 | Large memory set | Add 50-100 memories and verify ask/search still feels usable. |
  | 33 | Sensitive data prompt | Verify PII is not leaked into unsafe contexts or logs. |
  | 34 | Accessibility pass | Font scale, screen reader labels on main flows. |
  | 35 | Store build sanity | Production env points to intended test/release endpoints, no demo flags accidentally enabled. |

