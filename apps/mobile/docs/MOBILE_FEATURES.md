# Dina Mobile — Feature Map (user + provider)

A human-readable inventory of what the **Dina mobile app** does, from the
perspective of the person using it (**user**) and the person offering a service
(**provider**). It is grounded in the actual screens/routes — see
`apps/mobile/docs/SCREENS.md` for the screen-by-screen map and
`apps/mobile/src/features.tsx` / `packages/core/src/feature-names.ts` for the
canonical feature names.

## Status legend

- **shipped** — wired end-to-end and usable in the mobile UI today.
- **partial** — the protocol/runtime supports it, but the mobile UX is
  incomplete (the recurring gap: "runtime can, mobile can't yet").
- **planned** — described in the vision/spec but not implemented.

> The most common caveat below is **partial = "runtime supports it, mobile UX
> not built yet"** — true for unlisted sharing, known-only invocation,
> service-area editing, public custom-cap schemas, contact-detail editing,
> whole-vault delete, reminder row actions, namespaces, and the co-sign inbox.

---

## Perfect vs Current Product Flows

This section is the plain-language audit. For every major mobile scenario, it
answers three questions:

- **Perfect flow:** what a normal user would expect Dina to do.
- **Current app:** what the mobile app actually does today.
- **Remaining gap:** what is still missing or weaker than the perfect version.

### 1. Identity And Onboarding

**Perfect flow:** A user should be able to start with Dina in three ways:
create a fresh Dina identity, restore an existing Dina on a new device, or bring
an existing AT Protocol identity/PDS. In all three cases, the user should own
the recovery phrase, understand that the phrase matters, and not accidentally
create a non-recoverable identity.

**Current app:** This is implemented. The app supports new identity creation,
restore with recovery phrase + handle check, existing AT Protocol identity
onboarding, passphrase setup, recovery phrase reveal, and recovery phrase quiz.
Cold-start unlock also works with passphrase or keychain auto-unlock.

**Remaining gap:** No major release gap. Infrastructure override is post-
onboarding through Settings, not part of the first-run wizard.

**Status:** **shipped**

### 2. Chat As The Main Dina Surface

**Perfect flow:** The user should have one primary place to talk to Dina. From
there, they should be able to ask questions, save memories, and delegate tasks
to an agent when an agent exists. The UI should not show modes that cannot
actually work.

**Current app:** Ask, Remember, and Task are the main modes. Task appears only
when an active paired agent exists. This avoids offering an agent path when no
agent can claim the task. Personal D2D talk is intentionally not in this mode
picker; it lives under People.

**Remaining gap:** No major release gap for the mode split. The product story
should keep explaining that Chat is "talk to Dina", while People chat is "talk
to another Dina/person".

**Status:** **shipped**

### 3. Ask / External Service Choice

**Perfect flow:** If the user asks "What homework does Emma have today?", Dina
should decide whether to answer from the vault, ask Emma directly, invoke a
known school service, or search AppView for a suitable service. The user should
not have to manually know which path is right.

**Current app:** The service-query path exists through Chat. Dina can discover
services through AppView, send service queries, and show missing-provider or
missing-capability cards when no match exists. Known direct D2D talk exists
separately under People.

**Remaining gap:** There is no dedicated Network service marketplace/search UI
yet. The LLM-driven decision between vault recall, D2D, known service, and
AppView search is the intended architecture, but the user-facing browse/search
surface is still future UX.

**Status:** **partial**

### 4. Remember / Vault Storage

**Perfect flow:** The user should be able to say "remember X", and Dina should
store it in the right vault, link it to people when relevant, plan reminders if
dates are present, and make the memory available later without leaking locked
vault content.

**Current app:** Remember mode exists. Vault/persona routing exists. Stored
items can be browsed by vault. Reminder cards can be created from dated
memories. Locked/sensitive vault access can require approval before exposure.

**Remaining gap:** The current mobile UI does not give the user a rich
post-save correction flow, such as "this went to the wrong vault", "this memory
is about the wrong person", or "move this item". That is not a blocker for basic
memory, but it is the perfect future flow.

**Status:** **partial**

### 5. Inline Cards In Chat

**Perfect flow:** Dina should not return everything as plain text. Approvals,
reminders, review drafts, service results, and safety prompts should appear as
clear cards with buttons only when buttons are safe.

