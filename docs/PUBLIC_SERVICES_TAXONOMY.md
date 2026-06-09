# Public Services Taxonomy — Exhaustive Coverage Target

> **Status:** planning document (not code). Companion to
> `SERVICE_CAPABILITY_CATALOG_DESIGN.md`. This is the target the canonical
> capability catalog should grow toward; it is **not** the current catalog.

## Why this document exists

A **Public** listing can only advertise **canonical** capabilities (the closed,
shared registry). The custom (reverse-DNS) path is deferred for Public, because a
public custom capability needs a params/result schema the app can't author yet
(`validateServiceListing` §8.1). The practical consequence:

- **Public providers can only publish a service type the canonical catalog already
  covers.** If "pharmacy refill status" isn't in the registry, a pharmacy can't go
  Public for it — it would fall to custom, which Public doesn't allow.
- **Unlisted / Private don't have this problem** — they can use custom capabilities
  freely (no schema required), so an incomplete catalog only pinches them at the
  edges.

So the catalog must be **exhaustive for Public** specifically. This document
enumerates the universe of public **service types** (not capabilities — services)
so the registry can be grown to cover the long tail, vertical by vertical.

## How to read this

- The unit here is a **service type** — the kind of real-world service a provider
  runs (e.g. "city bus", "pharmacy", "DMV"). A concrete listing ("Bus 42",
  "CVS on Main St") is an instance of one.
- Each service type lists the **canonical capabilities** it would advertise.
  Capabilities are mostly **read/query** (Dina's pull model: fetch verified status
  on demand). A few are **actions** (book, reserve).
  - ✅ = capability exists in the catalog today.
  - ⬜ = **gap** — proposed capability to add for Public coverage.
