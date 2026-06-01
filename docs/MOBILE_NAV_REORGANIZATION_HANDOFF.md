# Mobile Navigation Reorganization Handoff

Status: implementation handoff
Owner: Claude Code
Target: pre-release mobile polish

## 1. Goal

Reorganize the mobile app so the first two minutes of use explain Dina correctly.

The app currently has the right underlying surfaces, but the bottom navigation exposes them as separate implementation concepts:

```text
Chat | People | PeerLens | Notifications | Approvals
```

That makes Dina look like a chat app plus a review network plus a notification center plus an approval queue. The product model should be simpler:

```text
Chat | People | Network | Activity
```

This is not a backend rewrite. It is a product-information-architecture cleanup that should reuse the existing code paths.

## 2. Why This Matters Before Release

This is important enough to do before release because it affects product comprehension, not because it fixes data loss.

Identity, outbox durability, and security issues were correctness blockers. This is different: it is a user-understanding blocker. A first-time user should immediately understand that Dina has four primary surfaces:

1. Chat with Dina.
2. Manage people and relationships.
3. Discover/trust the outside network: services, providers, and PeerLens reviews.
4. Review activity and safety decisions.

If Services stay hidden in Settings and PeerLens stays as a standalone top-level tab, users will not understand Dina's most unique idea: a sovereign home node that can discover and call trusted external services.

## 3. Current State Observed In Code

### 3.1 Root navigation

File: `apps/mobile/app/_layout.tsx`

Current visible bottom tabs:

```text
Chat
People
PeerLens
Notifications
Approvals, conditional on provider/agent readiness
```

Important current details:

- `TabName` is currently `Chat | People | PeerLens | Notifications | Approvals`.
- `TAB_FEATURE.PeerLens` maps to `peerlens`.
- `TAB_FEATURE.Notifications` maps to `notifications`.
- `TAB_FEATURE.Approvals` maps to `security`.
- `Approvals` visibility is conditional on `showApprovalsTab`.
- Notification and approval badges are separate.
- `service-settings` is hidden from the bottom bar and reached through Settings.

### 3.2 Feature registry

File: `apps/mobile/src/features.tsx`

Important current details:

- `peerlens` has route `/peerlens`.
- `services` exists as a feature but has no route.
- `notifications` has route `/notifications`.
- `security` has route `/approvals` and tab label `Approvals`.

This means Services are a named feature, but not a discoverable primary surface.

### 3.3 Notifications screen

File: `apps/mobile/app/notifications.tsx`

Current intent is already close to Activity:

- Comment says it is a unified inbox.
- It shows reminders, approvals, nudges, briefings, and ask-approval cards.
- It already has filters for Unread, All, Reminders, and Approvals.

This screen should become the base for `Activity`.

### 3.4 Approvals screen

File: `apps/mobile/app/approvals.tsx`

Current intent:

- Pending approval tasks.
- Completed approval history.
- Approve/deny actions.

This should not be a bottom-tab concept. It is an action bucket inside Activity. Keep `/approvals` as a route for deep links and focused review, but hide it from the bottom bar.

### 3.5 PeerLens screen

File: `apps/mobile/app/peerlens/index.tsx`

Current intent:

- PeerLens self profile.
- Search subjects/reviewers/places.
- PeerLens feed.
- Outbox and namespaces footer.

This should become a section inside a broader `Network` tab. Do not delete PeerLens. Reframe it.

### 3.6 Service settings

File: `apps/mobile/app/service-settings.tsx`

Current intent:

- Configure requester/provider/both role.
- Make node discoverable.
- Configure public service profile.
- Add capabilities.

Problems:

- It is discoverable mainly through Settings.
- The add-capability modal suggests flat names like `weather_forecast`.
- The modal says custom capabilities ship without JSON Schemas and asks developers to register them in the Brain registry. That copy conflicts with the target service architecture where public custom capabilities should be provider-owned, namespaced, and schema-described.

## 4. Target Information Architecture

### 4.1 Bottom tabs

The bottom tabs should be:

```text
Chat | People | Network | Activity
```

Detailed meaning:

| Tab | Meaning | Existing base |
| --- | --- | --- |
| Chat | Ask, remember, task, service answers, Dina conversation | `/` |
| People | Contacts, identities, people graph, relationships | `/people` |
| Network | Services, providers, PeerLens reviews, trust discovery | `/peerlens` plus service entry points |
| Activity | Notifications, approvals, reminders, nudges, service results, safety prompts | `/notifications` plus approval actions |

### 4.2 Do not rename Chat

Keep the bottom tab label `Chat`.

Reason:

- `Ask` is too narrow.
- `Home` is vague.
- `Dina` is brand-like but not an action.
- `Assistant` is generic.
- `Command` or `Console` is too technical.

The Chat screen can teach broader behaviors with chips or examples:

```text
Ask
Remember
Task
Find a service
```

But the tab should remain `Chat`.

### 4.3 Settings/hamburger

Keep Settings in the hamburger/menu.

Recommended menu:

```text
Vault
Reminders, optional if still useful as a standalone view
Settings
Help
Sign out
```

Do not add Services as a hamburger-only concept. Services should be visible from Network.

## 5. Implementation Scope

### 5.1 Rename PeerLens tab to Network

Required behavior:

- Bottom tab label becomes `Network`.
- Header title for the `/peerlens` root becomes `Network`.
- Existing route may remain `/peerlens` for release safety.
- Existing PeerLens stack routes should continue to work:
  - `/peerlens/search`
  - `/peerlens/[subjectId]`
  - `/peerlens/reviewer/[did]`
  - `/peerlens/write`
  - `/peerlens/outbox`
  - `/peerlens/namespace`

Recommended implementation:

- Do not rename the route folder before release unless there is a very strong reason.
- Do not rename `FEATURE_NAMES.peerlens` globally unless that has been checked across all packages. PeerLens is still the name of the trust/review feature.
- Prefer mobile-level labels:
  - `FEATURES.peerlens.tabLabel = 'Network'`, if the tab renderer uses it.
  - Or explicit `title: 'Network'` in `_layout.tsx`.
- Update comments in `_layout.tsx` so they do not say PeerLens is the top-level product surface.

Network tab content should contain these first-level modules:

1. `Services`
   - "Find a service"
   - "Publish a service" or "My services"
   - "Configured capabilities", if provider mode is active

2. `PeerLens`
   - Existing PeerLens profile/feed/search
   - Keep current PeerLens mechanics
   - Reword copy so PeerLens reads as trust signal inside the wider network

3. `Network health`, optional if already available
   - AppView reachable/unreachable
   - Publishing blocked state
   - Provider readiness blockers, only if the user has entered provider mode


### 5.2 Rename Notifications tab to Activity

Required behavior:

- Bottom tab label becomes `Activity`.
- Header title becomes `Activity`.
- Existing route may remain `/notifications`.
- The screen remains the unified chronological inbox.

Recommended filters:

```text
Needs action | Unread | All | Reminders
```

`Needs action` should include:

- `approval`
- `ask_approval`
- locked-vault approval prompts
- agent validation requests
- service approval requests


### 5.3 Remove Approvals from bottom tab

Required behavior:

- `/approvals` remains routable.
- `/approvals` is hidden from the bottom tab using `href: null`.
- Existing push/deep-link behavior must not break.
- Existing approval cards/actions must continue to work.

Important:

- Do not delete the approvals screen.
- Do not weaken approval safety.
- Do not remove the `showApprovalsTab` readiness logic until all call sites are checked. It may still be useful for deciding whether to show approval-related CTA text or empty states.

Preferred UX:

- Activity has a top section or filter for pending approvals.
- Tapping an approval notification or `dina://approvals/<id>` can still land on `/approvals` if that is simpler and safer.
- The user should not see `Approvals` as a fifth bottom tab.

### 5.4 Activity badge behavior

The bottom-tab badge should prioritize action.

Preferred behavior:

1. If there are pending approvals/action items, show that count on Activity.
2. Else, show unread notification count.
3. Avoid double-counting approvals if they are already included in unread notifications.

Minimal safe implementation:

```ts
const approvalBadge = useUnreadBadge('approval');
const notificationsBadge = useUnreadBadge();
const activityBadge = approvalBadge ?? notificationsBadge;
```