**Current app:** The stream renders inline approval cards, briefings, nudges,
reminders, review drafts, service approvals, missing-service cards, and service
query result cards.

**Remaining gap:** CardSpec media blocks are not rendered yet. The renderer
shows alt text until a safe image-proxy/cache policy exists.

**Status:** **shipped**, with media rendering **partial**

### 6. Vaults

**Perfect flow:** A user should be able to create vaults, edit descriptions,
browse memories, delete individual memories, delete an entire vault with strong
confirmation, and understand which vaults are locked.

**Current app:** Create/list vaults, edit descriptions, browse items, and delete
individual items are implemented. Locked vault rows show as locked rather than
pretending to be empty.

**Remaining gap:** Whole-vault delete is not exposed in mobile yet. There is no
rich item move/reclassify flow yet.

**Status:** **partial**

### 7. People And Contacts

**Perfect flow:** A user should be able to add a person, see all identities
linked to that person, edit display name/trust/aliases, block or unblock them,
inspect PLC identity details, and start D2D chat.

**Current app:** Own identity card exists. Contacts can be added by handle/DID
with a display name. Contacts show trust badges and open 1:1 chat. The chat
header opens the identity modal with DID/PLC information. Relations from the
people graph are visible.

**Remaining gap:** There is no dedicated contact detail screen yet. Trust
editing, alias editing, linked-identity management, notes, split/merge, and
block/unblock UX are not all exposed from mobile.

**Status:** **partial**

### 8. Personal D2D Talk

**Perfect flow:** If the user wants to talk to a known person, they should go
through a personal D2D chat path. This should be separate from service queries,
because personal chat can become an ongoing relationship while service queries
should be narrow and one-shot.

**Current app:** People/contact rows open 1:1 D2D chat. Messages have delivery
status and failed-send handling. Unknown contacts get a warning/add-contact
path.

**Remaining gap:** Contact policy management is still thin. The UI does not yet
make every admission-policy distinction visible to the user, such as why a
message was quarantined versus staged.

**Status:** **shipped** for chat, **partial** for richer policy UX

### 9. Reminders

**Perfect flow:** A user should be able to see reminders grouped by time, mark
them done, snooze them, delete them, dismiss them, and understand recurring
state from the Reminders screen itself.

**Current app:** The Reminders screen shows grouped reminders. Long-press
dismiss works. Fired inline reminder cards in Chat support Mark done and Snooze
1h.

**Remaining gap:** Row-level done/snooze/delete buttons are not exposed on the
Reminders screen yet.

**Status:** **partial**

### 10. Activity And Approvals

**Perfect flow:** The user should have one place for everything that happened
and everything needing a decision: reminders, service approvals, locked-vault
approval, agent safety prompts, and normal notifications.

**Current app:** Activity has Needs action / Unread / All / Reminders filters.
Approvals are a deep-link route, not a bottom tab. Safe deep-link routing keeps
notification taps on allowed internal routes.

**Remaining gap:** No major release gap. Future improvement is more per-item
context and better grouping if the inbox gets busy.

**Status:** **shipped**

### 11. Services As A Requester

**Perfect flow:** A user asks naturally. Dina decides whether the answer should
come from local memory, a known provider, or AppView service discovery. If a
service is used, the provider gets only a narrow service query, not a personal
chat invitation. The response is validated and rendered as a safe card.

**Current app:** Service discovery and service query through Chat exist.
Responses can render CardSpec cards. Missing-provider and missing-capability
cards exist. Service traffic uses D2D/MsgBox and temporary query windows.

**Remaining gap:** There is no dedicated service marketplace/search screen in
Network. "Find a service" routes to Chat. That is acceptable for the first
release but not the perfect browse/discovery UX.

**Status:** **partial**

### 12. Service Result Cards

**Perfect flow:** Any provider should be able to return a safe, rich card for
their product or service without shipping code into the user's phone. The card
should support structured blocks, safe links, maps, expiry/staleness, and later
safe media.

**Current app:** CardSpec is data, not executable UI. The renderer supports a
fixed safe vocabulary, skips unknown blocks, shows real link hosts, builds map
links client-side, and handles staleness/expiry.

