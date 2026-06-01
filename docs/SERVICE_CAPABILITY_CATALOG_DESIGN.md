# Service Capability Catalog — AppView Source of Truth

Status: Design / implementation handoff.

Purpose: define the official Dina service capability catalog that AppView serves and mobile consumes. This prevents providers from inventing random common capability names, while still allowing advanced provider-owned custom capabilities such as `com.rajschool.homework_status`.

This document is intentionally broader than the current shipped registry. Current code has a small launch registry (`eta_query`, `appointment_status`, `price_check`) plus namespaced custom capability support. This document defines the product architecture and a proposed catalog expansion path for Claude to validate before implementation.

---

## 1. Core Product Model

Dina service creation should feel simple to normal users/providers:

```txt
Add service
-> Choose category
-> Choose what this service can answer/do
-> Fill details/schema/automation
-> Publish
```

The user should not type common capability names directly.

Correct model:

```txt
Category -> Official capability -> Provider listing
```

Examples:

```txt
Transit -> ETA / arrival time -> eta_query
Commerce -> Price and availability -> price_check
School -> Homework status -> school_homework_status
Healthcare -> Appointment status -> appointment_status
Developer Tools -> Service health status -> service_health_status
Security -> Vulnerability status -> vulnerability_status
Data Operations -> Backup status -> backup_status
```

Important distinction:

- Category is product/UI grouping.
- Capability is the wire contract.
- Provider listing is one concrete service published by one DID.

Categories are not used for routing by themselves. Routing uses capability IDs and schemas.

---

## 2. Architecture Decision

The official capability catalog should be served by AppView / protocol-owned infrastructure, not hardcoded only in mobile.

Reason:

- Mobile and AppView must share the same source of truth.
- New official capabilities can be added without app release.
- Deprecation/promotion can be handled centrally.
- The LLM/router, provider setup UI, and AppView search all use the same definitions.
- Prevents namespace drift like `eta_query`, `bus_eta`, `arrival_time`, `next_bus` becoming separate markets.

Mobile should fetch and cache the catalog.

```txt
AppView official catalog -> mobile cache -> provider setup UI
AppView official catalog -> service search / intent mapping
AppView official catalog -> Brain routing hints
```

Mobile can ship a small fallback catalog for offline setup, but it must be treated as fallback only. AppView catalog wins when available.

Implementation note:

- AppView should serve the runtime catalog.
- `@dina/protocol` should expose the same schema/types and may include a generated fallback snapshot.
- Avoid hand-maintained divergent copies. If both AppView and protocol need local registry data, generate them from one catalog source or keep an explicit drift test.

---

## 3. Common vs Custom Capabilities

### 3.1 Official common capability

Use for capabilities that many providers can implement.

Examples:

```txt
eta_query
appointment_status
price_check
order_status
package_tracking
reservation_availability
school_homework_status
```

Properties:

- Comes from Dina/AppView official catalog.
- Has stable canonical ID.
- Has aliases for search/canonicalization.
- Has params/result schema.
- Can be ranked across providers.
- Can drive standard cards.
- Should be selectable from dropdown/categories.

Providers should not invent official/common names.

### 3.2 Provider-owned custom capability

Use when a provider has a specific function that is not yet an official common capability.

Examples:

```txt
com.rajschool.homework_status
com.acme.banana_inventory
org.citylibrary.book_hold_status
```

Properties:

- Provider-defined.
- Reverse-DNS/namespaced.
- Own schema required for serious/public use.
- Discoverable, but visually labeled as custom/provider-defined.
- No alias folding unless the namespace owner defines it inside the listing.
- Not automatically treated as official Dina capability.

Custom capability is useful because it gives typed, scoped service invocation without opening a personal D2D channel. Its main value is service semantics, not broad marketplace discovery.

### 3.3 Promotion path

A custom capability can be promoted later if many providers converge on the same workflow.

```txt
com.rajschool.homework_status
com.greenschool.homework_status
com.sunriseacademy.homework_status
        ↓
school_homework_status official capability
```

Promotion should preserve compatibility by adding aliases/migration guidance, not by silently rewriting provider semantics.

---

## 4. Naming Rules

### 4.1 Existing official IDs stay as-is

Do not rename shipped canonical capabilities casually. Current examples:

```txt
eta_query
appointment_status
price_check
```

These are already in tests/demos/configs. Cleaner names can be aliases, but canonical IDs should remain stable.

### 4.2 New official IDs

Use stable snake_case, verb/object oriented, not provider-specific.

Good:

```txt
package_tracking
reservation_availability
school_homework_status
order_status
service_quote
```

Bad:

```txt
raj_homework
bus_stuff
ask_shop
get_info
thing_status
```

### 4.3 Custom IDs

Use reverse-DNS style dotted names.

Good:

```txt
com.rajschool.homework_status
com.acme.banana_inventory
org.citylibrary.book_hold_status
```

Bad:

```txt
homework
banana
rajschool_homework
custom1
```

---

## 5. Catalog Delivery Contract

Proposed endpoint:

```txt
GET /xrpc/com.dinakernel.catalog.capabilities
```

Optional filters:

```txt
?locale=en-US
?platform=mobile
?include=schemas,display,examples
?sinceVersion=2026-06-01
```

Response shape:

```ts
type CapabilityCatalog = {
  catalog_version: string;        // monotonically increasing semantic/date version
  catalog_hash: string;           // canonical hash of full payload
  generated_at: string;           // ISO timestamp
  min_client_version?: string;
  categories: CatalogCategory[];
  capabilities: CapabilityDefinition[];
  deprecated_capabilities: DeprecatedCapability[];
  signature?: CatalogSignature;   // recommended after V1
};

type CatalogCategory = {
  id: string;                     // transit, commerce, school
  display_name: string;           // Transit
  short_description: string;
  long_description?: string;
  icon?: string;                  // symbolic icon key, not arbitrary remote asset
  sort_order: number;
  lifecycle: 'stable' | 'beta' | 'hidden';
};

type CapabilityDefinition = {
  id: string;                     // canonical capability ID
  category_ids: string[];         // allowed/default UI categories for this capability
  default_category_id?: string;   // optional default for simple UIs
  display_name: string;
  short_description: string;
  long_description?: string;
  aliases: string[];
  lifecycle: 'draft' | 'beta' | 'stable' | 'deprecated' | 'retired';
  action_class: 'read' | 'quote' | 'write' | 'booking' | 'payment' | 'agentic';
  privacy_class: 'public' | 'personal' | 'sensitive' | 'regulated';
  identity_requirement: 'none' | 'requester_did' | 'account_id' | 'subject_id' | 'provider_auth';
  location_requirement: 'none' | 'optional' | 'required';
  time_sensitivity: 'low' | 'medium' | 'high' | 'real_time';
  params_schema: JsonSchema;
  result_schema: JsonSchema;
  display_template?: DisplayTemplateRef;
  example_user_queries: string[];
  example_provider_types: string[];
  approval_policy_hint: 'none' | 'confirm_before_send' | 'confirm_before_action' | 'always_approval';
  cache_policy_hint: 'no_cache' | 'short_ttl' | 'medium_ttl' | 'long_ttl';
  introduced_in: string;
};

type DeprecatedCapability = {
  id: string;
  replacement_id?: string;
  deprecated_at: string;
  removal_not_before?: string;
  reason: string;
};
```

Notes:

- Remote catalog is trusted only if fetched from official AppView over TLS and validated.
- For stronger integrity, sign the catalog or pin its hash through app config.
- Mobile should validate response shape before using it.
- Provider-published custom schemas remain untrusted even if indexed by AppView.
- Capability definitions may be cross-category. Example: `appointment_availability` can be used by healthcare, salons, government offices, and professional services. The provider listing must carry the concrete category/vertical chosen for that service instance.

---

## 5.1 Provider Listing Contract

The catalog defines official capabilities. A provider listing defines one concrete service offered by one DID/rkey.

Minimum provider listing fields AppView should index:

```ts
type ProviderServiceListing = {
  service_uri: string;              // AT URI, includes rkey
  rkey: string;
  provider_did: string;
  display_name: string;
  description: string;
  capability: string;               // official ID or namespaced custom ID
  capability_kind: 'official' | 'custom';
  category_id: string;              // concrete vertical for this listing
  discoverability: 'public' | 'unlisted' | 'known_only';
  access_policy_hint?: 'anyone' | 'authenticated' | 'invited' | 'paired_dids' | 'owner_only' | 'provider_defined';
  rate_limit_hint?: 'none' | 'low' | 'medium' | 'high' | 'provider_defined';
  pricing_hint?: 'free' | 'paid' | 'quote_required' | 'provider_defined';
  freshness_hint?: 'real_time' | 'short_ttl' | 'medium_ttl' | 'long_ttl' | 'provider_defined';
  schema_hash: string;
  params_schema: JsonSchema;
  result_schema: JsonSchema;
  response_policy: 'auto' | 'approval_required' | 'manual' | 'disabled';
  service_area?: ServiceArea;
  specialties?: string[];           // ENT, tax, plumber, pediatric, etc.
  provider_type?: string;           // clinic, school, store, courier, etc.
  lifecycle: 'active' | 'paused' | 'deprecated' | 'tombstoned';
  verified_provider?: boolean;
  verified_namespace?: boolean;
  updated_at: string;
};
```

Validation:

- If `capability_kind = official`, `capability` must exist in the official catalog.
- If `capability_kind = official`, `category_id` must be allowed by the capability's `category_ids`.
- If `capability_kind = custom`, `capability` must be namespaced and `category_id` is still required.
- AppView search should be able to filter by both `capability` and `category_id`.
- Provider listing category is not cosmetic. It controls policy, consent, ranking, and result-card expectations.
- `discoverability` is required. Capability identity and public discoverability are separate decisions.
- V1 may store the optional hint fields but should not depend on them for enforcement. Provider-side authorization remains provider-defined.

