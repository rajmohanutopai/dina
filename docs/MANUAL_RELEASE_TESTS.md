# Manual Release Tests

Last updated: 2026-06-02

This is the current release-candidate manual checklist for the mobile app. It is intentionally clean: keep validation entries short and put long logs, screenshots, stack traces, and debugging notes in `docs/MANUAL_RELEASE_TEST_RESULTS.md` or an issue.

## How To Use This File

- `P0` means release blocker if it fails.
- `P1` means should pass for the first public release unless explicitly scoped out.
- `P2` means useful coverage, but not a blocker unless the feature is advertised in the release notes.
- Fill the `Validation` column with only date, device, result, and issue ID if failed.
- Do not paste long device logs here. Example: `2026-06-02 iPhone 17 sim: PASS` or `2026-06-02 Pixel 10 emu: FAIL, see MT-24-I1`.

## Required Test Environments

- iOS simulator or physical iPhone.
- Android emulator or physical Android phone.
- Two Dina identities for D2D and services testing.
- Test PDS, AppView, and MsgBox endpoints.
- Paired `dina-agent` / OpenClaw container for task and agent-safety tests.
- At least one provider Dina with service listings enabled.

## P0 Release Gate

All P0 rows must pass before release. If a P0 row is not applicable to the release build, mark it `N/A` with a short reason.

