# Service Provider Tiers — Who Can Serve What, and How Easily

**Status:** design (2026-06-10) · companion to `DINA_SERVICES_PROVIDER_GUIDE.md`,
`PUBLIC_SERVICES_TAXONOMY.md`, and the structured-results chain in `dina_details.md`.

**The question this answers:** *"A user wants to offer a service — what do they actually
do?"* The answer depends on **where the service's answer lives**, which yields three
provider tiers. The design goal: the easiest tier requires **a phone and a sentence** —
no code, no daemon, no server.

---

## The tier model

| | **Tier 1 — Prompt provider** | **Tier 2 — Agent provider** | **Tier 3 — Developer provider** |
|---|---|---|---|
| The answer lives in… | the provider's **head/notes** (maintained knowledge) | their **agent's tools** (files, sheets, browsing, device access) | **external systems** (APIs, fleets, databases) |
| What the provider does | Publish listing + write *"How should Dina answer?"* in plain language; keep facts fresh via `/remember` | Tier 1 + `dina init` on a machine + `dina agent-daemon --runner claude-code\|openclaw-cli\|codex\|gemini` | Tier 2 + write a runner / MCP tool (`AgentRunner` protocol or MCP binding) |
| Execution plane | **their own Dina, in-process** (`LocalDelegationRunner` + brain `runCapability`: instruction + params + vault search → schema-constrained LLM output) | their paired headless agent executes the task envelope | custom runner / MCP server |
| Infrastructure | phone, on and connected | + one always-on machine with the agent CLI | + whatever the integration needs |
| Update mechanism | **talking to their own Dina** (`/remember price changed`) — zero new behavior | same, plus the agent's own data sources | code/config deploys |
| Volume envelope | dozens/day | hundreds/day | whatever the backend takes |
| Status | **to build** (instruction field + brain runCapability + local-runner routing; LocalDelegationRunner + Response-Bridge validation already exist) | mostly built (runners shipped; needs the **structured envelope** for `service_query_execution` tasks) | shipped (bus42/stub pattern, MCP binding) |

**Structure safety is tier-independent**: every tier's output passes the frozen
`schemaSnapshot` validation at the Response Bridge — a Tier 1 LLM answer that doesn't
conform becomes a clean `result_schema_violation` error, never garbage. This is what makes
*prompt-as-handler* safe.

**Tier 1's real competitor is not an API — it is "call the guy and wait."** Every Tier 1
scenario below is, today, a phone call or a WhatsApp message answered at the provider's
convenience. Tier 1 makes the knowledge they already maintain queryable 24/7, with privacy
gates (visibility + grants) no business platform offers.

---

## The defining test per tier

Ask: **"Could the provider answer this question right now, from memory or their notes,
over the phone?"**

- Yes, and the facts change at human cadence → **Tier 1**.
- Only by looking at their computer/files/a website → **Tier 2**.
- Only a machine can answer (live sensors, big data, transactions) → **Tier 3**.

A second axis decides **visibility** (from `PUBLIC_SERVICES_TAXONOMY.md`): generic
discoverable → `public`; share-by-link → `unlisted`; per-person, subject-scoped →
`known_only` + grant (and subject-scoped capabilities are *never* generically routable).

---

## Service catalog — candidate services by domain and tier

Capability column: canonical names from the catalog where one fits; `custom:` prefix where
the provider-specific lane applies. Visibility column is the *natural* fit.

### Commerce & retail

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Price & availability of goods | corner shop, bakery, farm stall, bookstore | `price_check` | **1** | public | The archetype. Rate card + `/remember mangoes out till Thu`. |
| Shop hours / open today? | any small shop | `service_health_status` | **1** | public | "As-of" discipline matters (holiday closures). |
| Custom-order status | baker, tailor, cobbler, framer | `order_status` | **1** | known_only | Subject-scoped → grant per customer. "Emma's cake: ready Friday." |
| Bulk/wholesale quote | wholesaler, caterer | `service_quote` | **1–2** | public/unlisted | Judgment over a rate card = prompt; complex tiered pricing → agent + sheet. |
| Live inventory at scale | supermarket, pharmacy chain | `price_check` | **3** | public | Needs the POS system; never Tier 1. |
| Product catalog Q&A | artisan, boutique | `custom:catalog_query` | **2** | public | Agent reads their catalog file/photos. |

### Trades & sole practitioners

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Job quote estimate | electrician, plumber, painter, carpenter | `service_quote` | **1** | public | The strongest Tier 1 category: quotes ARE judgment + rate card. Will never have an API otherwise. |
| Availability window | the same trades | `appointment_availability` | **1** | public | "Mornings this week, not Thursday." Calendar-precision → Tier 2. |
| Take a booking | barber, mechanic, tutor | `appointment_book` | **1** | public | `responsePolicy: review` → approval card → human confirms. Async-by-design matches how they already work. |
| Repair status | phone/laptop/shoe repair | `order_status` | **1** | known_only | "Your laptop: part arrived, ready Tuesday." |
| Service-area check | mobile trades | `custom:serves_area` | **1** | public | "Do you come to Indiranagar?" — pure instruction. |

### Education & care

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Homework / class status | teacher | `school_homework_status` | **1** | known_only | The canonical known_only case; parents hold grants. Catalog already defaults this to known_only. |
| Daycare day-summary | daycare worker | `custom:day_summary` | **1** | known_only | Subject-scoped, deeply private — grants only. |
| Tutor slots + rates | tutor | `appointment_availability`, `price_check` | **1** | public | |
| Course/exam schedule | coaching center | `service_health_status`/custom | **1** | public/unlisted | |
| School-wide notices | school office | `custom:notices` | **1–2** | unlisted | Link shared to parent group; agent if sourced from a portal. |