**Remaining gap:** Media rendering is intentionally skipped until a safe image
proxy/cache policy exists. Provider-declared display hints beyond the current
CardSpec vocabulary are future work.

**Status:** **shipped**, with media **partial**

### 13. Provider Role

**Perfect flow:** A user should clearly choose whether this Dina only requests
services, only provides services, does both, or is effectively provider-off.
Changing this should be understandable and not silently leave old provider
machinery running.

**Current app:** My Services exposes requester/provider/both. "Requester only"
is provider-off. Role preference is saved.

**Remaining gap:** Changing role requires force-quit + reopen because provider
runtime wiring happens at boot. The UI warns about this.

**Status:** **shipped**, with restart caveat

### 14. Provider Multi-Listing

**Perfect flow:** One DID should be able to manage many independent service
listings. If a provider has five services, they should be able to pause, edit,
delete, or add one listing without affecting the other four.

**Current app:** My Services lists every listing. Each row has name,
capability count, visibility, Active/Paused toggle, tap-to-edit, delete, and
New listing. The editor writes by rkey, and runtime publishes one AT Protocol
record per listing.

**Remaining gap:** No major release gap for basic multi-listing. Future
improvements are nicer sorting, duplicated-listing convenience, and analytics
per listing.

**Status:** **shipped**

### 15. Official Capability Picker

**Perfect flow:** Normal users should not type capability IDs. They should pick
a category, then pick a capability from an official catalog. Dina should attach
the right schema and safer defaults automatically.

**Current app:** The provider editor uses a Category -> Capability picker backed
by the official catalog, with bundled fallback and AppView catalog loading.
Sensitive capabilities can default to safer discoverability.

**Remaining gap:** The catalog itself will need ongoing curation as real users
add more service types. This is a product/catalog maintenance task, not a
missing mobile control.

**Status:** **shipped**

### 16. Custom Capabilities

**Perfect flow:** A developer/provider should be able to define a namespaced
custom capability, add params/result schemas, choose public/unlisted/private,
and publish it from mobile without needing a CLI.

**Current app:** Mobile can add a namespaced custom capability name such as
`com.example.foo`.

**Remaining gap:** Public custom capabilities require params/result schemas, but
mobile has no schema editor yet. So mobile cannot complete a safe public custom
capability end-to-end today. Custom known/private service semantics are also
not fully exposed.

**Status:** **partial**

### 17. Discoverability And Privacy

**Perfect flow:** A provider should choose Public, Unlisted, or Private/known-
only for each listing. Public should appear in search. Unlisted should be
shareable by link/QR/invite but not searchable. Private should only work with
explicitly connected known parties.

**Current app:** Public, unlisted, and known-only states exist in the model and
editor. Public is searchable. Unlisted is published and URI-resolvable but
excluded from search. Known-only is not published.

**Remaining gap:** Unlisted share/scan UX is not built. Known-only invocation
through explicit pairing/direct connection is future work.

**Status:** **partial**

### 18. Service Area And Local Search

**Perfect flow:** Local providers should be able to say where they serve:
city, radius, exact location, or region. AppView should use that for queries
like "ENT doctor near me" or "plumber in Kochi".

**Current app:** AppView/runtime can use location and radius in service search.

**Remaining gap:** Mobile provider UI does not expose service-area editing yet.
This matters for doctors, restaurants, transit, plumbers, schools, delivery,
home services, and local professional services.

**Status:** **partial**

### 19. Provider Execution And Review

**Perfect flow:** A provider should receive service queries, validate them,
either answer automatically or ask the provider to review, and then send a
validated service response back through the narrow service window.

**Current app:** Inbound service queries can be answered automatically or via
service approval cards, depending on response policy. Active/Paused gates
whether the listing answers. Runtime warnings tell the provider if publishing
or reachability is degraded.

**Remaining gap:** Provider review UX can become richer: request history,
per-listing inbox, reject reasons, and better debugging for failed execution.

**Status:** **shipped** for basic provider execution, richer ops UX **partial**

### 20. Network / PeerLens Discovery

**Perfect flow:** Network should feel like one coherent surface for external
trust and services: find services, understand trust, search subjects, read
reviews, and see why Dina prefers one provider/product over another.

**Current app:** Network has a Services card plus PeerLens feed/search. Self
profile, subject cards, subject detail, reviewer profiles, and preferences
exist.

