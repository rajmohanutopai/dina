# Dina Mobile — Screen Inventory

Complete catalogue of every screen, modal, popup, and inline card in the mobile app. Routes refer to Expo Router paths under `apps/mobile/app/`. Components without routes live under `apps/mobile/src/components/` or `apps/mobile/src/peerlens/`.

---

## Review Tracker

`☐ unreviewed · ◐ in progress · ☑ reviewed · screenshots in /tmp/dina-review/`

### Onboarding (§1)
- ☑ welcome
- ☑ choose (mode_choice)
- ☑ create_name (owner_name)
- ☑ create_handle (handle_pick)
- ☑ create_passphrase (passphrase_set)
- ☑ create_mnemonic_reveal (mnemonic_reveal)
- ☑ create_mnemonic_verify (mnemonic_verify)
- ☑ provisioning_create (source-review only)
- ☑ infra_setup (source-review only)
- ☑ recover_mnemonic (recovery_entry) — source-review (mirror of mnemonic_reveal/owner_name, same canonical concerns)
- ☑ recover_handle (recovery_handle) — source-review (same handle-pick pattern)
- ☑ recover_passphrase — source-review (same passphrase_set component, `flow='recover'`)
- ☑ provisioning_recover — source-review (same `provisioning.tsx` component)
- ☑ onboarding error panel — source-review (rendered by shell.tsx with `retry` callback)

### Unlock gate (§2)
- ☑ passphrase prompt — source-review (unlock_gate.tsx lines 273-323; same passphrase input pattern, no show-password peek, no hard-coded colors)
- ☑ auto-unlock spinner — source-review (silent `ActivityIndicator`; no announced status text for VoiceOver — see cross-cutting)
- ☑ forgot-passphrase escape — source-review (uses same recovery_entry mounted inside unlock_gate)

### Tabs (§3)
- ☑ Chat (`/`) — empty state
- ☑ Vaults list (`/vault`) + add-vault inline form
- ☑ Vault detail (`/vault/[name]`)
- ☑ People — Contacts sub-tab
- ☑ People — Relations sub-tab
- ☑ People — Own Identity card
- ☑ PeerLens feed (`/peerlens`)
- ☑ PeerLens search (`/peerlens/search`)
- ☑ PeerLens subject (`/peerlens/[subjectId]`) — source-review (header card + score badge + flag banner + review list + alternatives strip — uses canonical tokens after migration; subject card style verified clean)
- ☑ PeerLens reviewer (`/peerlens/reviewer/[did]`) — source-review (handle + DID + stats grid + sentiment chips + authored attestation rows — canonical tokens)
- ☑ PeerLens write (`/peerlens/write`) + wizard modal
- ☑ PeerLens outbox (`/peerlens/outbox`) — source-review (status rows + retry/dismiss buttons; canonical tokens)
- ☑ PeerLens namespace (`/peerlens/namespace`) — source-review (publish-new CTA, list rows; canonical tokens)
- ☑ Notifications (`/notifications`)
- ☑ Approvals (`/approvals`) — source-review (hard-coded warning/error palette — see §22 above)

### Hamburger menu (§4)
- ☑ menu modal itself

### Secondary routes (§5)
- ☑ Reminders (`/reminders`)
- ☑ Settings (`/settings`)
- ☑ Help (`/help`) — source-review (dev-gear blocks tap)
- ☑ Add-Contact (`/add-contact`) — source-review
- ☑ Chat detail (`/chat/[did]`) — source-review (peer-handle header, bubble stream, delivery indicators; canonical tokens)
- ☑ Admin (`/admin`) — source-review (Identity / Policies / Diagnostics / Danger zone sections; hard-coded `#FFFFFF` literals — see §22)
- ☑ Recovery phrase — gate, unlocking, revealed (3 modes) — source-review (same warning palette leak; mnemonic grid mirrors mnemonic_reveal)
- ☑ Confirm recovery phrase — gate, unlocking, verify (3 modes) — source-review (mounts mnemonic_verify with `compact=true`)
- ☑ Paired devices (`/paired-devices`) — source-review (live-code generator + countdown + copy; canonical tokens — uses `textStyles.display + textStyles.mono.fontFamily` for the code)
- ☑ Service settings (`/service-settings`) + capability modal — source-review (role chips + capability list + add-capability modal; canonical tokens; many Alert.alert dialogs)
- ☑ Policy (`/policy`) + add-action modal — source-review (4 risk colors hard-coded — see §22)
- ☑ PeerLens prefs (6 sub-pages: region, budget, devices, languages, dietary, accessibility) — source-review (all use canonical `multi_select_screen.tsx` view + canonical tokens; budget uses 3-step segmented control)

### Modals (§7)
- ☑ Identity modal — source-review (handle + DID + PLC services + namespace fragments + copy buttons; canonical tokens)
- ☑ Mode-switch popover — visible on Chat, source-reviewed in §9
- ☑ PeerLens first-run — source-review (one-time onboarding explainer; canonical tokens)
- ☑ Vault add form — source-review (inline form within /vault, name + tier chips + description; canonical tokens)
- ☑ Settings add-key form — visible on Settings (§20)

### Inline cards (§6)
- ☑ Approval, Briefing, Nudge, Reminder, Review draft, Service approval, Service query — all source-reviewed during canonical-token migration; each uses `textStyles.*` tokens correctly. Per-card notes:
  - **InlineApprovalCard** — approve/deny pair, no destructive-red on Deny. Consider tinting Deny red for security.
  - **InlineBriefingCard** — section-headed list, fine.
  - **InlineNudgeCard** — contact-line + action/dismiss; the "she/her" framing in Dina's outbound nudge text is downstream content, not the card itself.
  - **InlineReminderCard** — done/snooze pair; uses mono for persona pill — works.
  - **InlineReviewDraftCard** — sentiment pills inline; consistent with /peerlens/write sentiment chips.
  - **InlineServiceApprovalCard** — uses inline `fonts.sansSemibold` + `fonts.monoMedium` for emphasis (intentional inline-text emphasis).
  - **InlineServiceQueryCard** — uses `textStyles.h2` for the primary ETA value (e.g., "6 min"). Override `fontSize: 28` had been removed — now snaps to canonical 24pt.

### Cross-cutting (§10)
- ☑ Navigation chrome (header, tab bar, back chevron) — see Cross-cutting findings above; key gaps: back-chevron inconsistency, 23-tab AX leak, dev-gear overlap.

---

## 1. Onboarding flow (pre-vault, before any auth)

Stateful wizard rendered by `OnboardingFlow` (`src/components/onboarding/onboarding_flow.tsx`). State machine lives in `src/onboarding/state.ts`. Steps are not Expo routes — they swap inside the same flow.

| # | Step kind | Screen file | Purpose |
|---|-----------|-------------|---------|
| 1 | `welcome` | `welcome.tsx` | Brand hero. Cormorant-italic display. Six feature pills (Vault / Tasks / Reminders / Talk / Services / PeerLens). "Begin" CTA. |
| 2 | `choose` | `mode_choice.tsx` | Two cards: "Create a new Dina" / "Restore your identity on this device". Back button returns to `welcome`. |
| 3 | `create_name` | `owner_name.tsx` | "Who is this Dina for?" — user's display name. |
| 4 | `create_handle` | `handle_pick.tsx` | Pick a `@handle.dinakernel.com` username. Availability check against PLC directory. |
| 5 | `create_passphrase` | `passphrase_set.tsx` | Set passphrase (8+ chars) that wraps the master seed. |
| 6 | `create_mnemonic_reveal` | `mnemonic_reveal.tsx` | Reveal 24-word BIP-39 recovery phrase. "I've saved it" continues. |
| 7 | `create_mnemonic_verify` | `mnemonic_verify.tsx` | Quiz: pick 3 random positions from the phrase. |
| 8 | `provisioning_create` | `provisioning.tsx` | Spinner: derives keys, creates PDS account, publishes PLC document. |
| 9 | `infra_setup` | `infra_setup.tsx` | Configure infra endpoints (mailbox, PLC, AppView). Shown when defaults need overriding. |
| 10 | `recover_mnemonic` | `recovery_entry.tsx` | Enter 24-word recovery phrase. |
| 11 | `recover_handle` | `recovery_handle.tsx` | Confirm handle that maps to the recovered seed (rotation-key check). |
| 12 | `recover_passphrase` | `passphrase_set.tsx` (reused) | Set passphrase on the recovered device. |
| 13 | `provisioning_recover` | `provisioning.tsx` (reused) | Spinner: re-derives keys, fetches PDS account. |
| 14 | `error` | (rendered by `shell.tsx`) | Error panel with retry button — surfaces fatal errors from any provisioning step. |

Shared chrome:
- `shell.tsx` — outer scaffold: eyebrow + title + body + footer button. All steps render inside it.

---

## 2. Unlock gate (post-onboarding, every cold start)

`src/components/unlock_gate.tsx` — overlays the entire app until the vault is unlocked.

- **Passphrase prompt** — when `startupMode === 'security'` or when sign-out armed the force-prompt flag. Cormorant "Welcome back" headline + passphrase input + "Unlock" CTA.
- **Auto-unlock spinner** — when `startupMode === 'auto'`. Brief loading state while keychain-cached passphrase decrypts the seed.
- **Recovery escape hatch** — "Forgot passphrase?" link → routes back into onboarding's recover flow.

---

## 3. Bottom-tab navigation (post-unlock)

Root layout: `app/_layout.tsx`. Five tabs, each with its own Stack:

### 3.1 Chat (tab 1) — `/` — `app/index.tsx`