| ID | Priority | Area | Manual Test | Pass Criteria | Validation |
|---|---:|---|---|---|---|
| MT-01 | P0 | Install | Fresh install on iOS | App launches cleanly, first-run onboarding starts, no dev overlay, no stale local identity. | |
| MT-02 | P0 | Install | Fresh install on Android | Same as iOS; no Android-only crash, app reaches onboarding. | |
| MT-03 | P0 | Onboarding | Create new Dina identity | User can choose infrastructure, create handle/account, get DID, set passphrase, and boot to Chat. MsgBox connects. | |
| MT-04 | P0 | Onboarding | Recovery phrase display and confirmation | 24 words are shown clearly, confirmation is required, copy distinguishes identity recovery from data backup. | |
| MT-05 | P0 | Onboarding | Existing AT Protocol identity onboarding | User can onboard using an existing ATProto identity/PDS without forcing `dinakernel.com` identity. DID/session persist. | |
| MT-06 | P0 | Restart | Kill/reopen after onboarding | App does not re-onboard. DID, vault state, contacts, service config, and node boot state survive. | |
| MT-07 | P0 | Unlock | Wrong passphrase path | Wrong passphrase shows a clear error, no crash, no vault content shown. | |
| MT-08 | P0 | Unlock | Auto-lock and sign-out | Background/timeout/sign-out reseals sensitive vault state. Re-auth restores app without restart. | |
| MT-09 | P0 | AI Setup | Provider key setup | Invalid key gives actionable error and is not saved. Valid key enables Ask. Removing key disables that provider cleanly. | |
| MT-10 | P0 | Chat | Basic Ask | User asks what Dina can do and gets a Dina-specific answer, not a generic fallback or raw internal error. | |
| MT-11 | P0 | Memory | Basic Remember and recall | Save a fact, ask about it later, and answer uses stored memory. | |
| MT-12 | P0 | Memory | Memory persistence | Kill/relaunch and confirm stored facts still retrieve. | |
| MT-13 | P0 | Vaults | Persona routing | Health, finance, work, and general facts route to the expected vaults. | |
| MT-14 | P0 | Vaults | Locked vault write approval | Sensitive/locked remember creates approval. Deny blocks store. Approve stores only after approval. | |
| MT-15 | P0 | Vaults | Locked vault read approval | Asking for locked/sensitive data prompts for approval rather than leaking data into Chat or agent context. | |
| MT-16 | P0 | Vaults | Vault browser | Stored items appear in the right vault. Locked vaults are shown as locked, not as empty. | |
| MT-17 | P0 | People | Add contact by handle/DID | Contact creates/links a person, persists after restart, and does not auto-trust unknown same-name DIDs. | |
| MT-18 | P0 | People | Identity memory link | Remember a fact about a contact, receive a DID-only message from that contact, and Dina can retrieve the person-linked fact. | |
| MT-19 | P0 | D2D | Bidirectional encrypted D2D chat | Two Dina nodes send messages both directions through MsgBox. Delivery state is visible and no plaintext is logged. | |
| MT-20 | P0 | D2D | Persistent queued send | With peer offline, send queues. Kill/relaunch. When peer returns, queued message/service query drains and is not lost. | |
| MT-21 | P0 | D2D | Unknown/blocked sender policy | Unknown personal message is staged/quarantined per policy. Blocked sender is dropped before service or contact bypasses. | |
| MT-22 | P0 | Services | Provider role screen | My Services shows requester/provider/both, explains restart requirement, and saved role survives restart. | |
| MT-23 | P0 | Services | Create official public listing | Provider creates a listing from Category -> Capability picker. No raw capability typing needed for official capabilities. | |
| MT-24 | P0 | Services | Multi-listing management | One DID can create at least two listings. Edit/pause/delete one without changing the other. | |
| MT-25 | P0 | Services | Listing Active/Pause enforcement | Active listing publishes and answers. Paused/draft listing unpublishes and does not answer, even if another listing has the same capability. | |
| MT-26 | P0 | Services | Service config restart hydration | Provider listing config, status, role, and publish state survive kill/relaunch and republish as expected. | |
| MT-27 | P0 | Services | AppView discovery | Public active listing is indexed by AppView search with correct capability, schema, schema hash, service URI, and provider DID. | |
| MT-28 | P0 | Services | Service URI/rkey targeting | Query a specific listing URI. Provider validates and executes against that exact rkey, not any other listing under the same DID. | |
| MT-29 | P0 | Services | Natural language service query | User asks naturally, Dina discovers provider, fills params, sends service.query, and receives result in Chat. | |
| MT-30 | P0 | Services | Bus ETA E2E through agent | Bus ETA request executes through provider Dina -> task -> `dina-agent`/OpenClaw -> transit tool -> service.response. Brain must not call MCP directly. | |
| MT-31 | P0 | Services | Provider review-policy flow | Review policy creates approval instead of auto-executing. Approve executes once. Deny sends/records rejection cleanly. | |
| MT-32 | P0 | Services | Service negative cases | No provider, offline provider, malformed params, stale schema hash, bad signature, timeout, and invalid result all show clear user-facing degradation. | |
| MT-33 | P0 | CardSpec | Safe service result card | Provider CardSpec renders with safe blocks only. Unknown blocks are skipped. No remote code execution, no provider-controlled trust badges. | |
| MT-34 | P0 | CardSpec | Link and map safety | Card links show real host, unsafe schemes are blocked, map actions use allowed client-side URL handling. | |
| MT-35 | P0 | Agents | Pair OpenClaw/dina-agent | Pair agent through mobile. Agent appears as active, can claim tasks, and all traffic goes through MsgBox. | |
| MT-36 | P0 | Agents | Mobile Task flow | User creates a task in Chat. Agent claims, marks running, completes, and result appears once in Chat/Activity. | |
| MT-37 | P0 | Agents | Agent outbound action validation | Agent tries to send email or equivalent risky action. Dina creates approval. Deny blocks. Approve allows only the approved action. | |
| MT-38 | P0 | Agents | Locked-vault agent request and resume | Agent requests locked data. Dina returns approval-required/no data. Approve resumes and returns only approved data. Deny/expire returns no data. | |
| MT-39 | P0 | Agents | Revoke paired agent | Revoke agent. After restart, signed requests from revoked device fail immediately. In-flight grants are not silently retained. | |
| MT-40 | P0 | Backup | Export real data | Export archive includes contacts, people, memories, reminders, service config, and vault items. It excludes API keys, PDS password, and master seed. | |
| MT-41 | P0 | Backup | Restore into clean install | Clean install/import restores real data and service config. Wrong passphrase/corrupt archive fail cleanly. | |
| MT-42 | P0 | Backup | Restore overwrite guard | Import into non-clean install requires explicit confirmation and does not silently merge unsafe target-only rows. | |
| MT-43 | P0 | Notifications | Activity and approval deep links | Notification/deep link opens allowed internal route with correct context. Unsafe routes and external schemes are rejected. | |
| MT-44 | P0 | Security | No sensitive logs | Device logs contain no vault content, prompts, tool args, service params/results, D2D plaintext, API keys, or recovery words. | |
| MT-45 | P0 | Security | Store build env sanity | Production/test build points to intended PDS/AppView/MsgBox. No demo responder, dev passphrase, or secret-like `EXPO_PUBLIC_*` value enabled. | |
| MT-46 | P0 | Network | Bad network recovery | Airplane mode/offline during Ask, D2D, service query, and AppView calls does not crash; app reconnects and recovers without duplicates. | |
| MT-47 | P0 | Data Safety | Erase local device | Erase removes local vault, identity/session material, tasks, outbox, caches, push/device registration, and returns to onboarding. | |
| MT-48 | P0 | Upgrade | Upgrade previous RC/build | Install previous build with real data, upgrade to RC, unlock, confirm data, contacts, outbox, service config, agent pairing, and reminders still work. | |