**Remaining gap:** The Network screen still has separate Services and PeerLens
modules rather than a fully integrated discovery surface. This is acceptable
for release but not the final UX.

**Status:** **partial**

### 21. Writing PeerLens Reviews

**Perfect flow:** A user should be able to write useful reviews with enough
structure for trust ranking: kind, sentiment, headline, body, use cases,
confidence, alternatives, price, and reviewer experience.

**Current app:** Review write flow and advanced wizard exist with those fields.
Edit warning exists for cosignature release scenarios.

**Remaining gap:** No major release gap for writing a review. Future work is
making the flow shorter for casual users and stronger for expert reviewers.

**Status:** **shipped**

### 22. PeerLens Namespaces

**Perfect flow:** A user should be able to manage pseudonymous namespaces from
mobile: see existing namespace keys, create a new namespace, disable/rotate if
needed, and understand which namespace a review uses.

**Current app:** The namespace route exists as a presentational shell.

**Remaining gap:** The live runner that reads PLC state and submits namespace
changes is not wired into mobile yet.

**Status:** **partial**

### 23. PeerLens Co-Sign Inbox

**Perfect flow:** If someone asks the user to co-sign a review, the request
should appear in Activity/Network with Endorse and Decline actions. The user
should see who asked, which review, why, expiry, and what endorsing means.

**Current app:** The data-layer derivation and row component exist.

**Remaining gap:** There is no shipped mobile route/inbox surface that wires
those rows to real endorse/decline actions.

**Status:** **partial**

### 24. Backup / Restore / Portability

**Perfect flow:** The user should be able to export real user data, restore it
on another device, avoid accidental overwrite, and understand that secrets and
master seed are not blindly exported.

**Current app:** Encrypted `.dina` export/restore exists. Restore validates the
archive/passphrase, blocks accidental overwrite unless confirmed, and asks the
user to close/reopen after restore. The archive includes vault/user data, not
master seed or API secrets.

**Remaining gap:** No major release gap. Future improvement is clearer UX copy
around what is included and excluded.

**Status:** **shipped**

### 25. Settings / Infrastructure / Admin

**Perfect flow:** A user should be able to manage AI provider keys, choose
models, change passphrase/security settings, configure infrastructure, pair or
revoke agents, inspect diagnostics, and erase local state.

**Current app:** AI providers/model picker, security settings, recovery phrase,
agent pairing/revoke, policy screen, infrastructure endpoints, admin
diagnostics, sign out, erase vault, and help routes exist.

**Remaining gap:** Paired devices is currently agent-specific rather than a
general multi-role device manager. "Re-publish PLC document" is a placeholder.

**Status:** **shipped** for current release needs, broader device/admin UX
**partial**

### 26. Agent Safety

**Perfect flow:** Agents should never get vault keys. They should request work
or data through Dina, and Dina should enforce policy: safe actions may proceed,
risky actions need approval, blocked actions are denied, locked vault access
requires explicit approval.

**Current app:** Agent pairing, task mode, policy screen, approvals, and locked-
vault approval surfaces exist. SAFE can auto-approve, MODERATE requires session
approval, HIGH requires approval every time, and BLOCKED is denied.

**Remaining gap:** Future improvement is clearer per-agent audit history and
better explanation of why each approval was required.

**Status:** **shipped**

### 27. Transport And Security Defaults

**Perfect flow:** Cross-Dina traffic should go through MsgBox, service replies
should be allowed only for the matching query window, local vault data should
stay encrypted, and notification/deep-link paths should not let remote data
navigate into unsafe screens.

**Current app:** D2D/cross-Dina traffic routes through MsgBox. Local vault data
is encrypted. Sensitive key material is device-bound or passphrase-wrapped.
Agents do not hold vault keys. Notification deep links are allowlisted.

**Remaining gap:** No major release gap in the feature map. Deeper transport
and security correctness is covered by separate architecture/security audits.

**Status:** **shipped**

---

## Identity & Onboarding

- **Create a new Dina** — display name, claim a `@handle.dinakernel.com`,
  set a passphrase (wraps the master seed), reveal a 24-word BIP-39 recovery
  phrase, verify it via a 3-position quiz. **shipped**
- **Restore on a new device** — enter recovery phrase + confirm the handle
  (rotation-key check). **shipped**
