# Mobile Navigation Audit

Date: 2026-05-17  
Method: Static analysis of all router calls, `parentRouteFor` map, and Tabs/Stack layouts.

---

## Architecture Overview

```
Root: <Tabs> (flat — no per-tab Stack except for peerlens/ and vault/)

Bottom bar tabs (4 — same even with provider/agent enabled):
  Chat (/)          People (/people)
  Network (/peerlens)   Activity (/notifications)

  Network  = Services + PeerLens trust/reviews (route folder unchanged)
  Activity = unified inbox: notifications + approvals + reminders + nudges

Hidden / deep-link routes (href: null): Approvals (/approvals),
  Service settings (/service-settings), Vault drill-downs, Settings family.

Hamburger menu (header-left on every top-level tab):
  → /vault          → /reminders        → /settings
  → /help           → Sign out (lock)

Back button system:
  All non-tab screens have headerLeft: HeaderBackButton.
  This calls parentRouteFor(pathname) → router.replace(parent).
  In-screen buttons (Cancel, Done, Not now) call router.back() directly.

Stack-scoped tabs (have their own nested Stack):
  /peerlens/_layout.tsx  — back chevron is Stack-aware
  /vault/_layout.tsx     — back chevron is Stack-aware
```

---

## Complete Route → Entry Point Map

| Route | How you reach it | Expected back destination |
|---|---|---|
| `/` | Default / tab bar | n/a (root) |
| `/people` | Tab bar | n/a (root tab) |
| `/notifications` | Tab bar | n/a (root tab) |
| `/approvals` | Tab bar (conditional) | n/a (root tab) |
| `/peerlens` | Tab bar | n/a (root tab) |
| `/peerlens/search` | PeerLens → search icon | `/peerlens` (Stack) |
| `/peerlens/[subjectId]` | PeerLens search result | `/peerlens` or `/peerlens/search` (Stack) |
| `/peerlens/reviewer/[did]` | Subject → reviewer | `/peerlens/[subjectId]` (Stack) |
| `/peerlens/write` | Subject / reviewer / chat draft | `/peerlens/[subjectId]` or `/` (chat-draft) |
| `/peerlens/outbox` | PeerLens → outbox button | `/peerlens` (Stack) |
| `/peerlens/namespace` | PeerLens → namespace button | `/peerlens` (Stack) |
| `/vault` | Hamburger menu | n/a (Stack root) |
| `/vault/[name]` | Vault hub → persona card | `/vault` (Stack) |
| `/settings` | Hamburger menu | `/` (Chat) |
| `/admin` | Settings → MORE → Admin | `/settings` |
| `/policy` | Admin → Agent policies | `/admin` |
| `/paired-devices` | Settings → MORE → Agents | `/settings` |
| `/service-settings` | Settings → Service Sharing | `/settings` |
| `/recovery-phrase` | Settings → View recovery phrase, or confirm-recovery-phrase → View phrase | `/settings` (or `/confirm-recovery-phrase`) |
| `/confirm-recovery-phrase` | Chat banner, or Settings → Confirm phrase | `/settings` (or `/`) |
| `/peerlens-preferences/region` | Settings → PeerLens Preferences | `/settings` |
| `/peerlens-preferences/budget` | Settings → PeerLens Preferences | `/settings` |
| `/peerlens-preferences/devices` | Settings → PeerLens Preferences | `/settings` |
| `/peerlens-preferences/languages` | Settings → PeerLens Preferences | `/settings` |
| `/peerlens-preferences/dietary` | Settings → PeerLens Preferences | `/settings` |
| `/peerlens-preferences/accessibility` | Settings → PeerLens Preferences | `/settings` |
| `/reminders` | Hamburger menu | `/` (Chat) |
| `/help` | Hamburger / header right (?) button | `/` (or source tab via `?from=`) |
| `/add-contact` | People → + Add | `/people` |
| `/chat/[did]` | People → contact row | `/people` |

---

## Bugs Found

### 🔴 Critical — Header back button goes to wrong screen

**Bug 1: `/policy` → back lands on Chat, not Admin**

- Path: Settings → Admin → Agent Policies → ← back
- `parentRouteFor('/policy')` → `'policy'` not in `SECTION_PARENTS` → returns `/`
- User lands on Chat tab instead of Admin screen
- Fix: add `policy: '/admin'` to `SECTION_PARENTS` in `src/navigation/parent_route.ts`

**Bug 2: `/peerlens-preferences/*` → back lands on Chat, not Settings**