Only use this exact shape if it matches the return type. The concept is action-first, not necessarily this exact code.

### 5.5 Move service discovery/publishing entry point into Network

Required behavior:

- A user can discover that Dina supports services from the Network tab.
- A user who wants to publish a service can reach `/service-settings` from Network.
- The Settings row may remain.

Suggested copy:

```text
Services
Ask other Dinas for live answers, or publish what this Dina can do.

Find services
Publish a service
```

Provider mode copy should adapt:

- Requester-only user:
  - `Publish a service`
  - Routes to `/service-settings`.

- Provider/both user:
  - `My services`
  - `Configure listings`
  - Routes to `/service-settings`.

If provider blockers exist, show a calm warning:

```text
Service publishing is saved locally but not discoverable yet.
Missing: <blocker list>
```

Do not show a scary global warning unless the user is trying to publish.

### 5.6 Fix custom capability copy

Required behavior:

- Do not present flat capability keys as the right pattern for custom public capabilities.
- Do not tell users that custom public capabilities have no schema as if that is normal.

Custom capability examples should be namespaced:

```text
com.shop.inventory_lookup
org.school.homework_status
com.restaurant.table_availability
com.dinakernel.eta_query
```

Recommended copy:

```text
Use a reverse-DNS capability name you control, e.g.
com.example.inventory_lookup.

Public custom capabilities should include a parameter/result schema so
requesters can fill arguments and validate replies safely.
```

If the schema editor is not implemented yet:

- Do not lie.
- Either mark custom capability creation as developer preview, or require selecting a known capability for public discovery.

Acceptable v0 compromise:

```text
Custom capability keys are developer preview. They should be reverse-DNS
names and need schemas before other Dinas can reliably call them.
```

Best implementation:

- If service config already supports `capability_schemas`, expose a simple JSON editor/import field.
- Validate JSON before save.
- Show schema hash if already available.
- Do not add a complex schema builder unless it is already mostly implemented.

## 6. What Not To Do

Do not:

- Rename Chat.
- Add a fifth `Services` bottom tab.
- Delete `/approvals`.
- Delete `/peerlens`.
- Rename route folders aggressively before release.
- Make Settings the only path to service publishing.
- Hardcode bus/transit-specific UI into Network.
- Make custom services require a hardcoded Brain registry entry for the long-term path.
- Let providers control trust badges or system chrome.
- Let remote service cards render arbitrary Markdown/HTML as privileged UI.

## 7. Expected Final User Experience

### 7.1 First launch bottom bar

User sees:

```text
Chat | People | Network | Activity
```

This should be true even if provider mode or agent mode is enabled. Provider/agent readiness should affect content inside Activity, not create a fifth bottom tab.

### 7.2 User wants to ask something

Flow:

1. Opens Chat.
2. Asks naturally.
3. Dina may answer locally, remember something, create a task, or use services.

No navigation change required.

### 7.3 User wants to find a service

Flow:

1. Opens Network.
2. Sees Services section.
3. Can tap `Find services` or follow copy telling them to ask in Chat.
4. Can see that services are part of the Dina network, not hidden settings.

### 7.4 User wants to publish a service

Flow:

1. Opens Network.
2. Taps `Publish a service` or `My services`.
3. Lands on `/service-settings`.
4. Can configure role, discoverability, listing, and capabilities.

### 7.5 User receives approval request

Flow:

1. Activity tab gets badge.
2. User opens Activity.
3. `Needs action` shows the request.
4. User approves/denies.
5. If deep-linked, `/approvals` still works.

### 7.6 User receives ordinary reminder/update

Flow:

1. Activity tab may get badge.
2. User opens Activity.
3. Reminder/update appears in chronological feed.

## 8. Code-Level Checklist

### 8.1 Root layout

File: `apps/mobile/app/_layout.tsx`

Expected changes:

- Update top comment to reflect:

```text
Tab navigator: Chat, People, Network, Activity
Hamburger: Vault, Reminders, Settings, Help
Hidden/deep-link routes: Approvals, Service settings, etc.
```

- Change `TabName` from:

```ts
'Chat' | 'People' | 'PeerLens' | 'Notifications' | 'Approvals'
```

to something like:

```ts
'Chat' | 'People' | 'Network' | 'Activity'
```

- Map:

```ts
Network -> 'peerlens'
Activity -> 'notifications'
```

- Change `/peerlens` screen title to `Network`.
- Change `/notifications` screen title to `Activity`.
- Hide `/approvals` with `href: null`.
- Preserve `/approvals` route and back button behavior.
- Preserve notification deep links.

### 8.2 Feature registry

File: `apps/mobile/src/features.tsx`

Expected changes:

- Add mobile-level tab labels as needed:

```ts
peerlens.tabLabel = 'Network'
notifications.tabLabel = 'Activity'
```

- Do not necessarily change canonical `FEATURE_NAMES.peerlens`.
- Do not necessarily change canonical `FEATURE_NAMES.notifications`.
- Ensure icons typecheck.

### 8.3 Feature names

File: `packages/core/src/feature-names.ts`

Preferred:

- Avoid changing global canonical names unless there is a clear reason.
- `PeerLens` remains a feature.
- `Notifications` remains the lower-level inbox concept.
- Mobile can display `Network` and `Activity` as tab labels without renaming global feature keys.

If Claude decides to add new feature keys `network` or `activity`, that is a larger cross-package change and needs full search/test coverage. I do not recommend that for this release unless it is clearly cleaner in the existing code.

### 8.4 Network screen

File: `apps/mobile/app/peerlens/index.tsx`

Expected changes:

- Header/user-facing title should be Network.
- Add a Services module near the top.
- Keep existing PeerLens feed/search/self-profile.
- Update search placeholder if needed:

Current:

```text
Search subjects, reviewers, places...
```

Potential:

```text
Search reviews, providers, places...
```

Do not break current PeerLens tests unless updating expected copy.

### 8.5 Activity screen

File: `apps/mobile/app/notifications.tsx`

Expected changes:

- Rename user-facing title/copy from Notifications to Activity where appropriate.
- Prefer `Needs action` over `Approvals` as the action filter.
- Keep unread/all/reminders behavior.
- Preserve `resolveSafeDeepLink`.
- Preserve live subscription.

### 8.6 Approvals screen

File: `apps/mobile/app/approvals.tsx`

Expected changes:

- Keep route.
- Keep approve/deny safety.
- Consider updating title/copy to make it a focused Activity sub-screen:

```text
Approvals
Pending | Completed
```

- Do not remove tests.
- Do not move approve/deny business logic into the notification screen by copy/paste. If Activity needs inline approval cards, extract shared components/hooks.

### 8.7 Service settings

File: `apps/mobile/app/service-settings.tsx`

Expected changes:

- Fix custom capability placeholder.
- Fix custom capability help text.
- If easy, support namespaced custom capability validation.
- Do not force hardcoded registry as the long-term public-service path.

### 8.8 Settings

File: `apps/mobile/app/settings.tsx`

Expected changes:

- Keep Service Sharing row.
- It is fine if Settings still links to `/service-settings`.
- Do not make Settings the only entry point.

### 8.9 Docs that may need updates

Likely update:

- `apps/mobile/NAV_AUDIT.md`
- `apps/mobile/docs/SCREENS.md`

Only update docs that are expected to stay current. If a doc is explicitly old/historical, do not churn it.

## 9. Test Plan

Run at minimum:

```bash
npm run typecheck -w @dina/app
npm test -w @dina/app -- --runInBand
```

If full mobile test suite is too slow, run targeted tests first, then full suite if possible:

```bash
npm test -w @dina/app -- --runInBand apps/mobile/__tests__/notifications/screen.render.test.tsx
npm test -w @dina/app -- --runInBand apps/mobile/__tests__/notifications/screen_filter.test.ts
npm test -w @dina/app -- --runInBand apps/mobile/__tests__/approvals/screen.live_refresh.test.tsx
npm test -w @dina/app -- --runInBand apps/mobile/__tests__/navigation/parent_route.test.ts
npm test -w @dina/app -- --runInBand apps/mobile/__tests__/peerlens/index.render.test.tsx
```