- **Use an existing AT Protocol identity** — onboard with an account you
  already have (app password, optional PLC token) while creating Dina's local
  encrypted state and recovery path. **shipped**
- **Unlock gate** — passphrase prompt (security mode) or auto-unlock (keychain),
  every cold start; "Forgot passphrase?" routes to the recover flow. **shipped**
- **Infrastructure overrides after onboarding** — endpoint overrides live in
  Settings → Infrastructure, not in the first-run wizard. **shipped**

## Chat — Ask / Remember / Task

The primary surface (`/`). One composer, three modes via the mode pill:

- **Ask** — ask Dina anything; she reasons across every open vault/persona
  allowed by the current privacy policy (cross-domain retrieval, not just
  keyword search). Sensitive/locked data can require approval instead of being
  exposed automatically. **shipped**
- **Remember** — save a fact/note/memory into a vault. **shipped**
- **Task** — hand a job to an autonomous agent (Agent Tasks). Visible only
  when at least one active paired agent exists, so the user is not offered a
  task path that no agent can claim. **shipped**
- **Inline cards** in the stream — approvals, daily/weekly briefings,
  Sancho-moment nudges (toward real humans), reminders due now, review drafts,
  service approvals, missing-service/missing-capability prompts, and
  service-query results. **shipped**
- **"Confirm your recovery phrase" banner** until the mnemonic is verified.
  **shipped**

## Vaults & Memory

- Multiple **personas/vaults** (general, work, health, finance… **user-
  configurable**), each a separate encrypted compartment with a privacy tier.
  **shipped**
- Create a vault (name + tier + description), browse stored memories
  (timestamps + classifier sentiment), edit description, and delete individual
  items. Whole-vault delete is not exposed in mobile yet. **partial**

## People & D2D

- **Own identity card** (handle, DID, copy buttons). **shipped**
- **Contacts** — add by handle/DID/name, see trust badges, and tap a contact
  to open 1:1 chat. From the chat header, the user can open the full identity
  modal (DID, PLC services, namespaces). There is no dedicated contact detail
  or trust-edit screen yet. **partial**
- **Relations** — people you've interacted with but not added as contacts.
  **shipped**
- **Talk / 1:1 Dina-to-Dina chat** — reached from People/contact routes, not
  from the main Chat mode pill. Runs over MsgBox with delivery status
  (sending/delivered/failed) + failed-send handling. **shipped**

## Reminders

- Grouped list — overdue / today / later / recurring. **shipped**
- Reminder actions — long-press a row to dismiss it. Fired inline reminder
  cards support **Mark done** and **Snooze 1h**. Row-level done/snooze/delete
  buttons are not exposed on the Reminders screen yet. **partial**

## Activity & Approvals

- **Activity** (bottom tab) — unified inbox with filters: Needs action / Unread
  / All / Reminders. "Needs action" gathers everything awaiting a decision.
  **shipped**
- **Approvals** (deep-link route, not a bottom tab) — approve/deny pending
  agent intents, service approvals, and locked-vault / vault-read prompts; also
  includes a completed/resolved history tab for auditability. Reached by
  tapping an approval notification or `dina://approvals/<id>`. **shipped**
- **Safe deep-link routing** — notification taps route into approvals/reminders
  predictably (logical-parent back navigation). **shipped**

## Network — Services (discovery via AppView service search)

- **Find a service** — Network → Services module routes to chat to query
  providers on the network. There is not yet a dedicated in-Network service
  marketplace/search screen. **shipped**
- **Service result cards** — CardSpec-driven ("safe provider-rendered result
  cards," re-validated as untrusted at render), with provenance (discovery →
  query → response path). `eta_query` is the richest renderer today; other
  capabilities fall back to a generic card. Provider cards are data, not
  executable UI code. Media blocks are intentionally not rendered yet; the card
  shows the media `alt` text until an image-proxy path exists. **shipped**
- **No-provider / missing-capability UX** — when Dina cannot find a matching
  service or capability, the chat stream can show an inline gap card instead of
  failing silently. **shipped**

## Network — PeerLens (trust / review discovery)