Example:

```txt
capability: appointment_availability
category_id: healthcare
specialties: ["ENT"]
```

is different from:

```txt
capability: appointment_availability
category_id: local_services
specialties: ["haircut"]
```

Same action shape, different domain policy.

---

## 5.2 Discoverability Modes

Publishing a service must include an explicit discoverability value.

Recommended field:

```ts
discoverability: 'public' | 'unlisted' | 'known_only'
```

This controls discovery, not execution authorization.

```txt
discoverability != authorization
```

A public service can still reject unauthorized params. A known-only service can still be invoked through a known binding/pairing.

### `public`

Appears in normal AppView service search and capability discovery.

Use for services intended to be found by strangers:

```txt
bus ETA
store price check
restaurant reservation
public clinic appointment availability
public SaaS status page integration
```

### `unlisted`

Does not appear in broad search. Can be resolved by exact service URI/link/QR/invite if the user has it.

Use for:

```txt
school parent portal
partner integration
private beta provider
team-only service
```

### `known_only`

Not searchable. Intended only for local known-service bindings, pairing, or explicit trusted relationships.

Use for:

```txt
company API health
internal CI/CD status
private logs/metrics
personal/home-node automations
team-only operational tools
```

V1 behavior:

- `public` appears in normal AppView search.
- `unlisted` does not appear in normal search; exact lookup/link handling may be added if supported.
- `known_only` does not appear in normal search or public lookup.

If exact-link lookup and pairing proof are not implemented yet, treat `unlisted` and `known_only` conservatively:

```txt
not returned by normal AppView search
invoked only if local Dina already has the service profile/binding
```

Default recommendations:

| Service type | Default discoverability |
|---|---|
| Official public marketplace service | `public` |
| Custom provider capability | `unlisted` |
| School/parent portal | `unlisted` |
| Developer/ops/internal service | `known_only` |
| Logs/metrics/CI/CD/internal automation | `known_only` |
| Sensitive healthcare/finance/employment provider | `unlisted` unless intentionally public |

Mobile publish copy:

```txt
Who can find this service?

Public
Anyone can find this service in Dina search.

Unlisted
Only people with the service link, QR, invite, or pairing can find it.

Private / known only
Only people or Dinas you explicitly connect can use it.
```

Backwards compatibility if existing configs only have `isDiscoverable`:

```txt
isDiscoverable: true  -> discoverability: public
isDiscoverable: false -> discoverability: known_only
```

Do not infer public discoverability only from official capability. Official capability means common contract, not public listing.

---

## 5.3 Future Policy Hints: Access, Rate Limits, Pricing, Freshness, Pairing

V1 should keep these concepts explicit in the architecture, but not build full enforcement yet.

The important distinction:

```txt
discoverability controls who can find the service.
access policy controls who may invoke/use the service.
provider authorization controls whether a specific request is accepted.
```

Do not treat `known_only` as security. It reduces discovery exposure; it is not authorization.

V1 stance:

- Store/display simple hints if useful.
- Do not build CLI/headless auth.
- Do not build payments.
- Do not build full invite/pairing infrastructure unless already available.
- Provider remains responsible for real authorization and request validation.
- Dina should still avoid misleading UX by showing policy hints where present.

### Access policy hint

Optional field:

```ts
access_policy_hint:
  | 'anyone'
  | 'authenticated'
  | 'invited'
  | 'paired_dids'
  | 'owner_only'
  | 'provider_defined'
```

Examples:

| Service | discoverability | access_policy_hint |
|---|---|---|
| Public bus ETA | `public` | `anyone` |
| Public store price | `public` | `anyone` |
| Clinic appointment status | `public` or `unlisted` | `authenticated` |
| School parent portal | `unlisted` | `invited` |
| Internal API health | `known_only` | `paired_dids` |
| Personal home automation | `known_only` | `owner_only` |

V1 enforcement:

```txt
Provider-defined. Dina/AppView do not guarantee access enforcement.
```

Required copy:

```txt
Discoverability is not authorization. Providers must enforce access.
```

### Rate-limit hint

Optional field:

```ts
rate_limit_hint: 'none' | 'low' | 'medium' | 'high' | 'provider_defined'
```

Purpose:

- Help clients avoid hammering public providers.
- Help mobile display "this provider may throttle requests."
- Help future AppView ranking/abuse controls.

V1 enforcement:

```txt
Provider-defined. AppView may meter/search-rate-limit globally, but per-provider enforcement is not required.
```

### Pricing hint

Optional field:

```ts
pricing_hint: 'free' | 'paid' | 'quote_required' | 'provider_defined'
```

Purpose:

- Avoid surprising users.
- Allow future paid services without changing the listing model.

V1 enforcement:

```txt
No payments in V1. Treat as display/expectation only.
```

### Freshness hint

Optional field:

```ts
freshness_hint: 'real_time' | 'short_ttl' | 'medium_ttl' | 'long_ttl' | 'provider_defined'
```

Use for:

```txt
ETA
stock/price
API health
deploy status
incident status
order/package status
```

Result schemas should still include concrete timestamps where relevant:

```txt
generated_at
updated_at
valid_until
```

V1 enforcement:

```txt
No global freshness enforcement. Display stale/unknown if provider returns timestamps.
```

### Trust/verification hints

Already included fields:

```ts
verified_provider?: boolean
verified_namespace?: boolean
```

V1 behavior:

- Do not let providers self-assert official/verified status.
- AppView controls verified flags.
- Custom namespaces are unverified unless AppView explicitly verifies them.

### Pairing / invite / exact-link flow

Future concepts:

```txt
service link
QR pairing
team/org invite
paired DID allowlist
known-service binding import
```

V1 stance:

- Do not require full pairing/invite infrastructure for the catalog.
- `unlisted` and `known_only` can initially mean "not returned by normal AppView search."
- Invocation can happen when local Dina already has the service profile/binding.
- Exact-link lookup can be added later without changing the visibility model.

---

## 6. Security and Trust Rules

Official catalog and provider listings have different trust levels.

```txt
Official catalog = Dina/AppView controlled
Provider listing = provider controlled
Custom schema    = provider controlled and untrusted
```

Rules:

1. Official common capabilities come only from official catalog.
2. Provider custom capabilities must be namespaced.
3. Mobile must never treat provider custom capability metadata as official UI without labeling.
4. Remote display templates must be constrained; no arbitrary code.
5. Params/result schemas are validation data, not execution permission.
6. Any write/payment/booking capability requires explicit approval policy.
7. Sensitive/regulated categories require stronger copy and consent.
8. AppView discovery should receive generic intent, not private local details.
9. A service query should not create contact/social messaging permission.
10. Do not claim anonymity unless brokered/blinded service query exists.
11. Provider schemas and display templates are untrusted input; validate, bound, and render them in constrained components only.
12. Custom capability namespace ownership is unverified unless AppView explicitly marks it verified.
13. Catalog updates must be append-only for stable capability IDs; never silently change a stable wire contract.
14. AppView should rate-limit or meter provider listings to prevent capability/search spam.
15. Provider listings must not be able to spoof official badges, verified status, category icons, or Dina-owned copy.
16. Developer tooling must fail closed: validation errors should block publish, not publish a half-valid public service.
17. Discoverability is not authorization. Providers must enforce access even for unlisted/known-only services.
18. Policy hints such as access, pricing, rate limits, and freshness are informational in V1 unless a specific enforcement path exists.

Threat to avoid:

```txt
Provider publishes capability: eta_query2 / official-looking display / fake icon
Mobile shows it as official trusted Dina capability
```

Correct behavior:

```txt
Unknown flat names are rejected or hidden from public discovery.
Namespaced custom names are allowed but labeled provider-defined/custom.
Official common capabilities come from the signed/catalog source only.
```

---

## 7. Lifecycle Rules

Capability lifecycle:

```txt
draft -> beta -> stable -> deprecated -> retired
```

Recommended behavior:

- `draft`: internal/testing only, hidden from normal provider UI.
- `beta`: visible with beta label; schema may change with migration.
- `stable`: normal public use.
- `deprecated`: existing providers still work; new listings discouraged.
- `retired`: hidden from new creation; old listings may be searchable only for backward compatibility.

Breaking changes:

- Do not mutate an existing stable schema incompatibly.
- Add a new capability ID or versioned variant if contract changes materially.
- Add aliases for discoverability, not semantic rewrites.

Schema versioning:

- `schema_hash` remains the execution compatibility key.
- Catalog can define default schemas.
- Provider listing can include schema snapshot/hash.
- If requester has stale schema hash, refresh profile and retry once.

---

## 8. Provider Setup UX

Normal provider flow:

```txt
1. I provide a service
2. Choose category
3. Choose capability
4. Fill service details
5. Configure how it runs
6. Publish
```

Example:

```txt
Category: Transit
Capability: ETA / arrival time
Display name: SF Transit Live
Area: San Francisco
Execution: agent/tool/manual approval
Publish
```

Advanced custom flow:

```txt
1. Advanced: custom capability
2. Enter namespaced ID: com.rajschool.homework_status
3. Add description
4. Add params schema
5. Add result schema
6. Add response/approval policy
7. Publish as custom/provider-defined
```

Custom flow should not look like the normal path for casual users. It is provider/developer mode.

---

## 8.1 Mobile-Only Developer Mode

Initial service providers may be developers, but V1 should still publish services only through Dina mobile/provider settings. Do not add a CLI publishing path now. A CLI introduces extra auth/key/signing/distribution complexity and creates a second write path that must duplicate mobile validation. If organizations later need CI/CD or headless publishing, that is a good future problem.

