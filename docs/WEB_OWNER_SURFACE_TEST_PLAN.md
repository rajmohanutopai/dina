# One owner interface — test plan

What `docs/WEB_OWNER_SURFACE_PLAN.md` promises, turned into checks a person
or an agent can run. Unit and contract tests already pin most rules in code
(listed per section); this plan is the end-to-end layer on the home-node-lite
bed (`dina-nodes/`, the primary test surface per `dina_details.md`), in a
real browser, and on the phone.

**Bed.** Four nodes, all in security mode (passphrase-wrapped seed, so
presence checks are live): alonso `8301/8401`, sancho `8302/8402`,
chairmaker `8303/8403`, albert `8304/8404`. Core serves the web app at
`http://127.0.0.1:83xx/app/`; Brain allows exactly that origin. The owner key
is `dina-nodes/nodes/<node>/vault/owner_capability`; the passphrase is
`DINA_UNLOCK_PASSPHRASE` in `nodes/<node>/node.env`. Neither is ever printed:
scripts read them from the files.

**Presence is per surface, for five minutes.** A proof counts only for the
principal that made it: the capability (the `/owner` console, scripts), one
owner device (one browser), or the phone's own app. A proof made with the
capability does not open a gate for a browser, and one browser's proof does
not open it for another. A refusal test must still run before its own
principal proves, or five minutes after.

Result for each check: PASS, FAIL (with the request/response or screenshot),
or BLOCKED (with why).

---

## A. Core serves the page

Pinned by `core-server/__tests__/web_app.test.ts`.

| # | Check | Expected |
|---|---|---|
| A1 | `GET /app/`, `/app/index.html`, a deep link `/app/settings`, `/app/tender?tender_id=x` | 200 `text/html`, `cache-control: no-cache, must-revalidate`, the shell |
| A2 | A hashed asset under `/app/_expo/static/js/web/` | 200 with its JS type |
| A3 | Traversal: `/app/../x`, `/app/..%2F..%2Fx`, `/app/%2e%2e/x`, `/app/..%5c..%5cx` | never a file outside the bundle |
| A4 | `GET /app/runtime-config.json` | `{served_by:'core', brain_url:<Brain origin>}`, `no-store` |
| A5 | Headers on every `/app/*` answer | the exact CSP (`script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-eval`/`unsafe-inline` for scripts, `frame-ancestors 'none'`, `object-src 'none'`), `x-frame-options: DENY`, `nosniff`, `no-referrer` |
| A6 | In the browser, inject an inline `<script>` into the DOM | blocked by CSP (a violation, the script does not run) |
| A7 | Brain no longer serves the app | `GET :84xx/app/` and `:84xx/web/` → 404; `:84xx/readyz` has no `webUI` field |

## B. Brain across origins

Pinned by `brain-server/__tests__/web_origin.test.ts`.

| # | Check | Expected |
|---|---|---|
| B1 | `GET :84xx/api/v1/contacts` with `Origin: http://127.0.0.1:83xx` | `access-control-allow-origin` = that origin, no `allow-credentials` |
| B2 | Preflight `OPTIONS` for `POST` + `content-type`, and for `DELETE` | 204, the method listed, `content-type` allowed |
| B3 | Another origin (`http://evil.example`, `http://localhost:<other port>`, `https://127.0.0.1:83xx`, `null`) | no CORS header; preflight gives none (the listed pair `127.0.0.1:83xx` and `localhost:83xx` both get it: the installer and the bed list both loopback names) |
| B4 | `GET :84xx/healthz` with the listed origin | no CORS header (only `/api/*` is shared) |
| B5 | SSE `/api/v1/notifications/stream`, `/api/v1/chat/stream`, `/api/v1/reminders/stream` from the listed origin | `text/event-stream` and the CORS header |
| B6 | A foreign `Host` header on Brain | refused by the Host allowlist |
| B7 | A no-preflight `POST :84xx/api/v1/chat/reset` (`content-type: text/plain`) with `Origin: http://evil.example` or `null` | `403 origin_not_allowed`; the handler never runs (the chat thread survives) |
| B8 | The same POST with the listed origin, with Brain's own origin (`Origin: http://127.0.0.1:84xx`, as `/dev` sends), and with no `Origin` | answered by the route |