- **Self-profile** — your attestations summary. **shipped**
- **Feed + search** — subject cards, composite scores, flag warnings. **shipped**
- **Subject detail** — reviews, alternatives strip, score badge. **shipped**
- **Write a review** — kind/headline/body/sentiment; advanced wizard adds your
  experience, use-cases, confidence, alternatives, price, reviewer experience.
  **shipped**
- **Reviewer profiles**, **Outbox** (queued/failed publishes + retry),
  **Namespaces**, **co-sign inbox** (endorse/decline).
  - Reviewer profiles and Outbox are usable in mobile today. **shipped**
  - Namespaces is currently a presentational/unwired route. **partial**
  - Co-sign inbox has data-layer and row components, but no shipped mobile
    inbox route yet. **partial**
- **PeerLens preferences** — region, budget, devices, languages, dietary,
  accessibility (personalize ranking). **shipped**

## Provider Mode

The provider home is **My Services** (`/my-listings`, reached from Network →
Services → "My services" and Settings → "Service Sharing"). It holds the
node-level role + the list of all listings; each listing is edited in the
per-listing editor (**Service Settings**, `/service-settings?rkey=…`).

- **Role** — `requester` / `provider` / `both`, set on **My Services** (so a
  requester can become a provider without first creating a listing). There is
  **no explicit "off"**; "requester only" *is* provider-off. **shipped**
  - **Caveat:** changing role requires a **force-quit + reopen** to wire the
    runtime (ServicePublisher / ServiceHandler). **shipped (with restart)**
- **Multi-listing management** — **My Services** lists every listing (one DID,
  many listings keyed by rkey); per row: name, capability count · visibility, a
  per-listing **Active/Paused** toggle, tap-to-edit, delete, and "+ New
  listing". So a provider with several services can pause/edit/remove any one
  independently. **shipped**
- **Publish / edit a listing** — name + description, capabilities via the
  **Category → Capability picker** (official catalog, no typing IDs),
  per-capability response policy (**auto** vs **review**), fail-closed publish
  (blocks + explains an invalid listing). New listings get a unique rkey
  generated from the name; `self` is the default listing. **shipped**
- **Custom capabilities** — add a namespaced `com.example.foo`. But a **public**
  custom capability requires params/result schemas, and mobile has **no schema
  editor** — so a public custom capability can't be completed in-app yet.
  **partial**
- **Service status — Active / Paused** — the per-listing ON/OFF switch, a
  distinct axis from node role and from discoverability. **Active** = live
  (publish per discoverability + answer queries); **Paused** = keep the config
  but unpublish + stop answering. Togglable per row on My Services AND inside the
  editor. (Model also has `draft`; not a mobile toggle yet.) Enforced one place —
  `isListingPublishable` — shared by the publishers and Core's inbound query
  gate, so paused listings both unpublish and reject queries. **shipped**
- **Service area / location scope** — AppView/runtime can use location and
  radius for matching, but mobile does not yet expose a provider UI for
  setting a listing's service area. This matters for local services such as
  doctors, restaurants, transit, plumbers, schools, and delivery. **partial**
- **Discoverability — "Who can find this service?"** (only applies when Active)
  - **Public** — appears in network (AppView) service search. **shipped**
  - **Unlisted** — published + URI-resolvable, **excluded from search**;
    intended for direct link / QR / invite flows, but **that share UX is not
    built** — today it just means "not searchable." **partial**
  - **Private / known-only** — not published; local/direct-connection only (the
    pairing-invocation path is future work). **partial**
  - Sensitive capabilities default to the safer discoverability automatically.
    **shipped**
- **Receive + answer inbound service queries** — auto, or after review via the
  service-approval card (only when the listing is Active). **shipped**
- **Runtime health / degradation warnings** — the provider screen tells you when
  publishing / search / reachability is blocked (e.g. PDS/MsgBox not wired).
  **shipped**

## Backup / Restore / Portability

- **Encrypted `.dina` export + restore** from Admin (`shareArchive` +
  `restoreBackup`, native backup wiring). **shipped**
- **Caveat:** the archive includes your **vault / user data**, **not** private
  keys or API secrets — the master seed is deliberately excluded (restore runs
  post-onboarding, after the seed already exists on-device). **shipped**
- **Restore safety** — restore validates the archive/passphrase, blocks
  accidental overwrite on non-clean installs unless the user explicitly
  confirms, and asks the user to close/reopen after restore so persistence
  hydrates cleanly. **shipped**

