# Public Services Taxonomy — Provider Categories & Canonical Capability Shapes

> **Status:** planning document (not code). Companion to
> `SERVICE_CAPABILITY_CATALOG_DESIGN.md`.
>
> **What this is NOT:** an implementation backlog of hundreds of capabilities. The
> official capability registry stays **small and disciplined**; the *category map*
> is broad (to show coverage and developer opportunity); the long tail lives in the
> **provider-specific lane** and is promoted to official only by demand.

## The model: three different things

Keep these separate — they scale differently:

1. **Provider category** — *what kind of provider is this?* (school, clinic, bus
   operator, bank, dev-tool). **Enumerate broadly** — finite-ish, good for browsing /
   maps / AppView profile pages / developer inspiration.
2. **Capability** — *what callable function exists?* (`status_lookup`,
   `availability_lookup`, `appointment_book`). **Keep small + reusable** — a compact
   canonical core; meaning comes from `category` + provider context.
3. **Provider-specific function** — *a special function that belongs to one
   provider* (RajSchool's homework dashboard, House of Prime Rib's tasting menu).
   **Not** in the official catalog; reached only via provider/place/profile/link.

**Why not enumerate every capability?** It never finishes, it bloats the vocabulary
the LLM routes over, and ~95% of provider functions are one-offs that belong in lane
3. Categories scale by **enumeration**; capabilities scale by **abstraction +
promotion**.

## 1 · Public search modes

| Mode | Surfaces | What's matched |
|---|---|---|
| **Generic intent search** | "find a service that answers X" | **official canonical capabilities flagged `intent_routable`** (a subset of the registry) |
| **Provider / place / profile search** | a known provider's / place's page | official **+** provider-specific capabilities |
| **Direct link / QR** | a shared listing URI | that **exact** listing only |
| **Approved-only** | grant / contact / `service.offer` | nothing public; off-network authority |

**The provider/place/profile is the search identity — the custom capability key is
NOT the search key.** You find *House of Prime Rib*, then its menu; nobody
generic-searches `com.houseofprimerib.tasting_menu`.

**V1 reality (verified in code, updated 2026-06-10):** generic search returns
**canonical only** — `appview/src/api/xrpc/search-capabilities.ts` iterates
`allCanonicalCapabilities()` and *deliberately excludes custom*; the mobile
`AppViewStub` matches. **Now wired:** `intent_routable` is a required field on
`CapabilityDefinition` (mirrored as `intentRoutable` on the registry, §79
parity-gated), and generic search filters on it — official-but-subject-scoped
capabilities never enter the generic pool even when covered. See §2/§3.

**Discoverability ≠ authorization.** Two orthogonal questions, never conflated:
- **"How is it found?"** → discoverability (`public` / `unlisted` / `known_only`) +
  the search modes above. An `unlisted` link or a `public` listing is a *findability*
  property, **not** permission to invoke.
- **"Who may invoke it?"** → access policy: grants / contact relationship /
  `service.offer` / per-capability `requires_subject_authorization`.

A `public` listing being *findable* does not mean its capability is freely
*callable* on a subject's data — implementers must enforce the access-policy axis
separately from discoverability.