## P1 Product Confidence Tests

These should pass if the corresponding feature is visible in the release UI.

| ID | Priority | Area | Manual Test | Pass Criteria | Validation |
|---|---:|---|---|---|---|
| MT-49 | P1 | Navigation | Current tab structure | Bottom tabs are Chat, People, Network, Activity. Settings/Vault/Reminders/Help are reachable from the hamburger or expected secondary surfaces. | |
| MT-50 | P1 | Chat | Mode visibility | Ask and Remember are visible. Task appears only when an active paired agent exists. Personal Talk is under People, not the main Chat mode pill. | |
| MT-51 | P1 | Chat | Raw internal errors hidden | LLM/provider/tool failures show friendly copy, not stack traces, enum names, or `/ask failed: provider_error`. | |
| MT-52 | P1 | Reminders | Reminder creation and firing | Create reminder from natural language. It appears in Reminders/Activity and fires with Mark done/Snooze actions. | |
| MT-53 | P1 | Reminders | Reminder list actions | Grouping is correct. Long-press/dismiss works. Inline card Mark done and Snooze work. | |
| MT-54 | P1 | Activity | Filters and badges | Needs action, Unread, All, and Reminders filters show correct items. Badges hydrate correctly after restart. | |
| MT-55 | P1 | People | Contact detail/identity modal | Contact chat header opens identity details with DID/PLC data. Copy buttons work. | |
| MT-56 | P1 | People | Name ambiguity | Same-name contacts do not auto-merge. Ambiguous memory/person link asks for clarification or refuses to link. | |
| MT-57 | P1 | Network | Network home | Network screen shows Services entry plus PeerLens/trust content without appearing broken when the feed is empty. | |
| MT-58 | P1 | PeerLens | Trust feed/search/detail | Search subject, open detail, open reviewer, back navigation works, no AppView crash on empty results. | |
| MT-59 | P1 | PeerLens | Write review/outbox | Write review. Online publish reaches PDS/AppView. Offline publish enters durable outbox and retries. | |
| MT-60 | P1 | PeerLens | Preferences | PeerLens preferences save and affect ranking/search inputs after restart. | |
| MT-61 | P1 | Services | Official catalog load/fallback | Capability picker loads AppView catalog when available and bundled fallback when unavailable. No sniffed/mobile-only capability list is trusted blindly. | |
| MT-62 | P1 | Services | Custom capability guard | Namespaced custom capability can be added. Public custom without schema is blocked with clear copy. Unknown flat capability is blocked. | |
| MT-63 | P1 | Services | Discoverability states | Public appears in search. Unlisted is URI-resolvable but not searchable. Known-only is not published and is not accepted by public service search. | |
| MT-64 | P1 | Services | Empty live listing blocked | Active public/unlisted listing with zero capabilities cannot be saved or activated. Paused empty listing can remain draft-like if supported. | |
| MT-65 | P1 | Services | Sensitive capability defaults | Booking/payment/write/agentic capabilities default to review or safer discoverability and cannot be left on unsafe auto policy. | |
| MT-66 | P1 | Services | Multiple providers same capability | AppView returns/ranks multiple providers. Dina chooses one with service URI and can ask for clarification when needed. | |
| MT-67 | P1 | Services | Known provider service query | If user already knows provider/listing, Dina can query it directly without unnecessary AppView rediscovery, while still using service.query semantics. | |
| MT-68 | P1 | CardSpec | Markdown/text safety | Provider text/Markdown renders as inert content. No script, HTML injection, fake trust badge, or unsafe link behavior. | |
| MT-69 | P1 | CardSpec | Staleness/expiry | Expired or stale service cards visibly degrade and do not look fresh. | |
| MT-70 | P1 | Backup | Physical-device keychain behavior | Delete/reinstall on a real iPhone verifies expected keychain behavior and no stale broken identity state. | |
| MT-71 | P1 | Permissions | Low/no permissions | Push denied/provisional, background disabled, contacts unavailable, and sharing unavailable all degrade cleanly. | |
| MT-72 | P1 | Accessibility | Main screen accessibility | Visible buttons/inputs on Chat, People, Network, Activity, My Services, Approvals, and Settings have labels and work with larger font scale. | |
| MT-73 | P1 | Performance | Moderate data set | 50-100 memories, 20 contacts, several service listings, and PeerLens items remain usable; no obvious UI freeze. | |
| MT-74 | P1 | Diagnostics | Admin diagnostics | Diagnostics copy-all works and excludes secrets/vault contents. | |
| MT-75 | P1 | Security | Replay/duplicate handling | Duplicate D2D/service messages are rejected or idempotently ignored. Service responses are one-shot and scoped to matching window. | |
| MT-76 | P1 | Security | Metrics/test endpoints | AppView metrics/test-inject routes are token-gated/default-off in release environment. | |