## Settings / Infrastructure / Admin

- **AI provider keys + model choice** — bring-your-own (Anthropic / OpenAI /
  Gemini / OpenRouter), per-provider add/use/remove, active-provider switch,
  and model picker. **shipped**
- **Security** — passphrase, auto-lock timeout (preset chips), sign out
  (locks vault, drops in-RAM DEKs). **shipped**
- **Recovery phrase** — reveal (passphrase-gated) + confirm/verify. **shipped**
- **Agents / paired devices** — generate a pairing code for a `dina-agent`
  install, list authorized agents, and revoke agent access. The route remains
  `/paired-devices`, but the current UI is agent-specific rather than a generic
  multi-role paired-device manager. **shipped**
- **Agent action policies** — per-action risk tiers (auto vs needs-approval).
  **shipped**
- **Infrastructure** — configure **PDS URL**, **PeerLens AppView URL**, and
  **Services AppView (discovery) URL** for self-hosting / test / recovery.
  **shipped**
- **Admin** — DID + recovery-key rows, policies, diagnostics (copy-all), danger
  zone (sign out, erase vault), "re-publish PLC document" (placeholder).
  **shipped**
- **Help** — explains Vault, Reminders, Talk, Agent Tasks, Services & PeerLens,
  Privacy, each deep-linking to the feature. **shipped**

## Always-on Security & Transport

- **Silence-first** notifications — interrupt only when silence would harm;
  otherwise save for the briefing. **shipped**
- **Encrypted local vault / sovereign keys** — vault data stays encrypted,
  sensitive key material is device-bound or passphrase-wrapped, and agents
  never hold your vault keys. **shipped**
- **Agent safety layer** — agent actions pass through Dina's policy gate:
  SAFE actions can auto-approve, MODERATE actions require session approval,
  HIGH actions require approval every time, and BLOCKED actions are denied.
  **shipped**
- **MsgBox transport** — all D2D / cross-Dina traffic routes through MsgBox.
  **shipped**
- **Hamburger menu** on every tab — Vault, Reminders, Settings, Help, Sign out.
  **shipped**

---

## Known mobile UX gaps (runtime ready, UI not built)

These are the honest "partial" items, collected for quick reference:

1. **Unlisted sharing** — unlisted records are published + URI-resolvable, but
   there's no link/QR/invite UI to share or scan them.
2. **Public custom-capability schemas** — namespaced custom caps are addable, but
   public ones need a params/result schema editor that mobile doesn't expose.
3. **Known-only invocation** — known-only listings aren't published; the
   "explicitly connect / pairing" invocation path is future work.
4. **Service-area editing** — AppView/runtime can match on location/radius, but
   providers cannot set service area from mobile yet.
5. **Dedicated service marketplace/search UI** — Network currently routes
   "Find a service" into Chat. A browse/search surface inside Network is future
   UX, not shipped.
6. **Whole-vault delete** — users can delete individual vault items, but mobile
   does not expose a delete-entire-vault flow yet.
7. **Contact detail / trust editing** — contacts open chat and chat can show the
   identity modal, but there is no dedicated contact detail page for editing
   trust, linked identities, aliases, or notes.
8. **Reminder row actions** — the Reminders list supports long-press dismiss;
   row-level done/snooze/delete buttons are future UX. Fired inline reminder
   cards already support Mark done + Snooze 1h.
9. **Namespaces** — the route exists as a presentational shell, but the live
    runner that reads PLC state and submits namespace changes is not wired into
    mobile yet.
10. **Co-sign inbox** — co-sign request derivation and row components exist, but
    there is no shipped mobile route/inbox surface where the user can endorse or
    decline requests.
11. **Card media rendering** — CardSpec media blocks are currently skipped with
    alt text. Rendering remote images safely needs an image-proxy/cache policy.

Resolved gap: **multi-listing management** is now shipped. My Services supports
per-row Active/Paused, edit, delete, and new listing flows. See Provider Mode.

## Source of truth

- Screens: `apps/mobile/docs/SCREENS.md`
- Feature names: `packages/core/src/feature-names.ts`
- Icons / routes / labels: `apps/mobile/src/features.tsx`
- Catalog + listing rules: `docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md`,
  `implementation-notes.html`