> **Unlisted, precisely.** The link/QR grants **addressability/discovery** (you can
> *reach* the listing; it's kept out of generic search). **Invocation still follows
> the listing's access policy.** In **V1**, an unlisted listing's access policy *may
> be* "anyone with the link" (which is what the mobile copy "anyone with the link or
> QR can access" means) — so possession of the link is the V1 gate. That's a
> deliberate *access-policy choice for unlisted*, not the link magically being a
> credential; a stricter access policy (grant/contact) can sit on top of the same
> unlisted discoverability.

## 2 · The official capability core

Small, reusable, organized by **shape**. `✅` = exists today (13); `⬜` = proposed
core. **Families & profiles:** a generic family id (`status_lookup`) plus typed
*profiles* where the payload/security/rendering genuinely differ. The current catalog
already does this — `order_status`, `appointment_status`, `device_status`,
`service_health_status`, `school_homework_status` are all `status` **profiles**.

| Shape | Family (generic) | Typed profiles / specific ids |
|---|---|---|
| **status** | `status_lookup` ⬜ (typed `object_type`) | `order_status` ✅, `appointment_status` ✅, `service_health_status` ✅, `device_status` ✅, `deploy_status` ✅, `school_homework_status` ✅, `application_status` ⬜, `ticket_status` ⬜, `claim_status` ⬜, `document_status` ⬜, `incident_status` ⬜, `reservation_status` ⬜, `membership_status` ⬜, `wait_time` ⬜, `job_status` ⬜, `integration_status` ⬜, `index_status` ⬜ |
| **tracking** (state + location over time) | — | `package_tracking` ✅ |
| **availability** | `availability_lookup` ⬜ (typed) | `appointment_availability` ✅, `inventory_lookup` ⬜ |
| **schedule / hours** | `schedule_lookup` ⬜ | `hours_lookup` ⬜ |
| **eta** | `eta_query` ✅ | `delivery_eta` ✅ |
| **price / quote** | `price_check` ✅ | `rate_lookup` ⬜, `service_quote` ✅, `quote_request` ⬜ (action) |
| **balance / usage** | `balance_lookup` ⬜ | `usage_lookup` ⬜ (account/data/energy/API usage — not money) |
| **reference lookup** | — | `menu_lookup` ⬜, `location_lookup` ⬜, `content_lookup` ⬜, `document_lookup` ⬜, `event_lookup` ⬜ (event detail; distinct from `schedule_lookup`) |
| **forecast / conditions** | — | `forecast_lookup` ⬜ (time-series), `conditions_lookup` ⬜ |
| **alert / disruption** | `service_alerts` ⬜ | `incident_status` ⬜ |
| **action** (review-gated) | — | `appointment_book` ✅, `booking_request` ⬜, `service_request` ⬜ |
| **sensitive / verified** (NOT a normal action) | — | `eligibility_check` ⬜ — *sensitive read, review-gated, `requires_subject_authorization`*; `credential_verify` ⬜ — *`requires_verified_provider` + verified issuer; never `intent_routable` without issuer trust* |

**Routing requires the tuple, not the bare id.** A broad family must be routed as
**`{ capability, category_id, object_type }`**, never `status_lookup` alone — a
school-homework status, a package status, a deploy status, a claim status, and a
passport status are not interchangeable. The tuple is what makes a generic family
safely routable, validatable, and renderable.

**Shape discipline:** prefer a generic id, but **split when validation, rendering,
authorization, or trust semantics differ.**
- `wait_time` — good generic (clinic / DMV / restaurant all return duration + queue).
- `status_lookup` — **only** with a typed `object_type` (`job`/`refill`/`case`/
  `release`/…) and per-type result-schema variants; a build status ≠ a court-case
  status. Generic *intent*, typed *payload*.
- `package_tracking` — a **tracking** shape (state + location over time), not pure
  ETA; `delivery_eta` stays under ETA (a single arrival time).
- `forecast_lookup` — must NOT fold into `status_lookup` (time-series, not a state).
- `eligibility_check` / `credential_verify` — NOT generic actions; they read/verify
  subject- or issuer-trusted data and carry the sensitive/verified policy below.

Do **not** mint vertical-specific ids like `dmv_wait_time` / `medication_price` —
use `wait_time` / `price_check` with category context.

## 3 · Capability policy model

Every canonical capability carries policy metadata so "official" never silently means
"anyone can query anything publicly." **Verified against
`packages/protocol/src/types/catalog.ts`:**

| Field | Status | Values |
|---|---|---|
| `action_class` | ✅ exists | `read` \| `quote` \| `booking` \| `write` \| `payment` \| `agentic` |
| `privacy_class` | ✅ exists | `public` \| `personal` \| `sensitive` \| `regulated` |
| `default_discoverability` | ✅ exists | `public` \| `unlisted` \| `known_only` |
| `approval_policy_hint` | ✅ exists | (informational approval hint) |
| `intent_routable` | ✅ exists (2026-06-09) | can this enter generic LLM service discovery? Mirrored as `intentRoutable` on the registry (§79 parity-gated) so AppView can filter. |
| `requires_verified_provider` | ✅ exists (2026-06-09) | must the provider prove domain/place/institution ownership? **Declarative only** — verification infra still doesn't exist. |
| `requires_subject_authorization` | ✅ exists (2026-06-09) | does the requester need a grant/relationship to the data **subject**? Catalog integrity enforces `subject_auth ⇒ !intent_routable` (fail-loud). |

`requires_subject_authorization` is the most important of the three.
`school_homework_status`, grades, lab results, benefit status, account balance are
not merely *sensitive* — they are **sensitive about a subject**. Generic search must
never imply access. The school-homework capability is *official*, with
`privacy_class: sensitive`, `intent_routable: false`,
`requires_subject_authorization: true`, and `default_discoverability: known_only`
(the target default — shipped 2026-06-09). Compare `eta_query`: `read` / `public` /
`intent_routable: true` / no verification / no subject auth.

> **Risk closed (2026-06-09/10).** The former gap — `searchCapabilities` returning
> *all* covered canonical caps with no way to filter — is fixed: the fields exist,
> generic search filters `intentRoutable`, and a provider flipping a sensitive
> listing to `public` is **rejected by the validator** (and, defense in depth,
> still wouldn't be generic-routed). The full routing matrix for the 13 shipped
> capabilities lives in `capability-catalog.ts` with per-capability rationale.

> **Where it's enforced** (defense in depth, all live): (1) the **listing
> validator** (`listing-validation.ts` `public_sensitive_capability` — rejects
> `public` + sensitive/regulated official caps unless
> `intent_routable && !requires_subject_authorization` explicitly allows), (2) the
> **mobile service-settings save path** (dedicated alert + one-tap "Make Unlisted" /
> "Make Private"), and (3) **AppView `searchCapabilities`** (filters
> `intentRoutable === true`; the mobile stub mirrors it).

## 4 · Provider-category map (the opportunity surface)

Broad on purpose — this is the "you can build here" map for developers. For each
category: the **official capabilities** available (from §2), **provider-specific
examples** (lane 3, custom), the **target visibility policy**, and
**guardrails**. `✅`/`🔁`/`⬜`: exists in this category / exists-but-needs-cross-listing
/ proposed.

**"Target visibility policy"** is built from wire values — `public` / `unlisted` /
`known_only` (the `Discoverability` enum) — but **split per capability family** where
they differ within a category (e.g. "availability `public`; book/status `unlisted`"),
so the column is policy prose, not a single enum value. UI labels map: `public` →
**Public**, `unlisted` → **Unlisted** (the link/QR reach), `known_only` → **Private /
Approved Only**. These are **targets**; some current catalog defaults differ (§3).

| Category | Official caps available | Provider-specific examples | Target visibility policy | Guardrails |
|---|---|---|---|---|
| **Transit & Mobility** | `eta_query` ✅, `schedule_lookup` ⬜, `service_alerts` ⬜, `rate_lookup` ⬜, `availability_lookup` ⬜ | live vehicle map, crowding level | `public` | — |
| **Commerce & Retail** | `price_check` ✅, `order_status` ✅, `inventory_lookup` ⬜, `hours_lookup` ⬜ | loyalty game, store-specific config | `public` | — |
| **Food & Dining** | `menu_lookup` ⬜, `order_status` 🔁, `availability_lookup` ⬜ (table), `reservation_status` ⬜, `wait_time` ⬜, `hours_lookup` ⬜ | special tasting menu, chef's table | `public` | — |
| **Appointments & Bookings** | `appointment_availability` ✅, `appointment_book` ✅, `appointment_status` ✅, `booking_request` ⬜ | intake forms, package builder | availability `public`; book/status `unlisted` (personal/sensitive) | per-family: status/booking carry subject data |
| **School & Education** | `hours_lookup` ⬜, `schedule_lookup` ⬜, `application_status` ⬜, `school_homework_status` ✅ | parent homework dashboard, LMS portal | `known_only` (shipped 2026-06-09) | `requires_subject_authorization`; `intent_routable: false` for student data |
| **Healthcare & Wellness** | `appointment_availability` ✅, `appointment_book` ✅, `wait_time` ⬜, `status_lookup` ⬜ (results) | patient portal flows, lab portal | `unlisted` / `known_only` | sensitive; subject auth; not public by default |
| **Home, Repairs & Local** | `service_quote` ✅, `appointment_availability` ✅, `status_lookup` ⬜ (job) | custom estimate wizard | `public` | — |
| **Logistics & Delivery** | `package_tracking` ✅, `delivery_eta` ✅, `order_status` 🔁, `document_status` ⬜ | carrier-specific tracking detail | `public` | — |
| **Professional Services** | `appointment_availability` ✅, `quote_request` ⬜, `ticket_status` ⬜, `claim_status` ⬜ | client portal, matter status | `public` / `unlisted` | personal for client data |
| **Developer Tools & Ops** | `service_health_status` ✅, `deploy_status` ✅, `incident_status` ⬜, `ticket_status` ⬜, `job_status` ⬜, `integration_status` ⬜, `index_status` ⬜, `usage_lookup` ⬜, `status_lookup` ⬜ | build dashboard, feature-flag state, release notes, usage quota, internal runbook | `public` (status) / `unlisted` (beta/customer) / `known_only` (internal) | — |
| **AI / Data / Automation** | `service_health_status` ✅, `usage_lookup` ⬜ (tokens/credits/quota), `status_lookup` ⬜ (model/job/eval), `index_status` ⬜, `content_lookup` ⬜ | model/agent endpoint, eval dashboard, dataset catalog | `public` (status) / `unlisted` (beta) / `known_only` (internal) | — |
| **Research / Labs** | `availability_lookup` ⬜ (instrument/study), `status_lookup` ⬜ (sample/experiment), `schedule_lookup` ⬜, `content_lookup` ⬜ (publications) | lab-specific portals | `public` / `unlisted` | sensitive for human-subject data |
| **Home & IoT Automations** | `device_status` ✅, `status_lookup` ⬜ (sensor/automation) | device-specific control surface | `known_only` | personal device data |
| **Government & Civic** | `application_status` ⬜, `document_status` ⬜, `wait_time` ⬜, `appointment_availability` 🔁, `schedule_lookup` ⬜ | agency-specific case portals | schedule/wait `public`; application/document `known_only` (personal records) | `requires_verified_provider`; subject auth for personal records |
| **Utilities & Energy** | `incident_status` ⬜ (outage), `usage_lookup` ⬜, `balance_lookup` ⬜, `service_alerts` ⬜ | meter portal, plan config | `public` (outage) / `known_only` (account) | personal for usage/billing |
| **Telecom / Connectivity** | `incident_status` ⬜, `usage_lookup` ⬜, `status_lookup` ⬜ (plan/roaming), `ticket_status` ⬜ | carrier app flows | `public` (status) / `known_only` (account) | personal account data |
| **Travel & Hospitality** | `availability_lookup` ⬜ (rooms), `reservation_status` ⬜, `status_lookup` ⬜ (flight/check-in), `location_lookup` ⬜ | upgrade request, loyalty tier | availability/location `public`; reservation/check-in `unlisted`/`known_only` | per-family: reservation/check-in are personal |
| **Entertainment & Events** | `schedule_lookup` ⬜ (showtimes), `availability_lookup` ⬜ (seats/tickets), `event_lookup` ⬜, `hours_lookup` ⬜ | venue-specific seat maps | `public` | — |
| **Culture & Heritage** | `hours_lookup` ⬜, `event_lookup` ⬜, `content_lookup` ⬜, `location_lookup` ⬜ | exhibit guides, collection lookups | `public` | — |
| **Weather & Environment** | `forecast_lookup` ⬜, `conditions_lookup` ⬜, `service_alerts` ⬜ | hyperlocal/station feeds | `public` | — |
| **Parks, Outdoors & Natural Places** | `conditions_lookup` ⬜ (trail/beach/snow), `availability_lookup` ⬜ (campsite), `service_alerts` ⬜ (closures/hazard), `hours_lookup` ⬜ | park-specific permits | `public` | — |
| **Automotive** | `inventory_lookup` ⬜, `service_quote` 🔁, `rate_lookup` ⬜ (fuel/EV), `status_lookup` ⬜ (recall), `appointment_availability` 🔁 | dealership-specific tools | `public` | — |
| **Real Estate & Property** | `availability_lookup` ⬜ (listings/rentals), `appointment_book` 🔁 (viewing), `ticket_status` ⬜ (maintenance), `balance_lookup` ⬜ (rent) | tenant portal flows | `public` (listings) / `known_only` (tenant) | personal for tenant data |
| **Fitness & Recreation** | `membership_status` ⬜, `schedule_lookup` ⬜, `availability_lookup` ⬜ (class/court), `reservation_status` ⬜ | class booking app, trainer tools | schedule/availability `public`; membership/reservation `unlisted` | per-family: membership/reservation are personal |
| **Pets & Animals** | `appointment_availability` 🔁, `availability_lookup` ⬜ (boarding/adoption), `price_check` 🔁 (supply) | grooming package builder | `public` | — |
| **Finance & Banking** | `hours_lookup` ⬜, `location_lookup` ⬜ (ATM), `rate_lookup` ⬜, `application_status` ⬜ (loan) | account portals | `public` (branch info) / `known_only` (account) | **no money-movement caps**; sensitive |
| **Insurance** | `claim_status` ⬜, `status_lookup` ⬜ (policy), `quote_request` ⬜, `document_status` ⬜ | carrier claim portals | `public` (quote) / `known_only` (policy) | personal/sensitive |
| **Employment & Careers** | `availability_lookup` ⬜ (postings), `application_status` ⬜, `schedule_lookup` ⬜ (interview), `status_lookup` ⬜ (offer/background) | ATS-specific flows | `public` (postings) / `known_only` (candidate) | personal candidate data |
| **Customer Support & Tickets** | `ticket_status` ⬜, `claim_status` ⬜ (warranty/RMA), `service_request` ⬜ | product-specific support flows | `unlisted` / `known_only` (personal ticket data) | subject auth; status is about a subject |
| **Identity, Credentials & Verification** | `credential_verify` ⬜, `status_lookup` ⬜ (license/cert), `membership_status` ⬜ | issuer-specific portals | `public` (verify) / `known_only` (subject) | `requires_verified_provider`; subject auth |
| **Legal / Compliance / Regulated** | `application_status` ⬜ (permit/license), `document_status` ⬜ (filing/audit), `status_lookup` ⬜ (case) | firm/agency-specific portals | `public` / `known_only` | personal for matter data; `requires_verified_provider` |
| **Care Services** | `availability_lookup` ⬜, `appointment_book` 🔁, `eligibility_check` ⬜ | provider matching flows | `known_only` | sensitive; children/elders; subject auth |
| **Social Services & Benefits** | `eligibility_check` ⬜, `application_status` ⬜, `appointment_availability` 🔁, `document_status` ⬜ | agency-specific case flows | `known_only` | sensitive; subject auth |
| **Immigration, Passport & Consular** | `application_status` ⬜, `document_status` ⬜, `appointment_availability` 🔁, `schedule_lookup` ⬜ | consulate-specific portals | `known_only` | sensitive; `requires_verified_provider`; subject auth |
| **Information, Media & Communications** | `content_lookup` ⬜, `status_lookup` ⬜ (service), `service_alerts` ⬜ | publisher/creator-specific feeds | `public` | content *trust/ranking* is PeerLens, not a capability |
| **Personal & Household Services** | `service_quote` 🔁, `appointment_availability` 🔁, `status_lookup` ⬜ (order/job) | laundry/tailor-specific flows | `public` | — |
| **Facilities & Public Amenities** | `status_lookup` ⬜ (toilet/elevator/access), `location_lookup` ⬜, `availability_lookup` ⬜ (locker), `service_request` ⬜ | building-specific access flows | `public` / `known_only` | access control sensitive |
| **Environmental & Waste Services** | `schedule_lookup` ⬜ (pickup), `service_alerts` ⬜, `conditions_lookup` ⬜ (air/water quality), `location_lookup` ⬜ (disposal) | municipality-specific tools | `public` | — |
| **Community, Worship & Public Safety** | `schedule_lookup` ⬜ (services/events), `event_lookup` ⬜, `incident_status` ⬜, `service_alerts` ⬜, `availability_lookup` ⬜ (shelter) | congregation/org-specific flows | `public` | — |

> Cross-listing (`🔁`) is a one-line `category_ids` edit; `⬜` is a new
> capability (id + schema + policy). Sequence by demand.

## 5 · Provider-specific lane

Public, but scoped to a provider/place/profile/link — **not** generic Dina search.
The official catalog must **not** absorb these:

- House of Prime Rib's special tasting menu · RajSchool's parent homework dashboard ·
  Acme's internal build dashboard · a clinic's custom lab-portal flow · a
  hotel-specific upgrade request · a shop-specific loyalty game.

**Properties:**
- May carry provider-owned (custom/namespaced) capabilities as public *metadata* on
  the provider's page; discoverable only via provider/place/profile/link, never
  generic intent.
- **Verify the provider, not the NSID.** Trust is anchored on the
  provider/place/domain/**DID** (does this entity own the place/domain it claims?).
  The custom capability key is then just *metadata on that verified provider* — it is
  **not** the user-facing identity and **not** the search key. (Provider/DID
  verification is currently unenforced — a known gap.)
- **Mobile V1 authoring:** **public** provider-specific (public + custom) is
  **disabled** in mobile V1 — public+custom can't save without a params/result schema
  the app can't author yet. **Unlisted / private custom capabilities ARE allowed** in
  mobile today (`service-settings.tsx` gates the custom box to non-public). Public
  provider-specific is reachable only by exact NSID/URI until authoring exists.

## 6 · Promotion rule — custom → official

Two **separate** stages — becoming *official* does **not** make a capability
*generic-searchable*.

**Stage A — custom → official shared contract.** Promote when all hold:
1. **Many unrelated providers** need the same workflow (not "RajSchool exists").
2. The **params/result schema is stable** and interoperable.
3. It has a **clear privacy/access policy** (the §3 fields).
4. It can be **rendered safely**.

**Stage B — official → generic intent routing** (a distinct, later decision). Set
`intent_routable: true` **only** if the capability is safe for generic discovery —
the shipped predicate (enforced by catalog integrity):
1. **No `requires_subject_authorization`** — it reads no EXISTING subject data
   (provider-side info like open slots or prices, requester-created requests like
   a new booking or quote, or possession-keyed lookups like a tracking number are
   all fine; "your order / your homework / your appointment" never are).
2. **Finding a NEW provider is the actual use case** — generic routing exists for
   "find me an X", not for data whose provider the user already knows.
3. **Either** no verified provider is required **or** generic routing filters to
   verified providers only (so `credential_verify` *can* eventually be routable,
   but only against verified issuers — until that filter exists, catalog
   integrity rejects routable+verified-required).

`privacy_class: public` is NOT required — `appointment_availability` (personal)
and `service_health_status` (sensitive, public status pages) are deliberately
routable because they satisfy 1+2; the sensitivity gates their LISTING visibility
(validator/ingester), not their vocabulary membership. **Many official
capabilities stay `intent_routable: false` permanently** — e.g.
`school_homework_status` is a legitimate *official shared contract* (Stage A) but
must **never** be generic-routed (Stage B), because it reads subject data.

> Example: `com.rajschool.homework_status` stays provider-specific until *many*
> schools converge on one homework contract → promote to the official
> `school_homework_status` profile (Stage A — which is how it entered the registry, as
> a `beta` status profile). It stops there: `intent_routable: false` forever.

## Never public-official (guardrail)

Must **not** be normal Public-official capabilities — at most **future approved-only**
grant-based flows: payment initiation / money movement / withdrawals; securities or
crypto trades; medical diagnosis; prescription changes; emergency dispatch; legal
filing submission; gambling / betting; adult / controlled-substance services; weapon /
firearm services. (Four Laws: Dina advises and fetches verified truth — it does not
transact, diagnose, dispatch, or file from a public listing.)

## Guardrail tests (status as of 2026-06-10)

The taxonomy is only safe if search enforces it. Status:

1. ✅ Generic `searchCapabilities` **excludes custom** capabilities *(production + mobile stub)*.
2. ✅ Generic `searchCapabilities` filters **`intentRoutable === true`** *(production `search_capabilities.test.ts` + stub parity tests)*.
3. ✅ `school_homework_status` (and every subject-scoped official cap) **never appears in generic search**, even from a discoverable provider *(both sides)*.
4. ✅ Bare family ids (`status_lookup`, `availability_lookup`, …) classify as **unknown** → validator-rejected — i.e. **conceptual until tuple routing exists** *(capability_catalog.test.ts)*. The positive tuple-router test arrives with the first shipped family.
5. ✅ Custom reachable by **exact NSID** (`service_search.test.ts` binds the NSID into the index query) **/ URI** (`service_get_by_uri` resolves unlisted) but never generic intent. Plus: a **non-routable official cap is still exact-searchable** (routing ≠ reachability).
6. ✅ Stub ↔ production parity: registry **drift gate** (byte-identical) + mirrored behavioural cases on both sides.
7. ✅ Validator **rejects `public` + sensitive/regulated** official caps unless `intent_routable && !requires_subject_authorization` *(7 cases incl. alias-bypass; catalog defaults additionally asserted)*.
8. ⬜ **Still open (infra missing):** provider/place/domain/DID verification before a "verified/provider-owned" badge — nothing to test against until verification exists.
9. ✅ **Unlisted behaves as specified:** exact-URI resolves; generic search excludes it; invocation follows the listing's access policy (`isListingPublic` + Core's ingress gate).

## Notes

- **Small core, big map.** ~30 reusable capability shapes/profiles cover most public
  needs; the category map is broad for coverage + developer inspiration; the long tail
  is provider-specific and promoted by demand.
- **Read-first.** Default new capabilities to read; `*_book`/`*_request`/
  `quote_request`/`eligibility_check` are the review-gated exceptions; the guardrail
  list is excluded.
- **Verified state (2026-06-10):** catalog = 10 categories, 13 capabilities (4 `beta`),
  `CATALOG_VERSION 2026-06-09`; ALL SEVEN policy fields exist (`action_class`,
  `privacy_class`, `default_discoverability`, `approval_policy_hint`,
  `intent_routable`, `requires_verified_provider`, `requires_subject_authorization`);
  `school_homework_status` defaults `known_only`; production `searchCapabilities`
  excludes custom AND filters `intentRoutable`; the mobile stub mirrors both; the
  validator rejects public+sensitive. Remaining gaps: provider/DID verification
  (declarative field only) and tuple routing for generic families.