## C. Connecting a browser as the owner

Pinned by `mobile/__tests__/services/owner_device_web.test.ts`.

| # | Check | Expected |
|---|---|---|
| C1 | Settings shows "Owner access" on the web; the phone app does not show it | as stated |
| C2 | Wrong owner key | "That owner key is not right…"; the passphrase is never sent (network log) |
| C3 | Right key, no passphrase, on a security-mode node | "Enter your passphrase to connect this browser." |
| C4 | Right key, wrong passphrase | "That passphrase is not right." |
| C5 | Right key and passphrase | connected; the device appears in Core's `owner_devices` under the given name |
| C6 | In the page: `indexedDB` record `dina-owner-device/device/owner` | a `CryptoKey` with `extractable: false`; `exportKey` rejects; no field holds the owner key; `localStorage`/`sessionStorage` hold no owner key |
| C7 | Reload | still connected; owner screens work without asking again |
| C8 | Disconnect | the device is revoked at Core (gone from `owner_devices`) and forgotten here |
| C9 | Revoke the device from another surface (capability + `DELETE /v1/owner/setup/owner-device/:id`) | the browser's next owner call asks Core's status route, finds the device unknown, forgets the key, and the screen says "Connect this browser as the owner"; Settings → Owner access shows the connect form, not "connected". Disconnect afterwards reports revoked, not "could not confirm". |
| C10 | A page NOT served by Core (a static server over the same bundle) | the Owner access screen says it cannot connect; nothing is sent |
| C11 | `POST /v1/pair/initiate` asking for role `owner` | refused; only the owner-device mint issues that role |
| C12 | Two tabs of the same browser, both connected; disconnect in tab A | tab B's next owner call answers "not connected" (no signing with the dropped key) and its Settings screen redraws; connecting again in tab B while tab A is connected is refused ("already connected") |

## D. Signed owner-device requests (API level)

Pinned by `core/__tests__/auth/owner_device.test.ts`,
`core-server/__tests__/owner_device_channel.test.ts`, `bind_core_router.test.ts`.
Pair a scripted device (Ed25519 key, `/v1/owner/setup/owner-device` then
`/v1/pair/complete`) and sign with `signRequest` from `@dina/core`.

| # | Check | Expected |
|---|---|---|
| D1 | `GET /v1/run/list`, `/v1/workflow/tasks`, `/v1/owner/setup/status`, `/v1/commerce/trade/inbox` | 200, as the owner |
| D2 | Off the owner surface: `POST /v1/vault/query`, `POST /v1/vault/store`, `POST /v1/staging/ingest` | refused; never the owner |
| D3 | Body changed after signing | 401 at the entry point |
| D4 | The same signed request twice | the second refused (nonce) |
| D5 | Timestamp 10 minutes old | refused |
| D6 | Revoked device | refused |
| D7 | A staff device signing an owner path | not the owner |
| D8 | Capability header still works beside owner devices | 200 |
| D10 | Throttle: more signed owner calls than the per-DID budget in a minute (only on a node started with the default `DINA_RATE_LIMIT`; skip on the bed if it runs higher) | `429 {rejected_at:'rate_limit'}`, and the browser keeps its key |
| D11 | A full `/app/` page load (about ninety files) on a default-budget node | every asset 200; the owner's next signed call is not refused by the per-IP limit |
| D9 | New owner-surface entries: `GET /v1/workflow/tasks/:id` and `POST /v1/service/respond` reachable; `POST /v1/workflow/tasks/:id`, `GET …/:id/events`, create/claim/complete refused | as stated |

## E. Owner presence on the powerful actions

Pinned by `core/__tests__/server/routes/owner_presence_gates.test.ts`,
`owner_setup_routes.test.ts`, `agent_gating_policy.test.ts`,
`core-server/__tests__/approval_phone_routes.test.ts`.