Primary conversation surface. Dina's brain.

- **"Confirm your recovery phrase" banner** (conditional, top) — appears when the user has not yet verified their mnemonic. Tap → `/confirm-recovery-phrase`.
- **Empty state** — shown when message history is empty (`messages.length === 0`). Prompts the user toward their first interaction.
- Stream of message bubbles (user + Dina + inline cards interleaved).
- Composer: text input + send button + mode pill.
- **Mode-switch popover (modal)** — tap the mode pill (Ask / Remember / Task / Talk) to switch. Slides up from bottom; lists available actions with descriptions.
- Inline cards rendered as message-stream items (see §6).

### 3.2 Vaults (tab 2) — `/vault` — Stack with its own `_layout.tsx`

- **Vaults list** — `/vault` — `vault/index.tsx`
  - Hero: "YOUR VAULTS" eyebrow + tagline.
  - Card per persona: lock icon, name, tier label, classifier description, item count.
  - **Add-vault inline form** — toggled by "+ New vault" pill. Name + tier chips + description.
- **Vault detail** — `/vault/[name]` — `vault/[name].tsx`
  - Persona metadata: tier, description, item count.
  - List of stored memories with timestamps + classifier sentiment.
  - Edit-description sheet.
  - Per-item actions (delete confirmation `Alert`).
  - Danger zone: delete vault confirmation `Alert`.

### 3.3 People (tab 3) — `/people` — `app/people.tsx`

Two sub-views switched via an in-page `SubTabBar`:

- **Own Identity card** (always at top, both sub-tabs): user's handle, DID, copy buttons. Tap → identity modal.
- **Sub-tab: Contacts** (`ContactsView`)
  - List of contacts (DID + display name) with trust badges.
  - Tap row → opens **Identity modal** (full-screen `Modal` in `src/components/identity/identity_modal.tsx`): handle, DID, PLC services, namespace fragments, copy-to-clipboard.
  - "+ Add contact" → routes to `/add-contact`.
  - Delete-contact confirmation `Alert`.
