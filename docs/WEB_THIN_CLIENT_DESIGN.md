# Design: Web SPA as a Thin Client of the Home Node Lite server

**Status:** Approved direction; revised after 2nd review (2026-06-17, rev 3)
**Author:** Claude (with Rajmohan)
**Scope:** `apps/mobile` (web target only) + `apps/home-node-lite/brain-server`
**Non-scope:** mobile native (iOS/Android) — see [§9 Mobile impact](#9-mobile-impact-none)

> **Rev 3 changes** (2nd review): PeerLens publish corrected — the durable job
> *repository* exists in core, but the worker/drainer/PDS-publish/error-classifier
> are still mobile-side (`apps/mobile/src/peerlens/`), so web needs a real
> server-side submit route + worker + PDS wiring + status projection (§5, D6, §7).
> Contacts gap noted — `CoreClient` lacks general `listContacts/addContact/
> deleteContact`; add them or shim (§5). Non-goal vs access-gate contradiction
> resolved — single-user session auth is **in scope** (§3). Effort re-estimated
> **4–7 days** (§7). DoD secret-list narrowed (DID/handle cacheable, §12). Work-
> breakdown renumbered.
>
> **Rev 2 changes** (review feedback folded in): browser client renamed
> `BrowserCoreProxyClient` (it must NOT be confused with, or reuse, the signed
> Brain→Core `HttpCoreTransport` — the browser holds no signing key, §4.1); access
> gate is now **required** for any non-dev web build, not optional (§8, D4);
> PeerLens **write/publish** corrected — superseded by rev 3 below (it is a
> server-side build, not a proxy; see §5, D6); AI-provider-key handling now
> has an explicit server-side design (§4.4, D7); `expo start --web` declared
> non-standalone (§4.5, D2); updating `apps/home-node-lite/web/SECURITY.md` added
> to Definition of Done (§12).

---

## 1. Summary

Today the **web build** of the Dina app boots a *full Home Node inside the
browser* — the same in-process Core router + Brain that mobile runs — but the
browser has no native SQLite engine, so its durable stores fall back to memory.
That produces the visible **"Dina is running in limited mode … No SQLite adapter
supplied — workflow tasks + service config are not durable across restart"**
banner, and means a browser tab is a half-real, partly-ephemeral node.

This document proposes converting the web build into a **thin client** of a
durable **Home Node Lite server** (the `dina-nodes/` Core+Brain instances). The
browser stops running its own node and instead drives the server node over HTTP,
exactly the way `chat` and `reminders` already do today. The server holds the
vault, the keys, and the `did:plc`; the browser is a pure UI.

**Result:** the "limited mode" banner disappears, every tab faithfully reflects a
durable server Dina (with real `did:plc`, MsgBox, SQLCipher vault), and the
`dina-nodes/` multi-Dina test bed becomes a true cross-Dina rig — without
touching the mobile app.

---

## 2. Background — how it works today

### 2.1 Two build targets, one codebase

`apps/mobile` is an Expo app that builds for **native** (iOS/Android) and **web**.
The Brain + Core are shared `@dina/*` TypeScript packages that can run in-process
(one JS VM) on every target.

### 2.2 The boot path is currently identical on web and native

`bootAppNode` (`apps/mobile/src/services/boot_service.ts:308`) composes a full
in-process node on **both** targets:

- `const router = createCoreRouter(); const coreClient = new InProcessTransport(router)`
  (`boot_service.ts:331-357`) — the whole Core request chain, dispatched in-VM.
- The Brain subsystems (workflow service, staging drain, service handler, agentic
  `/ask`) are wired against that `coreClient` via `createNode()`.
- Persistence repos are chosen by whether a SQLite adapter was supplied
  (`boot_service.ts:364-376`):
  ```ts
  if (inputs.databaseAdapter !== undefined) {
    workflowRepository       = new SQLiteWorkflowRepository(inputs.databaseAdapter);
    serviceConfigRepository  = new SQLiteServiceConfigRepository(inputs.databaseAdapter);
    reviewPublishRepository  = new SQLiteReviewPublishRepository(inputs.databaseAdapter);
  } else {
    workflowRepository       = new InMemoryWorkflowRepository();
    serviceConfigRepository  = new InMemoryServiceConfigRepository();
    reviewPublishRepository  = new InMemoryReviewPublishRepository();
    addDegradation('persistence.in_memory', 'No SQLite adapter supplied …');
  }
  ```

### 2.3 Why web hits the in-memory branch

`databaseAdapter` comes from `getIdentityAdapter()`
(`boot_capabilities.ts:411`), which is only set after `initializePersistence()`
opens op-sqlite (`apps/mobile/src/storage/init.ts`). **op-sqlite is a native
module** (so is `better-sqlite3`); the browser has neither. So on web
`getIdentityAdapter()` returns `undefined` → the in-memory branch → the banner.

### 2.4 Two domains already ARE thin-client on web

The `.web.ts` **Metro platform-extension** mechanism resolves `foo.web.ts` for
the web bundle and `foo.ts` for native — native bundles never even include the
`.web.ts` code. Four files already use it:

| File | Native | Web |
|---|---|---|
| `hooks/chat_transport.web.ts` | in-process orchestrator | `POST /api/v1/chat` + SSE `/api/v1/chat/stream` |
| `hooks/reminder_transport.web.ts` | in-process reminder store | `/api/v1/reminders/*` + SSE |
| `services/keychain.web.ts` | `react-native-keychain` | IndexedDB + WebCrypto AES-GCM |
| `services/install_marker.web.ts` | sentinel file | no-op |

So on web **today** chat + reminders go to the durable server, while **everything
else** (vault, contacts, personas, service config, workflow, devices, …) runs
against the in-browser in-memory node. The result is a hybrid; this design
finishes the job.

### 2.5 The transport seam already exists

Both transports implement one interface, `CoreClient`
(`packages/core/src/client/core-client.ts`, ~69 async methods: vault, personas,
service config, workflow, contacts, people, reminders, msg, policy, …):

- **native:** `InProcessTransport(router)` — dispatch in-VM.
- **brain→core (server):** an HTTP transport with Ed25519 canonical signing
  already exists and is how the brain-server talks to the core-server
  (`apps/home-node-lite/brain-server/src/core_client.ts`).

That second one is the proof that an HTTP `CoreClient` works; this design reuses
the same idea for the **browser→server** hop.

---

## 3. Goals / Non-goals

**Goals**
- Web tab is a faithful, durable view of a server Home Node Lite node.
- "limited mode / no SQLite" banner gone on web (because the in-browser
  in-memory node is no longer booted).
- `dina-nodes/` multi-Dina bed works as real cross-Dina testing in browser tabs.
- **Zero change to mobile native behavior or risk.**

**Non-goals**
- Durable vault *in the browser* (that's the rejected wasm-SQLite alternative, §10).
- Multi-user / **public remote access over the internet** (out of scope).
  **In scope:** single-user browser-session auth on the local node (§8) — the
  access gate is part of this design, not a follow-up.
- Changing the wire/crypto model. The server keeps doing all crypto.

---

## 4. Proposed architecture

```
┌──────────────────────────┐        same-origin HTTP/SSE        ┌──────────────────────────┐         signed HTTP        ┌───────────────────────┐
│  Browser tab (SPA UI)    │  ───────────────────────────────▶ │  brain-server :8401      │ ─────────────────────────▶ │  core-server :8301     │
│  apps/mobile (web build) │   /api/v1/chat, /reminders,        │  (serves /web bundle +   │   Ed25519 canonical sign   │  vault (SQLCipher),     │
│  NO node, NO crypto,     │   /vault, /contacts, /personas,    │   proxies CoreClient)    │   (already exists:         │  did:plc, MsgBox,       │
│  NO SQLite               │   /service-config, /workflow, …    │                          │    core_client.ts)         │  workflow/service SQLite│
└──────────────────────────┘                                    └──────────────────────────┘                            └───────────────────────┘
```

Three principles:

1. **The browser runs no node.** On web we do **not** call `createCoreRouter()`
   and do **not** instantiate the in-memory repos. There is nothing to be
   "in-memory" → no degradation → no banner.
2. **The server does all crypto.** The core-server already holds the master seed
   (keyfile / wrapped seed), opens the SQLCipher vault, and owns the `did:plc`.
   The browser never sees a seed, a DEK, or a passphrase-derived key. This is why
   the "browser can't derive the vault DEK" concern is *moot* — the browser never
   needs to; it asks the server to read/write and the server decrypts.
3. **The browser talks to the brain-server only (same origin).** The SPA is
   served by the brain-server, so `/api/v1/*` calls are same-origin (no CORS, no
   browser-held keys). The brain-server proxies to the core-server with its
   existing Ed25519 service key. The browser never calls the core-server (:8301)
   directly.

### 4.1 Transport: one web `CoreClient`, not seven hand-written transports

Because every Brain subsystem and SPA hook already consumes the
transport-agnostic `CoreClient`, the cleanest conversion is **one** web-only
client, `BrowserCoreProxyClient`:

```ts
// boot_service.ts (conceptual, web-gated)
const coreClient = isWeb
  ? new BrowserCoreProxyClient({ baseUrl: '/api/v1' })  // same-origin → brain-server proxy
  : new InProcessTransport(createCoreRouter());          // native, unchanged
```

`BrowserCoreProxyClient` maps each `CoreClient` method to a brain-server proxy
route. The existing `chat_transport.web.ts` / `reminder_transport.web.ts` stay
as-is (or fold into this client later — not required for MVP).

> ⚠️ **Naming — do NOT call this `HttpCoreClient`/`HttpCoreTransport`.** That name
> already belongs to the **signed Brain→Core** transport
> (`apps/home-node-lite/brain-server/src/core_client.ts`), which holds an Ed25519
> service key and signs canonical requests. The **browser must never hold a
> signing key.** `BrowserCoreProxyClient` is unsigned, same-origin, and talks
> **only** to the brain-server's `/api/v1/*` proxy; the brain-server is the one
> that then uses the real signed `HttpCoreTransport` to reach the core-server.
> Two distinct hops, two distinct clients — keep the names distinct so nobody
> wires a key into the browser by reaching for the familiar class.

> **Design decision needed (D1):** *generic passthrough* vs *per-domain routes*
> on the brain-server. Per-domain routes (one file per domain, like
> `routes/reminders.ts`) give request validation + contract tests and match the
> existing pattern; a single generic `POST /api/v1/core {method,args}` is less
> code but unvalidated. **Recommendation: per-domain routes** for the domains the
> SPA actually uses (§6), generic passthrough rejected for the same reasons we
> validate everything else.

### 4.2 Identity + unlock in thin-client mode

The server node already has an unlocked vault (keyfile mode auto-unlocks on boot)
and an already-provisioned `did:plc`. So on web:

- **Skip onboarding.** The `UnlockGate` state machine
  (`unlock_gate.tsx:60-164`) keys off `loadWrappedSeed()`. In thin-client mode
  there is no local wrapped seed; instead the web boot fetches the server's
  identity and jumps straight to the app.
- **New endpoint:** `GET /api/v1/identity → { did, handle }` (the core-server
  has the did:plc but exposes **no** identity/whoami route today —
  `packages/core/src/server/routes/paths.ts` declares `DID_*` paths that are not
  registered). Add a small read-only proxy. The DID is public (it's in the PLC
  directory), so loopback-unauthenticated is acceptable for the test bed.
- **No passphrase prompt** in thin-client mode (the server is already unlocked).
  Any future access gate is an *authorization* concern (§8), not a crypto unlock.

> **Design decision needed (D2):** does the web build *always* run thin-client,
> or is it a flag? **Recommendation:** gate on `Platform.OS === 'web'` (web is
> always thin-client) so there's a single, predictable web behavior and the
> banner can never reappear. A build-time env flag (`EXPO_PUBLIC_DINA_WEB_MODE`)
> is the escape hatch if we ever want the old embedded-web mode back.

### 4.3 What stays in the browser

UI state only: navigation, the SSE-mirrored chat/reminder stores
(`applyRemoteMessage`), form drafts, theme. `keychain.web.ts` (IndexedDB) is
retained only for any genuinely browser-local prefs (and, if D4's session token
uses a cookie, nothing here); the vault and identity move server-side.

### 4.4 AI provider keys (BYOK + starter credits) — server-side

This needs an explicit design (it was hand-waved in rev 1). In thin-client mode
the LLM runs **server-side** (the brain-server already calls the model; the web
chat is proxied), so the provider key must live on the server, not the browser.

- **Storage:** the provider key (OpenRouter / Gemini) is stored **on the server**,
  in Core's encrypted keystore (the same place the node keeps service secrets) —
  never in IndexedDB / localStorage / SecureStore on the browser.
- **Entry:** the BYOK screen `POST`s the key to a brain-server route
  (e.g. `POST /api/v1/providers/key`); the response is a redacted status
  (`{ provider, last4, active }`), never the key back. The browser holds at most
  the redacted status for display.
- **Removal:** `DELETE /api/v1/providers/key` clears it server-side; the UI reads
  state from the server, so removal is authoritative.
- **Starter credits:** the OpenRouter starter-credits grant is **server-side
  only** (it already is — credits/grants live in the node). The browser shows
  remaining credits via a status read; it never holds the credit key.
- **Consequence:** because keys live server-side, a stolen browser session can
  *use* the node's model budget but cannot *exfiltrate the key* — another reason
  D4's access gate matters.

> **Decision (D7):** confirm the brain-server's current key source (env
> `DINA_GEMINI_API_KEY` vs a stored BYOK key) and define the one storage location
> so web BYOK and the existing mobile BYOK converge rather than fork.

### 4.5 The web build is NOT standalone

Because web is always thin-client (D2), `expo start --web` on its own is **not a
running Dina** — it is a UI shell that requires a reachable Home Node Lite
brain-server.

- Document prominently (README + the unsupported screen): *"The web app is a
  client for your Home Node Lite. Start it with `dina-nodes/start.sh` (or a
  brain-server) first."*
- If `GET /api/v1/identity` is unavailable at boot (no server / wrong origin), the
  SPA must render a clear **"No Home Node reachable — start your server"** screen,
  not a broken onboarding flow or a spinner. This is part of D2's done criteria.

---

## 5. Coverage matrix — what must convert

From the consumer inventory. "HTTP" = already thin-client on web; "in-process" =
still runs the in-browser node and must convert.

| Domain | SPA file(s) | Web today | Target (brain-server proxy → CoreClient) |
|---|---|---|---|
| Chat / Ask | `hooks/useChatThread.ts`, `chat_transport.web.ts` | **HTTP** ✓ | `/api/v1/chat`, `/api/v1/ask` (exists) |
| Reminders | `reminders.tsx`, `reminder_transport.web.ts` | **HTTP** ✓ | `/api/v1/reminders/*` (exists) |
| PeerLens **read**/search | peerlens screens | **HTTP** ✓ (AppView xRPC) | test-appview (exists) |
| PeerLens **write**/publish/outbox | peerlens write/compose | in-process (mobile PDS/outbox) | **build server-side: submit route + worker/drainer + PDS publisher + status projection** (D6) |
| Vault items | `hooks/useVaultItems.ts`, `useVaultBrowser.ts` | in-process | `vaultList/query/get/delete` |
| Contacts | `hooks/useContacts.ts:13`, `app/people.tsx:31`, `app/add-contact.tsx` | in-process (direct local calls) | needs new `contactList/contactAdd/contactDelete` (gap, see below) |
| People graph | `hooks/usePeople*` | in-process | `peopleList/findByName/resolveByDid` |
| Personas | `hooks/usePersonas.ts` | in-process | `personasList/personaUnlock` |
| Service config / listings | `hooks/useServiceConfigForm.ts`, `my-listings.tsx` | in-process | `serviceConfig/listServiceConfigs/put/delete` |
| Approvals / workflow | `hooks/useServiceInbox.ts`, `approvals.tsx` | in-process | `listWorkflowTasks/get/approve/cancel` |
| Notifications | `app/notifications.tsx` | in-process | notifications list/markRead |
| Devices / pairing | `app/paired-devices.tsx` | in-process | devices list/pair/revoke |
| D2D quarantine | `hooks/useD2DMessages.ts` | in-process | quarantine list/accept/block |
| Security (passphrase) | `hooks/useSecurity.ts`, `change_passphrase.ts` | in-process | n/a in thin-client (server owns seed)* |
| Identity / export | `hooks/useShareExport.ts` | in-process | **new** `GET /api/v1/identity`; export |

\* *Change-passphrase in thin-client mode re-wraps the server's seed and is a
server operation; this needs a small server endpoint or is deferred (the local
test bed auto-unlocks). Flag as an open item — see D3.*

**Brain-server proxy gaps to add** (per the server-surface audit): vault,
contacts, personas, service-config, workflow/approvals, devices, identity,
**review-publish**, **provider-keys**. Most are a thin `routes/<domain>.ts` that
calls the brain-server's existing `CoreClient` — the same shape as
`routes/reminders.ts`. **Two are NOT thin** — contacts and review-publish below.

**Contacts — CoreClient gap (corrected).** `CoreClient` today has only
`contactLookup`, `updateContact`, `findContactsByPreference` — **not** general
`listContacts` / `addContact` / `deleteContact`. The SPA uses direct local calls
(`apps/mobile/src/hooks/useContacts.ts:13`, `apps/mobile/app/people.tsx:31`). So
the work is either (a) add `contactList` / `contactAdd` / `contactDelete` to the
`CoreClient` interface + the in-process router + the brain-server proxy (then web
goes through the proxy like everything else), or (b) leave `CoreClient` alone and
write `.web.ts` hook shims for contacts that hit a new brain-server route directly.
**Recommend (a)** — it keeps native + web on one surface and is the cleaner fix.

**PeerLens write — corrected (D6), and it's bigger than rev-1/rev-2 implied.**
Read/search go through AppView and are fine. **Publish is NOT a simple proxy.**
Core has the durable job *domain + repository* (`packages/core/src/review/
publish_job.ts` + `publish_job_repository.ts`, SQLite) — but the actual
**worker/drainer, the PDS publish path, the error classifier, and the drain
loop currently live mobile-side** under `apps/mobile/src/peerlens/`. So web
publish requires real server work: a server-side **submit route** + **worker/
drainer** + **PDS publisher wiring** + **status projection** the SPA can read.
This is the largest single item; if it slips, the deferral fallback is to **hide
the PeerLens write CTA on web** behind a flag while read/search stay live.

---

## 6. Work breakdown

### Server (`apps/home-node-lite/brain-server`)
1. `routes/identity.ts` — `GET /api/v1/identity → {did, handle}` (read from the
   running node; core-server gains a matching read if needed).
2. `routes/core_proxy/*.ts` — per-domain proxy routes for the gap domains in §5,
   each forwarding to `CoreClient` (pattern: `routes/reminders.ts`). Add request
   validation + a contract test per route (repo norm).
3. **PeerLens publish (server-side build, NOT a proxy):** build the server-side
   **submit route + worker/drainer + PDS publisher + status projection**. Core has
   the durable job repository (`packages/core/src/review/publish_job.ts`); the
   worker/PDS/drain logic currently lives mobile-side (`apps/mobile/src/peerlens/`)
   and must move server-side. Do NOT reimplement the outbox in the browser, and do
   NOT assume a simple enqueue route suffices.
4. `routes/providers.ts` — `POST/DELETE /api/v1/providers/key` + `GET` redacted
   status (§4.4). Key stored server-side; never returned to the browser.
5. **Access gate (required for any non-dev build, D4):** issue a server-generated
   session token on first load (SameSite=Strict cookie or bearer), require it on
   all `/api/v1/*` calls, add CSRF protection on state-changing routes, bind
   `127.0.0.1` by default. Dev/test may run it unauthenticated (gated by an
   explicit `DINA_BRAIN_DEV_OPEN=1`), but the shipped default is gated.
6. Confirm SSE patterns reused where the SPA expects live updates (workflow/
   approval cards already flow over the chat SSE; verify no extra stream needed).

### Client (`apps/mobile`, web-gated)
7. `services/browser_core_proxy_client.web.ts` — `BrowserCoreProxyClient`
   implementing `CoreClient` against the brain-server `/api/v1/*` proxy
   (unsigned, same-origin, sends the D4 session token).
8. Web-gate `boot_service.ts` / `boot_capabilities.ts`: on web, inject
   `BrowserCoreProxyClient`, **skip** `createCoreRouter()` + the in-memory repos +
   the persistence degradation.
9. Web-gate the `UnlockGate`: in thin-client mode fetch `/api/v1/identity` and
   render the app directly (no onboarding / no passphrase); if it's unreachable,
   show the "No Home Node reachable" screen (§4.5), not onboarding.
10. Hide the change-passphrase row on web (D3) — server owns the seed.
11. Per-domain `.web.ts` only where a hook bypasses `CoreClient` and talks to the
    in-process node directly (most go through `CoreClient` and need no per-hook
    change — that's the payoff of the single-transport approach).

### Tests
12. brain-server: contract tests for each new proxy route.
13. `apps/mobile`: web-target boot test asserting (a) no in-memory repos created,
    (b) no `persistence.in_memory` degradation, (c) `coreClient` is the
    `BrowserCoreProxyClient`.
14. Live: bring up two `dina-nodes` (alonso, sancho), drive Talk/Services across
    two browser tabs, confirm durability across a tab refresh.

---

## 7. Effort estimate

**~4–7 focused days** (revised up from rev-1's 2–4 once the access gate, provider
keys, the PeerLens publish worker, the Contacts `CoreClient` gap, and docs/tests
were counted). The lower end assumes aggressively deferring **PeerLens write** and
the **provider-key UI**; the upper end builds them. Phasing so value lands early:

| Phase | Scope | Rough |
|---|---|---|
| 1 | `BrowserCoreProxyClient` + web boot gating + `/api/v1/identity` + "no Home Node" screen + vault/personas proxies | ~1.5 d |
| 2 | Contacts (`contactList/Add/Delete` on CoreClient + router + proxy) + service-config + workflow/approvals proxies | ~1–1.5 d |
| 3 | Access gate (session token + CSRF + bind) + provider-key routes/UI (§4.4) | ~1–1.5 d |
| 4 | PeerLens publish: server submit route + worker/drainer + PDS wiring + status projection (or defer behind flag) | ~1–2 d |
| 5 | notifications, D2D quarantine, devices, export + tests (contract + web-boot) + docs (incl. `web/SECURITY.md`) + live `dina-nodes` cross-Dina pass | ~1 d |

---

## 8. Security model

- **The browser holds no secrets:** no master seed, no DEK, no signing key, no
  passphrase-derived material, no provider key. All crypto stays on the server.
  This is the central security win over the in-browser-node status quo (which keeps
  keys in browser RAM).
- **Access gate — REQUIRED for any non-dev build (revised, D4).** Unauthenticated
  loopback is acceptable ONLY for local dev/test (behind an explicit
  `DINA_BRAIN_DEV_OPEN=1`). The shipped default MUST gate `/api/v1/*` because
  otherwise **any local process on the machine can drive the node API** (read the
  vault, approve agent actions, etc.) — same-origin and 127.0.0.1 binding do not
  stop a local process. The gate:
  - a **server-generated browser session token** minted on first load;
  - carried as a **SameSite=Strict cookie or bearer token** on every `/api/v1/*` call;
  - **CSRF protection** on all state-changing (POST/PUT/DELETE) routes;
  - **bind `127.0.0.1`** by default; any non-loopback exposure additionally needs
    TLS + a CORS allow-list + (for multi-user) device-pairing.
- **Rejected:** browser → core-server **direct** with a browser-held service key.
  That puts an Ed25519 signing key in the browser and forces CORS. The
  same-origin brain-server proxy avoids both; the browser's session token is an
  *authorization* gate, never a signing key.
- **Update the existing web security doc.** `apps/home-node-lite/web/SECURITY.md`
  already *claims* "Core vault data — not stored in the browser at all … thin UI
  shell over the same `/api/v1/*` endpoints." That is **aspirational today** (most
  domains still run the in-browser node). Making it true is exactly this design;
  the doc must be updated to match reality + describe the D4 gate (§12).

---

## 9. Mobile impact: NONE

This is the load-bearing guarantee.

- All client changes are **web-gated**: either new `*.web.ts` files (which Metro
  compiles **only** into the web bundle) or `Platform.OS === 'web'` branches. The
  native bundle does not include `.web.ts` code and does not take the web branch.
- The native path keeps `InProcessTransport(createCoreRouter())`, op-sqlite, and
  the full in-process node — byte-for-byte unchanged.
- Server-side changes live in `apps/home-node-lite/brain-server`, which mobile
  does not ship.
- Regression proof: the existing mobile jest suite + a Maestro smoke run must stay
  green; the new web-boot test asserts the web branch is taken only on web.

The precedent is already in production: four `.web.ts` files ship today without
affecting native.

---

## 10. Alternatives considered

**A. wasm SQLite in the browser** (sql.js / wa-sqlite over IndexedDB/OPFS).
Supply a `databaseAdapter` on web so the in-browser node becomes durable; banner
disappears, everything persists in the browser. *Rejected as the primary path:*
each tab becomes its **own** node (its own identity), which makes the durable
`dina-nodes` servers redundant and pushes `did:plc` provisioning + MsgBox WS into
the browser (unproven, and duplicates crypto/keys in browser RAM). It does not
serve the "test scenarios *between the server Dinas*" goal. Could be a future
"offline web Dina" feature, but it's a different product.

**B. Per-domain `.web.ts` transports for all ~13 domains** (instead of one
`BrowserCoreProxyClient`). More files, more surface, but maximally explicit. Rejected in
favor of the single transport because every consumer already speaks `CoreClient`;
one HTTP implementation covers all methods at once. (Chat/reminders keep their
bespoke `.web.ts` because they add SSE streaming on top.)

**C. Generic brain-server passthrough** (`POST /api/v1/core {method,args}`).
Least server code, but unvalidated and untestable per-route. Rejected (D1).

---

## 11. Decisions (resolved in review, 2026-06-17)

- **D1 — RESOLVED: per-domain proxy routes.** Validated + contract-tested, like
  `routes/reminders.ts`. Generic `{method,args}` passthrough rejected.
- **D2 — RESOLVED: web is always thin-client.** Gate on `Platform.OS === 'web'`.
  Consequence: `expo start --web` is not standalone (§4.5); when
  `GET /api/v1/identity` is unavailable the SPA shows a "No Home Node reachable —
  start your server" screen, never a broken onboarding/spinner.
- **D3 — RESOLVED: hide change-passphrase on web initially.** Do not build a
  server seed-re-wrap endpoint now (server auto-unlocks in keyfile mode).
- **D4 — RESOLVED: access gate required before any non-dev build.** Not left
  unauthenticated for a shipped web UI. Spec in §8 (session token + SameSite/
  bearer + CSRF + 127.0.0.1 bind; `DINA_BRAIN_DEV_OPEN=1` is the only unauth path).
- **D5 — RESOLVED: multi-tab to one node is allowed,** but the implementation must
  test two failure modes: (a) write conflicts when two tabs drive one node, and
  (b) SSE duplication (same event mirrored into two tabs). Add tests; don't assume.
- **D6 — RESOLVED (new): PeerLens write becomes server-side (a build, not a
  proxy).** Read/search stay on AppView. The durable job *repository* exists in
  core (`packages/core/src/review/publish_job.ts`), but the worker/drainer, PDS
  publish path, and error classifier are still mobile-side
  (`apps/mobile/src/peerlens/`) — so web needs a server-side **submit route +
  worker/drainer + PDS publisher wiring + status projection** (largest single
  item, §7 phase 4). Do not reimplement the outbox in the browser. Fallback if it
  slips: hide the PeerLens write CTA on web behind a flag.
- **D7 — OPEN (new): provider-key storage convergence.** Confirm where the
  brain-server gets its model key today (`DINA_GEMINI_API_KEY` env vs a stored
  BYOK key) and define ONE server-side storage location so web BYOK + mobile BYOK
  don't fork (§4.4). The only decision still genuinely open.

---

## 12. Definition of done

1. `http://127.0.0.1:84xx/web/` shows **no** "limited mode" banner.
2. A `/remember` in the web tab persists across a **tab refresh** (served from the
   server's SQLCipher vault, verified in `dina-nodes/<node>/vault/*.sqlite`).
3. Two tabs (alonso, sancho) complete a **Talk** round trip and a **Services**
   query, each reflecting its server node's `did:plc`.
4. Mobile jest suite + Maestro smoke green; new web-boot test green.
5. The web bundle no longer instantiates `createCoreRouter()` or the in-memory
   repos (asserted in test).
6. **Access gate enforced (D4):** a request to `/api/v1/*` without a valid session
   token returns 401 in the default (non-dev) build; CSRF rejected on a
   state-changing call without the token.
7. **No browser secret material (D7/§4.4):** no seed, DEK, signing key, provider
   key, passphrase, or session-secret in browser storage (asserted). The DID /
   handle MAY be cached as public identity metadata; BYOK status reads from the
   server.
8. **PeerLens publish (D6):** a review published from the web tab lands in the
   server publish-job machine (not an in-browser outbox); verified server-side.
9. **No-Home-Node screen (D2):** with the brain-server stopped, the web tab shows
   the "start your server" screen, not onboarding or a spinner.
10. **Docs updated:** `apps/home-node-lite/web/SECURITY.md` reflects the now-true
    thin-client model + the D4 gate; `docs/HOME_NODE_LITE_WEB_UI_TASKS.md` and the
    `dina-nodes/README.md` note the server-required requirement.