On a node with no fresh proof, each gated route answers
`403 {error:'no_user_presence'}` **before any side effect**, and answers for
itself after `POST /v1/commerce/catalog/drafts/presence {passphrase}`.

| # | Gated | Ungated (never asks) |
|---|---|---|
| E1 | `POST /v1/owner/setup/{coding-agent,staff,owner-device}` | `DELETE /v1/owner/setup/{coding-agent,staff,owner-device,device}/:id` |
| E2 | `POST /v1/owner/setup/phone` | `DELETE /v1/owner/setup/phone` |
| E3 | `POST /v1/plugins/install/{setup_code,confirm}`, `/v1/plugins/update/confirm` | `…/decline`, `…/uninstall`, `…/begin`, `…/country_pack`, `/v1/plugins/installs`, `…/pairing_state` |
| E4 | `POST /v1/commerce/install/{bind_reference_runner,bind_device,confirm,update/confirm}` | `…/begin`, `…/update/prepare`, `…/retire`, `…/updates` |
| E5 | The yes on `negotiation_price_approval`, `payment_evidence_record`, `commerce_staff_escalation` and `integration_settings_proposal` cards | their no; every other card's yes |
| E6 | `PUT /v1/owner/agent-policies/:did` below full supervision | to `full_supervision`; `DELETE` |
| E7 | The earlier gates still hold: orders from quote, orders prepare, drafts approve, tender award, staff grants, invites; a settings proposal's yes (E5) | reads; the owner's SEND of an approved draft or held order (`drafts/submit`, `orders/submit`) needs no second proof, because its approval did; creating a settings proposal only mints a card |
| E8 | A wrong passphrase at the presence route | `401 not_proven`; nothing gated opens |
| E9 | `POST /v1/commerce/trade/payment-note`, `/v1/commerce/invites/redeem`, `/v1/commerce/invites/accept-held`, `PUT /v1/commerce/settings/{supplier,buyer}`, `POST /v1/reasoning/backends/register` | `PUT /v1/commerce/settings/business`; `POST /v1/reasoning/backends/:id/revoke` |
| E10 | Per principal: prove with the capability, then call a gated route as an owner device (and the reverse; and two owner devices) | the unproven principal is refused `no_user_presence`; the proven one passes |

## F. The approval inbox in a browser

Pinned by `mobile/__tests__/services/inbox_client_resolver_web.test.ts`,
`components/approval_inbox_presence.test.tsx`; the PR Playwright tier.

| # | Check | Expected |
|---|---|---|
| F1 | Not connected: Activity → Needs action | "Connect this browser as the owner (Settings → Owner access)…" |
| F2 | Connected: every pending card lists, owner-only kinds included (tender ready, checkout link, payment record, price approval, disclosure review) | all present with their buttons (no "decide elsewhere") |
| F3 | Record a payment with no fresh proof | the "confirm it's you" sheet; a wrong passphrase is said in the sheet; the right one sends the same yes; the card leaves |
| F4 | Cancel the sheet | nothing sent; the card stays |
| F5 | Deny a service-query card | `unavailable` goes to the requester via `/v1/service/respond`; no timeout |
| F6 | A refusal (e.g. a card already decided elsewhere) | Core's reason on the card |
| F7 | An agent persona-access card | a single browser confirm, then the agent's retry succeeds |

## G. Owner screens in a browser (connected)

Each screen reads the Home Node's data, not the tab's own node.

