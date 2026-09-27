# One owner interface on phone and server

**Status:** Plan. Nothing built.
**Date:** 2026-09-27 (revised the same day: owner devices instead of a stored key; Brain kept off Core's origin; history of today's design added; the four decisions settled, §8; a session unlock was considered and dropped in favour of owner presence on the ungated powerful actions, §3.8).
**Replaces, once done:** the bare Core-served owner console (`/owner`, `apps/home-node-lite/core-server/src/server/owner_console.ts`) as the way to run a server Home Node, and the Brain-served web build (`/web`) as the way to see it.
**Related:** `apps/home-node-lite/web/SECURITY.md`, `docs/HOME_NODE_LITE_WEB_UI_TASKS.md`, `docs/INTERACTIVE_SERVICES_ARCHITECTURE.md` §12.5.

---

## 1. The problem

Dina runs in two places:

- **On the phone.** The app is the whole Home Node. The person using it is the owner, and every owner screen works: Approvals, Trade and tenders, Plugins and pack updates, Staff, Agents, Runs, Subscriptions.
- **On a server.** No screen of its own. Today it has two browser surfaces, and neither does the job:
  - **`/web`** (`DINA_BRAIN_WEB_UI=1`): the phone app compiled for the browser, served by **Brain**. Chat, people, reminders and PeerLens work. Owner actions do not: the web build has no owner client (`owner_run_client.web.ts` returns none), the commerce and plugin screens have no way to reach Core, and approval cards only the owner may decide say "decide elsewhere" (`OWNER_DECIDES_ON_THIS_SURFACE = false` in `inbox_client_resolver.web.ts`), because the web inbox goes through Brain and Core refuses Brain on those cards.
  - **`/owner`** (`DINA_CORE_OWNER_CONSOLE=1`): a hand-written page served by **Core**. The owner key is safe there, but the page grew one section at a time and looks it.

**Goal:** the server shows the same screens as the phone, with every owner action working, and owner authority never reaching Brain.

**Non-goals:** changing what the phone does or how it looks; adding owner powers the phone lacks; making the server reachable from the internet (the deployment advice in `SECURITY.md` stands).

---

## 2. Why it is built the way it is

The owner model was designed for the phone, where the owner is the in-app user and carries no credential. The server's owner access was added later, in steps, each reasonable on its own:

1. **2026-07-21, `7d9769f7`** (review item A-07, owner-approved). Interactive runs needed an owner on the server. The simplest safe answer was a shared secret: Core mints `DINA_OWNER_CAPABILITY` or a `0600` `owner_capability` file, and a request whose `x-dina-owner-capability` header matches (timing-safe) is treated as the owner. No pairing, no ceremony; it works for headless servers and scripts (the bed's scripts use it). Brain served the web app and passed the header through; the commit records that as an accepted residual.
2. **2026-07-21, `7b79a532`** (review item B-02). The reviewers flagged that the reusable secret passed through Brain. The fix was the tiny Core-served `/owner` page: inline only, DOM built with `textContent`, strict headers. Keeping the key-holding page tiny was deliberate.
3. **Since then.** Each new feature added its prefix to the same check in `isOwnerSurfacePath` (`apps/home-node-lite/core-server/src/server/bind_core_router.ts:194`): commerce, plugins, coordination, the task list and decision verbs, reasoning backends. The code comments say why ("the first live server run surfaced" it).

What that design got right, and this plan keeps: owner authority never reaches Brain; the custom header blocks cross-site requests; a headless server can be run by a script holding a file. What nobody designed: the owner using the full interface in a browser. The shared secret is also the one owner path outside Dina's own authentication model, where every other hop into Core is an Ed25519-signed request from a paired device.

---

## 3. The design

### 3.1 Shape

```
browser (Core origin)
  ├─ /app/*    web build, served by Core
  ├─ /v1/...   Core's own routes, signed by the browser's owner-device key
  └─ Brain calls ──cross-origin, CORS──► Brain :8200 (loopback)
```

Three decisions, each explained below:

1. **Core serves the web build** (§3.2), so the owner's credentials live on Core's origin.
2. **The browser is paired as an owner device** with a key scripts cannot read, and signs its requests (§3.3). No reusable secret is stored in the browser.
3. **Brain's answers stay off Core's origin** (§3.4). The page calls Brain cross-origin, so nothing Brain returns can ever become a page on Core's origin.

Two facts keep the work small:

- **Core already accepts owner calls on every route the owner screens use** (`isOwnerSurfacePath`). No Core route changes.
- **The commerce screens already talk to Core through one method.** `InProcessOwnerCommerceClient` (`packages/core/src/client/owner-commerce-client.ts`) sends every call through `router.handle(request)`. Give it an HTTP sender and its ~50 methods work in the browser.

### 3.2 Serving

- New opt-in flag **`DINA_CORE_WEB_UI=1`**. Core serves the same bundle Brain serves today (`npx expo export --platform web` → `apps/home-node-lite/web/dist/`) at **`/app/`**, with the SPA fallback Brain's `routes/web.ts` implements.
- Headers as strict as `/owner`'s: `content-security-policy` with `script-src 'self'` and `frame-ancestors 'none'`, `connect-src` naming only Core's origin and Brain's, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `cache-control: no-cache` on the HTML shell. Phase 1 confirms the Expo web bundle runs without `unsafe-eval`; if it cannot, record why and what it costs.
- Core stays bound to `127.0.0.1` by default (`DINA_CORE_HOST`). Serving static files is the only new thing Core does for the page.

### 3.3 The owner device

**Pairing (once per browser).**
1. The browser makes a signing key with WebCrypto, **non-extractable**: the page can ask the browser to sign with it, but no script can read it out.
2. The owner proves they are the owner once: with the existing shared secret (as `/owner` asks today) or the owner passphrase. Pairing an owner device is itself a powerful action and needs owner presence (§3.8).
3. Core registers the key as a device with a new role, **`owner`**, through the existing device registry and pairing code (`/v1/pair/*`).

**Using it.** Every owner request is signed exactly like any paired device's: `X-DID`, `X-Timestamp`, `X-Nonce`, `X-Signature` over the canonical payload, checked by the existing verifier with its ±5-minute window, nonce replay cache and per-DID rate limit.

**Where Core decides "this is the owner".** Today `bind_core_router.ts` marks a request as owner (sets `trustedInProcess`, `callerType: 'owner'` and the server-side `ownerCapability`) when the header matches, before the router runs. Because that flag skips the router's own signature check, the owner-device path runs the **same check first**:

- On an owner-surface path, if the request carries `X-DID` of a device whose role is `owner`, the adapter runs `authenticateCore` (the router's verifier) on it.
- On success it marks the request **exactly as the header path does**. The owner checks in every route (`makeOwnerGuard`, `ownerDecisionGuard`, commerce's `ownerOnlyGuard`, run and watch guards) see the same request they see today and **are not edited**. Editing each of them would risk missing one.
- `owner_setup.ts` reads the header itself (`requireOwner`); it gets the same owner-device check.
- Off owner-surface paths, an `owner`-role device is refused (fail-closed, as the `staff` role is everywhere except its routes). It is not a general device.

**Keeping.**
- The shared secret stays, for headless servers, scripts, the bed, and pairing the first owner device. It is added to, not removed.
- An owner device can be listed and revoked like any device, from the phone, the web app, or with the secret. A lost laptop is one revoke.
- Owner presence (passphrase, five minutes) still gates money actions, as on the phone; the tender screen already has the prompt.

**Browser support.** Core's device keys are Ed25519 (`did:key`). Current Chrome, Safari and Firefox support Ed25519 in WebCrypto; phase 1 confirms the browsers we support. If one does not, the fallback is P-256, which needs Core's signature check to accept a second algorithm (the AP2, UCP and A2A documents propose a P-256 branch for their own reasons).

### 3.4 Reaching Brain

- The web build's Brain calls are relative today (`fetch('/api/v1/contacts')`, `'/api/v1/workflow/tasks'`, `'/api/v1/notifications'`, `'/api/peerlens/xrpc/*'` and others in the `.web.ts` files). They get a **Brain base address** from build or runtime config and go **cross-origin**.
- Brain adds CORS allowing **only Core's origin**. Server-sent events (`/api/v1/notifications/stream`) work cross-origin with CORS.
- **Why not forward through Core:** anything Core forwards is, to the browser, Core's own content. A hijacked Brain could answer with `text/html`, and if the browser opened it as a page, its script would run on Core's origin beside the owner device. Cross-origin, Brain's answers are only ever data to the page.
- **Remote use goes through a tunnel.** A browser on another machine reaches both ports through an SSH port-forward (`-L 8100:127.0.0.1:8100 -L 8200:127.0.0.1:8200`) or a private network such as Tailscale. Both then appear as `localhost` on that machine, so the origins, the CORS rule and Brain's loopback-only binding all hold unchanged. No new code, and nothing new inside the key-holding process. Today's `/web` has the same loopback limit, so this is not a regression.
- **No forwarder in Core.** It would be built only if a need appears that a tunnel cannot meet, such as managed hosting, which will have its own front edge designed for that case. If it is ever built: listed paths only, JSON or event-stream answers only, `nosniff` and a sandboxing CSP forced on every forwarded response, cookies and headers stripped, size and time capped.
- The approval inbox stops using Brain's `/api/v1/workflow/tasks` proxy and calls Core directly (§3.5).

### 3.5 Web clients

Each owner screen gets its data through a module with a phone version and, where needed, a `.web.ts` version. The bundler picks `.web.ts` only for the browser build; the phone never includes them. The app already has eleven such files.

| Screens | Module today | Web version |
|---|---|---|
| Trade, Tender, Orders (drafts), Staff grants, Business identity, Catalog, Catalog draft, Order draft, Invites | `services/owner_commerce_client.ts` holding an `InProcessOwnerCommerceClient` | Same class, built with the signing HTTP sender (§3.6) |
| Group plan cards | `services/owner_coordination_client.ts` | Same approach; confirm in phase 3 that it is router-based |
| Runs, Subscriptions | `services/owner_run_client.ts`; web returns none | `owner_run_client.web.ts` returns a signing HTTP client for `/v1/run*`, `/v1/watch*` |
| Approvals / Activity inbox | `inbox_client_resolver.web.ts` goes through Brain | Call Core's `/v1/workflow/tasks`, `/approve`, `/cancel` as the owner device; set `OWNER_DECIDES_ON_THIS_SURFACE = true`. Orders, tenders, clerk escalations and pack decisions become decidable on the web |
| Plugins (install, consent, pack updates) | `services/plugin_install.ts` calls `@dina/core` functions directly | New `plugin_install.web.ts` with the same exports, calling `/v1/plugins/install/*`, `/v1/plugins/*`, `/v1/commerce/install/update/*` |
| Orders (buyer pack activation) | `services/commerce_install.ts` | `commerce_install.web.ts` calling `/v1/commerce/install/*` |
| Agents (coding agent, staff phone codes, device list, revoke) | `app/paired-devices.tsx` calls `@dina/core` functions directly | Move those calls into a new `services/owner_devices.ts` (phone: the same calls, moved) with `owner_devices.web.ts` calling `/v1/owner/setup/status`, `/coding-agent`, `/staff` and the delete routes. Owner devices appear in the same list |

No web version, on purpose: pairing an approval phone (the browser is not a phone), and anything needing device hardware the browser lacks (listed in phase 4).

### 3.6 The signing HTTP sender

A small class in `packages/core/src/client/`, `OwnerHttpDispatcher`, with one method: `handle(request: CoreRequest): Promise<CoreResponse>`. It serialises the request, signs it with the owner-device key through an injected signer (WebCrypto on the web), sends it to Core's own origin, and turns the answer back into a `CoreResponse`. `InProcessOwnerCommerceClient`'s constructor accepts anything with that method; a `CoreRouter` already has it, so the phone passes the router exactly as now.

### 3.7 The `/owner` console and Brain's `/web`

Both stay, unchanged, until the web build reaches parity (phase 5). Then Brain's `/web`, `DINA_BRAIN_OWNER_PROXY` (the path that lets the secret pass through Brain) and the console are all removed (§8). Before the console goes, phase 5 confirms the web build covers every console section, including runs, reasoning backends and phone pairing.


### 3.8 Owner presence on the powerful actions that lack it

**Considered and dropped: a per-session unlock** (passkey or passphrase before any owner action in a browser session). It guards one narrow case, someone using an already-unlocked computer while the page is open, which the computer's own lock screen mostly covers, and it would protect the browser only.

**What the owner-presence check (passphrase, five minutes, `owner_presence.ts`) already covers:** placing orders (`/v1/commerce/orders/from_quote`, `/orders/prepare`, `/orders/drafts/approve`, `/orders/drafts/submit`), awarding a tender (`/trade/tender/award`), granting staff authority (`/staff-grants`), invites (`/invites`), and integration settings proposals (`/integration/settings/proposal`). So without the passphrase, nobody at an unlocked computer or phone can spend money or hand out spending power.

**The gap:** powerful actions with no presence check today, on the phone and the server alike:

| Action | Where |
|---|---|
| Pair a coding agent; create a staff-phone setup code; pair an owner device (new) | `/v1/owner/setup/coding-agent`, `/v1/owner/setup/staff` (`owner_setup.ts`); the phone's Agents screen (in-process pairing) |
| Install a plugin, consent to it, update a pack | `/v1/plugins/install/*` (`plugin_install.ts`), `/v1/plugins/*` updates (`plugin_updates.ts`), `/v1/commerce/install/update/*`; the phone's Plugins screen |
| Decide a money-related card: a price below the automatic limit; payment evidence (a yes writes a khata payment note) | `/v1/workflow/tasks/:id/approve` for `negotiation_price_approval` and `payment_evidence_record` cards |

**The fix:** require owner presence on exactly these, with the same `no_user_presence` answer the other routes give, so the phone's and the web's existing presence prompt handles it. Revoking a device or uninstalling a plugin stays ungated: those reduce authority. Phase 1 lists the actions again against the code before gating, in case one is missed or has changed.

This protects the phone as well as the web, reuses code that exists, and costs a few more passphrase prompts for actions people do rarely. A passkey (Touch ID and the like) as a quicker way to prove presence than typing the passphrase is a later comfort improvement, not a security need.

---

## 4. What changes in the phone code

| File | Change | Phone behaviour |
|---|---|---|
| `packages/core/src/client/owner-commerce-client.ts` | Constructor accepts `{ handle(req) }` instead of `CoreRouter` only | Unchanged; still given the router |
| `apps/mobile/app/paired-devices.tsx` | Imports move to `services/owner_devices.ts`; nothing visible changes | Unchanged; same calls, moved |
| `apps/mobile/src/services/owner_devices.ts` | New; holds the calls moved out of the screen | Unchanged |
| All `*.web.ts` files | New or changed | Not in the phone build |
| Every other screen | None | Unchanged |

Proof: the full mobile suite (3,485 tests) passes unchanged, plus a Maestro smoke run on the existing simulator through Approvals, Trade → tender, Plugins, Staff and Agents.

---

## 5. What changes in Core and Brain

| Where | Change |
|---|---|
| `core-server` | Serve `/app/*` behind `DINA_CORE_WEB_UI`; owner-device check in `bind_core_router.ts` and `owner_setup.ts` (§3.3) |
| Device registry and pairing | Accept role `owner`; pairing it requires the secret or the passphrase, and owner presence |
| Owner presence | Added to the ungated powerful actions (§3.8): device and agent pairing, plugin install, consent and pack updates, money-related card decisions |
| `auth/caller_type.ts`, `auth/authz.ts` | Map role `owner` to refused everywhere except the owner-surface marking path |
| `brain-server` | CORS for Core's origin only; nothing else |
| `SECURITY.md` | New model, the retired proxy, the remaining trade-off (§6) |

---

## 6. Security

| Compared with today | Effect |
|---|---|
| Owner authority reaches Brain | Never, as today. Brain receives no owner signature, secret or session. |
| Credential theft by an injected script | **Better than a stored secret.** The key cannot be read out; an injected script cannot take a credential away and use it later. |
| Someone at an unlocked computer or phone | **Better than today**: spending, staff authority, pairing, plugin installs and money-related card decisions all need the owner passphrase (§3.8). Lesser actions are covered by the device's own lock screen. |
| Acting as owner through an injected script while the page is open | **The one real loss** against the tiny console: the page next to owner authority is now the whole app. Answers: strict CSP (no scripts but the app's own), React renders text not markup, card links through `safe_url.ts`, cards through `SafeCardRenderer`, a phase-5 audit for `dangerouslySetInnerHTML` and raw HTML, no third-party scripts, and money actions still behind the owner passphrase. The phone does not have this risk: native views run no HTML. |
| Brain content turning into a Core-origin page | Prevented by design: Brain is only reached cross-origin (§3.4). |
| Cross-site requests | Signed requests cannot be forged by another site: it holds no key. |
| Replay | Existing nonce cache and time window. |
| Lost laptop | Revoke the owner device. |
| Headless servers and scripts | Unchanged: the shared secret still works. |
| Brain's unauthenticated API | Unchanged: still loopback-only, now reachable cross-origin from Core's origin only. |
| Remote browsers | Through a tunnel; nothing new is exposed. |
| Two owner web interfaces to keep secure | Ended: the console is removed after parity. |

---

## 7. Phases

Sizes are rough, for one engineer who knows the codebase, excluding review rounds.

| Phase | What | Size |
|---|---|---|
| 1. Serve and pair | Core serves `/app/` behind `DINA_CORE_WEB_UI`; headers and CSP check; `owner` device role, pairing with the secret or passphrase; owner-device check at the entry point and in `owner_setup.ts`; WebCrypto key and signer; browser support check; tests that an owner device is refused off owner paths and that route guards are untouched | 4–5 days |
| 1b. Presence on powerful actions | §3.8 for phone and web: re-list the actions against the code, gate them, contract tests per route, phone prompt checked on the existing simulator | 1–2 days |
| 2. Brain cross-origin, approvals, runs, watches | Brain base address in the `.web.ts` files; CORS on Brain; web inbox on Core with owner decisions; web run and watch client | 3–4 days |
| 3. Commerce screens | `OwnerHttpDispatcher`; constructor change; web commerce and coordination clients (nine screens) | 3–4 days |
| 4. Plugins, buyer activation, Agents | `plugin_install.web.ts`, `commerce_install.web.ts`, the `owner_devices` split and its web version | 4–5 days |
| 5. Parity and hardening | Bundle audit, final CSP, `SECURITY.md` (including the tunnel recipe); a Chrome run on the bed through every owner screen (the bed is the primary test surface per `dina_details.md`); Maestro smoke on the existing simulator; confirm console parity, then remove Brain's `/web`, the owner proxy and the console | 3–4 days |

About three and a half weeks in all.

---

## 8. Decisions (settled 2026-09-27)

1. **Path: `/app/` on Core.** Brain's `/web` is on Brain's port, another origin, so the two never clash; both run during the move, and `/web` is retired at parity.
2. **Console: removed after parity.** Two owner interfaces are two things to secure and keep in step. Headless servers and scripts use the secret against Core's routes, not the console. The recovery path if the web build will not load is the secret plus the command line; a rarely used fallback page tends to be broken the day it is needed. Parity is checked section by section first (§3.7).
3. **No session unlock; owner presence on the powerful actions that lack it** (pairing, plugin install and consent, pack updates, money-related card decisions), for phone and web alike. Passkeys come later as a quicker way to prove presence. (§3.8)
4. **Remote browsers: through an SSH or Tailscale tunnel; no forwarder in Core** unless a need appears that a tunnel cannot meet. (§3.4)