V1 developer mode should be mobile-first:

```txt
Network -> Services -> Provide a service -> Developer mode
```

Developer goals remain:

- See the official catalog.
- Pick an official capability or define a namespaced custom capability.
- Validate schemas before publish.
- Publish a listing under the device/node DID.
- See service_uri, rkey, schema_hash, and category.
- Copy sample request/response payloads.
- Run an external responder/agent separately.
- Test service.query from the app.
- Debug why discovery or execution failed.

Mobile-only developer flow:

```txt
1. Open mobile provider settings.
2. Enable Developer mode.
3. Choose category.
4. Choose official capability or Advanced custom capability.
5. Enter display name, description, service area, and specialties.
6. Add/edit params schema and result schema.
7. Choose response policy.
8. Validate in mobile.
9. Publish from mobile.
10. Mobile shows service_uri, rkey, capability, category_id, schema_hash, and sample payloads.
11. Developer runs external responder/agent against the published service.
12. Mobile/AppView inspect view shows visibility, last query, and rejection reasons.
```

No CLI is required for V1.

### Mobile developer-mode fields

Developer mode should expose these fields in-app:

```txt
rkey
display_name
description
category_id
capability
capability_kind: official | custom
service_area
specialties/provider_type
params_schema
result_schema
response_policy
service_uri
schema_hash
AppView visibility status
last published time
last query status/reason
```

The app can support copy/export for convenience:

```txt
Copy service URI
Copy schema hash
Copy params schema
Copy result schema
Copy sample service.query JSON
Copy latest rejection reason
```

Copy/export is fine. Publishing still happens through mobile.

### Developer validation rules

Mobile validation should fail or warn on:

- Unknown flat capability name.
- Custom capability that is not namespaced.
- Official capability used with a category not allowed by `category_ids`.
- Missing params/result schema for public custom capability.
- Schema with no `type: object` root.
- Schema allowing arbitrary `additionalProperties` unless explicitly justified.
- Missing `response_policy`.
- Write/payment/booking capability without explicit approval policy.
- Sensitive category without consent/privacy copy.
- Duplicate rkey for same DID.
- Invalid service area shape.
- Display name/description too long or misleading.

Validation must fail closed. A half-valid public service should not be published.

### Developer diagnostics

Developers need direct answers in mobile/AppView inspect views:

```txt
Why is my service not visible in AppView search?
Why did service.query get rejected?
Which schema_hash is AppView showing?
Which schema_hash did the requester send?
Was my capability canonicalized?
Was my custom capability treated as provider-defined?
Did AppView drop my capability as unknown?
Which rkey/service_uri was invoked?
Was the query blocked by policy, schema, auth, or execution failure?
```

Developer-mode inspect actions:

```txt
Refresh AppView visibility
Send test query
Show last query
Show last rejection reason
Copy sample payload
Copy service URI
Copy schema hash
Unpublish listing
```

### Developer docs

Minimum docs needed for developer launch:

- How to enable provider/developer mode in mobile.
- Official capability catalog reference.
- Custom capability naming guide.
- JSON Schema subset supported by Dina.
- Schema hash computation.
- Service profile/rkey publishing model.
- service.query request/response examples.
- Approval/response policy examples.
- CardSpec/display template constraints.
- AppView discovery/debugging guide.
- Security/privacy requirements for sensitive domains.
- Migration guide from custom capability to official capability.

### Namespace ownership

Namespaced custom capabilities are useful immediately, but namespace ownership must be honest.

V1 behavior:

- Accept syntactically valid namespaced custom capability IDs.
- Label them as provider-defined/custom.
- Do not imply the provider owns the DNS/org namespace unless verified.

Future stronger behavior:

- Verify DNS/domain ownership for `com.example.*`.
- Or bind namespace ownership to a DID record.
- Or mark namespace as `verified_namespace: true` in AppView after proof.

Until verification exists, UI should not say:

```txt
Official RajSchool capability
```

It should say:

```txt
Provider-defined capability by RajSchool
```

### V1 scope boundary

Explicitly out of scope for V1:

```txt
CLI publishing
Headless publishing
CI/CD service deployment
Remote signing for service profiles
Bulk organization service management
API-key based provider publishing
```

Those are future organization/provider-platform features. If customers ask for them, it means Dina has enough service-provider traction to justify the additional complexity.

V1 developer priority:

1. Mobile developer mode.
2. Strict in-app validation.
3. Publish multiple listings per DID/rkey from mobile.
4. AppView visibility/debug status in mobile.
5. In-app test query / sample payload copy.
6. External responder/agent can be run by developer separately.

Developer catalog policy:

- Do not block developers because the official catalog is small.
- If an official capability fits, require the official capability.
- If no official capability fits, allow a namespaced custom capability with schemas.
- Make custom services discoverable as provider-defined, not official.
- Use developer feedback and custom-capability clustering to decide which workflows deserve promotion into the official catalog.

---

## 9. Router Semantics

Service invocation routing should follow this priority:

```txt
local/private context
-> known service binding
-> AppView discovery
-> direct D2D conversation fallback
-> clarification
```

Important:

- AppView is for discovery, not mandatory invocation.
- Known service can skip AppView discovery.
- Known service should still use `service.query`.
- D2D is only for conversation/message intent.

Example:

```txt
User: What homework does Emma have today?

Dina should:
1. Check vault/local context.
2. Check known binding: Emma -> school -> RajSchool homework service.
3. If known, call RajSchool via service.query.
4. If unknown, search AppView for generic school homework service.
5. Only message Emma/RajSchool if user asked for conversation or approves fallback.
```

---

## 9.1 Category Boundary Rules

Some capabilities are cross-cutting. Appointment scheduling is the clearest example:

```txt
appointment_availability
appointment_book
appointment_status
```

These can apply to doctors, salons, consultants, mechanics, government offices, and tutors. But the category still matters because category controls privacy, consent, ranking, copy, and provider trust expectations.

Rule:

```txt
Capability = what action/answer is being requested.
Category/provider vertical = what policy and UX apply.
```

So Dina should not route only by the word "appointment." It should also infer the provider vertical.

Examples:

| User intent | Correct category | Capability | Notes |
|---|---|---|---|
| "Find me an ENT doctor appointment tomorrow" | Healthcare and Wellness | `appointment_availability` | Medical/sensitive. Do not classify as Professional Services. |
| "Book a dentist appointment" | Healthcare and Wellness | `appointment_availability` then `appointment_book` | Booking requires explicit approval. |
| "Check my Dr Rao appointment" | Healthcare and Wellness | `appointment_status` | Known provider binding should be used if available. |
| "Find a tax consultant slot" | Professional Services | `consultation_availability` or `appointment_availability` | Non-medical professional service. |
| "Book a haircut" | Appointments and Bookings / Local Services | `appointment_availability` then `appointment_book` | Lower privacy than healthcare. |
| "Check my passport office appointment" | Government and Utilities | `civic_appointment_status` | Government/civic policy. |

Practical implication:

- `appointment_availability` can be a shared official capability.
- The provider listing should also carry category/domain metadata such as `healthcare`, `salon`, `professional_services`, or `government`.
- Brain/router should use both capability and category to decide consent/privacy handling.
- AppView ranking/filtering should allow category constraints, e.g. "appointment availability where category = healthcare and specialty = ENT."
- For official capabilities, AppView should validate that the provider listing's `category_id` is allowed by the capability's `category_ids`.
- For custom capabilities, AppView should still require a `category_id` so discovery/policy is not category-less.

For the ENT example:

```txt
User: I want an ENT doctor appointment near Indiranagar tomorrow.

Dina:
1. Intent: healthcare appointment availability.
2. Category: Healthcare and Wellness.
3. Capability: appointment_availability.
4. Discovery query: healthcare appointment providers, specialty ENT, near Indiranagar.
5. Do not send private symptoms to AppView discovery unless explicitly needed/approved.
6. Query selected provider via service.query.
7. If booking is requested, use appointment_book with explicit approval.
8. Store known service binding for repeat use.
```

Professional Services must be reserved for non-medical expert services:

```txt
lawyer
accountant
tax consultant
business consultant
real estate broker
career coach
```

Medical professionals are healthcare providers, not Professional Services, because health intent and patient data require stronger privacy/consent handling.

---

## 9.2 Ambiguous Scenario Test Matrix

The catalog should be validated against realistic user prompts, because many prompts mention a generic action ("book", "status", "availability", "appointment", "bill") that exists across multiple categories.

Routing rule:

```txt
First infer the domain/provider vertical.
Then choose the capability.
Then apply the domain's privacy/approval policy.
```

If the domain cannot be inferred safely, ask a clarification rather than guessing.