- Capabilities are **cross-category** (catalog §9.1): the same capability id can
  serve many service types. A small set of "shapes" (status / availability / ETA /
  price / balance / book) covers most of the surface — see
  [§13 Capability shapes](#13-capability-shapes).

## Current catalog snapshot (the "fair list")

**10 categories:** Developer Tools & Operations, Home/Personal/IoT Automations,
Transit & Mobility, Commerce & Retail, Appointments & Bookings, School &
Education, Home/Repairs/Local Services, Logistics/Delivery/Postal, Professional
Services, Healthcare & Wellness.

**13 capabilities:** `eta_query`, `appointment_status`, `price_check`,
`appointment_availability`, `appointment_book`, `order_status`, `package_tracking`,
`delivery_eta`, `service_health_status`, `deploy_status`, `school_homework_status`,
`service_quote`, `device_status`.

That's broad but shallow — most categories have 1–2 capabilities and miss the bulk
of their real service types. The rest of this doc fills that in.

---

# Part A — Service types within the existing 10 categories

### 1. Transit & Mobility (`transit`)

| Service type | Canonical capabilities |
|---|---|
| City bus / public transit | `eta_query` ✅, `route_info` ⬜, `service_alerts` ⬜, `fare_info` ⬜ |
| Subway / metro / light rail | `eta_query` ✅, `line_status` ⬜, `station_info` ⬜ |
| Commuter / intercity rail | `schedule_lookup` ⬜, `vehicle_status` ⬜ (delays), `platform_info` ⬜ |
| Ride-hailing / taxi | `ride_eta` ⬜, `fare_estimate` ⬜, `ride_status` ⬜ |
| Bike / scooter share | `vehicle_availability` ⬜, `dock_availability` ⬜ |
| Ferry / water taxi | `schedule_lookup` ⬜, `departure_status` ⬜ |
| Parking (garage / lot / street) | `parking_availability` ⬜, `parking_rate` ⬜ |
| EV charging network | `charger_availability` ⬜, `charging_status` ⬜ |
| Toll road / bridge | `toll_rate` ⬜, `traffic_status` ⬜ |
| Car / van rental | `vehicle_availability` ⬜, `booking_status` ⬜ |

### 2. Commerce & Retail (`commerce`)

| Service type | Canonical capabilities |
|---|---|
| Brick-and-mortar shop | `price_check` ✅, `stock_availability` ⬜, `store_hours` ⬜ |
| E-commerce store | `order_status` ✅, `price_check` ✅, `return_status` ⬜, `shipping_status` ⬜ |
| Grocery / supermarket | `price_check` ✅, `stock_availability` ⬜, `store_hours` ⬜ |
| Restaurant / café (ordering) | `menu_lookup` ⬜, `order_status` ✅, `wait_time` ⬜, `store_hours` ⬜ |
| Marketplace seller | `listing_status` ⬜, `order_status` ✅ |
| Loyalty / rewards program | `points_balance` ⬜, `offer_lookup` ⬜ |
| Gift cards | `balance_check` ⬜ |
| Subscription box | `subscription_status` ⬜, `next_shipment` ⬜ |
| Auction house | `auction_status` ⬜, `bid_status` ⬜ |

### 3. Appointments & Bookings (`appointments`)

| Service type | Canonical capabilities |
|---|---|
| Salon / barber / spa | `appointment_availability` ✅, `appointment_book` ✅, `appointment_status` ✅ |
| Fitness studio / gym class | `class_schedule` ⬜, `class_availability` ⬜, `membership_status` ⬜ |
| Consultant / coach (non-pro) | `appointment_availability` ✅, `appointment_book` ✅ |
| Restaurant reservation | `table_availability` ⬜, `reservation_status` ⬜ |
| Event / venue booking | `ticket_availability` ⬜, `booking_status` ⬜ |
| Photographer / event vendor | `appointment_availability` ✅, `booking_status` ⬜ |
| Tutoring (non-school) | `appointment_availability` ✅, `appointment_book` ✅ |

### 4. School & Education (`school`)

| Service type | Canonical capabilities |
|---|---|
| K-12 school | `school_homework_status` ✅, `grade_lookup` ⬜, `attendance_status` ⬜, `class_schedule` ⬜, `lunch_menu` ⬜, `school_calendar` ⬜, `closure_alerts` ⬜ |
| College / university | `enrollment_status` ⬜, `grade_lookup` ⬜, `course_availability` ⬜, `tuition_balance` ⬜, `exam_schedule` ⬜ |
| Tutoring center | `class_schedule` ⬜, `progress_status` ⬜ |
| Online course / MOOC | `course_progress` ⬜, `certificate_status` ⬜ |
| Public library | `catalog_lookup` ⬜, `item_availability` ⬜, `loan_status` ⬜, `store_hours` ⬜ |
| Exam board / test prep | `exam_schedule` ⬜, `result_status` ⬜ |

### 5. Healthcare & Wellness (`healthcare`)

> Health is a **sensitive** vertical — most of these stay Unlisted/Private in
> practice. Listed here for completeness; Public exposure should be conservative.

| Service type | Canonical capabilities |
|---|---|
| Doctor / clinic | `appointment_availability` ✅, `appointment_book` ✅, `appointment_status` ✅, `wait_time` ⬜ |
| Dentist | `appointment_availability` ✅, `appointment_book` ✅ |
| Pharmacy | `prescription_status` ⬜, `refill_status` ⬜, `medication_price` ⬜, `stock_availability` ⬜, `store_hours` ⬜ |
| Lab / diagnostics | `result_status` ⬜, `appointment_availability` ✅ |
| Hospital / ER / urgent care | `wait_time` ⬜, `bed_availability` ⬜ |
| Therapist / mental health | `appointment_availability` ✅, `appointment_book` ✅ |
| Veterinary | `appointment_availability` ✅, `appointment_book` ✅ |
| Optometry | `appointment_availability` ✅, `order_status` ✅ (glasses) |
| Vaccination clinic | `slot_availability` ⬜ (≈ `appointment_availability`), `appointment_book` ✅ |

### 6. Home, Repairs & Local Services (`home_local`)

| Service type | Canonical capabilities |
|---|---|
| Plumber / electrician / handyman | `service_quote` ✅, `appointment_availability` ✅, `job_status` ⬜ |
| Cleaning service | `service_quote` ✅, `appointment_availability` ✅, `booking_status` ⬜ |
| HVAC | `service_quote` ✅, `appointment_availability` ✅ |
| Landscaping / lawn | `service_quote` ✅, `class_schedule` ⬜ (visit schedule) |
| Pest control | `service_quote` ✅, `appointment_availability` ✅ |
| Moving / hauling | `service_quote` ✅, `booking_status` ⬜ |
| Locksmith | `service_quote` ✅, `eta_query` ✅ |
| Appliance repair | `service_quote` ✅, `job_status` ⬜ |
| Painter / general contractor | `service_quote` ✅, `project_status` ⬜ |

### 7. Logistics, Delivery & Postal (`logistics`)

| Service type | Canonical capabilities |
|---|---|
| Courier / parcel carrier | `package_tracking` ✅, `delivery_eta` ✅ |
| Postal service | `package_tracking` ✅, `mail_status` ⬜ |
| Food delivery | `delivery_eta` ✅, `order_status` ✅ |
| Grocery delivery | `delivery_eta` ✅, `order_status` ✅ |
| Freight / LTL | `shipment_tracking` ⬜ (≈ `package_tracking`), `delivery_eta` ✅ |
| Same-day local courier | `delivery_eta` ✅, `pickup_status` ⬜ |
| Locker / pickup point | `locker_status` ⬜ |
| Returns / drop-off | `return_status` ⬜ |

### 8. Professional Services (`professional`)

| Service type | Canonical capabilities |
|---|---|
| Lawyer / legal | `appointment_availability` ✅, `case_status` ⬜ |
| Accountant / tax | `appointment_availability` ✅, `filing_status` ⬜ |
| Consultant / agency | `appointment_availability` ✅, `project_status` ⬜ |
| Insurance agent / broker | `quote_request` ⬜, `claim_status` ⬜, `policy_status` ⬜ |
| Real-estate agent | `listing_availability` ⬜, `viewing_book` ⬜ (≈ `appointment_book`) |
| Financial advisor | `appointment_availability` ✅ |
| Notary | `appointment_availability` ✅ |
| Freelancer (translation/design) | `quote_request` ⬜, `job_status` ⬜ |

### 9. Developer Tools & Operations (`developer_ops`)

| Service type | Canonical capabilities |
|---|---|
| API / SaaS provider | `service_health_status` ✅, `incident_status` ⬜, `sla_status` ⬜ |
| Cloud / infra | `service_health_status` ✅, `region_status` ⬜ |
| CI/CD pipeline | `build_status` ⬜, `deploy_status` ✅ |
| Status page / monitoring | `incident_status` ⬜, `uptime_status` ⬜ |
| Package registry | `version_lookup` ⬜ |
| App store / release channel | `release_status` ⬜ (≈ `deploy_status`) |

### 10. Home, Personal & IoT Automations (`home_iot`)

| Service type | Canonical capabilities |
|---|---|
| Smart-home hub | `device_status` ✅, `automation_status` ⬜ |
| Security / camera | `alarm_status` ⬜, `device_status` ✅ |
| Thermostat / climate | `device_status` ✅, `sensor_reading` ⬜ |
| Energy / solar | `energy_usage` ⬜, `production_status` ⬜ |
| Environmental sensors | `sensor_reading` ⬜ |
| Smart appliances | `device_status` ✅ |
| Pet feeder / tracker | `device_status` ✅ |

---

# Part B — Proposed NEW categories needed for full Public coverage

The 10 existing categories miss whole verticals a public directory needs. These
are candidate additions (each would seed several capabilities):

### 11. Government & Civic (`government`)
DMV / motor vehicles (`wait_time` ⬜, `appointment_availability` ✅,
`document_status` ⬜), permits & licensing (`application_status` ⬜), tax authority
(`filing_status` ⬜, `refund_status` ⬜), public records (`record_lookup` ⬜),
waste / recycling (`pickup_schedule` ⬜), elections (`polling_info` ⬜,
`registration_status` ⬜), courts (`case_status` ⬜).

### 12. Utilities & Energy (`utilities`)
Electric / water / gas (`outage_status` ⬜, `usage_lookup` ⬜, `bill_balance` ⬜),
internet / telecom (`outage_status` ⬜, `account_status` ⬜).

### 13. Travel & Hospitality (`travel`)
Hotels / lodging (`room_availability` ⬜, `reservation_status` ⬜), airlines
(`flight_status` ⬜, `gate_info` ⬜), vacation rentals (`booking_status` ⬜), tours
/ activities (`availability` ⬜).
*(Flight status could also live under Transit — capabilities are cross-category.)*

### 14. Entertainment & Events (`entertainment`)
Cinema (`showtimes` ⬜, `seat_availability` ⬜), live events / concerts
(`ticket_availability` ⬜, `event_status` ⬜), sports (`score_lookup` ⬜,
`fixture_schedule` ⬜), museums / attractions (`store_hours` ⬜,
`ticket_availability` ⬜), streaming (`content_lookup` ⬜).

### 15. Weather & Environment (`weather`)
Weather forecast (`forecast_lookup` ⬜), air quality (`air_quality` ⬜), pollen /
UV (`index_lookup` ⬜), tides / marine (`tide_lookup` ⬜), ski / surf conditions
(`conditions_lookup` ⬜). *(Read-only, high-fanout — natural Pull-Economy fits.)*

### 16. Automotive (`automotive`)
Dealership (`inventory_lookup` ⬜, `appointment_availability` ✅), auto repair /
service (`service_quote` ✅, `job_status` ⬜), fuel / EV pricing
(`fuel_price` ⬜), recalls (`recall_lookup` ⬜).

### 17. Finance & Banking (`finance`)
> **Sensitive + Dina's no-money rule** (Cart Handover: advise, never transact).
> Read-only status only; never an action capability that moves funds.

Bank / credit union (`branch_hours` ⬜, `atm_locator` ⬜, `rate_lookup` ⬜),
account status (`balance_check` ⬜ — Private only, realistically), loan / mortgage
(`application_status` ⬜).

### 18. Community & Public Safety (`community`)
Road / traffic alerts (`traffic_status` ⬜, `road_closures` ⬜), emergency alerts
(`alert_status` ⬜), food banks / shelters (`availability` ⬜, `store_hours` ⬜),
nonprofits / community events (`event_status` ⬜).

---

# §13 Capability shapes

Across all the above, most capabilities collapse into a handful of reusable
**shapes**. Defining the shape once (params/result schema) and reusing it keeps the
registry small even as coverage gets exhaustive:

| Shape | Examples | Reads… |
|---|---|---|
| **status** | `order_status`, `appointment_status`, `claim_status`, `flight_status`, `incident_status`, `application_status` | the state of one known thing |
| **availability** | `appointment_availability`, `stock_availability`, `room_availability`, `parking_availability`, `seat_availability` | what's free / in-stock to grab |
| **eta** | `eta_query`, `delivery_eta`, `ride_eta` | when something arrives |
| **price / quote** | `price_check`, `service_quote`, `fare_estimate`, `quote_request` | what it costs |
| **balance** | `points_balance`, `gift card balance`, `bill_balance`, `tuition_balance` | a numeric account value |
| **schedule / hours** | `class_schedule`, `school_calendar`, `store_hours`, `showtimes` | when it's open / when things happen |
| **lookup** | `menu_lookup`, `catalog_lookup`, `route_info`, `forecast_lookup` | reference data |
| **book** (action) | `appointment_book`, `reservation_status`-create, `viewing_book` | creates/holds a slot — review-gated |

**Implication for growing the catalog:** prefer adding a service type by mapping it
to an *existing shape* (e.g. a pharmacy refill is a `status` read) before minting a
brand-new capability id. That keeps Public coverage exhaustive without exploding the
registry.

---

## Notes & guardrails

- **Read-first.** Dina's model is pull/verify; default new capabilities to read-only
  status/availability/lookup. `book` / write actions are the exception and are
  review-gated (catalog write/booking rule).
- **Sensitive verticals** (Healthcare, Finance, parts of Government) belong mostly to
  Unlisted/Private. They're listed here for taxonomy completeness, not as a push to
  make them Public by default.
- **Cross-category is fine.** Don't duplicate a capability per category; one id with
  multiple `category_ids` (e.g. `appointment_availability` already spans 4) is the
  pattern.
- **This is the target, not a migration.** Promoting a ⬜ to ✅ means adding it to the
  canonical registry with params/result schemas — sequence by demand, not all at
  once.