Also run:

```bash
npm run typecheck
```

only if the workspace typecheck is confirmed to actually cover packages. The safer release check is still per-package.

## 10. Manual Verification

Manual smoke test on mobile:

1. Launch app.
2. Confirm bottom bar shows exactly:

```text
Chat | People | Network | Activity
```

3. Confirm no `Approvals` bottom tab appears, even with provider/agent enabled.
4. Open Network.
5. Confirm PeerLens content still works.
6. Confirm Services section is visible.
7. Tap `Publish service` / `My services`.
8. Confirm `/service-settings` opens.
9. Open Activity.
10. Confirm unread/reminder/approval items appear.
11. Trigger or seed a pending approval.
12. Confirm Activity badge appears.
13. Confirm pending approval is reachable.
14. Confirm approve/deny still works.
15. Confirm existing approval deep link still works.
16. Confirm Settings still has Service Sharing.
17. Confirm custom capability copy uses namespaced examples.

## 11. Acceptance Criteria

This work is complete only when:

- Bottom navigation has four visible tabs: Chat, People, Network, Activity.
- PeerLens no longer appears as a bottom-tab label.
- Notifications no longer appears as a bottom-tab label.
- Approvals no longer appears as a bottom-tab label.
- `/approvals` still works as a hidden/deep-link route.
- `/peerlens` stack still works.
- `/notifications` stack/screen still works.
- Network visibly exposes Services.
- Service settings remain reachable.
- Custom capability copy no longer suggests flat names as the normal public path.
- Custom capability copy no longer presents schema-less public capabilities as the proper architecture.
- Existing notification deep-link allowlist remains intact.
- Existing approval safety remains intact.
- Mobile typecheck passes.
- Relevant mobile tests pass.

## 12. Architecture Judgment

The desired architecture is:

```text
Chat     = user intent surface
People   = identity/contact/relationship surface
Network  = external discovery/trust/services surface
Activity = event/action/safety surface
```

This aligns with Dina's actual architecture:

- D2D and services are network interactions.
- PeerLens is trust signal for network interactions.
- Approvals are safety activity, not a separate app mode.
- Notifications are activity, not just passive messages.
- Service publishing is a network-facing identity action, not a hidden settings preference.

## 13. Non-Goals

Do not attempt these in this task:

- Full service marketplace UI.
- Full schema-builder UI.
- Route migration from `/peerlens` to `/network`.
- Route migration from `/notifications` to `/activity`.
- Backend protocol changes.
- AppView schema changes.
- D2D service changes.
- CardSpec changes.
- Identity model changes.

Those may be correct later, but this task is navigation and product framing.

## 14. Common Pitfalls

### 14.1 Creating a Services tab

Do not do this.

Services belong under Network. A separate Services tab recreates bottom-bar overload and makes PeerLens feel disconnected from services even though trust and service discovery should reinforce each other.

### 14.2 Removing Approvals route

Do not do this.

Approvals should be removed only from the bottom bar. Existing deep links, safety cards, and focused review flows may still depend on `/approvals`.

### 14.3 Renaming global PeerLens everywhere

Do not blindly rename every `PeerLens` string to `Network`.

PeerLens remains the name of the trust/review subsystem. Network is the top-level mobile surface that contains PeerLens.

### 14.4 Making Activity passive

Activity must not become just "notifications with a new name." It should make pending safety decisions obvious.

### 14.5 Overbuilding custom capabilities

Do not build a large schema design tool if it risks destabilizing release.

But do fix the misleading copy. If schema editing is not implemented, label custom capabilities honestly as developer preview.

## 15. Suggested Implementation Order

1. Update labels and bottom-tab structure in `_layout.tsx`.
2. Hide Approvals from bottom bar but keep route.
3. Rename Notifications surface to Activity.
4. Add Services module to Network/PeerLens root.
5. Add Network route into `/service-settings`.
6. Fix custom capability copy.
7. Update targeted tests.
8. Run typecheck.
9. Run mobile test suite.
10. Manual smoke test.

This order keeps the riskiest safety flows visible during implementation and avoids changing service/backend code unnecessarily.