| # | User prompt | Correct category | Capability | AppView discovery text | Must not do | Notes |
|---:|---|---|---|---|---|---|
| 1 | "I want an ENT doctor appointment tomorrow" | Healthcare and Wellness | `appointment_availability` | "healthcare appointment availability, specialty ENT, near <area>" | Route to Professional Services | Medical provider = healthcare, not generic/professional. |
| 2 | "Book a haircut for Saturday" | Appointments and Bookings / Home and Local Services | `appointment_availability` then `appointment_book` | "salon/barber appointment availability" | Treat as healthcare appointment | Lower-risk appointment; booking still needs confirmation. |
| 3 | "Find a tax consultant slot next week" | Professional Services | `consultation_availability` or `appointment_availability` | "tax consultant consultation availability" | Use Healthcare or Finance | Finance topic, but provider is a professional-service consultant; not account/bank data. |
| 4 | "When is my passport office appointment?" | Government, Civic, and Utilities | `civic_appointment_status` | If unknown: "government appointment status service" | Use generic `appointment_status` without civic policy | Civic identity/process data. |
| 5 | "Is my visa application approved?" | Travel and Lodging or Government/Civic depending provider | `travel_document_status` or `civic_case_status` | "visa/document application status service" | Treat as travel booking | Ask clarification if provider is unknown: consulate/agency vs travel agent. |
| 6 | "Track my Amazon order" | Commerce and Retail | `order_status` | "order status service for merchant" | Use `package_tracking` first | Order status is merchant-side. If shipment tracking number exists, then package tracking may be used. |
| 7 | "Where is my FedEx package?" | Logistics, Delivery, and Postal | `package_tracking` | "package tracking service" | Use commerce `order_status` | Carrier tracking. |
| 8 | "When will my food arrive?" | Food, Dining, and Hospitality | `food_delivery_eta` or `delivery_eta` with food category | "food delivery ETA" | Use generic logistics without food context | Food delivery has restaurant/order semantics. |
| 9 | "Is the medicine refill ready?" | Healthcare and Wellness | `prescription_refill_status` | "pharmacy prescription refill status" | Use commerce `product_availability` | Prescription data is regulated/sensitive. |
| 10 | "Is paracetamol available near me?" | Commerce/Retail or Healthcare depending provider | `price_check` / `product_search` or pharmacy-specific custom | "pharmacy product availability for paracetamol" | Treat as prescription refill | OTC availability can be commerce-like; prescription refill is healthcare. |
| 11 | "What homework does Emma have today?" | School and Education | `school_homework_status` | "school homework status service" | Send "Emma" to AppView discovery | Use local known binding first. Child data is sensitive. |
| 12 | "What's Emma's grade?" | School and Education | `school_grade_status` | "school grade/report status service" | Treat as generic status | Strong sensitive policy; likely approval/known provider required. |
| 13 | "Pay my electricity bill" | Government/Utilities or Finance/Billing depending provider | `utility_bill_status` then future payment capability | "utility bill status/payment service" | Execute payment without approval | Payment/write action requires explicit approval. |
| 14 | "What's my credit card balance?" | Finance, Billing, and Insurance | `account_balance` | Usually avoid public discovery; use known bank binding | Use generic `bill_due_status` | Regulated finance. Prefer known provider/auth. |
| 15 | "Is my insurance claim approved?" | Finance/Insurance or Healthcare depending insurer/provider | `insurance_claim_status` | "insurance claim status service" | Treat as healthcare lab/appointment | Insurance is regulated finance; may relate to health but provider vertical is insurer. |
| 16 | "Schedule plumber for leak tomorrow" | Home, Repairs, and Local Services | `local_service_availability` then `appointment_book`/service booking | "plumber emergency/service availability" | Use generic Professional Services | Local service + possibly urgent. |
| 17 | "Where is the electrician?" | Home, Repairs, and Local Services | `technician_eta` | "technician ETA service" | Use transit ETA | ETA is for provider's technician, not public transit. |
| 18 | "Find a 2BHK for rent" | Real Estate and Property | `property_availability` | "rental property availability" | Use hotel availability | Property search, not travel lodging. |
| 19 | "Book a hotel in Goa" | Travel and Lodging | `hotel_availability` then future booking | "hotel room availability" | Use real-estate property availability | Short-term lodging/travel. |
| 20 | "Is my library book ready?" | Community, Nonprofit, and Membership | `library_hold_status` | "library hold status service" | Use commerce order status | Library/membership domain. |
| 21 | "Is my concert ticket confirmed?" | Events, Entertainment, and Venues | `ticket_status` | "event ticket status service" | Use travel booking status | Ticket domain, not travel. |
| 22 | "What time is my yoga class?" | Events/Venues or School/Education depending provider | `class_schedule` or `school_timetable_query` | "class schedule service" | Assume school child timetable | Ask if ambiguous: user's yoga studio vs child's school. |
| 23 | "Find a part-time job near me" | Jobs, Work, and Staffing | `job_availability` | "job availability service" | Use Professional Services | Job marketplace/staffing. |
| 24 | "When is my shift tomorrow?" | Jobs, Work, and Staffing | `shift_schedule` | Prefer known employer/workforce binding | Search AppView with employer/private details | Sensitive worker data. Known provider first. |
| 25 | "Submit this form to the city" | Agents/Automation + Government/Civic | `form_submit` or civic-specific future capability | Do not use discovery unless provider is clear | Submit without approval | Write/agentic/civic action; always approval. |

Ambiguity handling:

- If the same phrase can mean two materially different categories, ask a clarification.
- If one interpretation is sensitive and one is non-sensitive, prefer clarification or the safer sensitive policy.
- If a known service binding exists, it can disambiguate the category. Example: "my appointment" + known Dr Rao clinic binding => Healthcare.
- AppView discovery should receive only the generic service intent and necessary coarse filters, not private local details such as child names, symptoms, account numbers, employer names, or exact financial facts unless the user explicitly chose to disclose them.

Additional catalog implications from the matrix:

- Appointment capabilities are intentionally shared, but category must travel with the provider listing.
- `order_status`, `package_tracking`, and `delivery_eta` are separate because merchant order state, carrier package state, and delivery ETA are different provider contracts.
- `bill_due_status`, `utility_bill_status`, and `account_balance` should remain separate because utility bills and bank balances have different privacy/auth requirements.
- Food delivery can use a generic `delivery_eta` only if the provider listing category remains `food`; otherwise use `food_delivery_eta` to avoid card/routing ambiguity.
- Education, healthcare, finance, employment, and government should default to stricter consent if uncertain.

---

## 10. Proposed Catalog Categories

The list below is intentionally broad. Not all should be enabled at launch. Claude should validate names, schemas, overlap, and implementation priority.

Use three buckets:

- **Seed now**: already implemented or easy demo-backed capability.
- **Near-term**: useful soon, low risk, common across providers.
- **Later/sensitive**: useful but needs stronger consent, auth, policy, or provider ecosystem.

---

## 11. Category: Transit and Mobility

Purpose: buses, trains, metro, shuttles, taxis, ride providers, parking, route planners.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| ETA / arrival time | `eta_query` | Seed now | read | public/personal | Estimated arrival time for route/stop. |
| Service disruption | `transit_service_alerts` | Near-term | read | public | Delays, closures, disruptions. |
| Route plan | `transit_route_plan` | Near-term | read | personal | Plan a trip between origin/destination. |
| Fare estimate | `transit_fare_estimate` | Near-term | quote | public/personal | Estimate fare for route/trip. |
| Vehicle location | `transit_vehicle_location` | Later | read | public | Live vehicle location for a route. |
| Parking availability | `parking_availability` | Near-term | read | public/personal | Available parking near location. |
| Ride quote | `ride_quote` | Later | quote | personal | Quote ride price/ETA. |
| Ride booking status | `ride_booking_status` | Later/sensitive | read | personal | Status of a booked ride. |

Suggested `eta_query` params:

```json
{
  "route_id": "string",
  "stop_id": "string",
  "lat": "number?",
  "lng": "number?",
  "direction": "string?"
}
```

Suggested result:

```json
{
  "status": "ok|delayed|unknown",
  "eta_minutes": "number?",
  "scheduled_time": "string?",
  "route_name": "string?",
  "stop_name": "string?",
  "message": "string?"
}
```

---

## 12. Category: Commerce and Retail

Purpose: shops, local stores, online sellers, inventory systems, product catalogs.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Price and availability | `price_check` | Seed now | read | public | Current price and stock availability. |
| Product search | `product_search` | Near-term | read | public/personal | Search provider catalog. |
| Product details | `product_details` | Near-term | read | public | Details/specs/images for one product. |
| Store hours | `store_hours` | Near-term | read | public | Opening hours and holiday hours. |
| Store location | `store_location` | Near-term | read | public | Nearest branch/location. |
| Cart quote | `cart_quote` | Near-term | quote | personal | Quote total price for cart. |
| Order status | `order_status` | Near-term | read | personal | Status of an existing order. |
| Return eligibility | `return_eligibility` | Later | read | personal | Whether an order/item can be returned. |
| Warranty status | `warranty_status` | Later | read | personal | Warranty coverage for item/order. |

Suggested `price_check` params:

```json
{
  "product_id": "string?",
  "query": "string?",
  "sku": "string?",
  "location_id": "string?",
  "lat": "number?",
  "lng": "number?"
}
```

Suggested result:

```json
{
  "status": "ok|not_found|out_of_stock|unknown",
  "product_name": "string?",
  "price": "number?",
  "currency": "string?",
  "in_stock": "boolean?",
  "quantity_available": "number?",
  "store_name": "string?",
  "valid_until": "string?"
}
```

---

## 13. Category: Appointments and Bookings

Purpose: cross-cutting scheduling/bookings for lower-risk service providers such as salons, mechanics, consultants, classes, and other non-medical/non-regulated providers.

Important:

- Medical appointments belong under Healthcare and Wellness, even if they use the shared `appointment_availability`, `appointment_book`, or `appointment_status` capability.
- Government appointments belong under Government and Utilities if civic identity/process data is involved.
- Professional consultations can use this capability family, but Professional Services policy/copy should apply.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Appointment status | `appointment_status` | Seed now | read | personal/sensitive | Check appointment status or next availability. |
| Appointment availability | `appointment_availability` | Near-term | read | personal | Available slots. |
| Book appointment | `appointment_book` | Later | booking | personal/sensitive | Book a slot. Requires explicit approval. |
| Reschedule appointment | `appointment_reschedule` | Later | booking | personal/sensitive | Reschedule existing appointment. |
| Cancel appointment | `appointment_cancel` | Later | booking | personal/sensitive | Cancel appointment. |
| Waitlist status | `waitlist_status` | Near-term | read | personal | Check waitlist position/status. |
| Cancellation policy | `cancellation_policy` | Near-term | read | public/personal | Cancellation rules/fees. |
| Consultation availability | `consultation_availability` | Near-term | read | personal | Available consultation slots for non-medical professionals. |

