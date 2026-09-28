# Ask for quotes, find suppliers, and the iOS scene life cycle

Status: plan (2026-09-28). Three gaps a buyer and the iOS build hit today.

1. **Finding suppliers.** A tender needs each supplier's Dina ID and listing
   key. Nothing lets a buyer search and pick; they would have to know the IDs.
2. **Starting a tender.** Core's `POST /v1/commerce/trade/tender` works, but no
   screen or chat command calls it, so no buyer can begin the flow from the
   phone or the web.
3. **iOS 27.** The iOS 27 SDK asserts at launch unless an app adopts the
   scene-based life cycle. Ours creates its window in the app delegate.

---

## 1. Finding suppliers

### What exists

- AppView `com.dinakernel.commerce.searchCatalog` (`q`, `category`, `region`,
  `supplier`): published catalog rows, each naming `supplier_did`,
  `service_rkey`, `service_uri`, indicative price and fulfilment regions,
  already filtered by the trust floor (§3.6).
- AppView `com.dinakernel.service.search` (`capability`, `q`, `category`,
  optional `lat`/`lng`): listings answering a capability, with `name`,
  `operatorDid`, `uri`, `trustScore`, ranked by text, trust and distance.
  A supplier listing answers `com.dinakernel.commerce.request_quote`.
- `AppViewClient` (`@dina/brain`) wraps both (`searchCatalog`,
  `searchServices`, `getServiceByUri`).
- The app reaches the AppView at `appViewBase()`: the hosted AppView on the
  phone, Brain's `/api/peerlens` proxy on the web.

### What to build

**`supplier_finder` (app service).** `findSuppliers({ text, region? })`
returns one row per supplier listing:
`{ supplierDid, serviceRkey, name, trustScore, matches, indicativeFrom?, source }`.

- Two sources, merged by `(supplierDid, serviceRkey)`:
  - catalog search with `q = text` and the buyer's region — suppliers who
    publish a matching item and deliver there;
  - service search for `request_quote` with `q = text` — suppliers whose
    listing matches the words even without a catalog row (custom cakes).
- A catalog-only supplier's name comes from `getServiceByUri`; one that
  cannot be resolved is shown by its short DID, never dropped.
- Ranked by trust, then by catalog matches. The buyer's
  `blockedSuppliers` are removed; `preferredSuppliers` are marked and listed
  first.
- "Near me" is the buyer's saved delivery region (buyer settings
  `locations[0]`). The app does not read device location; there is no
  location permission in the app today and this does not add one.

**Brain's AppView proxy** forwards the two read-only NSIDs the finder uses
(`com.dinakernel.commerce.searchCatalog`, `com.dinakernel.service.search`,
`com.dinakernel.service.getByUri`) in addition to `com.dinakernel.peerlens.*`.
Still GET only, still refuses everything else.

**`SupplierPicker` (component).** A search box, the region it searched in,
and results with name, trust band, what matched and "from ₹…" when a price is
published. Tapping a row selects it; selected suppliers show as chips. It
says when results were suppressed below the trust floor, and when the buyer
has no saved region.

## 2. Ask for quotes

### What exists

`POST /v1/commerce/trade/tender` takes `suppliers[] {supplier_did,
service_rkey}`, `lines[]`, a delivery `projection`, `currency`, optional
`required_by`, and optional `negotiation {target_total, budget_ceiling,
max_rounds, deadline_seconds}` (checked before any request leaves). A line
may be a requirement line: `{ line_id, requirement: { text }, quantity }`
(NEGOTIATION_PLAN §4.6). The route answers `tender_id` and per-supplier
dispatch.

### What to build

**`OwnerCommerceClient.createTender(input)`** — the owner client for the
route, answering `{ tenderId, members, negotiating }`, refusals raised with
Core's key, like its other methods.

**The "Ask for quotes" screen (`/ask-quotes`).**

- **What you want:** one or more lines, each a description ("Floral
  celebration cake, 20 servings"), a quantity and a unit (a short list:
  piece, kg, box, serving; the §9.2 unit codes).
- **Who to ask:** the `SupplierPicker`, seeded with the first line's words.
- **Deliver to:** the buyer's saved regions (default the first); a postal
  code field when none is saved.
- **Limits (optional):** target and ceiling in the buyer's currency, maximum
  rounds, reply deadline in hours. Target must not exceed the ceiling; the
  screen checks what Core checks and still shows Core's refusal if any.
- **Send:** creates the tender, then opens the existing Tender screen with
  its `tender_id`. The screen reports any supplier the request did not
  reach.
- Reached from Trade and Orders ("Ask for quotes"), and from the chat card
  below. Works on the phone (in-process) and the web (as the owner device).
- **No presence gate.** Asking for quotes spends nothing; awarding already
  asks for the passphrase.

**The chat hand-off.** Brain gets one tool, `draft_quote_request`, that
turns a request like "ask bakeries near me for a floral cake for 20, budget
₹3,000" into a draft: lines, a supplier search phrase, and limits. It posts a
`quote_request_draft` card; the card's button opens `/ask-quotes`
prefilled. Brain never creates the tender: sending requests to suppliers is
the owner's act on the screen, and Brain holds no owner authority. The card
works the same on the phone and the web (the thread reaches both).

## 3. iOS scene life cycle

- **Upgrade to Expo SDK 57** (latest stable; React Native 0.86). Expo 57
  ships `ExpoAppSceneDelegate`: it creates the window from the connecting
  scene, starts React Native, rebuilds launch options so a cold-start deep
  link reaches `Linking.getInitialURL()`, and forwards URLs, universal links,
  quick actions and life-cycle events to `ExpoAppDelegate`. Writing our own
  on Expo 55 would copy about 250 lines Expo maintains and tests.
- **Config plugin `with-scene-lifecycle`**, because `ios/` is generated by
  `expo prebuild` and the SDK 57 template does not adopt scenes yet:
  - `Info.plist`: `UIApplicationSceneManifest` with one application scene,
    `UISceneDelegateClassName = $(PRODUCT_MODULE_NAME).SceneDelegate`,
    multiple scenes off;
  - `SceneDelegate.swift`: `class SceneDelegate: ExpoAppSceneDelegate {}`,
    added to the Xcode target;
  - `AppDelegate.swift`: conform to `ExpoReactNativeFactoryProvider`, keep
    creating the factory, stop creating the window and starting React
    Native, drop the URL and universal-link overrides (the scene delegate
    forwards them).
  - Idempotent, and a no-op once the template adopts scenes (Expo 58 does);
    then the plugin is deleted.
- **Verify:** prebuild from clean, build, launch on the simulator; a cold
  `dina://` link and a warm one both reach the router; a notification tap
  still routes; the dev client still loads from Metro. Android is untouched
  by the plugin but must still build after the upgrade.

## Tests

- Finder: merge and dedupe, name fallback, blocked/preferred, ranking,
  region passed through; against a fake AppView answering the real shapes.
- Proxy: the added NSIDs forward, anything else is still refused, GET only.
- Client: `createTender` against Core's real route (in-process dispatcher).
- Screen: lines, picker, limits validation, send → Tender screen, Core's
  refusal shown in words, not-connected message on the web.
- Brain tool: a request becomes a draft card; the tool never calls Core's
  tender route.
- Plugin: running it twice on a generated project changes nothing the
  second time; the manifest, scene delegate and app-delegate edits are
  present; a template that already adopts scenes is left alone.
- Live: on the bed, sancho asks chairmaker and albert for quotes from the
  browser and the phone, and the Tender screen shows their offers.