- **Sub-tab: Relations** (`RelationsView`)
  - List of `Person` rows derived from messaging + PeerLens history (people you've interacted with but not added as contacts).
  - Rows render via `RelationRow`.

### 3.4 PeerLens (tab 4) — `/peerlens` — Stack with its own `_layout.tsx`

Trust-network surface. Heavy stack.

- **Feed** — `/peerlens` — `peerlens/index.tsx`
  - Self-card (your own attestations summary, 2-column grid: subjects / reviews / endorsements / impact).
  - Search bar.
  - Feed of subject cards (rendered by `src/peerlens/components/subject_card_view.tsx`).
  - **First-run modal** — `src/peerlens/components/first_run_modal_view.tsx`. One-time onboarding explainer.
  - Empty / loading / error states.
  - Footer: links to Outbox + Namespaces.
- **Search** — `/peerlens/search` — `peerlens/search.tsx`
  - Query echo line + write-CTA when query is empty.
  - Result list of subject cards.
  - Loading / empty / error states.
- **Subject detail** — `/peerlens/[subjectId]` — `peerlens/[subjectId].tsx`
  - Header card: title, subtitle, context chips, score badge.
  - Optional flag-warning banner.
  - "Write a review" CTA → routes to `/peerlens/write`.
  - Review list (each row with reviewer name, mini-band, headline, edit pill if self).
  - Alternatives strip (TN-V2-RANK-014).
  - Loading / empty / error panels.
- **Reviewer profile** — `/peerlens/reviewer/[did]` — `peerlens/reviewer/[did].tsx`
  - Header: handle + DID + score badge.
  - 3-column stats grid (subjects, reviews, endorsements).
  - Sentiment chips row.
  - Section: authored attestations (rows with title, sentiment pill, category, age, edit pill if self).
- **Write review** — `/peerlens/write` — `peerlens/write.tsx`
  - Step 1 (inline): kind picker, headline, body, sentiment.
  - **Wizard modal (Steps 2 + 3)** — opens via "+ Add additional details" pill.
    - Stepper at top.
    - Step 2: Your experience (last-used picker, use-case chips, confidence segmented control, alternatives + search).
    - Step 3: Price (currency + amount), reviewer experience.
    - Modal footer: Cancel / Back / Next / Done.
  - Prefill banner (when Dina pre-filled fields).
  - Submit error panel.
  - Cancel + Publish buttons.
- **Outbox** — `/peerlens/outbox` — `peerlens/outbox.tsx`
  - In-flight banner (when retries are pending).
  - List of queued/failed publishes (status, preview, reason, retry/dismiss buttons).
  - Empty state.
- **Namespaces** — `/peerlens/namespace` — `peerlens/namespace.tsx`
  - Subtitle explainer.
  - Row list of registered namespace fragments + VM IDs.
  - "Publish new" CTA.
  - Loading / empty states.
- **Co-signature inbox row** — `src/peerlens/components/cosig_inbox_row_view.tsx` (rendered inside the feed). Endorse / decline actions.

### 3.5 Notifications (tab 5) — `/notifications` — `app/notifications.tsx`

- Filter chips (All / Unread / Briefings / Reminders / Approvals).
- List of notification rows with icon, title, subtitle, meta line, unread dot.
- Empty state.

### 3.6 Approvals (tab 6) — `/approvals` — `app/approvals.tsx`

- List of pending agent-intent approvals.
- Per-row approve/deny actions (each fires an `Alert` confirmation).
- Per-action approve / deny `Alert` confirmations.

---

## 4. Hamburger menu (header-left, every tab)

`app/_layout.tsx` — `NavMenu` `<Modal>` triggered from header. Lists:

1. **Vault** → `/vault`
2. **Reminders** → `/reminders`
3. **Settings** → `/settings`
4. **Help** → `/help`
5. **Sign out** — action item (locks vault, drops in-RAM DEKs, re-arms passphrase prompt).

---

## 5. Secondary stack screens (reached from menu / settings / cards)

| Route | File | Purpose |
|-------|------|---------|
| `/reminders` | `reminders.tsx` | Grouped reminder list (sections by due band: overdue, today, later, recurring). Per-row done/snooze actions + delete `Alert`. Empty state when no reminders. |
| `/settings` | `settings.tsx` | In-page `<SettingsSection>` blocks: (1) **AI Provider Keys** — per-provider row (Anthropic / OpenAI / Gemini / OpenRouter) with active badge, **add-key inline form** (paste API key input + Cancel/Save), and **configured-actions strip** (Use / Remove buttons), (2) **Service Sharing** (links to `/service-settings`), (3) **PeerLens Preferences** (6 sub-pages — region/budget/devices/languages/dietary/accessibility), (4) **More** (display-name override row + other misc rows), (5) **Security** (passphrase, auto-lock timeout picker with preset chips, sign out). |
| `/help` | `help.tsx` | Scrollable help shell. Six `CardSection` blocks: **Your vault**, **Reminders**, **Talk** (D2D messaging), **Agent tasks**, **Services & PeerLens**, **Privacy and control**. Each card lists capabilities with an example panel. Tapping a card deep-links to the relevant feature route. |
| `/add-contact` | `add-contact.tsx` | Add a DID-based contact. Inputs: handle + DID + name. Validation errors inline. |
| `/chat/[did]` | `chat/[did].tsx` | 1:1 chat with another Dina (D2D over MsgBox). Bubble stream (peer-left / me-right), delivery-status indicators (sending / delivered / failed), error rows on failed messages, composer with send button. Empty state when no messages yet. Failed-send `Alert`. |
| `/admin` | `admin.tsx` | Sections (each is an in-page `<Section>` block): **Identity** (DID row, handle row, recovery-key row, `DisplayNameRow` with inline edit/save/cancel), **Policies**, **Dev self-test** (dev builds only — `DevSendTestRow`), **Diagnostics** (groups + diag items + Copy-all button), **Danger zone** (Sign out, Erase vault). Includes "Re-publish PLC document" placeholder row + sign-out / erase-vault `Alert`s. |
| `/recovery-phrase` | `recovery-phrase.tsx` | **3-mode state machine inside one route**: (1) `gate` — passphrase prompt blocking reveal, (2) `unlocking` — spinner while decrypting seed, (3) `revealed` — 24-word grid in 2 columns with copy. Warning banner before reveal. |
| `/confirm-recovery-phrase` | `confirm-recovery-phrase.tsx` | **3-mode state machine inside one route**: (1) `gate` — passphrase prompt, (2) `unlocking` — spinner, (3) `verify` — 3-position quiz of mnemonic words. Cancel link + completion hint. |
| `/paired-devices` | `paired-devices.tsx` | Two sections rendered as in-page `<Section>` blocks: **Devices** (list of paired devices with role + last-seen, per-row unpair) and **Generate pairing code** (device-name input + role chips + Generate button → reveals live code card with mono display, countdown timer, copy button). Per-device unpair `Alert`. Code-generation error `Alert`. |
| `/service-settings` | `service-settings.tsx` | Service-sharing role config (requester / provider / both / off), capabilities (skills) list, policy chips, save button. **Add-capability modal** (`<Modal>`) — capability name input + add/cancel. Save/validation `Alert`s. |
| `/policy` | `policy.tsx` | Agent action policies — list of action names with risk dots + tier toggles, grouped by risk. **Add-action modal** (`<Modal>`) — action-name input + confirm. Remove confirmation + error `Alert`s. |
| `/notifications` | `notifications.tsx` | (also reachable via tab 5) |
| `/approvals` | `approvals.tsx` | (also reachable via tab 6) |

### 5.1 PeerLens preference sub-pages (linked from `/settings`)

All under `app/peerlens-preferences/`:

| Route | File | Purpose |
|-------|------|---------|
| `/peerlens-preferences/region` | `region.tsx` | Search + select primary region (auto-detect row + searchable list with mono sub-labels for ISO codes). |
| `/peerlens-preferences/budget` | `budget.tsx` | Per-category budget segmented controls (low / mid / high). |
| `/peerlens-preferences/devices` | `devices.tsx` | Multi-select device categories (renders `multi_select_screen` view). |
| `/peerlens-preferences/languages` | `languages.tsx` | Multi-select languages. |
| `/peerlens-preferences/dietary` | `dietary.tsx` | Multi-select dietary preferences. |
| `/peerlens-preferences/accessibility` | `accessibility.tsx` | Multi-select accessibility needs. |

Shared view: `src/peerlens/preferences/multi_select_screen.tsx` (description, search, row list with descriptions, empty placeholder).

---

## 6. Inline cards (rendered inside chat stream)

`src/components/Inline*Card.tsx` — every card mounts inline as a chat-bubble-sized element on `/` (Chat). They are not routes — they are message-stream content.

| Card | File | Surface |
|------|------|---------|
| **Approval card** | `InlineApprovalCard.tsx` | Approve / Deny agent intent. Status line after action. |
| **Briefing card** | `InlineBriefingCard.tsx` | Daily / weekly briefing. Period label, summary, preview, sectioned bullet list, empty state. |
| **Nudge card** | `InlineNudgeCard.tsx` | Sancho-Moment nudge: title, body, contact line, action / dismiss buttons. |
| **Reminder card** | `InlineReminderCard.tsx` | Reminder due now. Body + persona pill + done / snooze buttons. |
| **Review draft card** | `InlineReviewDraftCard.tsx` | Pre-filled PeerLens review draft (kind, subject, sentiment pills, headline / body inputs, secondary + primary actions). |
| **Service approval card** | `InlineServiceApprovalCard.tsx` | Approve a service-sharing session. Requester + capability inline emphasis. |
| **Service query card** | `InlineServiceQueryCard.tsx` | Response from a remote service (e.g., ETA query). Title, subtitle, primary value, secondary line, map button, error text. |

Supporting micro-component: `src/components/MessageTimestamp.tsx` — sub-bubble timestamp.

---

## 7. Identity / pairing modals (full-screen overlays)

| Modal | File | Trigger |
|-------|------|---------|
| **Identity modal** | `src/components/identity/identity_modal.tsx` | Tapping a contact in `/people` or a DID anywhere. Full screen: handle headline, DID caption, grouped field cards (handle, DID, PLC services, namespaces), copy buttons. Loading + error panels. |
| **Hamburger menu** | inline in `app/_layout.tsx` | Header-left button on every tab. |
| **Mode-switch popover** | inline in `app/index.tsx` | Tap mode pill in chat composer. |
| **PeerLens first-run modal** | `src/peerlens/components/first_run_modal_view.tsx` | First time the user opens `/peerlens`. |
| **PeerLens write wizard** | inline in `app/peerlens/write.tsx` | "+ Add additional details" pill on the write form. |
| **Service-settings capability modal** | inline in `app/service-settings.tsx` | "Add capability" button. |
| **Policy-add modal** | inline in `app/policy.tsx` | "+" button in the header. |
| **Vault add form** | inline in `app/vault/index.tsx` | "+ New vault" pill (not a Modal — toggled inline form). |
| **Settings add-key form** | inline in `app/settings.tsx` | "Add Key" link under AI Provider Keys (inline form, not Modal). |

---

## 8. Native `Alert.alert` dialogs

These are OS-level confirmation popups, not full screens. Locations and triggers:

- **`/admin`** — Sign out confirm, Erase vault confirm, Sign-out success, error toasts (multiple).
- **`/approvals`** — Per-action approve confirm, deny confirm, error toasts.
- **`/chat/[did]`** — Send-failed.
- **`/paired-devices`** — Unpair confirm, generate-code errors, missing device-name guard.
- **`/people`** — Delete contact confirm.
- **`/policy`** — Update / remove / add errors + confirm.
- **`/reminders`** — Delete confirm.
- **`/service-settings`** — Save success, missing-name guard, validation errors, save errors.
- **`/settings`** — Invalid AI key, key-didn't-work, save-failed, remove-key confirm.
- **`/vault/[name]`** — Delete confirm + delete-failed.

---

## 9. PeerLens view components (rendered inside other screens)

Not routable — used as building blocks inside `/peerlens/*` pages.

| View | File | Used by |
|------|------|---------|
| `subject_card_view.tsx` | Subject card | Feed (`/peerlens`), search results, alternatives strip. |
| `subject_anchor_view.tsx` | Compact subject reference | Reviewer detail, sub-headers. |
| `facet_bar_view.tsx` | Filter chip row | Feed, search. |
| `viewer_filter_chips_view.tsx` | Viewer-only filter chips | Feed. |
| `cosig_inbox_row_view.tsx` | Co-sign request row | Feed, notifications. |
| `first_run_modal_view.tsx` | First-run welcome modal | PeerLens feed (one-time). |

---

## 10. Navigation chrome (always-visible UI)

- **`stack_index_header.tsx`** — Custom header used for index tab. Hamburger + Dina logo + help button. 17pt native nav title style.
- **Header menu button** — top-left on every tab (opens hamburger modal).
- **Header help button** — top-right on tab screens (routes to `/help`).
- **Header back chevron** — on every stack sub-screen.
- **Bottom tab bar** — 6 tabs (Chat / Vaults / People / PeerLens / Notifications / Approvals). PeerLens preference + Reminders + Settings etc. are hidden tabs (`href: null`).

---

## Quick totals

- **Onboarding steps**: 14 distinct state kinds (12 screens; 2 shared chrome).
- **Tab routes**: up to 5 visible (Chat always, People always, PeerLens conditional on `!isTrustTabHidden()`, Notifications always, Approvals conditional on `showApprovalsTab`). Vault, Reminders, Settings, Help, etc. are routes with `href: null` — registered but reached only via the hamburger menu, not the tab bar.
- **Secondary routes (reachable but not in tab bar)**: 12 — Reminders, Settings, Help, Add-Contact, Chat detail, Admin, Recovery phrase, Confirm recovery phrase, Paired devices, Service settings, Policy, plus 6 PeerLens preference sub-pages.
- **PeerLens stack sub-routes**: 7 (feed, search, subject detail, reviewer detail, write, outbox, namespace).
- **Vault stack sub-routes**: 2 (list + detail).
- **In-page sub-tabs** (not separate routes):
  - People: Contacts vs Relations (2).
- **In-page state-machine views** (not separate routes):
  - Recovery phrase: gate / unlocking / revealed (3).
  - Confirm recovery phrase: gate / unlocking / verify (3).
- **Modals (`<Modal>`)**: 7 — hamburger menu, mode-switch popover, identity modal, PeerLens first-run, PeerLens write wizard, service-settings add-capability, policy add-action.
- **Inline cards**: 7 — Approval, Briefing, Nudge, Reminder, Review draft, Service approval, Service query.
- **PeerLens view components**: 6.
- **`Alert.alert` dialogs**: 43 call sites across 10 screens.
- **Conditional in-page banners**: Chat "Confirm your recovery phrase" banner; PeerLens flag-warning banner; PeerLens write prefill banner; PeerLens outbox in-flight banner.

---

## UI/UX Review Findings

Per-screen review notes, captured live via idb on iOS simulator (iPhone 17 Pro, iOS 26). Each finding is tagged:
- `copy` — wording / grammar / clarity
- `style` — non-canonical token, layout drift, hard-coded value
- `info-arch` — surface / hierarchy / discoverability
- `a11y` — accessibility (contrast, hit-target, screen-reader)
- `bug` — broken or unexpected behaviour
- `polish` — nice-to-have refinement

A leading **✅** marks findings already addressed in the cross-cutting-fix pass (2026-05-21). **🚧** marks blockers that can't be fixed inline (logged with the reason).

### 1. Welcome (`src/components/onboarding/welcome.tsx`)
Screenshots: `01-welcome-fresh.png`, `01-welcome-bottom.png`.

- **copy** · "All data encrypted **and in** your device, signed by your identity." — preposition is wrong; should read "encrypted **on** your device". The "and" forces a clause that doesn't belong.
- **copy** · "Reviews signed by real people, used by Dina during **high value** decisions." — `high-value` should be hyphenated when used attributively. The comma also feels splice-y; consider "Reviews signed by real people — what Dina uses when stakes are high."
- ✅ **copy** · "Give Dina a task and **she** delegates it to your connected agents." — Dina is gendered "she" in welcome copy. The Anti-Her principle in `README.md` warns against emotional-crutch framing; using "she" here cuts against the project's own framing. Either keep it intentionally and document the choice in `README.md`, or move to "it" / "Dina" / passive voice for the welcome surface. **Fixed**: rewritten to "and it gets delegated to your connected agents."
- **copy** · "Delete the key to delete everything, forever." — "the key" is ambiguous to a first-time user (they haven't been told they have a key yet). Either earlier-link to the concept of "mnemonic recovery phrase" or rephrase to "Forget your passphrase and the data is unrecoverable — by design."
- **info-arch** · The hero shows **6 pills** (Vault, Tasks, Reminders, Talk, Services, PeerLens) but the pillars list has **8 entries** (adds Identity and Approvals & Security). The two sets advertise different features — pills are a teaser and pillars are the full enumeration; consider matching them so the user doesn't feel like the page contradicts itself.
- **info-arch** · No progress indicator on the welcome step — every other onboarding step has a "n of 5 · Label" pill in the top-center. Add one (e.g., "1 of 7 · Welcome") so first-time users sense the flow has a finite length.
- **info-arch** · 8 pillars require scrolling to see; many users may bounce after the 4th. Either condense to 5 (the strongest), or split into a 3-pillar hero + collapsible "Learn more" disclosure.
- **polish** · "Dina-to-Dina Talk" is materially longer than the other pill labels and breaks the visual rhythm of the pill row. Consider "Talk" (already the canonical `FEATURE_NAMES.talk`) for the pill and reserve the full name for the pillar title.
- **polish** · The pillar list uses `textStyles.bodyStrong` (15pt) for titles and `textStyles.bodySmall` (13pt) for bodies. The 2-pt step is subtle on cream-on-cream — a contrast bump on the title (e.g. `bodyLargeStrong` 16pt) would give the hierarchy a clearer beat.
- **style** · ✓ All inline styles compose canonical `textStyles.*` tokens; no hard-coded fontSize/Family in welcome.tsx. `letterSpacing: 6` on brand and `letterSpacing: 0.2` on pillText are intentional brand-specific overrides on top of canonical tokens, acceptable.
- **a11y** · `accessibilityLabel` is on the FeatureIcon (via Ionicons defaults) but the pill chips have no explicit `accessibilityRole` — VoiceOver will announce them as plain text. Add `accessibilityRole="text"` or wrap in a `<Pressable accessibilityRole="button">` if they are tappable later.
- **a11y** · Pill text is 12pt (`caption`) — that's below the iOS HIG minimum recommendation (13pt) for non-incidental text. Consider 13pt (`bodySmall`).

### 2. Choose / Mode-choice (`src/components/onboarding/mode_choice.tsx`)
Screenshot: `02-choose-actual.png`.

- **copy** · "Restore your identity on this device. Saved memories stay **on** your old device's vault." — preposition error; memories live **in** a vault, not on it. Fix to "in your old device's vault".
- **copy** · Subtitle "New to Dina? Start fresh. Coming back? Restore from your 24-word recovery phrase." has four short sentences in one line — feels choppy. Consider two lines or "New here? Start fresh. Returning? Restore from your 24-word recovery phrase." for better symmetry.
- **copy** · Card 2 subtitle repeats the verb "Restore" inside itself ("Restore from recovery phrase" → "Restore your identity on this device"). Tighten to "Bring your identity to this device. Memories saved on your old device stay there."
- **info-arch** · Bottom half of the screen is empty space — there's room for a trust-anchor line ("Local-first. No server. No cloud account.") or a reassurance ("You can switch later" — *if* that's true; if not, omit).
- **info-arch** · Headline "Welcome to Dina" is the same as on Welcome. Two consecutive screens with identical hero copy reads like the user got bounced back. Differentiate the choose headline (e.g., "Begin or restore?" or "Pick your path").
- **info-arch** · No progress pill ("1 of 7 · Choose"). Same gap as on Welcome — see Welcome findings.
- **polish** · The circular glyphs are visually identical (44 × 44 muted circle, `colors.bgTertiary`). Subtle differentiation (e.g., accent border on Create, neutral on Restore) would tilt the user toward the primary action.
- ✅ **a11y** · `accessibilityLabel={title}` — drops the body text. VoiceOver users hear "Create a new Dina, button" with no context. Append the body: `accessibilityLabel={`${title}. ${body}`}`. **Fixed**: now uses `${title}. ${body}` + `accessibilityRole="button"`.
- **style** · ✓ All styles compose canonical tokens (`textStyles.display`, `textStyles.body`, `textStyles.bodyStrong`, `textStyles.bodySmall`, `textStyles.h3`). `minHeight: 132` is a hard pixel value — fine since it's expressing "card pair must match heights" not typography.
- **a11y** · Tap targets (cards) are ~132 px tall — comfortably above the 44pt iOS minimum. ✓
- **a11y** · Glyph `⟳` (U+21BA, "anticlockwise open circle arrow") for "Restore" is fine visually but VoiceOver reads it literally as "anticlockwise open circle arrow". Wrap glyph in `accessibilityElementsHidden` so it's not announced.

### 3. Owner name / Display name (`src/components/onboarding/owner_name.tsx`)
Screenshots: `03-owner-name.png`, `03-typed.png`.

- **copy** · "Just a display name — we use it as **the base** of your Dina handle on the community directory." — "the base" sounds odd; "the **basis** of" or "the starting point for" reads more naturally.
- **copy** · "the community directory" is undefined jargon for a first-time user — they have no mental model of what a community directory is. Either define it or substitute with concrete language ("your public handle on Dina's network").
- **bug/env** · Suggested handle preview reads "sancho.**test-pds**.dinakernel.com" — the "test-pds" subdomain leak is fine for staging but in production builds this should read like a polished handle (e.g. "sancho.dinakernel.com" or "@sancho"). Verify `resolveMobileHostedDinaEndpoints()` swaps the host for production bundles.
- **info-arch** · "SUGGESTED HANDLE" label is uppercase mini-eyebrow (`textStyles.eyebrow` + letterSpacing 1.5) — consistent with `DISPLAY NAME` above. ✓ But the two labels styled identically may flatten the hierarchy; the suggestion card is meant to feel like *output* of what you typed, not a *second input*. A different framing — e.g. soft italic "Your handle would be …" — would read better.
- **info-arch** · The card around the suggestion uses `colors.bgTertiary` background — visually similar enough to the input that it can read as a second editable field. Consider a hairline border or a "preview" label icon.
- **a11y** · `maxLength={40}` is enforced silently — no character counter or error. If a user pastes 50 chars, the 41–50 are dropped without feedback. Add a tiny inline counter or trim-warning.
- **a11y** · Continue button disabled state uses `opacity: 0.35` (per shell.tsx). At that opacity the white "Continue" label on grey button has very low contrast (~2.3:1). WCAG AA requires 4.5:1. Either darken the disabled background or keep the label at full opacity.
- **style** · ✓ All styles compose canonical tokens — `textStyles.label`, `textStyles.bodyLarge`, `textStyles.eyebrow` (with custom letterSpacing 1.5), `textStyles.mono`, `textStyles.caption`. `height: 52` on input is a hard pixel — fine for tap-target sizing but could move to a theme `inputHeight` token for consistency across all inputs.
- **bug** · Buildtime check — owner_name uses `pdsHostForEndpoints(resolveMobileHostedDinaEndpoints())`. If `loadInfraPreferences()` hasn't resolved yet (cold start), this will read defaults — confirm the preview updates if the user later overrides the PDS in InfraSetup.

### 4. Handle picker (`src/components/onboarding/handle_pick.tsx`)
Screenshot: `04-handle.png`.

- **bug/env** · Subtitle: "We'll add `.test-pds.dinakernel.com` automatically." — `.test-pds` host string is exposed in plaintext to the end user. Test-mode leak. Production should display only the canonical handle suffix.
- **info-arch** · Suggestion rows display the **full** handle (`sancho40.test-pds.dinakernel.com`) — 33 monospace characters per row. Three of those stacked feels noisy and hard to scan. Show just the prefix (`sancho40`) in mono and the suffix in a smaller muted style underneath (or to the right).
- **copy** · "✗ Taken — try one of these:" — concise. ✓
- **copy** · "Directory unreachable — you can keep going at your own risk." — "at your own risk" implies danger; the actual fallback is benign (server will reject true collisions at commit). Suggest "Directory unreachable — you can keep going; we'll verify on commit."
- **info-arch** · The suffix "TAP TO USE" sits to the right of the row in eyebrow uppercase — feels disconnected from the row's affordance. The whole row is already pressable; "TAP TO USE" suggests *that* element is the button. Either drop the label (the whole row is implied tappable) or move it to a small chevron `›`.
- **a11y** · Status copy "✓ Available" / "✗ Taken" uses red/green color as the only differentiator. Add an icon (already present) but ensure screen reader announces the status — wrap with `accessibilityRole="alert"` so VoiceOver picks up the change immediately.
- **a11y** · The input row's suffix label (`.test-pds.dinakernel.com`) is muted — contrast vs cream background looks ~3.5:1, possibly below WCAG AA for normal text. Check with a contrast tool.
- **style** · ✓ All styles compose canonical tokens. `inputRow` flexbox custom layout is fine.
- **bug** · `void pdsHost; // accepted for API symmetry` — the prop is accepted but unused, deliberately. Confirm this doesn't cause lint/unused warnings on strict builds.

### 5. Passphrase set (`src/components/onboarding/passphrase_set.tsx`)
Screenshot: `05-passphrase.png`.

- **copy** · Mode-card titles aren't parallel: "**Start automatically**" (instruction to system) vs "**Ask for my passphrase each time**" (instruction with first-person POV). Rewrite either pair so they match — e.g. "Unlock automatically" / "Require passphrase on every launch", or "Start automatically" / "Ask me each time".
- **copy** · "Convenient for daily use; less resilient if your phone is stolen." — "less resilient" is a CS-flavoured word. Rewrite for a layperson: "Convenient for daily use. Less secure if your phone is stolen."
- **copy** · Subtitle "it's the only way into your data" — softer than it could be. The recovery phrase is *also* a way in. The phrasing accidentally suggests there's no fallback. Consider: "Keep it safe — Dina can't reset it for you. Your 24-word recovery phrase is the only backup."
- **info-arch** · No "Show password" toggle. Most modern apps expose a peek eye-icon so users can verify what they typed before committing. With `secureTextEntry` masking everything, a typo on the passphrase is unrecoverable.
- **info-arch** · The strength bar (3-pixel tall pips) is too thin to read at a glance — easy to miss. Bump to 6 px and add a short label ("Weak" / "Okay" / "Strong" / "Excellent") so the score is interpretable.
- **info-arch** · No paste guidance. Password managers often inject extra whitespace; `trim()` happens nowhere. Confirm `pp` is trimmed before stored as the KDF input, or add a paste-paste-paste guard.
- ✅ **a11y** · `ModeCard` uses `accessibilityLabel={title}` — drops the body. VoiceOver users hear "Start automatically, button" with no tradeoff context. Include body. **Fixed**: now uses `${title}. ${body}`.
- ✅ **a11y** · Radio circle is `View` (decoration only). Add `accessibilityRole="radio"` and `accessibilityState={{ selected }}` on the outer `Pressable` so VoiceOver announces "selected" state correctly. **Fixed**: both added.
- **a11y** · Strength bar pips have no `accessibilityLabel` — screen reader can't relay strength. Add a single `accessibilityLabel="Passphrase strength: weak"` on the row.
- **style** · ✓ All canonical tokens (`textStyles.eyebrow`, `textStyles.label`, `textStyles.bodyLarge`, `textStyles.bodyStrong`, `textStyles.bodySmall`, `textStyles.caption`).
- **polish** · Selected mode card uses `bgTertiary` background + accent border. Visually subtle on cream background. A larger contrast bump on the selected card (e.g. accent at 10% opacity background) would make the current selection more obvious at a glance.

### 6. Mnemonic reveal (`src/components/onboarding/mnemonic_reveal.tsx`)
Screenshots: `06-mnemonic-reveal.png`, `06-mnemonic-scrolled.png`.

- ✅ **style** · **Non-canonical hard-coded colors**: `backgroundColor: '#FFF4DB'` and `color: '#8A5A00'` in `warningBanner` / `warningText`. These should be promoted to theme tokens (e.g., `colors.warningBgSoft`, `colors.warningTextDeep`) so the warning palette is reusable across the app. Same pattern appears in `recovery-phrase.tsx` (`warningBanner` / `warningText` lines 319-331). **Fixed**: both files now use `colors.warningBgSoft` + `colors.warningTextDeep`.
- **copy** · "**Note:** your chats and memories backup **is** separate from this." — subject-verb agreement is off ("backup" is the head noun → "is"; but "chats and memories" implies plurality). Rewrite: "Your chats and memories are backed up separately — this phrase only restores your identity."
- **copy** · "To restore your Dina identity (your handle, keys, and network presence), **you will need** these 24 words." → contract to "you'll need". Conversational tone reads warmer.
- **copy** · "Anyone with these words can access your Dina identity." — accurate but cold. Consider: "Treat these like a master key — anyone who has them can sign in as you."
- **bug** · "I've written it down" button is **enabled immediately** without requiring the user to scroll. Only 22 of 24 words are visible on first load; the user could tap-and-continue without ever seeing words 23-24. Recommend either: (a) disable the button until the user scrolls to the bottom of the grid, or (b) include the footer "you can re-view from Settings" copy above the fold so the user knows they aren't locked out.
- **info-arch** · No "copy to clipboard" affordance. Intentional for security? Document the choice; users may otherwise transcribe by hand with errors.
- **info-arch** · No QR-code alternative for cross-device restore. Power-user feature — could add a small "Show as QR" link.
- **a11y** · The 24 mono words have no `accessibilityLabel` grouping — VoiceOver reads each word separately as "dynamic, brown, illness, dust …" which is overwhelming. Wrap each row pair in a single `accessibilityLabel="Words 1 and 2: dynamic, brown"` or hide the cell and provide a single full-phrase label.
- **a11y** · Cell index `01`, `02`, etc. — VoiceOver reads "zero one, zero two". Better: render `1`, `2` (no padding) and let layout handle alignment, or set `accessibilityLabel={String(i+1)}`.
- **style** · ✓ Mnemonic cells use `textStyles.monoSmall` (index) and `textStyles.mono` (word) — canonical. `letterSpacing: 0.2` on word is a per-instance override but small enough to ignore.

### 7. Mnemonic verify (`src/components/onboarding/mnemonic_verify.tsx`)
Screenshot: `07-mnemonic-verify.png`.

- **copy** · "Just a few words from what you wrote down — to make sure your copy is good." — "your copy is good" reads slightly odd. Consider "to make sure you've got them right."
- **copy** · "I'll do this later" — clear ✓, but contextually risky for a security-critical step. Consider amending to "Skip for now (I'll verify in Settings)" so the user knows it'll come back as a banner.
- **bug** · Mismatch handler clears **all three inputs** on a single wrong word: `setAnswers(challenge.indices.map(() => ''))`. This is harsh — if the user got 2/3 right, retyping all of them feels punitive. Recommend keeping correct answers and only clearing/highlighting the mismatched word.
- **info-arch** · No indication of which word was wrong. Add per-input error state so the user knows which row to recheck.
- **info-arch** · The challenge picks 3 random positions but doesn't explain *why* those positions. Maybe a tiny line "Random sampling — three positions to confirm the phrase isn't a typo." would help.
- **a11y** · The "View my recovery phrase again" link has `accessibilityRole="link"` and explicit label ✓.
- **a11y** · Inputs have no `accessibilityLabel` — VoiceOver reads "Word #8" from the visual label. That's OK because the label is announced when the field is reached. ✓
- **style** · ✓ All canonical tokens (`textStyles.label`, `textStyles.mono`, `textStyles.bodySmall`, `textStyles.link`).
- **polish** · Word inputs are full-width and mono. Looks slightly hollow on phone — each input has only a 5–7-char word in it. Consider sizing them narrower (e.g., 60% width) and aligning left so the screen feels less empty.
- **polish** · "WORD #8" prefix uses `#` symbol — in mono context can read as "hash". Consider "8th word" or "Word 8".

### 8. Provisioning + Infra setup (`provisioning.tsx`, `infra_setup.tsx`)
Not directly captured live in this session — provisioning is brief; infra_setup only shows when no PDS URL is persisted yet. Source review:

- **provisioning.tsx** — full-screen ActivityIndicator + step label ("Creating account on PDS…", "Generating did:plc…", etc.). No navigation chrome. Reasonable for a 5–10s gate. **Recommend**: add a fallback if any step takes > 10s — current code may hang silently.
- **infra_setup.tsx** — captures PDS + MsgBox + AppView + PLC endpoints. Form-heavy screen for advanced users. **Issue**: shows on FIRST RUN before user even sees Welcome — that means novices see a confusing infra form before any branding. The flow logic in `unlock_gate.tsx:263` routes here when no infra prefs are saved. Consider: default-skip if Dina endpoints can be defaulted to canonical hosts, surface the form only behind a "Tools" / advanced gear (which the dev menu currently overlaps).
- **a11y** · Provisioning spinner has no announced status text — VoiceOver users won't know what's happening or for how long.

### 9. Chat (`app/index.tsx`) — empty state (signed in, no thread)
Screenshot: `08-provisioning.png` (showed the post-onboarding chat tab).

- ✅ **style** · **Non-canonical hard-coded colors** for the recovery-phrase banner — now all 4 hexes migrated to canonical tokens (`colors.warningBgSoft`, `colors.warningTextDeepest`, `colors.warningTextDeep`).
- **style** · `userBubble` / `dinaBubble` / `systemBubble` use `colors.userBubble`, `colors.dinaBubble`, `colors.systemBubble` — good, palette-tokened.
- **style** · `timestampUser`, `modePillChevron`, `msgChip`, `msgChipText` use raw `rgba(255,255,255,0.X)` literals. Acceptable for in-bubble overlays where the parent background is accent-coloured — but consider exposing as `colors.onAccentMuted` for consistency.
- **style** · `popoverBackdrop` uses `rgba(0,0,0,0.4)` — same pattern, add to palette as `colors.modalScrim`.
- **copy** · Banner: "Confirm your recovery phrase / Quick check that your written copy is good." — clear ✓.
- **copy** · Hero: "Your sovereign personal AI" is repeated **verbatim** from the Welcome screen. After full onboarding the user just saw this hero 7+ steps ago — feels like Welcome leaked into the post-signup state. Replace with greeting-style copy: "Hi Sancho. Ask me, remember a fact, or hand off a task."
- **copy** · "Everything stays on your device. Zero personal data on any server." — strong on-brand line ✓.
- **copy** · "What can Dina do?" action card body: "Tour the capabilities — your vault, working with agents, coordinating with people, and queries to the Dina network." — clipped, comma-spliced. Rewrite: "Tour Dina's capabilities — your vault, agents, people, and network services."
- **info-arch** · Tab bar shows 4 tabs (Chat, People, PeerLens, Notifications). The Approvals tab is conditional on `showApprovalsTab` (paired agent OR provider role). Could surface a quiet placeholder ("Connect an agent to see approvals here") in Settings rather than leaving users guessing why the count fluctuates.
- **info-arch** · "Ask" and "Remember" chips appear in the composer with `Talk` and `Task` missing. Per FEATURES the canonical talk feature lives at `/chat/[did]` — but a first-time user on the chat tab doesn't know that. Consider a small affordance ("→ Talk to someone" link) that routes to People.
- **a11y** · **Major bug** — bottom tab bar AX reports "Chat, tab, **1 of 23**" / "People, tab, **3 of 23**" etc. iOS counts all 23 registered Tabs.Screen entries (including every `href: null` hidden route). A VoiceOver user gets a confusing "1 of 23" prompt. Either remove the `href: null` routes from the tabs registry (declare them under a separate Stack) or set `tabBarItemStyle: { display: 'none' }` so AX excludes them.
- **a11y** · Header buttons: "Open menu" + "Open help" labels are explicit ✓.
- **a11y** · Hero text "Your sovereign\npersonal AI" — the `\n` forces a hard line break. VoiceOver pauses awkwardly. Use space and let layout wrap.
- **bug** · The doc previously asserted chat modes are "Ask / Remember / Task / Talk" — the actual ACTIONS array has 3 entries (`ask`, `remember`, `task`). Talk lives elsewhere (`/chat/[did]`). The SCREENS doc is now corrected above.

### 10. Hamburger menu (`app/_layout.tsx`, modal in `NavMenu`)
Screenshot: `10-menu.png`.

- **info-arch** · Five items: Vault, Reminders, Settings, Help, Sign out. Currently no separator between functional items and "Sign out" — Sign out is destructive (locks vault) and should be visually separated (e.g., a hairline divider above it or red text color).
- **info-arch** · "Sign out" should be styled with `colors.error` (currently `colors.textPrimary`) to telegraph severity. Confirmation modal already exists in admin.tsx — the menu item itself could lead to that confirmation rather than acting silently.
- **info-arch** · "Vault" entry at top — but Vault is conceptually the data store, not an everyday destination. Order should probably be: Reminders → Vault → Settings → Help → (separator) Sign out. Frequency-first ordering.
- **a11y** · Each row uses `TouchableOpacity` with `accessibilityRole="button"` and `accessibilityLabel` from `FEATURES[feature].menuLabel ?? FEATURES[feature].name` ✓.
- **a11y** · Backdrop uses `accessible={false}` + `importantForAccessibility="no-hide-descendants"` for AX containment ✓.
- **style** · Sheet uses inline `marginTop: Platform.OS === 'ios' ? 96 : 64` — magic numbers tied to nav-bar offset. Could derive from `useSafeAreaInsets()` instead.
- **style** · `rowText` is `textStyles.bodyLargeStrong` (canonical) ✓.
- **polish** · No visual chevron / "› navigate" on each row — most menu UIs imply navigation with a small right-side chevron or color cue.

### 11. Vaults list (`app/vault/index.tsx`)
Screenshots: `11-vault.png`, `11-vault-bottom.png`.

- **info-arch** · "Vaults" header has no back arrow. Vault is reached via the hamburger menu but not from a tab — so the only way back is the bottom tab bar. A user who entered Vault from the menu may expect a back chevron. Either add a back chevron in the header or rely on tab-bar navigation but ensure it's consistent across all menu-driven routes.
- **info-arch** · Each row shows "**0** ›" when empty — the 0 is noise pre-population. Render the count only when > 0, or replace with an "Empty" label.
- **copy** · Tier labels are long descriptions in muted text: "Default (always open)", "Standard (auto-open on boot)", "Sensitive (requires approval)". On a list view this feels like reading a manual. Suggest replacing with short badges: "OPEN" / "AUTO" / "SENSITIVE" / "LOCKED" — full descriptions live on the detail page.
- **copy** · Subtitle "Each vault is a separate encrypted compartment. Dina classifies new memories into the right one based on the vault's description." — fine for first-run but should hide after the user creates their first custom vault.
- **info-arch** · Lock icon state (open vs closed) correctly mirrors the tier (General/Work open; Health/Finance closed). ✓ However the open-lock SF Symbol can read as "vault is broken" — consider a different visual (e.g., a "•" dot for open, "🔒" for closed) or rely entirely on tier badge color.
- **info-arch** · "+ New vault" dashed pill at bottom is intuitive ✓ but its prominence is low (muted border). For an empty (single-vault) state, this should be more prominent.
- **a11y** · "VaultCard" uses `Pressable` but no `accessibilityRole="button"` declared. Add explicit role + composite label like "General vault, 0 items, default tier, open".
- **a11y** · Lock icon (Ionicons `lock-open-outline` / `lock-closed-outline`) is inside the row — VoiceOver may announce "lock open" twice (once for icon, once if the label includes "open"). Mark icon `accessibilityElementsHidden`.
- **style** · ✓ All styles compose canonical tokens (per `/Migrate peerlens pages` task already verified).
- **bug** · `safeCount(persona)` swallows the strict-mode `requireRepo` throw and returns 0 — that's intentional for sensitive vaults that haven't been opened. But the user sees "0" for a vault that might actually have items. Consider rendering an em-dash `—` instead of `0` for vaults that are sealed (DEK not in RAM).

### 12. Vault detail (`app/vault/[name].tsx`)
Screenshot: `12-vault-general.png`.

- **copy** · Empty state: "No items yet. Use `/remember` in chat or send Dina a message to populate this vault." — surfaces a slash command (`/remember`) without explaining it's the same as the Remember mode pill the user already saw on the chat tab. Consider: "No items yet. In chat, switch to Remember mode and tell Dina what to keep." (Drops the magic-string `/remember` and aligns with the chat-pill mental model.)
- **copy** · Description card body double-stacks instruction + content:
  - Line 1 (muted): "Used by Dina's classifier to route new memories into this vault."
  - Line 2 (primary): "Personal facts, preferences, family, relationships, hobbies, recipes, pets, birthdays, daily life, opinions"
  
  Splitting the card visually (label + value) or moving the instruction outside the card would tighten this.
- **info-arch** · Tier indicator at top is a full-width card with only the lock + "Default (always open)" text — wastes vertical space. Inline it as a small badge next to the header title.
- **info-arch** · Header back chevron is rendered in a **white circle background** (custom in `vault/_layout.tsx`). Other screens use a bare arrow. Pick one convention.
- **info-arch** · No "Delete vault" or "Edit name" affordance visible on the detail page for non-default vaults. Users can't manage their own additions from here.
- **a11y** · "Edit" link in description card is a small button (top-right) — verify hit-target is ≥ 44 pt.
- **style** · ✓ Per earlier audit; canonical tokens throughout.

### 13. People — Contacts + Relations sub-tabs (`app/people.tsx`)
Screenshots: `13-people.png`, `13b-relations.png`.

- **bug** · Own-handle line wraps **mid-token**: "sancho40.test-" / "pds.dinakernel.com" — the dash inside "test-pds" is a soft-break candidate but the result reads broken. Either truncate with middle ellipsis (`sancho40…dinakernel.com`) or constrain to a single line and let user tap to view full handle.
- **bug/env** · Handle exposes "test-pds" subdomain. Same dev-leak as owner_name / handle_pick subtitle.
- **info-arch** · "+" header button (add contact) is small (≤ 32 pt) — could be confused for a decorative plus. Make it a clearly-tappable button with `accessibilityLabel="Add contact"`.
- **info-arch** · Share button is a filled black pill inside the YOUR HANDLE card — visually it competes with the handle text. Consider a subtle outline button + icon, since "Share" is secondary, not the primary action of this tab.
- **info-arch** · "Contacts" / "Relations" pill toggle is a custom in-page sub-tab — its visual weight is light (looks like inactive chips). The active one is filled slightly; the inactive has no visible state. Improve contrast for selected state.
- **copy** · Contacts empty state ("Add someone by their handle to start an end-to-end encrypted conversation.") — clear ✓
- **copy** · Relations empty state ("As you tell Dina about people in your life — "Emma is my daughter", "Sancho is my brother" — they'll show up here.") — uses our test username "Sancho" as example. Cute, but if the user themselves picked "sancho" the example reads recursively. Consider rotating example names.
- **a11y** · Sub-tab buttons have generic AX labels ("Contacts", "Relations"). Add `accessibilityRole="tab"` + `accessibilityState={{ selected }}` so VoiceOver announces the selected tab.
- **style** · ✓ Per earlier sweep; canonical tokens used. Own-handle card body uses `textStyles.monoSmall` — fine.
- **polish** · The big "👥 No contacts yet" empty illustration is bare (just an icon). Consider adding a stronger affordance ("Tap + to add" with arrow) so first-time users find the entry point.

### 14. Add contact (`app/add-contact.tsx`)
Reviewed via source (the dev gear overlaps the "+" trigger on People tab, so couldn't reach the page interactively in this dev build).

- **bug/env** · Subtitle: "Paste a handle (`alice.test-pds.dinakernel.com`) or a DID (`did:plc:…`). Just the handle is enough — the host is the PDS." — example handle hard-coded with `.test-pds.` subdomain. In production this needs to read the canonical host (no `test-pds`).
- **copy** · "Just the handle is enough — the host is the PDS." — sentence ambiguity. The reader might parse it as a riddle. Consider: "Just the handle is enough; we'll resolve the host automatically."
- **info-arch** · Inputs are stacked (handle/DID, display name) with no preview of what the resolved DID will look like before saving. A preview block would reduce mistakes.
- **a11y** · The Save button uses `<Pressable>` + custom styling; no `accessibilityRole="button"`. Add it.
- **a11y** · Activity indicator on busy state is silent for VoiceOver. Add `accessibilityLabel="Resolving"` to the `ActivityIndicator`.
- **style** · `<Text style={styles.error}>` uses `colors.error` ✓. `<Text style={styles.cancelText}>` is `textStyles.bodyStrong` ✓.
- **bug** · `resolveHandle` order is xrpc → well-known. Note in the docstring mentions iOS RN fetch bug with NXDOMAIN → blob error. Confirm this still works post-`expo/fetch` swap.

### 15. PeerLens feed (`app/peerlens/index.tsx`)
Screenshot: `15-peerlens.png`.

- **info-arch** · Empty state is reached with no Self-card / no contextual entry. A first-time user lands here and sees an empty page — should surface "Add a review" or "Browse popular subjects" entry points.
- **copy** · "Your network is quiet" — pleasant phrasing ✓. Body: "Search above for what you want to review. If nothing matches, you can create the first review for it from there." — long sentence; consider "Search to review something. If we don't find it, you can add it."
- **info-arch** · "Outbox · Namespaces" footer is muted and small — easy to miss. Outbox (= pending publishes) is important if any are queued; consider surfacing a counter badge when non-empty.
- **info-arch** · The header has a "?" help button at top-right (separate from the menu). It's distinct from the global help available via menu. Cross-check: tapping "?" should route to /help filtered to the PeerLens section.
- **a11y** · Search input has placeholder but no `accessibilityLabel`. Add explicit label.
- **a11y** · "Your network is quiet" + icon — wrap so VoiceOver groups them as a single announcement.
- **style** · ✓ Migrated to canonical tokens earlier.

### 16. PeerLens search (`app/peerlens/search.tsx`)
Screenshots: `16-pl-search-typed.png`, `16b-pl-search-result.png`.

- **info-arch** · Back chevron rendered in **white circle background**. Inconsistent with the bare arrow used everywhere else (only Vault detail uses the same custom circle). Pick one convention.
- **info-arch** · "In my languages" filter chip is pre-applied without telling the user *why*. If results are zero, the user doesn't know whether to disable the language filter to broaden. Add an explainer tooltip or hint.
- **copy** · Query echo wraps the term in curly quotes — typographically nice ✓. "Nothing found for "coffee". Try a different search or write the first review." — clear ✓.
- **info-arch** · "Review 'coffee'" filled-black button is high-affordance ✓ — but contextually one tap routes straight to a 6-step write form, which is overwhelming for a one-shot query. Consider a confirmation step or a much-reduced "Quick review" mode.
- **a11y** · Search field has explicit `accessibilityLabel="Search PeerLens"` ✓ (per describe-all).
- **style** · ✓ Canonical tokens.

### 17. PeerLens write review (`app/peerlens/write.tsx`)
Screenshots: `17-pl-write.png`, `17b-pl-write-scroll.png`.

- ✅ **info-arch** · **Title duplication**: native header shows "Write a review" AND an in-page H1 also reads "Write a review". The add-contact file explicitly avoided this pattern (line 114 comment). Same fix applies: drop the in-page H1 or move it inside the first card. **Fixed**: removed the in-page H1; tests updated to assert via the publish-button accessibilityLabel instead.
- **info-arch** · Kind chips wrap to 2 rows; "Claim" sits alone on row 2 — visually orphaned. Either keep all 7 on one row (smaller chips) or split into a 3-3-1 grouped layout.
- **info-arch** · Sentiment is **required** but mounted as a card with no required-marker. The Publish button stays disabled until set, but a user might not notice why. Add a subtle "Required" badge near "Sentiment".
- **copy** · "Pre-filled from your search — tap to edit if the spelling is off." — clear ✓.
- **copy** · "A reviewable product (e.g. Aeron Chair, ASIN, ISBN)." — Aeron Chair is a specific brand reference. Either generic example ("e.g. headphones, model #") or rotate examples.
- **copy** · Body placeholder "Add detail, evidence, or caveats" — solid, encourages substance ✓.
- **a11y** · Kind chips have selected state shown only by background color. Add `accessibilityRole="radio"` + `accessibilityState={{ selected }}` for each chip.
- **a11y** · Headline + Body counters ("0 / 140", "0 / 4000") have no live update for screen readers. Add `accessibilityLiveRegion="polite"` (Android) and equivalent for iOS so VoiceOver users hear count changes when nearing limits.
- **style** · ✓ Migrated to canonical tokens earlier. `Aeron Chair` example might be culturally narrow — fine for English-only audience but consider neutral nouns.
- **polish** · "Add additional details (optional)" pill at the bottom of card stack opens the modal wizard. The "+" + chevron + label is intuitive ✓.

### 18. Notifications (`app/notifications.tsx`)
Screenshot: `18-notifications.png`.

- **info-arch** · Filter chips: All / Unread / Reminders / Approvals. Missing: **PeerLens** category (co-signature requests, attestation activity) — currently those would only show under "All" with no targeted filter.
- **info-arch** · No "mark all read" / "clear" affordance — once notifications start arriving, the user has no bulk action.
- **copy** · "Reminders, approvals, and chat events will appear here." — concise ✓. PeerLens mentioned in the empty state would set the right expectation.
- **a11y** · Filter chips: selected state (filled black) vs unselected (outline). Add `accessibilityState={{ selected }}`.
- **a11y** · "No notifications yet" + icon — same VoiceOver grouping issue as People empty state.
- **style** · ✓ Migrated to canonical tokens earlier.

### 19. Reminders (`app/reminders.tsx`)
Screenshot: `20-settings.png` (landed on Reminders by mis-tap).

- **copy** · "Tell Dina about an event in Chat — pick `Remember` and any dates inside will turn into reminders here." — inline pill highlighting the word "Remember" with a mono pill style is a clever interactive callback to chat. ✓
- **info-arch** · Empty state has no CTA. Add a "Go to Chat" link below the body so the user has a one-tap path.
- **info-arch** · The `Remember` chip in the body looks like a button but is non-tappable (it's `<Text style={styles.code}>` with grey background). Either make it tappable (route to chat with Remember pre-selected) or visually de-button-ify it (remove the chip background, just emphasize the word).
- **a11y** · The pill-styled word "Remember" should have `accessibilityLabel="Remember mode in chat"` so VoiceOver doesn't read it as a button.
- **style** · ✓ Canonical tokens.

### 20. Settings (`app/settings.tsx`)
Screenshots: `20b-settings.png`, `20c-settings-scroll.png`.

- **bug** · Section reads "**Encryption: AES-256-GCM**" but per CLAUDE.md the vault is SQLCipher with **AES-256-CBC** per page. GCM applies to the wrapped seed in keychain. Either fix the label to "Seed wrap: AES-256-GCM · Vault: AES-256-CBC", or split into two rows.
- **bug** · OpenAI provider line says "**GPT-5.4, GPT-5 mini**" — verify "GPT-5.4" is a real shipping model name as of release. If aspirational/preview, mark explicitly or omit.
- **info-arch** · "Confirm recovery phrase | Pending ›" — the orange "Pending" badge is a nice nudge ✓. But its row is grouped with "View recovery phrase" — separate the two for clarity.
- **info-arch** · "Admin" row (between MORE and SECURITY) is unlabeled in section heading and visually orphaned — looks like a leftover row.
- **info-arch** · "Become a provider" under SERVICE SHARING — single row, no description. Add a one-line subtitle hinting at what becoming a provider entails.
- **info-arch** · PEERLENS PREFERENCES has 6 sub-pages — visually heavy in the Settings list. Consider grouping them under a single "PeerLens preferences ›" entry that drills into a sub-page with all 6.
- **copy** · "Bring your own API key. Your key stays on this device." — clear ✓.
- **copy** · "Your data never leaves this device" footer ✓ (matches the chat hero subtitle).
- **a11y** · Read-only crypto rows ("Encryption: AES-256-GCM", "Key storage: Device Keychain") have no `accessibilityHint`. VoiceOver users would read just "Encryption AES dash 256 dash GCM" — fine but no context that this is read-only.
- **a11y** · Auto-lock row is tappable but has no `accessibilityRole="button"` declared inline — verify the wrapper supplies it.
- **style** · ✓ Migrated to canonical tokens earlier. ACTIVE badge uses canonical eyebrow style with white color.
- **polish** · "AIza...yYdE" obfuscated key — good security UX. Verify the ellipsis is U+2026 (not three dots) for clean rendering.

### 21. Help (`app/help.tsx`)
Source review only (dev gear blocks the help-button tap in dev builds).

- **info-arch** · 6 card sections grouped by feature — well-organised ✓.
- **copy** · Hero: "Tap an action card on the chat screen, or type naturally. Dina figures out what you want." — friendly, on-brand ✓.
- **copy** · Footer: "Dina is a sovereign AI. The keys live on your phone — one identity, all your data anchored to it." — distills the value prop nicely ✓.
- **info-arch** · Some cards drill into routes (have `href`), some are read-only blurbs. Visual differentiation between linkable/non-linkable could be stronger — currently only the trailing chevron `›` distinguishes them.
- **a11y** · Linkable cards should declare `accessibilityRole="link"`; non-linkable ones should declare `accessibilityRole="text"` so VoiceOver doesn't announce all rows as buttons.
- **style** · ✓ No hard-coded colors. Canonical tokens.

### 22–27. Source-reviewed (interactive testing blocked by Expo dev-gear overlap)

The remaining screens were reviewed from source. The high-frequency findings are aggregated into the **Cross-cutting findings** section below; per-screen specifics noted here:

#### Approvals (`app/approvals.tsx`)
- ✅ **style** · **Hard-coded warning/error palette** at lines 374-379, 457. **Fixed**: migrated to `colors.warningBgSoft`/`colors.warningTextMid`/`colors.errorBgSoft`/`colors.errorTextDeep`/`colors.error`.

#### Policy (`app/policy.tsx`)
- ✅ **style** · **Hard-coded risk colors** `#059669`/`#D97706`/`#DC2626`/`#7C3AED`. **Fixed**: now uses `colors.riskLow`/`colors.riskMed`/`colors.riskHigh`/`colors.riskAdmin`. Error banner also migrated.

#### People (`app/people.tsx`) — additional badges
- ✅ **style** · **Hard-coded badge colors at lines 267-273** — paired (`#E6F0FE`/`#1F5BB8`) and suggested (`#FFF4D6`/`#8A6300`). **Fixed**: now uses `colors.badgePairedBg/Text` + `colors.badgeSuggestedBg/Text`.

#### Admin (`app/admin.tsx`)
- ✅ **style** · `color: '#FFFFFF'` at lines 326, 498. **Fixed**: now `colors.white`.

#### Provisioning (`src/components/onboarding/provisioning.tsx`)
- ✅ **style** · Error panel hard-codes (`#FDE8E8`, `#7A1F1F`). **Fixed**: now `colors.errorBgSofter` + `colors.errorTextDeepest`.

#### Recovery-phrase (`app/recovery-phrase.tsx`)
- ✅ **style** · Warning banner duplicates the colors from `mnemonic_reveal.tsx`. **Fixed** (same migration).

#### Chat (`app/index.tsx`) verify-banner
- ✅ **style** · 4 separate warning hex literals. **Fixed** — see §9.

#### Add-contact (`app/add-contact.tsx`)
- ✅ **style** · `color: '#FFFFFF'` at line 348. **Fixed**: now `colors.white`.

#### Service-settings (`app/service-settings.tsx`)
- ✅ **style** · `errorBanner` used `#FEF2F2` + `#FCA5A5`. **Fixed**: now `colors.errorBgSoft` + `colors.error`.

#### Chat detail (`app/chat/[did].tsx`)
- ✅ **style** · `warningBanner` used `#FFF4DB` + `#D97706` literally. **Fixed**: now uses canonical `colors.warningBgSoft` + `colors.warning`.

#### Vault detail (`app/vault/[name].tsx`)
- ✅ **style** · Unverified-sender chip used `#FFF7ED` + `#FED7AA`. **Fixed**: now `colors.warningBgSoft` + `colors.warning`.

#### Notifications (`app/notifications.tsx`)
- ✅ **style** · `iconWrapUnread` used `#F0EAE0` (matched bgTertiary). **Fixed**: now `colors.bgTertiary`.

---

## Cross-cutting findings (across screens)

These issues recur across many surfaces and are worth a single fix-it pass rather than per-screen patches.

1. ✅ **Non-canonical warning / error / badge palette** — the same shades of `#FFF4DB`, `#8A5A00`, `#5A3A00`, `#FEF3C7`, `#92400E`, `#FEE2E2`, `#991B1B`, `#FEF2F2`, `#FDE8E8`, `#7A1F1F`, `#E6F0FE`, `#1F5BB8`, `#FFF4D6`, `#8A6300`, `#059669`, `#D97706`, `#DC2626`, `#7C3AED` appeared across 13 files. **Fixed**: added 15 semantic tokens (`successBgSoft`, `warningBgSoft`, `errorBgSoft`, `errorBgSofter`, `successTextDeep`, `warningTextDeep`, `warningTextDeepest`, `warningTextMid`, `errorTextDeep`, `errorTextDeepest`, `riskLow/Med/High/Admin`, `badgePairedBg/Text`, `badgeSuggestedBg/Text`) to `theme.ts`; migrated all 13 files. Zero hex literals remain.
2. **"test-pds" subdomain leak** — handle suffix `.test-pds.dinakernel.com` is visible in: owner_name preview, handle_pick subtitle + input suffix + suggestion rows, People own-handle card, add-contact subtitle + placeholder. **Resolution (no code change)**: production endpoints already use `pds.dinakernel.com` (no `test-` prefix) per `RELEASE_ENDPOINTS` in `packages/home-node/src/endpoints.ts`. The leak is dev/staging only and is accurate to the actually-published handle. Added docstring to `pdsHostForEndpoints` documenting this.
3. **Back-chevron inconsistency** — most screens use a bare `‹` arrow; vault/[name] and peerlens/search use a `‹` in a **white-circle background**. **Resolution (no code change)**: all code paths already use bare `chevron-back` Ionicons. The "white circle" was iOS 26 native back-button rendering, not Dina code.
4. ✅ **Title duplication (header + body)** — write-review showed the same title in both the native header and the in-page body. **Fixed**: in-page H1 removed from `peerlens/write.tsx`. Tests updated to assert mode via the publish-button accessibilityLabel.
5. **Dev-only Expo "Tools" gear overlap** — the floating dev gear at top-right intercepts taps on the help/+ buttons during dev builds. In production this disappears, but during QA it causes false misses. Documented for reviewers.
6. 🚧 **Bottom-tab `1 of 23` AX bug** — every hidden `Tabs.Screen` with `href: null` still counts toward iOS's "tab N of M" announcement. VoiceOver users hear "Chat, tab, 1 of 23". **Cannot be fixed inline** — Expo Router throws `Cannot use `href` and `tabBarButton` together`, and `tabBarItemStyle: { display: 'none' }` hides visually but doesn't remove from AX tree. The real fix requires lifting all 18 hidden routes out of `Tabs.Screen` into a sibling `Stack` registration — deferred to a follow-up.
7. ✅ **`accessibilityLabel={title}` drops body context** — **Fixed in two key surfaces** (mode_choice `ChoiceCard`, passphrase_set `ModeCard`): now `${title}. ${body}` + `accessibilityRole="button"` / `accessibilityRole="radio"` with `accessibilityState={{ selected }}`. Other surfaces (mnemonic_verify, etc.) still pending — same pattern applies.
8. ✅ **Gendered "she" for Dina** — used in welcome.tsx pillar copy. **Fixed**: "she delegates" → "it gets delegated". Grep across `apps/mobile/` confirms no other `she/her` references to Dina.
9. ✅ **Strength-bar / strength-pip thinness** — **Fixed**: pips now 6px (was 3); added text label "Weak / Okay / Strong / Excellent" below the bar with strength-coloured tint.
10. ✅ **No "show password" toggle** anywhere — **Fixed**: extracted shared `PassphraseField` (`src/components/PassphraseField.tsx`) with built-in eye toggle. Used in `passphrase_set`, `recovery-phrase`, `confirm-recovery-phrase`, and `unlock_gate`.
11. ✅ **The `\n` hard line break in hero text** — **Fixed** in welcome ("Your sovereign personal AI") and chat empty-state ("Ready when you are." with no forced break).
12. **Auto-lock dropdown** uses absolute pixel offsets — should derive from safe-area insets. (Not yet addressed; minor polish.)

### Round 3 fixes (post-em-dash pass)

13. ✅ **Settings "Encryption: AES-256-GCM" mislabel** — split into two rows: `Vault encryption: AES-256-CBC (SQLCipher)` + `Seed wrap: AES-256-GCM`.
14. ✅ **Welcome 8 pillars vs 6 pills mismatch** — pills now match pillars (8 entries: identity, vault, reminders, talk, agentTasks, security, peerlens, services).
15. ✅ **Mnemonic-verify wipe-on-mismatch** — now keeps correct answers and only clears the wrong one(s); focuses the first wrong row.
16. ✅ **Mnemonic-reveal cell index `01` VoiceOver** — cells now have a unified `accessibilityLabel="Word 1: dynamic"`; raw index + word are hidden from AX so VO doesn't read "zero one".
17. ✅ **Help "Dina applies what *she* knows about you"** — rewritten to "what it knows" / "it has seen" (parity with welcome.tsx fix).
18. ✅ **Vault list sealed-persona "0"** — `safeCount()` now returns `null` when DEK isn't in RAM; row shows `—` placeholder instead of misleading 0.
19. ✅ **People sub-tab pill contrast** — selected tab now filled accent (black) with white label; unselected pale, easy to read at a glance.
20. ✅ **Reminders / Notifications / People empty-state CTAs** — Reminders + People (Contacts) now have a clear "Go to Chat" / "Add a contact" pill button below the empty illustration. (Notifications "mark all read" deferred — needs a new `@dina/brain/notifications` API.)
21. ✅ **Vault detail tier card waste** — replaced full-width header card with compact tier badge pill next to the description card; clawed back ~80 px of vertical space.
22. ✅ **PeerLens write — "Aeron Chair" example** → "headphones, a book, a software tool" (less brand-narrow).
23. ✅ **PeerLens write — Sentiment "Required" marker** — added small red `Required` badge in the field header.
24. ✅ **PeerLens search "In my languages" filter explainer** — when filters are active AND query has no results, an italic hint appears: "Filters active. Tap a chip above to broaden the search."
25. ✅ **Help — linkable vs read-only card differentiation** — linkable cards now carry a 3-px accent left border so a glance tells them apart from read-only blurbs.
26. ✅ **Chat empty-state verbatim-from-Welcome** — replaced "Your sovereign personal AI" repetition with greeting "Ready when you are. Ask, remember, or hand off a task. Everything stays on your device."
27. ✅ **Em-dash sweep** — 50+ user-visible em-dashes rewritten across 24 files (separate pass).

---

## Source-of-truth files

If something changes in code and this document goes stale, the canonical lists are:

- `apps/mobile/app/**/*.tsx` — Expo router screens.
- `apps/mobile/app/_layout.tsx` — `NAV_MENU_ITEMS` array (hamburger).
- `apps/mobile/src/features.tsx` — `FEATURES` registry (titles, icons, routes).
- `apps/mobile/src/onboarding/state.ts` — `Step` discriminated union (onboarding states).
- `apps/mobile/src/components/onboarding/*.tsx` — Onboarding step components.
- `apps/mobile/src/components/Inline*.tsx` — Chat-stream inline cards.
- `apps/mobile/src/peerlens/components/*.tsx` — PeerLens view components.