Suggested `appointment_status` params:

```json
{
  "appointment_id": "string?",
  "patient_id": "string?",
  "customer_id": "string?",
  "date": "string?",
  "service_type": "string?"
}
```

Suggested result:

```json
{
  "status": "confirmed|pending|cancelled|not_found|available|unavailable|unknown",
  "appointment_time": "string?",
  "provider_name": "string?",
  "location": "string?",
  "next_available_time": "string?",
  "message": "string?"
}
```

---

## 14. Category: Food, Dining, and Hospitality

Purpose: restaurants, cafes, caterers, hotels with dining, food delivery providers.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Menu query | `menu_query` | Near-term | read | public | Menu items, prices, availability. |
| Reservation availability | `reservation_availability` | Near-term | read | personal | Available table/time slots. |
| Reservation status | `reservation_status` | Near-term | read | personal | Status of an existing reservation. |
| Order status | `food_order_status` | Near-term | read | personal | Status of food order. |
| Delivery ETA | `food_delivery_eta` | Near-term | read | personal | Delivery/pickup ETA. |
| Dietary options | `dietary_options` | Near-term | read | public/personal | Vegan, halal, allergens, gluten-free. |
| Catering quote | `catering_quote` | Later | quote | personal | Quote catering for event. |

Notes:

- `order_status` exists in commerce too. Use domain-specific IDs only when result semantics differ materially. Otherwise prefer one common `order_status` across commerce/food/logistics.
- Claude should decide whether to keep `food_order_status` separate or unify under `order_status` with category metadata.

---

## 15. Category: Logistics, Delivery, and Postal

Purpose: courier, shipping, warehouse pickup, local delivery, postal services.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Package tracking | `package_tracking` | Near-term | read | personal | Track shipment/package. |
| Delivery ETA | `delivery_eta` | Near-term | read | personal | ETA for active delivery. |
| Pickup availability | `pickup_availability` | Near-term | read | public/personal | Available pickup slots. |
| Pickup status | `pickup_status` | Near-term | read | personal | Status of scheduled pickup. |
| Shipping quote | `shipping_quote` | Near-term | quote | personal | Cost/time quote for shipping. |
| Return pickup status | `return_pickup_status` | Later | read | personal | Return collection status. |

Suggested `package_tracking` params:

```json
{
  "tracking_number": "string",
  "postal_code": "string?",
  "order_id": "string?"
}
```

Suggested result:

```json
{
  "status": "created|in_transit|out_for_delivery|delivered|exception|unknown",
  "current_location": "string?",
  "estimated_delivery_time": "string?",
  "last_update_time": "string?",
  "message": "string?"
}
```

---

## 16. Category: School and Education

Purpose: schools, colleges, tutoring centers, activity classes, learning platforms.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Homework status | `school_homework_status` | Near-term | read | sensitive | Homework/assignments for a student. |
| Attendance status | `school_attendance_status` | Later/sensitive | read | sensitive | Student attendance. |
| Timetable query | `school_timetable_query` | Near-term | read | personal | Class timetable/schedule. |
| School notice query | `school_notice_query` | Near-term | read | personal | Notices/circulars relevant to student/class. |
| Fee due status | `school_fee_status` | Later/sensitive | read/payment | sensitive | Fee balance/due date. |
| Exam schedule | `school_exam_schedule` | Near-term | read | sensitive | Exam/test schedule. |
| Grade/report status | `school_grade_status` | Later/sensitive | read | regulated/sensitive | Grades/report cards. |
| Tutor availability | `tutor_availability` | Near-term | read | personal | Available tutoring slots. |

Suggested `school_homework_status` params:

```json
{
  "student_id": "string?",
  "student_name": "string?",
  "class_id": "string?",
  "section": "string?",
  "date": "string?",
  "subject": "string?"
}
```

Suggested result:

```json
{
  "status": "ok|not_found|unauthorized|unknown",
  "assignments": [
    {
      "subject": "string",
      "title": "string",
      "description": "string?",
      "due_date": "string?"
    }
  ],
  "message": "string?"
}
```

Privacy note:

- AppView discovery should not receive `student_name` or child-specific details.
- Known service binding should handle recurring school relationships:

```txt
Emma -> school -> RajSchool -> school_homework_status
```

---

## 17. Category: Healthcare and Wellness

Purpose: clinics, dentists, pharmacies, labs, therapists, fitness/wellness providers.

This category is sensitive. Start narrow and approval-heavy.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Appointment status | `appointment_status` | Seed now | read | sensitive | Existing clinic/provider appointment. |
| Appointment availability | `appointment_availability` | Near-term | read | sensitive | Available doctor/clinic slots, optionally by specialty. |
| Book appointment | `appointment_book` | Later/sensitive | booking | sensitive | Book medical appointment. Requires explicit approval. |
| Prescription refill status | `prescription_refill_status` | Later/sensitive | read | regulated | Pharmacy refill status. |
| Lab result status | `lab_result_status` | Later/sensitive | read | regulated | Whether lab results are ready, not necessarily the result value. |
| Care instruction query | `care_instruction_query` | Later/sensitive | read | sensitive | Provider-issued post-visit instructions. |
| Insurance eligibility | `insurance_eligibility_status` | Later/sensitive | read | regulated | Coverage/eligibility status. |

Rules:

- Health data should default to approval or strong consent.
- Do not leak health intent to AppView beyond generic service discovery.
- Avoid returning raw medical records until permission model is mature.
- Provider identity should be verified/trusted before use.
- A doctor/ENT/dentist/therapist appointment is Healthcare and Wellness, not Professional Services.

---

## 18. Category: Home, Repairs, and Local Services

Purpose: plumbers, electricians, cleaners, mechanics, appliance repair, housing maintenance.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Service availability | `local_service_availability` | Near-term | read | personal | Available slots for service. |
| Service quote | `service_quote` | Near-term | quote | personal | Quote for requested job. |
| Job status | `service_job_status` | Near-term | read | personal | Existing repair/service job status. |
| Technician ETA | `technician_eta` | Near-term | read | personal | ETA of assigned technician. |
| Maintenance ticket status | `maintenance_ticket_status` | Near-term | read | personal | Landlord/HOA/property ticket status. |
| Emergency availability | `emergency_service_availability` | Later | read | personal | Urgent service availability. |

Suggested `service_quote` params:

```json
{
  "service_type": "string",
  "description": "string?",
  "location": "string?",
  "preferred_time": "string?",
  "urgency": "low|normal|urgent?"
}
```

---

## 19. Category: Developer Tools and Operations

Purpose: developer-owned services for API health, deploy status, build/CI, incidents, queues, webhooks, issues, pull requests, and operational summaries.

This category is important for early developer adoption. These services are often generic in contract but private in listing visibility. The default discoverability should usually be `known_only`, not `public`.

| Capability | Canonical ID | Bucket | Action | Privacy | Default discoverability | Description |
|---|---:|---|---|---|---|---|
| Service health status | `service_health_status` | Near-term | read | sensitive | `known_only` | Health of an API/service/system. |
| Deploy status | `deploy_status` | Near-term | read | sensitive | `known_only` | Status of a deployment. |
| Build status | `build_status` | Near-term | read | sensitive | `known_only` | CI/build result. |
| Incident status | `incident_status` | Near-term | read | sensitive | `known_only` | Active incidents or incident state. |
| Error summary | `error_summary` | Near-term | read | sensitive | `known_only` | Aggregated production errors. |
| Job status | `job_status` | Near-term | read | sensitive | `known_only` | Background job/workflow status. |
| Queue status | `queue_status` | Near-term | read | sensitive | `known_only` | Queue depth/lag/health. |
| Webhook status | `webhook_status` | Near-term | read | sensitive | `known_only` | Webhook delivery/receiver status. |
| Issue status | `issue_status` | Near-term | read | personal/sensitive | `known_only` | Issue/ticket status from tracker. |
| Pull request status | `pull_request_status` | Near-term | read | personal/sensitive | `known_only` | PR/check/review status. |
| Repository status | `repository_status` | Near-term | read | sensitive | `known_only` | Repository health/default branch/release status. |
| Release status | `release_status` | Near-term | read | sensitive | `known_only` | Software release status. |
| Test run status | `test_run_status` | Near-term | read | sensitive | `known_only` | Test suite/run status. |
| Environment status | `environment_status` | Near-term | read | sensitive | `known_only` | Environment health/config drift summary. |
| Metric query | `metric_query` | Later/sensitive | read | sensitive | `known_only` | Query operational metrics. |
| Log query | `log_query` | Later/sensitive | read | sensitive | `known_only` | Query logs. Logs may contain secrets/PII. |
| Feature flag status | `feature_flag_status` | Later/sensitive | read | sensitive | `known_only` | Current feature flag state. |
| Feature flag update | `feature_flag_update` | Later/sensitive | write | sensitive | `known_only` | Change a feature flag. Requires explicit approval. |
| Deploy trigger | `deploy_trigger` | Later/sensitive | write | sensitive | `known_only` | Trigger a deploy. Requires explicit approval. |

Suggested `service_health_status` params:

```json
{
  "service_name": "string?",
  "environment": "string?"
}
```

Suggested result:

```json
{
  "status": "healthy|degraded|down|unknown",
  "service_name": "string?",
  "environment": "string?",
  "uptime_percent": "number?",
  "active_incidents": "number?",
  "updated_at": "string?",
  "message": "string?"
}
```

Suggested `deploy_status` params:

```json
{
  "service_name": "string?",
  "environment": "string?",
  "version": "string?",
  "deploy_id": "string?"
}
```

Suggested result:

```json
{
  "status": "pending|running|succeeded|failed|rolled_back|unknown",
  "service_name": "string?",
  "environment": "string?",
  "version": "string?",
  "started_at": "string?",
  "completed_at": "string?",
  "message": "string?"
}
```

Rules:

- Official developer/ops capability does not imply public discovery.
- Default developer/ops listings to `known_only`.
- AppView discovery should not receive private system names unless the user explicitly chose to disclose them.
- Known service bindings are the expected path for internal developer services.
- Logs/metrics may contain secrets or PII; Dina is a mediator, but UI should label them sensitive and avoid public discovery.
- Write actions such as deploy/feature-flag changes require explicit approval even if the provider handles authorization.

Example:

```txt
User: Is prod API healthy?
Dina: known binding -> Acme API Health -> service.query(service_health_status)
No AppView search.
```

---

## 20. Category: Security and Compliance

Purpose: security scanners, compliance checks, access reviews, vulnerability status, audit evidence, and policy checks. These are developer/organization services and should usually be `known_only`.

| Capability | Canonical ID | Bucket | Action | Privacy | Default discoverability | Description |
|---|---:|---|---|---|---|---|
| Vulnerability status | `vulnerability_status` | Near-term | read | sensitive | `known_only` | Vulnerability summary for service/repo/image. |
| Dependency audit status | `dependency_audit_status` | Near-term | read | sensitive | `known_only` | Dependency/security audit status. |
| Secret scan status | `secret_scan_status` | Near-term | read | sensitive | `known_only` | Secret scan result/status. |
| Compliance check status | `compliance_check_status` | Near-term | read | sensitive/regulated | `known_only` | Compliance policy/check status. |
| Access review status | `access_review_status` | Later/sensitive | read | sensitive | `known_only` | Access review progress/status. |
| Audit evidence status | `audit_evidence_status` | Later/sensitive | read | regulated | `known_only` | Audit evidence collection status. |
| Policy evaluation | `policy_evaluation` | Later/sensitive | read | sensitive | `known_only` | Evaluate a policy against a resource. |

Rules:

- Do not expose security posture in public discovery.
- Results should be summaries by default, not raw secrets/findings.
- Write/remediation actions should be future separate capabilities with explicit approval.

---

## 21. Category: Identity, Access, and Team Operations

Purpose: internal identity providers, team directories, access requests, group membership, on-call ownership, and account provisioning status.

These are often organization-private. Default to `known_only` unless intentionally public.

| Capability | Canonical ID | Bucket | Action | Privacy | Default discoverability | Description |
|---|---:|---|---|---|---|---|
| Access request status | `access_request_status` | Near-term | read | sensitive | `known_only` | Status of an access request. |
| Group membership status | `group_membership_status` | Near-term | read | sensitive | `known_only` | Whether a user/team is in a group. |
| User account status | `user_account_status` | Near-term | read | sensitive | `known_only` | Account active/disabled/provisioning status. |
| On-call status | `oncall_status` | Near-term | read | personal/sensitive | `known_only` | Current on-call owner/escalation status. |
| Team directory query | `team_directory_query` | Later/sensitive | read | personal/sensitive | `known_only` | Team/member lookup. |
| Access request approval | `access_request_approval` | Later/sensitive | write | sensitive | `known_only` | Approve/deny access. Requires explicit approval. |

Rules:

- This is not social People/contacts. It is organizational identity/access state.
- Do not leak employee/team names to AppView discovery.
- Use known bindings or org pairing.

---

## 22. Category: Data, Database, and Analytics Operations

Purpose: data pipeline status, database health, backups, warehouse jobs, data quality, and analytics report freshness.

These are typically private organization services. Default to `known_only`.

| Capability | Canonical ID | Bucket | Action | Privacy | Default discoverability | Description |
|---|---:|---|---|---|---|---|
| Data pipeline status | `data_pipeline_status` | Near-term | read | sensitive | `known_only` | ETL/ELT/pipeline status. |
| Database health status | `database_health_status` | Near-term | read | sensitive | `known_only` | Database health/replication/storage summary. |
| Backup status | `backup_status` | Near-term | read | sensitive | `known_only` | Backup success/failure/freshness. |
| Data quality status | `data_quality_status` | Near-term | read | sensitive | `known_only` | Data quality/check status. |
| Report freshness | `report_freshness` | Near-term | read | sensitive | `known_only` | Last refreshed time/status for report/dashboard. |
| Query job status | `query_job_status` | Near-term | read | sensitive | `known_only` | Long-running analytics/query job status. |
| Query execution | `query_execution` | Later/sensitive | read/write | sensitive | `known_only` | Execute a query. Strong approval/auth required. |

Rules:

- Query execution can leak arbitrary data; keep later/sensitive.
- Status/freshness summaries are useful early and safer than raw query/log access.

---

## 23. Category: AI, Model, and Agent Operations

Purpose: model serving health, eval status, dataset/index status, agent/task runs, prompt/version status, and model deployment summaries.

These are developer/AI-builder services and should usually be `known_only`.

| Capability | Canonical ID | Bucket | Action | Privacy | Default discoverability | Description |
|---|---:|---|---|---|---|---|
| Model serving status | `model_serving_status` | Near-term | read | sensitive | `known_only` | Model endpoint health/latency/error summary. |
| Model eval status | `model_eval_status` | Near-term | read | sensitive | `known_only` | Eval run/result status. |
| Dataset status | `dataset_status` | Near-term | read | sensitive | `known_only` | Dataset processing/freshness status. |
| Vector index status | `vector_index_status` | Near-term | read | sensitive | `known_only` | Embedding/index build/query health. |
| Agent run status | `agent_run_status` | Near-term | read | sensitive | `known_only` | Agent/task run status. |
| Prompt version status | `prompt_version_status` | Later/sensitive | read | sensitive | `known_only` | Prompt/config version status. |
| Model deployment status | `model_deployment_status` | Near-term | read | sensitive | `known_only` | Model deployment status. |

Rules:

- Do not expose prompts, datasets, or model internals by default.
- Prefer status summaries over raw traces/logs for early capability support.

---

## 24. Category: Home, Personal, and IoT Automations

Purpose: private home-node services, personal automations, devices, sensors, reminders, personal workflows, and smart-home state.

These are usually `known_only` and should not be public marketplace services by default.

| Capability | Canonical ID | Bucket | Action | Privacy | Default discoverability | Description |
|---|---:|---|---|---|---|---|
| Device status | `device_status` | Near-term | read | personal | `known_only` | Device/sensor status. |
| Home automation status | `home_automation_status` | Near-term | read | personal | `known_only` | Automation/routine status. |
| Sensor reading | `sensor_reading` | Near-term | read | personal | `known_only` | Sensor value/status. |
| Reminder status | `reminder_status` | Near-term | read | personal | `known_only` | Reminder/task status from a personal node. |
| Personal task status | `personal_task_status` | Near-term | read | personal | `known_only` | Personal automation/task status. |
| Device command | `device_command` | Later/sensitive | write | personal/sensitive | `known_only` | Control a device. Requires explicit approval. |
| Home automation trigger | `home_automation_trigger` | Later/sensitive | write | personal/sensitive | `known_only` | Trigger a routine. Requires explicit approval. |

Rules:

- These are useful Dina-native services but should not be public discoverable by default.
- Use known binding/pairing, not broad AppView discovery.
- Write/device actions require explicit approval.

---

## 25. Category: Travel and Lodging

Purpose: airlines, hotels, travel agencies, tourism providers.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Flight status | `flight_status` | Near-term | read | public/personal | Flight delay/gate/status. |
| Booking status | `travel_booking_status` | Near-term | read | personal | Travel booking status. |
| Hotel availability | `hotel_availability` | Later | read | personal | Room availability. |
| Hotel booking status | `hotel_booking_status` | Later | read | personal | Existing hotel booking. |
| Baggage status | `baggage_status` | Later/sensitive | read | personal | Checked baggage status. |
| Itinerary details | `itinerary_details` | Later/sensitive | read | personal | Itinerary from travel provider. |
| Visa/document status | `travel_document_status` | Later/sensitive | read | regulated | Visa/travel document process status. |

---

## 26. Category: Events, Entertainment, and Venues

Purpose: theaters, concerts, sports, museums, classes, community events.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Event availability | `event_availability` | Near-term | read | public/personal | Available events/seats/tickets. |
| Ticket status | `ticket_status` | Near-term | read | personal | Existing ticket/order status. |
| Venue info | `venue_info` | Near-term | read | public | Opening hours, location, accessibility. |
| Class schedule | `class_schedule` | Near-term | read | public/personal | Schedule for class/activity. |
| Membership status | `membership_status` | Later | read | personal | Venue/club membership status. |

---

## 27. Category: Government, Civic, and Utilities

Purpose: city services, public agencies, utilities, civic alerts.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Public office hours | `public_office_hours` | Near-term | read | public | Office hours/location. |
| Civic appointment availability | `civic_appointment_availability` | Later | read | personal | Available government/civic appointment slots. |
| Civic appointment status | `civic_appointment_status` | Later | read | personal | Government appointment status. |
| Civic appointment booking | `civic_appointment_book` | Later/sensitive | booking | sensitive | Book a government/civic appointment. Requires approval. |
| Permit status | `permit_status` | Later/sensitive | read | personal | Permit/application status. |
| Waste pickup schedule | `waste_pickup_schedule` | Near-term | read | personal/public | Garbage/recycling schedule. |
| Utility outage status | `utility_outage_status` | Near-term | read | public/personal | Power/water/internet outage. |
| Utility bill status | `utility_bill_status` | Later/sensitive | read/payment | sensitive | Bill due/payment status. |
| Case/application status | `civic_case_status` | Later/sensitive | read | sensitive | Public agency case status. |