## P2 Optional / Future-Scope Checks

Run these when the feature is advertised, demoed, or specifically touched in the release branch.

| ID | Priority | Area | Manual Test | Pass Criteria | Validation |
|---|---:|---|---|---|---|
| MT-77 | P2 | Services | Service area editing | If exposed, provider can set service area and AppView uses it for local queries such as doctor/plumber/restaurant near me. | |
| MT-78 | P2 | Services | Unlisted share/scan | If exposed, provider can share unlisted listing by link/QR/invite and requester can invoke it without search. | |
| MT-79 | P2 | Services | Known-only invocation | If exposed, known-only/private service works only through explicit known relationship/pairing and never appears in public search. | |
| MT-80 | P2 | Services | Public custom schema editor | If exposed, mobile can define params/result schemas for custom public capability and AppView returns them. | |
| MT-81 | P2 | PeerLens | Namespaces | If exposed, namespace creation/rotation/selection works against live PLC/PDS state. | |
| MT-82 | P2 | PeerLens | Co-sign inbox | If exposed, co-sign request appears, user can endorse/decline, and result publishes. | |
| MT-83 | P2 | Vaults | Whole-vault delete | If exposed, whole-vault delete requires strong confirmation and cannot delete default/system vaults accidentally. | |
| MT-84 | P2 | People | Contact trust editing | If exposed, user can edit trust, aliases, linked identities, notes, block/unblock, split/merge people. | |
| MT-85 | P2 | Reminders | Row-level reminder actions | If exposed, reminder list row buttons for done/snooze/delete work without relying on long-press. | |
| MT-86 | P2 | CardSpec | Media rendering | If enabled, remote images/media render only through the approved safe proxy/cache policy and show alt text on failure. | |
| MT-87 | P2 | Device Mgmt | General paired devices | If exposed, non-agent paired devices can be listed/revoked with clear roles and no agent-specific copy. | |
| MT-88 | P2 | Admin | Re-publish PLC document | If exposed, action republishes current endpoint/profile safely and reports success/failure. | |

## Current Known Partial Areas

These are not automatic release blockers unless the release promises them as shipped.

| Area | Current Status | Manual Handling |
|---|---|---|
| Dedicated service marketplace UI | Not shipped; Network routes service search intent into Chat. | Test Chat service discovery and My Services instead. |
| Unlisted share/QR/invite | Runtime model exists; share UX not built. | Do not claim full unlisted sharing in release notes. |
| Known-only service invocation | Model exists; explicit invocation path is future. | Do not claim private service marketplace support. |
| Public custom capability schema editor | Public custom validation exists; mobile schema editor not built. | Public custom should be blocked or require non-mobile setup. |
| Service-area editing | Runtime/AppView can use area; provider UI not exposed. | Avoid promising local-radius provider setup from mobile. |
| Card media rendering | Media skipped/alt text until safe proxy exists. | Do not claim arbitrary remote image cards. |
| Namespaces and co-sign inbox | Partial/presentational. | Treat as optional unless release notes mention it. |
| Whole-vault delete | Not exposed in mobile. | Erase-device path is separate and must pass. |
| Contact trust/identity management | Core model stronger than mobile UI. | Basic add/contact/D2D must pass; advanced management is future. |

## Short Validation Format

Use one of these forms in the `Validation` column:

- `2026-06-02 iPhone 17 sim: PASS`
- `2026-06-02 Pixel 10 emu: FAIL, see MT-30-I1`
- `2026-06-02 physical iPhone: SKIP, feature not in this release`
- `2026-06-02 Docker + iPhone sim: PARTIAL, service query passed, review path pending`

Long evidence belongs in `docs/MANUAL_RELEASE_TEST_RESULTS.md`, not this checklist.