### Food & hospitality

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Today's menu / specials | home kitchen, tiffin service, café | `custom:menu_today` | **1** | public | Updated by `/remember` each morning. |
| Table/booking request | small restaurant | `appointment_book` | **1** | public | review-policy human confirm. |
| Tiffin subscription status | tiffin service | `order_status` | **1** | known_only | |
| Room availability | homestay, small B&B | `appointment_availability` | **1–2** | public | Few rooms = head-knowledge; many = calendar/agent. |
| Delivery ETA (own delivery) | the same kitchens | `delivery_eta` | **1** | known_only | Subject-scoped; "your order leaves at 1pm." |

### Transport & logistics

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Schedule-based ETA | bus/van operator who knows their route | `eta_query` | **1** | public | Works in the "schedule + my own updates" flavor only. |
| Live-GPS ETA | fleet operator | `eta_query` | **3** | public | Needs telemetry; the bus42 stub stands in for this. |
| Auto/taxi availability | individual driver | `custom:available_now` | **1** | public/unlisted | "Am I free for an airport run tomorrow 6am?" |
| Package tracking | courier company | `package_tracking` | **3** | public | Carrier systems. |
| Movers' quote | small moving crew | `service_quote` | **1** | public | |

### Community & civic

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Temple/church/mosque timings | office volunteer | `service_health_status` | **1** | public | Kills the "answered 40× in the WhatsApp group" problem. |
| Society/building status | building manager | `custom:building_status` | **1** | unlisted/known_only | "Water off today?" — residents hold the link/grants. |
| Club/league schedule | club secretary | `custom:schedule` | **1** | unlisted | |
| Library book check | librarian | `custom:book_lookup` | **1–2** | public | Small library = memory; cataloged = agent over the catalog. |
| Event info | organizer | `service_health_status`/custom | **1** | public/unlisted | |

### Professional & knowledge services

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Consult slots + fees | doctor, lawyer, accountant, therapist | `appointment_availability`, `price_check` | **1** | public | The *answering* is Tier 1 even when the work isn't. |
| Appointment status | clinic | `appointment_status` | **1–2** | known_only | Subject-scoped; clinic-scale → agent over their book. |
| Document-ready status | notary, registrar agent, visa agent | `order_status` | **1** | known_only | |
| Domain Q&A (paid later) | consultant, astrologer, nutritionist | `custom:domain_qa` | **1–2** | public/unlisted | Pairs with PeerLens trust; payments later per roadmap. |
| Case status | small law office | `order_status` | **2** | known_only | Usually lives in files → agent. |

### Devices & technical (for completeness)

| Service | Example provider | Capability | Tier | Visibility | Notes |
|---|---|---|---|---|---|
| Home device status | self-hoster | `device_status` | **3** | known_only | Needs device integration; subject-scoped. |
| CI/deploy status | dev team | `deploy_status` | **2–3** | known_only | Agent over CI, or API runner. |
| Hosted API façade | any business with an API | any | **3** | public | The classic developer provider. |

### Out of scope at any tier

Payments/transfers (cart-handover Law — Dina advises, never moves money), anything
requiring real-time sensors the provider doesn't have, high-QPS public utilities, and
medical/legal *advice* presented as authoritative (liability — the provider answers as
themselves; Dina is the channel).

---

## Patterns visible in the catalog

1. **Tier 1 dominates the long tail.** Roughly 70% of rows are Tier 1 — and they are
   precisely the providers no platform has ever onboarded, because every existing model
   assumes either code or a dashboard. The supply side of the network can start from
   non-developers.
2. **`service_quote` and `order_status` are the killer Tier 1 capabilities** — judgment
   over a rate card, and status-by-human. Both already exist in the canonical catalog.
3. **known_only + Tier 1 is a natural pair**: subject-scoped answers (your cake, your
   homework, your repair) are human-scale by nature — low volume, high trust, grant-gated.
   The taxonomy's subject-authorization rules and Tier 1's capacity envelope coincide.
4. **The same provider climbs tiers per capability, not wholesale**: a clinic can be
   Tier 1 for hours/fees and Tier 2 for appointment_status. Tiers attach to capabilities
   (the `mcpServer`/`requested_runner` routing already supports exactly this per-capability
   split).
5. **`responsePolicy: review` is Tier 1's transactional escape hatch** — anything that
   *commits* the provider (a booking) routes through an approval card instead of
   auto-answering. Async human confirmation is how these businesses already operate.

## Design requirements distilled (Tier 1 build)

1. **Instruction field** (`howToAnswer`) per capability on the service config + listing
   editor UI. It is a prompt, not config — free text.
2. **Brain `runCapability`**: agentic call = instruction + params + vault search +
   capability result schema (native structured output where the provider supports it) →
   JSON. Plugged into the existing `LocalDelegationRunner` (already wired in mobile boot,
   currently demo-gated).
3. **Routing**: capabilities without an `mcpServer` binding and with no paired agent route
   to the local runner instead of warning `provider has no execution plane`.
4. **As-of / staleness discipline**: instructions carry their last-updated time; the prompt
   is told to prefer "unsure/ask the provider" over stale-confident; responses may carry
   "as of <when>".
5. **Prerequisite: relay reliability** — Tier 1 rides on the phone's MsgBox WebSocket;
   the idle-staleness finding (no auto-reconnect, found live 2026-06-10) graduates from P2
   to a Tier 1 blocker. Heartbeat + reconnect first.
6. **Tier 2 follow-up**: the structured task envelope for headless runners
   (params JSON + JSON-only stdout contract + extraction) so paired agents can serve
   declared capabilities; the Response Bridge already protects the requester either way.