- Path: Settings → any PeerLens Preference screen → ← back
- `parentRouteFor('/peerlens-preferences/region')` → `'peerlens-preferences'` not in `SECTION_PARENTS` → returns `/`
- Affects all 6 preference screens: region, budget, devices, languages, dietary, accessibility
- Fix: add `'peerlens-preferences': '/settings'` to `SECTION_PARENTS`

**Bug 3: `/recovery-phrase` → back lands on Chat, not Settings**

- Path: Settings → View recovery phrase → ← back
- `parentRouteFor('/recovery-phrase')` → `'recovery-phrase'` not in `SECTION_PARENTS` → returns `/`
- Fix: add `'recovery-phrase': '/settings'` to `SECTION_PARENTS`
- Edge case: when reached from `/confirm-recovery-phrase` via `onViewPhrase`, the correct back is `/confirm-recovery-phrase` not `/settings`. This can be solved by passing `?from=/confirm-recovery-phrase` on that push.

**Bug 4: `/confirm-recovery-phrase` → back lands on Chat, not Settings**

- Path: Settings → Confirm recovery phrase → ← back
- `parentRouteFor('/confirm-recovery-phrase')` → `'confirm-recovery-phrase'` not in `SECTION_PARENTS` → returns `/`
- Fix: add `'confirm-recovery-phrase': '/settings'` to `SECTION_PARENTS`
- Note: when reached via the chat-home banner, `/` is the correct back. The banner push should include `?from=/` to override the map.

---

### 🟠 Moderate — In-screen buttons call `router.back()` unsafely

Under bare `<Tabs>` without a per-tab Stack, `router.back()` pops the previously-focused **tab**, not the previously-pushed screen. These screens are registered at the Tabs root level (not inside a Stack), so `router.back()` in their internal buttons may send the user to whichever tab was active before they navigated to this screen.

**Bug 5: `add-contact.tsx` Cancel and Done → `router.back()`**

- Lines 99 (save success), 150 (Cancel button)
- Expected: return to `/people`
- Fix: change both to `router.replace('/people')`

**Bug 6: `confirm-recovery-phrase.tsx` in-screen buttons → `router.back()`**

- Line 69: `onBack={() => router.back()}` (inside MnemonicVerify)
- Line 75: `onVerified → router.back()` (after successful verification)
- Line 137: "Not now" Cancel button → `router.back()`
- Expected: return to `/settings` (or `/` if reached from chat banner)
- Fix: replace all three with `router.replace('/settings')` as the default; the chat-banner caller should pass `?from=/` so the header back honours it, and the in-screen buttons can read the same `from` param.

**Bug 7: `recovery-phrase.tsx` Back button → `router.back()`**

- Line 175: Back button inside the passphrase gate
- Expected: return to `/settings` (or `/confirm-recovery-phrase`)
- Fix: `router.replace('/settings')` as default; pass `?from` param from callers where needed.

**Bug 8: `peerlens-preferences/region.tsx` save → `router.back()`**

- Line 77: after saving region preference
- Expected: return to `/settings`
- Fix: `router.replace('/settings')`
- (Applies to all 6 preference screens — they may all use the same `router.back()` after save.)

**Bug 9: `service-settings.tsx` Alert OK → `router.back()`**

- Line 242: `{ text: 'OK', onPress: () => router.back() }` inside an Alert
- Expected: return to `/settings`
- Fix: `router.replace('/settings')`

---

### 🟡 Low — Cross-section navigations missing `?from` param

**Bug 10: `help.tsx` card → `/admin` — back goes to `/settings`, not `/help`**

- `help.tsx` renders a card with `href: '/admin'` that pushes to Admin
- From Admin, ← back → `parentRouteFor('/admin')` → `/settings` (correct per the map, but user came from Help)
- Fix: push with `router.push({ pathname: '/admin', params: { from: '/help' } })` so back returns to Help

**Bug 11: `confirm-recovery-phrase` → `router.push('/recovery-phrase')` (View phrase link) — back from recovery-phrase goes to Chat, not back to the verify step**

- `confirm-recovery-phrase.tsx:71`: `onViewPhrase={() => router.push('/recovery-phrase')}`
- Recovery phrase header back → `/` (Chat) because `recovery-phrase` isn't in `SECTION_PARENTS`
- Even after Bug 3 is fixed (adding `recovery-phrase → /settings`), back from recovery-phrase will go to Settings, not back to the verify step
- Fix: push with `router.push({ pathname: '/recovery-phrase', params: { from: '/confirm-recovery-phrase' } })` so the `?from` override kicks in.