---

## 28. Category: Finance, Billing, and Insurance

Purpose: invoices, subscriptions, insurance, banks, payment providers.

This category should be conservative. Many capabilities are sensitive or regulated.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Invoice status | `invoice_status` | Near-term | read | personal | Invoice due/paid status. |
| Bill due status | `bill_due_status` | Near-term | read | sensitive | Due amount/date. |
| Payment link quote | `payment_link_quote` | Later/sensitive | payment | sensitive | Prepare payment link/quote. |
| Payment execution | `payment_execute` | Later/sensitive | payment | regulated | Execute a payment. Requires explicit approval and strong auth. |
| Subscription status | `subscription_status` | Later | read | personal | Active/cancelled/renewal date. |
| Insurance claim status | `insurance_claim_status` | Later/sensitive | read | regulated | Insurance claim status. |
| Policy coverage query | `insurance_coverage_query` | Later/sensitive | read | regulated | Coverage info. |
| Account balance | `account_balance` | Later/sensitive | read | regulated | Financial balance. Do not launch casually. |

Rules:

- Payment/write capabilities require explicit approval.
- Finance should not be used for launch demos unless authentication/consent is strong.
- Result schemas must avoid unnecessary account details.

---

## 29. Category: Professional Services

Purpose: lawyers, accountants, consultants, agencies, B2B providers.

This category is for non-medical professional services. Doctors, dentists, therapists, clinics, and other care providers belong under Healthcare and Wellness.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Consultation availability | `consultation_availability` | Near-term | read | personal | Available consult slots. |
| Case status | `case_status` | Later/sensitive | read | sensitive | Legal/professional case status. |
| Document status | `document_status` | Near-term | read | personal/sensitive | Status of document/process. |
| Quote/proposal status | `proposal_status` | Near-term | read | personal | Proposal/quote status. |
| Filing deadline status | `filing_deadline_status` | Later/sensitive | read | sensitive | Deadline/status for filing. |

---

## 30. Category: Real Estate and Property

Purpose: property managers, landlords, brokers, maintenance portals.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Property availability | `property_availability` | Near-term | read | public/personal | Rental/sale availability. |
| Viewing availability | `viewing_availability` | Near-term | read | personal | Viewing/visit slots. |
| Application status | `property_application_status` | Later/sensitive | read | sensitive | Rental/application status. |
| Rent due status | `rent_due_status` | Later/sensitive | read/payment | sensitive | Rent due amount/date. |
| Maintenance ticket status | `maintenance_ticket_status` | Near-term | read | personal | Repair ticket status. |

---

## 31. Category: Jobs, Work, and Staffing

Purpose: job boards, recruiters, staffing agencies, shift schedulers.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Job availability | `job_availability` | Near-term | read | public/personal | Open roles/gigs. |
| Application status | `job_application_status` | Later/sensitive | read | sensitive | Candidate application status. |
| Interview status | `interview_status` | Later/sensitive | read | sensitive | Interview scheduling/status. |
| Shift availability | `shift_availability` | Near-term | read | personal | Available work shifts. |
| Shift schedule | `shift_schedule` | Later/sensitive | read | sensitive | Worker schedule. |

---

## 32. Category: Community, Nonprofit, and Membership

Purpose: clubs, libraries, community groups, religious orgs, nonprofits.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Membership status | `membership_status` | Near-term | read | personal | Membership active/expired. |
| Donation receipt status | `donation_receipt_status` | Later | read | personal | Donation receipt/tax status. |
| Library hold status | `library_hold_status` | Near-term | read | personal | Book/resource hold status. |
| Library item availability | `library_item_availability` | Near-term | read | public/personal | Book/resource availability. |
| Community event query | `community_event_query` | Near-term | read | public/personal | Events/programs. |

---

## 33. Category: Agents and Automation Services

Purpose: provider-side agents that perform bounded delegated work.

This category is powerful and should be constrained. Prefer read/quote first; write/action later.

| Capability | Canonical ID | Bucket | Action | Privacy | Description |
|---|---:|---|---|---|---|
| Task status | `agent_task_status` | Near-term | read | personal | Status of delegated task. |
| Document extraction | `document_extraction` | Later/sensitive | agentic | sensitive | Extract structured fields from docs. |
| Form fill draft | `form_fill_draft` | Later/sensitive | agentic | sensitive | Draft a form, not submit. |
| Submit form | `form_submit` | Later/sensitive | write | sensitive/regulated | Submit a form. Requires approval. |
| Research quote | `research_quote` | Later | quote | personal | Quote for research/agent task. |

Rules:

- Agentic/write capabilities require explicit approval.
- Provider must expose clear scope and audit trail.
- Results must be validated against schema.
- No arbitrary remote code execution from catalog/display metadata.

---

## 34. Cross-Cutting Generic Capabilities

Some capabilities can apply across many categories. Claude should decide whether to define them globally or create category-specific variants.

Candidates:

| Generic Capability | Canonical ID | Use Across |
|---|---:|---|
| Status of existing request/order/task | `status_query` | orders, bookings, jobs, tickets |
| Availability of resource/slot/item | `availability_query` | appointments, reservations, products, rooms |
| Quote/estimate | `quote_query` | repairs, shipping, ride, catering |
| Provider hours/location | `provider_info` | most local services |
| Policy query | `policy_query` | returns, cancellation, warranty |

Recommendation:

- Use specific capabilities where params/result semantics are meaningfully different.
- Use generic capabilities only if the result schema can be meaningfully shared.
- Avoid over-generic `status_query` if it makes cards and routing vague.

---

## 35. Recommended Initial Official Catalog

Do not ship the entire broad catalog at once. Start with a practical curated set.

### Launch / already-backed

```txt
eta_query
appointment_status
price_check
```

### Next low-risk additions

```txt
service_health_status
deploy_status
build_status
incident_status
error_summary
job_status
queue_status
webhook_status
issue_status
pull_request_status
repository_status
release_status
test_run_status
environment_status
vulnerability_status
dependency_audit_status
secret_scan_status
compliance_check_status
access_request_status
group_membership_status
user_account_status
oncall_status
data_pipeline_status
database_health_status
backup_status
data_quality_status
report_freshness
query_job_status
model_serving_status
model_eval_status
dataset_status
vector_index_status
agent_run_status
model_deployment_status
device_status
home_automation_status
sensor_reading
reminder_status
personal_task_status
store_hours
store_location
product_search
product_details
order_status
package_tracking
delivery_eta
reservation_availability
menu_query
transit_service_alerts
appointment_availability
consultation_availability
civic_appointment_status
service_quote
service_job_status
technician_eta
school_homework_status
school_timetable_query
library_item_availability
library_hold_status
```

### Sensitive / later

```txt
school_attendance_status
school_grade_status
prescription_refill_status
lab_result_status
insurance_claim_status
account_balance
rent_due_status
job_application_status
case_status
form_submit
payment_link_quote
payment_execute
metric_query
log_query
feature_flag_status
feature_flag_update
deploy_trigger
access_request_approval
audit_evidence_status
policy_evaluation
query_execution
prompt_version_status
device_command
home_automation_trigger
```

Rationale:

- Low-risk additions are mostly read-only, public, or common provider workflows. Developer/ops read-only capabilities are low-risk only when defaulted to `known_only`.
- Sensitive additions involve children, health, finance, legal, employment, payments, raw logs/metrics, privileged access, write actions, or raw data execution.
- Sensitive additions need stronger auth/consent and clearer UX before public rollout.

---

## 36. Suggested Category Ordering in Mobile

Provider setup UI order:

1. Developer Tools and Operations
2. Security and Compliance
3. Identity, Access, and Team Operations
4. Data, Database, and Analytics Operations
5. AI, Model, and Agent Operations
6. Home, Personal, and IoT Automations
7. Transit and Mobility
8. Commerce and Retail
9. Appointments and Bookings
10. Food and Dining
11. School and Education
12. Home and Local Services
13. Logistics and Delivery
14. Travel and Lodging
15. Events and Venues
16. Government and Utilities
17. Professional Services
18. Community and Membership
19. Healthcare and Wellness
20. Finance and Insurance
21. Jobs and Staffing
22. Advanced Custom

Why this order:

- Starts with developer/ops and adjacent private/internal service categories because early service providers are likely developers.
- Then shows lower-risk/common demos.
- Keeps sensitive/regulatory categories lower.
- Makes custom advanced explicit, not the default.

---

## 37. Mobile UI Copy

Provider setup title:

```txt
Add a service Dina can use
```

Category step:

```txt
What kind of service is this?
```

Capability step:

```txt
What can this service answer or do?
```

Official capability label:

```txt
Official Dina capability
```

Custom capability label:

```txt
Custom provider capability
```

Custom warning:

```txt
Custom capabilities are provider-defined. Use this only if your service does not fit an official Dina capability. Public custom services should include input and result schemas.
```

Find-service button:

```txt
Ask Dina to find a service
```

Not:

```txt
Find a service
```

because that implies an in-screen marketplace search.

---

## 38. AppView Search Behavior

Two separate search paths:

### Capability discovery

```txt
search_capabilities(intent)
```

Returns official capabilities and possibly provider-defined custom capabilities matching the generic intent.

Normal capability discovery should only count/return publicly discoverable provider listings. For private/internal developer services, Dina should use known bindings rather than broad AppView discovery.

For official capabilities:

```json
{
  "id": "price_check",
  "display_name": "Price and availability",
  "category_ids": ["commerce"],
  "default_category_id": "commerce",
  "official": true,
  "provider_count": 12
}
```

For custom capabilities:

```json
{
  "id": "com.rajschool.homework_status",
  "display_name": "RajSchool homework status",
  "category_id": "school",
  "official": false,
  "provider_defined": true,
  "provider_did": "did:plc:...",
  "verified_namespace": false
}
```