| # | Screen | Check |
|---|---|---|
| G1 | Trade | the node's inbox (payments, deliveries, tenders, khata) |
| G2 | Tender | ranking; award with no proof → sheet → award holds the order; send |
| G3 | Orders | drafts; "Enable ordering" shows only if Core has no active buyer pack; activation asks for presence and leaves nothing staged when refused |
| G4 | Catalog, Order draft, Catalog draft | lists; approve/submit ask for presence; submit reports the dispatch |
| G5 | Business identity | reads and saves Core's settings |
| G6 | Staff | Core's staff devices; grant asks for presence; revoke asks first |
| G7 | Invites | mint, redeem and accepting a held introduction each ask for presence; the code shows on screen; a non-presence refusal is said under the action's own title |
| G8 | Runs, Subscriptions | list; start/stop and create/cancel reach Core |
| G9 | Plugins | Core's installs; third-party door says whether this node can verify; a country pack stages, the runner code asks for presence and shows the `dina1:` string; decline removes it; pack updates review then apply with presence |
| G10 | Agents | Core's devices (every role, revoked marked); mint a coding agent / staff code with presence; revoke; supervision per coding agent (lowering asks for presence); the approval-phone section on a server node; "Use as Brain" only on coding agents |
| G11 | Every owner screen, browser disconnected | the connect message, never a raw error, never a blank (Agents, Plugins and Staff show it in place of "none yet"; Tender in words, not a key) |
| G12 | After the passphrase, while the retried award/send/grant is in flight | the button stays disabled and the spinner shows; a second tap sends nothing |
| G13 | Agents → Brain access ON for a coding agent with no fresh proof | the passphrase sheet, then the binding; OFF never asks |
| G14 | "Share Setup Code" (Agents) and "Share setup code" (runner consent) in a desktop browser with no share sheet | the code is copied and the button says "Copied", never a false "Shared!"; the full code is visible and selectable |

## H. Brain-backed screens across origins

| # | Screen | Check |
|---|---|---|
| H1 | Chat | a message posts to Brain and the answer arrives over the stream |
| H2 | People | Brain's contact list |
| H3 | Reminders, Activity notifications | lists and the live stream |
| H4 | Network → PeerLens search | results or a clean empty state |
| H5 | Quarantine card (a message from an unknown sender) | accept/block reach Brain |
| H6 | My Services | read and publish a listing |
| H7 | Network log | every Brain call goes to `:84xx`; none 404s on Core; no request carries cookies |

## I. The phone (existing simulator, Maestro)

The phone's owner calls now go through Core's routes in-process.

| # | Check | Expected |
|---|---|---|
| I1 | Approvals: a money card's yes with no fresh proof | the passphrase sheet, then the yes |
| I2 | Trade → Tender award | presence sheet, award |
| I3 | Plugins | list from Core's routes; a country pack stages; the runner code asks for presence |
| I4 | Staff | staff devices from Core's owner-setup status |
| I5 | Agents | mint a coding-agent code (presence), supervision picker on a coding agent, no approval-phone section |
| I6 | No "Owner access" row in Settings | as stated |

## J. Secrets and cross-site safety

| # | Check | Expected |
|---|---|---|
| J1 | Core and Brain logs after the runs | no owner key, no passphrase, no pairing code (count matches without printing) |
| J2 | A page on another origin calls an owner route with `fetch` | fails: no key to sign, no CORS |
| J3 | The owner key or passphrase in any URL | never (network log) |

## K. Deployment

| # | Check | Expected |
|---|---|---|
| K1 | `docker compose -f apps/home-node-lite/docker-compose.lite.yml config` | parses; Core mounts the bundle and has `DINA_CORE_WEB_UI`/`DINA_CORE_WEB_BRAIN_ORIGIN`; Brain has `DINA_BRAIN_WEB_ORIGIN` and no web mount |
| K2 | `install-lite.sh --help`; `bash -n` | the web-ui text names Core `/app/`; the script parses |
| K3 | `set_env_var` in a temp `.env` | replaces an existing line, appends a missing one, removes `DINA_BRAIN_WEB_UI` |
| K4 | Playwright PR and smoke tiers | green on Core `/app`; the PR tier runs Core in security mode and `owner_presence.spec.ts` drives the sheet (wrong passphrase said, right one mints) |
| K5 | Compose passes `DINA_UNLOCK_PASSPHRASE` to Core; `.env.example` explains security vs convenience mode; `install-lite.sh` lists both loopback origins | as stated |
| K6 | Core with `DINA_CORE_WEB_UI=1` and no Brain origin set | boots, naming `http://127.0.0.1:8200` in the page config |
| K7 | Brain's workflow proxy is gone | `POST :84xx/api/v1/workflow/tasks/x/approve`, `/cancel`, `POST :84xx/api/v1/service/respond` → 404 |
