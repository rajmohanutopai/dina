# Web Thin Client — Test Plan

Covers the thin-client work on `web-thin-client-hold` (see
`implementation-notes.html` for the per-task log). Maps every Definition-of-Done
item in `docs/WEB_THIN_CLIENT_DESIGN.md` §12 to its verification — **automated**
(jest, runnable now) or **live/manual** (needs running `dina-nodes` servers +
browser tabs, per `dina_details.md`). Functionality reference: `dina_details.md`.

> **Test-runner discipline:** run jest **one package at a time, `--runInBand`,
> foreground** (parallel full suites have OOM'd the machine). Never launch
> background/parallel full jest runs.

---

## A. Automated coverage (jest) — runnable now

| DoD / area | What it asserts | Suite |
|---|---|---|
| Transport baseline | `BrowserCoreProxyClient` implements the full `CoreClient` | `packages/core …/client/browser_core_proxy_client.test.ts` |
| **DoD #5** — no in-process core on web | `bootWebThinNode().coreClient instanceof BrowserCoreProxyClient`; `degradations===[]`; no `persistence.in_memory` | `apps/mobile …/services/web_thin_node.test.ts` |
| Web boot wires the app-layer singletons (R1) | `bootWebThinNode` installs `setInboxCoreClient`+`setServiceConfigCoreClient` (My Services + approval inbox route through the proxy); `dispose()` clears them | `apps/mobile …/services/web_thin_node.test.ts` |
| Inbox deny→notify on web (R5) | `BrowserCoreProxyClient.sendServiceRespond` → `POST /api/v1/service/respond` → `CoreClient.sendServiceRespond` (forward + 400 + 502 + snake_case back) | `brain-server …/workflow_routes.test.ts`, `…/browser_proxy_contract.test.ts` |
| Contract test covers contacts/people/devices + respond (R6) | end-to-end roundtrip each through the real Fastify routes | `brain-server …/browser_proxy_contract.test.ts` |
| Web Add-Contact handle gate (R8) | a bare handle on web → DID-first message + **no** network call (handle resolution stays off the browser, §9) | `apps/mobile …/add_contact/web_handle_gate.test.ts` |
| Contacts wire contract | core route (list/add/delete) · 3 transports · brain proxy · browser proxy all agree on `{contacts}`/`{contact,created}`/`{deleted}` | `core …/server/routes/contacts.test.ts`, `…/client/{browser_core_proxy,http_transport,in_process_transport}.test.ts`, `brain-server …/contacts_routes.test.ts` |
| Contacts end-to-end registration | real `createCoreRouter` → signed brain auth → real directory (POST/GET/DELETE round-trip) | `core …/server/core_router_integration.test.ts` |
| People graph proxy | list/find/by-did URL+unwrap+fail-soft | `brain-server …/people_routes.test.ts`, browser proxy people block |
| Devices/pairing proxy | `/devices/list` + `/pair/initiate` (role validation, 502-on-mutation) | `brain-server …/device_routes.test.ts`, browser proxy devices block |
| **DoD #6** — access gate (D4) | `/api/v1/*` without the session cookie → 401; cookie set on `/web/*`; `DINA_BRAIN_DEV_OPEN=1` opens it | `brain-server …/web_access_gate.test.ts` |
| **D3 / §8** — no seed in browser | seed-bound settings rows hidden on web | (covered by the `Platform.OS==='web'` gate; native rows asserted present by existing settings tests) |
| **D6** — PeerLens write fallback | flag=false → write CTA hidden, read/search empty-state still renders | `apps/mobile …/peerlens/web_publish_gate.test.ts` + full peerlens suite (1614) green with flag=true |
| Provider key (D7) | `GET /api/v1/providers/status` redacts the key (never returned) | `brain-server …/provider_routes.test.ts` |

**Regression gate (run before declaring green):**

```sh
# one package at a time, --runInBand
( cd packages/core && npx jest --runInBand )
( cd apps/home-node-lite/brain-server && npx jest --runInBand )
( cd apps/mobile && npx jest --runInBand __tests__/services __tests__/peerlens __tests__/components )
npm run typecheck   # workspace, 0 errors expected
```

## B. Live / manual scenarios — need running servers (`dina-nodes`)

Bring up two nodes (alonso, sancho) with the web UI (`dina-nodes/start.sh`;
brain-server with `DINA_BRAIN_WEB_UI=1`), open each `<brain>/web/` in a tab.

| DoD | Scenario | Pass criteria |
|---|---|---|
| **#1** | Open `http://127.0.0.1:84xx/web/` | **No** "limited mode / no SQLite" banner |
| **#2** | `/remember` a fact in the web tab → hard-refresh the tab | Fact persists (served from the server's SQLCipher vault; verify in `dina-nodes/<node>/vault/*.sqlite`) |
| **#3** | Two tabs (alonso, sancho): a **Talk** round trip + a **Services** query | Each reflects its server node's `did:plc`; both complete |
| **#4** | Mobile jest + a Maestro smoke run | Green (native unchanged) |
| **#9** | Stop the brain-server, reload the web tab | "No Home Node reachable — start your server" screen, NOT onboarding or a spinner |
| Contacts/People (web) | Add a contact **by DID** (`did:plc:…`) or a pasted contact card in the web People tab — **not** by handle (handle resolution is intentionally rejected on web, R8/§C); open Relations | Contact appears (served from the node); a bare handle shows the "add by DID / by-handle coming soon" message; Relations lists people (B1 authz fix verified live) |
| Devices (web) | *(transport only — the Paired Devices SCREEN is not web-wired yet, §C)* `curl` the proxy: `GET /api/v1/devices/list` (with the session cookie) | Returns the node's devices; `POST /api/v1/pair/initiate` mints a code |
| Access gate (D4) | From a second non-browser local process, `curl http://127.0.0.1:<brain>/api/v1/vault/list?persona=general` | `401` (no session cookie). With `DINA_BRAIN_DEV_OPEN=1`, the dev server allows it |
| D3 (web) | Open Settings → SECURITY on web | No "View recovery phrase" / "Change passphrase" / "Confirm recovery phrase" / "Auto-lock when backgrounded" rows (all seed/vault-on-device-only); "Key storage" reads "Home Node server" + "Storage" reads "On your Home Node"; the AI PROVIDER card reads "Managed on your Home Node"; the Agents row is absent |
| D6 (web) | PeerLens search/browse on web; look for a write CTA | Read/search work; **no** "Write a review" CTA |
| **D5** — multi-tab | Two tabs driving ONE node: (a) concurrent writes, (b) the same SSE event mirrored into both | No write corruption; no duplicate-event UI artifact |

## C. Deferred (not yet implemented — must NOT be claimed as passing)

- **DoD #8** — PeerLens **publish** from web landing in the server publish-job
  machine. Deferred: the write CTA is hidden (D6 fallback). Tracked: T5b.
- **D2D quarantine** on web (no `CoreClient` surface yet). Tracked: T3b.
- **Export** on web (`/v1/export` is admin-only; brain can't proxy).
- **Notifications** on web are a client-local projection of SSE events — verify
  the web SSE → local-notification-store wiring populates the tab (client
  concern, not a proxy).
- BYOK **write** path + the web AI-providers screen consuming the status
  read-only (D7 read path done; write path deferred).
- Paired-devices **revoke** on web (transport has list + pair-code only).
- Paired-devices **SCREEN** web-wiring (`paired-devices.tsx` still calls the
  in-process registry; the proxy transport is built + tested but the screen has
  no `Platform.OS==='web'` branch yet — needs the rest of the device-registry
  surface, incl. revoke, on `CoreClient`). The **Agents** Settings row that links
  to it is now **hidden on web** (R3) until the screen is wired.
- **Add-Contact by handle on web** (R8b): web currently requires a DID (handle
  resolution is node logic kept off the browser, §9). The server-side resolve
  proxy — a shared ATProto resolver + a brain `GET /api/v1/identity/resolve-handle`
  route — is deferred; until then the web screen shows "add by DID / by-handle
  coming soon".
- **Rebuild the web bundle before shipping:** `apps/home-node-lite/web/dist` is a
  gitignored artifact; regenerate it (`npx expo export --platform web`) so the
  bundled (dead-for-thin-client) router reflects the current core routes. Stale
  dist is harmless to the thin client (the browser drives `BrowserCoreProxyClient`,
  never `createCoreRouter`) but should not ship out of date.

## D. Security invariants to spot-check (web build)

Grep the built web bundle / browser storage — none of these may appear:
master seed, 24-word mnemonic, any DEK, an Ed25519 **signing** key, a provider
API key, the session-cookie secret (the cookie is `HttpOnly`). The DID + handle
MAY be cached (public identity metadata). Ref: `web/SECURITY.md`.