### Provider service search

```txt
service.search(capability=price_check)
```

Returns providers/listings for that capability.

Normal provider service search returns only `discoverability = public` listings unless the request is an exact known-service/binding flow with appropriate local context.

For cross-category capabilities, include category when the domain matters:

```txt
service.search(capability=appointment_availability&category_id=healthcare&specialty=ENT)
service.search(capability=appointment_availability&category_id=local_services&specialty=haircut)
```

Search result rows should return both capability and category:

```json
{
  "service_uri": "at://did:plc:.../com.dinakernel.service.profile/ent-appointments",
  "provider_did": "did:plc:...",
  "display_name": "Dr Rao ENT Clinic",
  "capability": "appointment_availability",
  "capability_kind": "official",
  "category_id": "healthcare",
  "discoverability": "public",
  "specialties": ["ENT"],
  "schema_hash": "..."
}
```

Known service shortcut:

```txt
known binding exists -> skip AppView discovery -> call service.query directly
```

---

## 39. Known Service Bindings

Catalog solves provider setup and discovery. It does not replace local known-service memory.

Dina should store bindings such as:

```txt
Emma -> school -> RajSchool
RajSchool -> service_uri
RajSchool -> capability: school_homework_status or com.rajschool.homework_status
RajSchool -> schema_hash
```

Then:

```txt
User: What homework does Emma have today?
Dina: use known RajSchool binding -> service.query directly
```

No AppView discovery is needed for repeat known relationships.

---

## 40. Implementation Tasks

### AppView / Protocol

1. Define catalog JSON schema/types.
2. Add `GET /xrpc/com.dinakernel.catalog.capabilities`.
3. Move official catalog data to AppView/protocol-owned source.
4. Keep current registry compatibility for `eta_query`, `appointment_status`, `price_check`.
5. Add lifecycle/deprecation fields.
6. Add catalog hash/version.
7. Add validation tests for duplicate IDs/aliases.
8. Add optional signature support or future hook.
9. Replace single `category_id` assumptions with `category_ids` in catalog definitions.
10. Add provider listing validation: official capability + allowed category, or valid namespaced custom capability + required category.
11. Add search filters for `category_id`, `specialty`, provider type, and service area where available.
12. Add listing visibility/explain data that mobile developer mode can show: why a listing is or is not discoverable.
13. Add required `discoverability` field to service listings.
14. Enforce search behavior: `public` in normal search, `unlisted`/`known_only` excluded from normal search.
15. Add developer/ops and adjacent private-service official capabilities with default `known_only` discoverability.
16. Add optional policy hint fields to listing schema: `access_policy_hint`, `rate_limit_hint`, `pricing_hint`, `freshness_hint`.
17. Document that policy hints are non-enforcing in V1.

### Mobile

1. Fetch catalog at startup or when opening provider setup.
2. Cache last-known-good catalog.
3. Use catalog to render category/capability picker.
4. Hide flat free-text common capability entry from normal flow.
5. Keep advanced custom capability flow namespaced-only.
6. Label custom capabilities clearly.
7. Validate official/common capability selection against fetched catalog.
8. Fallback to bundled minimal catalog only if AppView unavailable.
9. Show developer/custom capabilities as provider-defined, not official.
10. For cross-category capabilities, require the user/provider to choose the concrete category.
11. Ask "Who can find this service?" and publish `discoverability`.
12. Default developer/ops, security, identity/access, data/analytics, AI/model ops, and home/personal automation services to `known_only`.
13. Default custom capabilities to `unlisted` unless the provider explicitly chooses public.
14. Optionally display policy hints if present; do not imply Dina enforces provider access/pricing/rate limits in V1.

### Brain / Router

1. Use catalog/search capability endpoint for unknown service discovery.
2. Prefer known service bindings before AppView.
3. Never invent flat common capability names.
4. Allow namespaced custom capability only when discovered/known, not hallucinated.
5. Do not send private subject details to AppView search.
6. Route using capability + category/provider vertical, not capability alone.
7. Ask clarification when category ambiguity changes privacy or action semantics.
8. Prefer known bindings for `known_only`/internal developer, security, data, AI/model, identity, and home automation services; do not attempt broad AppView discovery for private system names.

### Core / Provider

1. Ensure provider config accepts only official catalog IDs or valid namespaced custom IDs.
2. Enforce schema presence for discoverable public custom capabilities, or mark developer-preview.
3. Keep service.query contact-gate bypass scoped to capability/window, not contact permission.
4. Refresh/retry once on schema hash mismatch.
5. Preserve one listing per DID/rkey as the durable join key.
6. Surface schema/policy rejection reasons to developer logs.
7. Persist and publish `discoverability` with each listing.
8. Persist optional policy hints if present, but keep provider authorization provider-defined in V1.

### Mobile Developer Mode

1. Add provider/developer mode inside mobile service settings.
2. Show official catalog categories/capabilities from AppView.
3. Support advanced namespaced custom capability entry.
4. Add in-app schema editor or structured schema fields for params/result schemas.
5. Validate schemas, category, capability, response policy, and rkey before publish.
6. Publish/unpublish service listings only from mobile.
7. Show service_uri, rkey, capability, category_id, and schema_hash after publish.
8. Show AppView visibility/diagnostic status in mobile.
9. Add in-app test query or sample payload copy.
10. Add schema hash/test-vector docs.
11. Add custom capability namespace/verification docs.

### Out of Scope for V1

Do not build these now:

- CLI publishing.
- Headless publishing.
- CI/CD service deployment.
- Remote signing for service profiles.
- API-key based provider publishing.
- Bulk organization service management.

---

## 41. Validation Tests

Add tests for:

- Catalog endpoint returns valid categories/capabilities.
- Duplicate alias across capabilities fails build/test.
- Official capability with unsupported `category_id` fails provider listing validation.
- Custom capability without `category_id` fails provider listing validation.
- Provider listing without `discoverability` fails validation.
- Policy hints are accepted if valid but are not treated as V1 enforcement.
- A known-only listing with `access_policy_hint: paired_dids` still does not appear in normal search.
- Mobile displays official catalog categories from remote data.
- Mobile does not allow arbitrary flat common capability creation.
- Mobile allows valid namespaced custom capability in advanced mode.
- AppView search maps aliases to canonical IDs.
- Unknown flat capability is not indexed as official/common.
- Custom namespaced capability is indexed as provider-defined/custom.
- Provider custom display metadata cannot spoof official badge.
- ENT/doctor appointment is routed as Healthcare and Wellness, not Professional Services.
- Healthcare appointment availability uses `appointment_availability` plus healthcare category/policy.
- Known service binding skips AppView discovery.
- AppView discovery receives generic intent, not private subject names.
- AppView search can filter by capability + category.
- Public listings appear in normal service search.
- Unlisted and known-only listings do not appear in normal service search.
- Developer/ops and adjacent private-service categories default to `known_only`.
- `service_health_status` can be official/common while its provider listing remains private/known-only.
- `vulnerability_status`, `backup_status`, `model_serving_status`, and `device_status` can be official/common while provider listings remain known-only.
- Mobile developer-mode validation catches unknown flat names, missing schemas, invalid namespace, and missing response policy.
- Mobile developer-mode inspect/explain shows whether capability was canonicalized, custom-admitted, or dropped.
- A provider cannot spoof official/verified status through listing metadata.
- Sensitive capability requires approval/consent policy.
- Deprecated capability remains callable for existing provider but hidden for new setup.

---

## 42. Acceptance Criteria

The catalog architecture is correct when:

- A normal provider can create a service without typing capability IDs.
- `eta_query` and other common capabilities are selected from official catalog/dropdown.
- A provider cannot pollute the official namespace with random flat names.
- A provider can still publish a custom namespaced capability if needed.
- Mobile, Brain, and AppView use the same capability definitions.
- AppView can update categories/capabilities without mobile app release.
- Custom capabilities are visibly provider-defined, not official Dina capabilities.
- Known services are invoked directly with `service.query` without AppView rediscovery.
- Direct D2D is reserved for conversation/person messaging.
- Sensitive categories are gated by approval/auth policy.
- Medical appointment requests are handled as Healthcare and Wellness even though they share appointment capability names.
- Developers can create, validate, publish, inspect, and test a service from mobile developer mode without any CLI publishing path.
- Cross-category capabilities require a concrete provider listing category before publication.
- Every published listing has explicit discoverability: `public`, `unlisted`, or `known_only`.
- Access policy is conceptually separate from discoverability, even if V1 leaves enforcement to the provider.
- Optional policy hints for access, rate limits, pricing, and freshness can be stored/displayed without becoming V1 enforcement promises.
- Developer/ops, security, identity/access, data/analytics, AI/model ops, and home/personal automation capabilities exist as official common contracts, but default provider listing discoverability is `known_only`.
- Common capability does not imply public marketplace exposure.
- AppView can explain why a developer's service is not discoverable.
- Custom capability namespace ownership is not implied unless verified.

---

## 43. Key Decision for Claude to Validate

The main design decision is not the exact list of 80+ capabilities. The main decision is this:

```txt
Official common capability catalog is curated and AppView-served.
Normal providers choose from it.
Advanced providers can create namespaced custom capabilities.
Unknown flat names are not public common capabilities.
Developer providers use mobile developer mode with strict validation and explainable discovery; CLI/headless publishing is out of scope for V1.
Every provider listing carries capability, concrete category, and explicit discoverability.
Access/pricing/rate/freshness policy hints are modeled but not enforced by Dina V1.
Developer/ops and adjacent private-service categories are first-class early capabilities, but internal listings default to known-only/private discovery.
```

If Claude validates only one thing, validate that this invariant is enforced end-to-end.