---

## What Is Working Correctly

- **PeerLens Stack** — search → subject → reviewer → write → back chain is fully correct. `PeerlensStackBack` handles rehydrated-stack cold-start correctly.
- **Vault Stack** — vault hub → vault detail → back is correct. `VaultStackBack` handles cold-start correctly.
- **write.tsx chat-draft back** — when pushed with `draftId + threadId`, publish/cancel both `router.replace('/')` back to Chat. Header left is overridden accordingly.
- **Settings family** — admin → `/settings`, paired-devices → `/settings`, service-settings → `/settings` all correct in `SECTION_PARENTS`.
- **Chat → People** — `chat → /people` in `SECTION_PARENTS` is correct.
- **add-contact header back** — header back uses `parentRouteFor` → `/people` ✓ (in-screen buttons are the bug).
- **Hamburger menu** items (vault, reminders, settings, help) all push correctly.
- **`help.tsx` `?from` param** — the `from` query param mechanism in `HeaderBackButton` works. PeerLens and Vault both pass `?from=<section>` when opening Help, so back from Help returns to the correct section.
- **NavMenu hides current route** — the menu filters out the entry matching the current path, so no self-navigation.
- **Approvals is not a bottom tab** — `/approvals` is `href: null` unconditionally (reached via notification tap / `dina://approvals/<id>` deep link). Its back chevron's logical parent is Activity (`parentRouteFor('/approvals') → /notifications`). The former `showApprovalsTab` provider/agent gate was retired.
- **Network (PeerLens) tab gating** — hidden when `isTrustTabHidden()`.

---

## Fix Plan

All fixes are in two files:

### 1. `src/navigation/parent_route.ts` — add 4 missing entries

```ts
const SECTION_PARENTS: Record<string, string> = {
  chat: '/people',
  'add-contact': '/people',
  admin: '/settings',
  'paired-devices': '/settings',
  'service-settings': '/settings',
  policy: '/admin',                        // ADD — admin drill-down
  'recovery-phrase': '/settings',          // ADD — settings drill-down
  'confirm-recovery-phrase': '/settings',  // ADD — settings drill-down (chat banner should pass ?from=/)
  'peerlens-preferences': '/settings',     // ADD — settings drill-downs (all 6 sub-screens)
  settings: '/',
  reminders: '/',
  help: '/',
};
```

### 2. In-screen `router.back()` → `router.replace(parent)` (Bugs 5–9)

| File | Line | Current | Fix |
|---|---|---|---|
| `add-contact.tsx` | 99 | `router.back()` | `router.replace('/people')` |
| `add-contact.tsx` | 150 | `router.back()` | `router.replace('/people')` |
| `confirm-recovery-phrase.tsx` | 69 | `router.back()` | `router.replace('/settings')` (or read `from` param) |
| `confirm-recovery-phrase.tsx` | 75 | `router.back()` | `router.replace('/settings')` |
| `confirm-recovery-phrase.tsx` | 137 | `router.back()` | `router.replace('/settings')` |
| `recovery-phrase.tsx` | 175 | `router.back()` | `router.replace('/settings')` |
| `peerlens-preferences/region.tsx` | 77 | `router.back()` | `router.replace('/settings')` |
| `service-settings.tsx` | 242 | `router.back()` | `router.replace('/settings')` |

### 3. Missing `?from` params (Bugs 10–11)

| Location | Current | Fix |
|---|---|---|
| `help.tsx:138` admin card | `router.push('/admin')` | `router.push({ pathname: '/admin', params: { from: '/help' } })` |
| `confirm-recovery-phrase.tsx:71` | `router.push('/recovery-phrase')` | `router.push({ pathname: '/recovery-phrase', params: { from: '/confirm-recovery-phrase' } })` |
| `index.tsx` chat banner | `router.push('/confirm-recovery-phrase')` | `router.push({ pathname: '/confirm-recovery-phrase', params: { from: '/' } })` — so in-screen buttons can return to Chat |

---

## Priority Order

1. **Bug 1, 2, 3, 4** — header back broken — fix `SECTION_PARENTS` (5 lines, one file)
2. **Bug 5, 6, 7, 8, 9** — in-screen `router.back()` — fix 8 call sites
3. **Bug 10, 11** — missing `?from` — fix 3 push sites
