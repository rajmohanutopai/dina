/**
 * Official service-capability catalog — curated source of truth.
 *
 * See `docs/SERVICE_CAPABILITY_CATALOG_DESIGN.md`. This is the OFFICIAL common
 * capability vocabulary providers choose from (vs. namespaced custom
 * capabilities like `com.acme.widget_price`). AppView serves it at
 * `GET /xrpc/com.dinakernel.catalog.capabilities`; mobile caches it; Brain +
 * Core resolve against it.
 *
 * V1 is intentionally a CURATED, representative set (not the full 80+ from the
 * spec) — it exercises every dimension (action_class, privacy_class,
 * default_discoverability, cross-category capabilities). New official
 * capabilities append here without an app release.
 *
 * Relationship to `capability-registry.ts`: that file is the sync resolver
 * (classify / canonicalize) byte-duplicated into AppView. The catalog is a
 * SUPERSET of it — every registry canonical (`eta_query`, `appointment_status`,
 * `price_check`) appears here with identical aliases. A consistency test
 * (`capability_catalog.test.ts`) enforces that so the two never diverge while
 * the resolver-from-catalog migration (Phase 3/4) is pending.
 *
 * INVARIANT (fail-loud at module load): no duplicate category/capability ids,
 * no alias collisions, every `category_ids`/`default_category_id` resolves,
 * and any write/booking/payment/agentic capability carries an approval hint.
 */

import { isCustomCapability, normalizeCapability } from './capability-registry';

import type {
  CapabilityCatalog,
  CapabilityDefinition,
  CatalogCategory,
  DeprecatedCapability,
} from '../types/catalog';

/** Catalog content version. Bump (date) on every catalog content change. */
// 2026-06-09: added routing-policy fields (intent_routable /
// requires_verified_provider / requires_subject_authorization) and moved
// `school_homework_status` to its target default `known_only`
// (PUBLIC_SERVICES_TAXONOMY.md §3). `introduced_in` stays pinned to the
// version each capability actually shipped in.
export const CATALOG_VERSION = '2026-06-09';

// ─── Categories ─────────────────────────────────────────────────────────────
// `sort_order` follows the spec's mobile ordering (§36) for the subset present.

export const CATALOG_CATEGORIES: readonly CatalogCategory[] = Object.freeze([
  Object.freeze({ id: 'developer_ops', display_name: 'Developer Tools and Operations', short_description: 'API health, deploys, builds, incidents, and ops status.', icon: 'terminal', sort_order: 1, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'home_iot', display_name: 'Home, Personal, and IoT Automations', short_description: 'Private home-node services, devices, sensors, automations.', icon: 'home', sort_order: 6, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'transit', display_name: 'Transit and Mobility', short_description: 'Buses, trains, shuttles, rides, parking, routes.', icon: 'bus', sort_order: 7, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'commerce', display_name: 'Commerce and Retail', short_description: 'Shops, sellers, inventory, prices, orders.', icon: 'cart', sort_order: 8, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'appointments', display_name: 'Appointments and Bookings', short_description: 'Scheduling for non-medical providers — salons, consultants, classes.', icon: 'calendar', sort_order: 9, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'school', display_name: 'School and Education', short_description: 'Schools, colleges, tutoring, classes.', icon: 'school', sort_order: 11, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'home_local', display_name: 'Home, Repairs, and Local Services', short_description: 'Plumbers, electricians, cleaners, repairs.', icon: 'tools', sort_order: 12, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'logistics', display_name: 'Logistics, Delivery, and Postal', short_description: 'Couriers, shipping, parcels, local delivery.', icon: 'package', sort_order: 13, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'professional', display_name: 'Professional Services', short_description: 'Lawyers, accountants, consultants, agencies (non-medical).', icon: 'briefcase', sort_order: 17, lifecycle: 'stable' as const }),
  Object.freeze({ id: 'healthcare', display_name: 'Healthcare and Wellness', short_description: 'Clinics, dentists, pharmacies, labs, therapists.', icon: 'health', sort_order: 19, lifecycle: 'stable' as const }),
]);

// ─── JSON Schemas for the launch-backed capabilities ────────────────────────
// Minimal-but-valid JSON Schema (object root). Provider listings carry the
// authoritative schema + hash; these are catalog DEFAULTS for the 3 seed.

const ETA_QUERY_PARAMS = Object.freeze({
  type: 'object',
  properties: {
    route_id: { type: 'string' },
    stop_id: { type: 'string' },
    lat: { type: 'number' },
    lng: { type: 'number' },
    direction: { type: 'string' },
  },
  additionalProperties: true,
});
const ETA_QUERY_RESULT = Object.freeze({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'delayed', 'unknown'] },
    eta_minutes: { type: 'number' },
    scheduled_time: { type: 'string' },
    route_name: { type: 'string' },
    stop_name: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: true,
});
const PRICE_CHECK_PARAMS = Object.freeze({
  type: 'object',
  properties: {
    product_id: { type: 'string' },
    query: { type: 'string' },
    sku: { type: 'string' },
    location_id: { type: 'string' },
    lat: { type: 'number' },
    lng: { type: 'number' },
  },
  additionalProperties: true,
});
const PRICE_CHECK_RESULT = Object.freeze({
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'not_found', 'out_of_stock', 'unknown'] },
    product_name: { type: 'string' },
    price: { type: 'number' },
    currency: { type: 'string' },
    in_stock: { type: 'boolean' },
    quantity_available: { type: 'number' },
    store_name: { type: 'string' },
    valid_until: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: true,
});
const APPOINTMENT_STATUS_PARAMS = Object.freeze({
  type: 'object',
  properties: {
    appointment_id: { type: 'string' },
    patient_id: { type: 'string' },
    customer_id: { type: 'string' },
    date: { type: 'string' },
    service_type: { type: 'string' },
  },
  additionalProperties: true,
});
const APPOINTMENT_STATUS_RESULT = Object.freeze({
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['confirmed', 'pending', 'cancelled', 'not_found', 'available', 'unavailable', 'unknown'],
    },
    appointment_time: { type: 'string' },
    provider_name: { type: 'string' },
    location: { type: 'string' },
    next_available_time: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['status'],
  additionalProperties: true,
});
// Appointment family (Tier 1 flagship — docs/SERVICE_PROVIDER_TIERS.md).
// These match the authoritative @dina/brain registry schemas byte-for-byte
// (registry is what listings actually publish; these are catalog defaults).
const APPOINTMENT_AVAILABILITY_PARAMS = Object.freeze({
  type: 'object',
  properties: {
    service: { type: 'string' },
    date: { type: 'string' },
    time_after: { type: 'string' },
    time_before: { type: 'string' },
  },
});
const APPOINTMENT_AVAILABILITY_RESULT = Object.freeze({
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['ok', 'no_slots', 'unknown'] },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['time'],
        properties: {
          time: { type: 'string' },
          date: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    date: { type: 'string' },
    as_of: { type: 'string' },
    message: { type: 'string' },
  },
});
const APPOINTMENT_BOOK_PARAMS = Object.freeze({
  type: 'object',
  required: ['time'],
  properties: {
    service: { type: 'string' },
    date: { type: 'string' },
    time: { type: 'string' },
    notes: { type: 'string' },
  },
});
const APPOINTMENT_BOOK_RESULT = Object.freeze({
  type: 'object',
  required: ['status'],
  properties: {
    status: { type: 'string', enum: ['confirmed', 'declined', 'unavailable', 'unknown'] },
    time: { type: 'string' },
    date: { type: 'string' },
    service: { type: 'string' },
    message: { type: 'string' },
  },
});

// ─── Capabilities (curated V1 set) ──────────────────────────────────────────

export const CATALOG_CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
  // ── Launch-backed (seed). IDs + aliases match capability-registry.ts EXACTLY. ──
  Object.freeze({
    id: 'eta_query',
    aliases: Object.freeze(['transit_eta', 'bus_eta', 'arrival_time', 'next_bus']),
    category_ids: Object.freeze(['transit']),
    default_category_id: 'transit',
    display_name: 'ETA / arrival time',
    short_description: 'Estimated arrival time for a transit route at a stop.',
    default_instruction:
      'Use my latest vault notes on routes and schedules to give the arrival time. If my vault does not cover that route or stop, tell them to check the official source. Never guess a time.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'public' as const,
    default_discoverability: 'public' as const,
    approval_policy_hint: 'none' as const,
    intent_routable: true, // public transit info — the canonical generic-discovery case
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
    params_schema: ETA_QUERY_PARAMS,
    result_schema: ETA_QUERY_RESULT,
  }),
  Object.freeze({
    id: 'appointment_status',
    aliases: Object.freeze(['appointment_query', 'appt_status', 'booking_status']),
    category_ids: Object.freeze(['appointments', 'healthcare']),
    default_category_id: 'appointments',
    display_name: 'Appointment status',
    short_description: 'Check the status or next availability of an appointment.',
    default_instruction:
      'Find this customer in my vault and report the status or next time of their appointment. If my vault has no record for them, say so. Never invent one.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'sensitive' as const,
    default_discoverability: 'unlisted' as const,
    approval_policy_hint: 'none' as const,
    // Reads an EXISTING appointment — subject-scoped: the requester already
    // knows their provider, so discovery goes via provider/profile, never
    // generic intent (taxonomy: subject auth ⇒ never intent-routable).
    intent_routable: false,
    requires_verified_provider: false,
    requires_subject_authorization: true,
    introduced_in: '2026-06-01',
    params_schema: APPOINTMENT_STATUS_PARAMS,
    result_schema: APPOINTMENT_STATUS_RESULT,
  }),
  Object.freeze({
    id: 'price_check',
    aliases: Object.freeze(['price_lookup', 'stock_price', 'product_price', 'availability_check']),
    category_ids: Object.freeze(['commerce']),
    default_category_id: 'commerce',
    display_name: 'Price and availability',
    short_description: 'Current price and stock availability of a product at a store.',
    default_instruction:
      'Answer with the current price and stock from my latest vault notes. If it is not in my vault, tell them to check with me. Never guess a price.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'public' as const,
    default_discoverability: 'public' as const,
    approval_policy_hint: 'none' as const,
    intent_routable: true, // public storefront info
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
    params_schema: PRICE_CHECK_PARAMS,
    result_schema: PRICE_CHECK_RESULT,
  }),

  // ── Cross-category appointment family (category travels on the listing). ──
  Object.freeze({
    id: 'appointment_availability',
    aliases: Object.freeze(['appointment_slots', 'appt_availability']),
    category_ids: Object.freeze(['appointments', 'healthcare', 'professional', 'home_local']),
    default_category_id: 'appointments',
    display_name: 'Appointment availability',
    short_description: 'Available appointment/consultation slots.',
    default_instruction:
      'Use my latest vault (current hours, recent changes, and any booked slots) to tell the customer what is open. Do not offer a slot my vault shows as already taken. If my vault does not cover it, tell them to confirm with me directly. Never invent a slot.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'personal' as const,
    default_discoverability: 'unlisted' as const,
    approval_policy_hint: 'none' as const,
    // PROVIDER-side open slots, not subject data — finding a NEW provider
    // ("find me ENT appointments") is the core generic-discovery use case.
    intent_routable: true,
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
    params_schema: APPOINTMENT_AVAILABILITY_PARAMS,
    result_schema: APPOINTMENT_AVAILABILITY_RESULT,
  }),
  Object.freeze({
    id: 'appointment_book',
    aliases: Object.freeze(['book_appointment', 'appointment_booking']),
    category_ids: Object.freeze(['appointments', 'healthcare']),
    default_category_id: 'appointments',
    display_name: 'Book appointment',
    short_description: 'Book an appointment slot. Requires explicit approval.',
    default_instruction:
      'If the requested time is free in my vault, confirm the booking and record it in my vault so that slot is no longer offered. If the time is not free, suggest the nearest open slot instead of confirming. Bookings wait for my approval before they are confirmed.',
    lifecycle: 'beta' as const,
    action_class: 'booking' as const,
    privacy_class: 'sensitive' as const,
    default_discoverability: 'unlisted' as const,
    approval_policy_hint: 'always_approval' as const,
    // CREATES a new booking for the requester ("book me a haircut") — a
    // legitimate generic flow; doesn't READ existing subject data (the
    // always_approval hint gates the action itself).
    intent_routable: true,
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
    params_schema: APPOINTMENT_BOOK_PARAMS,
    result_schema: APPOINTMENT_BOOK_RESULT,
    // Only a CONFIRMED booking persists the "slot taken" write. declined /
    // unavailable / unknown must NOT mark the slot booked (see the runtime's
    // commit gate) — otherwise a non-success result would falsely block the slot.
    mutation_success_statuses: Object.freeze(['confirmed']),
  }),

  // ── Commerce + logistics (distinct contracts: order vs parcel vs ETA). ──
  Object.freeze({
    id: 'order_status',
    aliases: Object.freeze(['order_state']),
    category_ids: Object.freeze(['commerce']),
    default_category_id: 'commerce',
    display_name: 'Order status',
    short_description: 'Status of an existing merchant order.',
    default_instruction:
      'Find this customer in my vault and report the status of their order. If my vault has no record for them, say so. Never make one up.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'personal' as const,
    default_discoverability: 'public' as const,
    approval_policy_hint: 'none' as const,
    // Reads an EXISTING order (subject-scoped) — the merchant is already known
    // from purchase context; "where's my order" routes via that provider, not
    // generic discovery.
    intent_routable: false,
    requires_verified_provider: false,
    requires_subject_authorization: true,
    introduced_in: '2026-06-01',
  }),
  Object.freeze({
    id: 'package_tracking',
    aliases: Object.freeze(['shipment_tracking', 'parcel_tracking']),
    category_ids: Object.freeze(['logistics']),
    default_category_id: 'logistics',
    display_name: 'Package tracking',
    short_description: 'Track a shipment/parcel by tracking number.',
    default_instruction:
      'Use the tracking number to find the shipment in my vault and report where it is. If my vault has nothing for that number, say so.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'personal' as const,
    default_discoverability: 'public' as const,
    approval_policy_hint: 'none' as const,
    // Tracking-NUMBER-scoped (possession of the number is the lookup key —
    // industry norm), not identity-scoped; "track 1Z…" → find the carrier is a
    // real generic flow.
    intent_routable: true,
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
  }),
  Object.freeze({
    id: 'delivery_eta',
    aliases: Object.freeze(['delivery_time']),
    category_ids: Object.freeze(['logistics']),
    default_category_id: 'logistics',
    display_name: 'Delivery ETA',
    short_description: 'ETA for an active delivery.',
    default_instruction:
      'Find the active delivery for this customer in my vault and give the ETA. If my vault has no record for them, say so.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'personal' as const,
    default_discoverability: 'public' as const,
    approval_policy_hint: 'none' as const,
    // YOUR active delivery (subject-scoped) — the courier is known from the
    // order; routes via that provider, not generic discovery.
    intent_routable: false,
    requires_verified_provider: false,
    requires_subject_authorization: true,
    introduced_in: '2026-06-01',
  }),

  // ── Developer/ops (official common contracts, but private by default). ──
  Object.freeze({
    id: 'service_health_status',
    aliases: Object.freeze(['health_status', 'api_health']),
    category_ids: Object.freeze(['developer_ops']),
    default_category_id: 'developer_ops',
    display_name: 'Service health status',
    short_description: 'Health of an API/service/system.',
    default_instruction:
      'Report the current status from my latest vault notes. If my vault does not have it, say so. Do not guess.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'sensitive' as const,
    default_discoverability: 'known_only' as const,
    approval_policy_hint: 'none' as const,
    // PUBLIC status pages are a real discovery case ("is X down?") — routable
    // when a provider deliberately publishes one; the known_only default keeps
    // internal ops listings out of search unless explicitly flipped.
    intent_routable: true,
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
  }),
  Object.freeze({
    id: 'deploy_status',
    aliases: Object.freeze(['deployment_status']),
    category_ids: Object.freeze(['developer_ops']),
    default_category_id: 'developer_ops',
    display_name: 'Deploy status',
    short_description: 'Status of a deployment.',
    default_instruction:
      'Report the current deployment status from my latest vault notes. If my vault does not have it, say so. Do not guess.',
    lifecycle: 'stable' as const,
    action_class: 'read' as const,
    privacy_class: 'sensitive' as const,
    default_discoverability: 'known_only' as const,
    approval_policy_hint: 'none' as const,
    // Internal ops vocabulary — nobody generic-searches "any deploy status";
    // reached via the known provider (your own pipeline).
    intent_routable: false,
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
  }),

  // ── School (sensitive — child data). ──
  Object.freeze({
    id: 'school_homework_status',
    aliases: Object.freeze(['homework_status']),
    category_ids: Object.freeze(['school']),
    default_category_id: 'school',
    display_name: 'Homework status',
    short_description: 'Homework/assignments for a student.',
    default_instruction:
      'Find this student in my vault and report their homework and assignments. If my vault has no record for them, say so. Never invent one.',
    lifecycle: 'beta' as const,
    action_class: 'read' as const,
    privacy_class: 'sensitive' as const,
    // Target default per PUBLIC_SERVICES_TAXONOMY §3 (was `unlisted`): student
    // data is subject-scoped child data — approved-only by default.
    default_discoverability: 'known_only' as const,
    approval_policy_hint: 'none' as const,
    // The taxonomy's canonical "official but NEVER generic-routable" example:
    // reads a child's data; the school is already known to the family.
    intent_routable: false,
    requires_verified_provider: false,
    requires_subject_authorization: true,
    introduced_in: '2026-06-01',
  }),

  // ── Local services (quote action). ──
  Object.freeze({
    id: 'service_quote',
    aliases: Object.freeze(['repair_quote', 'job_quote']),
    category_ids: Object.freeze(['home_local']),
    default_category_id: 'home_local',
    display_name: 'Service quote',
    short_description: 'Quote for a requested repair/service job.',
    default_instruction:
      'Give a rough quote from the pricing in my vault for what the customer described. If it is outside what my vault covers, tell them I will follow up with a custom quote. Do not guess a number.',
    lifecycle: 'beta' as const,
    action_class: 'quote' as const,
    privacy_class: 'personal' as const,
    default_discoverability: 'public' as const,
    approval_policy_hint: 'confirm_before_send' as const,
    // "Find me a plumber quote" — finding NEW providers is the use case;
    // submits a fresh request, reads no existing subject data.
    intent_routable: true,
    requires_verified_provider: false,
    requires_subject_authorization: false,
    introduced_in: '2026-06-01',
  }),

  // ── Home/IoT (private home-node, known-only by default). ──
  Object.freeze({
    id: 'device_status',
    aliases: Object.freeze(['device_state']),
    category_ids: Object.freeze(['home_iot']),
    default_category_id: 'home_iot',
    display_name: 'Device status',
    short_description: 'Status of a device/sensor on a personal node.',
    default_instruction:
      'Find this device or sensor in my vault and report its status. If my vault has no record for it, say so.',
    lifecycle: 'beta' as const,
    action_class: 'read' as const,
    privacy_class: 'personal' as const,
    default_discoverability: 'known_only' as const,
    approval_policy_hint: 'none' as const,
    // Your own home devices — subject-scoped personal-node data; never a
    // generic-discovery target.
    intent_routable: false,
    requires_verified_provider: false,
    requires_subject_authorization: true,
    introduced_in: '2026-06-01',
  }),
]);

/** Deprecated capabilities (none in V1 — the seed IDs are all stable). */
export const DEPRECATED_CAPABILITIES: readonly DeprecatedCapability[] = Object.freeze([]);

// ─── Integrity validation (fail-loud) ───────────────────────────────────────

/** Action classes that MUST carry an explicit (non-`none`) approval hint. */
const ACTION_REQUIRES_APPROVAL: ReadonlySet<string> = new Set([
  'write',
  'booking',
  'payment',
  'agentic',
]);

/**
 * Validate catalog integrity. Throws on the first violation (an authoring bug)
 * rather than serving a corrupt catalog. Exported so the invariant is unit-
 * testable against deliberately-bad fixtures (mirrors `buildAliasMap`).
 *
 * Checks:
 *  - unique category ids;
 *  - unique capability ids (flat — no dots, dots are reserved for custom);
 *  - every alias is unique catalog-wide and collides with no id (one token →
 *    one canonical, like the resolver's `buildAliasMap`); aliases are flat;
 *  - every `category_ids` / `default_category_id` references a real category,
 *    and `default_category_id` (if set) is within `category_ids`;
 *  - write/booking/payment/agentic capabilities carry a non-`none` approval hint;
 *  - a subject-scoped capability (`requires_subject_authorization`) is never
 *    `intent_routable` (PUBLIC_SERVICES_TAXONOMY §3: generic search must never
 *    imply access to a subject's data).
 */
export function validateCatalogIntegrity(
  categories: readonly CatalogCategory[],
  capabilities: readonly CapabilityDefinition[],
): void {
  const categoryIds = new Set<string>();
  for (const cat of categories) {
    if (categoryIds.has(cat.id)) {
      throw new Error(`capability-catalog: duplicate category id "${cat.id}".`);
    }
    categoryIds.add(cat.id);
  }

  // token → canonical id (ids + aliases share one namespace, like the resolver).
  const token = new Map<string, string>();
  const claim = (t: string, canonical: string, kind: 'id' | 'alias'): void => {
    if (t.includes('.')) {
      throw new Error(
        `capability-catalog: ${kind} "${t}" contains a dot — dots are reserved for namespaced custom capabilities.`,
      );
    }
    if (t !== t.trim().toLowerCase()) {
      throw new Error(`capability-catalog: ${kind} "${t}" must be trimmed + lowercase.`);
    }
    const existing = token.get(t);
    if (existing !== undefined && existing !== canonical) {
      throw new Error(
        `capability-catalog: token "${t}" maps to both "${existing}" and "${canonical}" — capability tokens must be unique.`,
      );
    }
    token.set(t, canonical);
  };

  const capabilityIds = new Set<string>();
  for (const cap of capabilities) {
    // A duplicate id maps to itself, so the token map below can't catch it
    // (same canonical → no collision) — check explicitly, like categories.
    if (capabilityIds.has(cap.id)) {
      throw new Error(`capability-catalog: duplicate capability id "${cap.id}".`);
    }
    capabilityIds.add(cap.id);

    claim(cap.id, cap.id, 'id');
    for (const alias of cap.aliases) claim(alias, cap.id, 'alias');

    if (cap.category_ids.length === 0) {
      throw new Error(`capability-catalog: capability "${cap.id}" has no category_ids.`);
    }
    for (const cid of cap.category_ids) {
      if (!categoryIds.has(cid)) {
        throw new Error(
          `capability-catalog: capability "${cap.id}" references unknown category "${cid}".`,
        );
      }
    }
    if (cap.default_category_id !== undefined && !cap.category_ids.includes(cap.default_category_id)) {
      throw new Error(
        `capability-catalog: capability "${cap.id}" default_category_id "${cap.default_category_id}" is not in its category_ids.`,
      );
    }
    if (ACTION_REQUIRES_APPROVAL.has(cap.action_class) && cap.approval_policy_hint === 'none') {
      throw new Error(
        `capability-catalog: ${cap.action_class} capability "${cap.id}" must carry a non-"none" approval_policy_hint.`,
      );
    }
    if (cap.requires_subject_authorization && cap.intent_routable) {
      throw new Error(
        `capability-catalog: capability "${cap.id}" is subject-scoped (requires_subject_authorization) and must not be intent_routable — generic search must never imply access to a subject's data.`,
      );
    }
    // A sensitive/regulated capability that the public-exposure predicate
    // forbids on public listings must not DEFAULT to public — otherwise the
    // catalog default steers every new listing straight into a guaranteed
    // `public_sensitive_capability` publish error.
    const publicExposureAllowed =
      (cap.privacy_class !== 'sensitive' && cap.privacy_class !== 'regulated') ||
      (cap.intent_routable && !cap.requires_subject_authorization);
    if (!publicExposureAllowed && cap.default_discoverability === 'public') {
      throw new Error(
        `capability-catalog: ${cap.privacy_class} capability "${cap.id}" fails the public-exposure predicate but defaults to "public" — its default_discoverability must be unlisted or known_only.`,
      );
    }
    // Verified-provider routing infra does not exist yet (taxonomy guardrail
    // #8): a capability that REQUIRES a verified provider must not enter
    // generic routing, or it would be routed to unverified providers. Relax
    // this only when generic routing can filter to verified providers
    // (taxonomy §6 Stage B).
    if (cap.requires_verified_provider && cap.intent_routable) {
      throw new Error(
        `capability-catalog: capability "${cap.id}" requires a verified provider and cannot be intent_routable until verified-provider routing exists (taxonomy §6 Stage B).`,
      );
    }
  }
}

// Fail-loud at module load: a bad edit breaks the build/tests immediately.
validateCatalogIntegrity(CATALOG_CATEGORIES, CATALOG_CAPABILITIES);

// ─── Accessors ──────────────────────────────────────────────────────────────

const CAPABILITY_BY_ID: ReadonlyMap<string, CapabilityDefinition> = new Map(
  CATALOG_CAPABILITIES.map((c) => [c.id, c]),
);
const CATEGORY_BY_ID: ReadonlyMap<string, CatalogCategory> = new Map(
  CATALOG_CATEGORIES.map((c) => [c.id, c]),
);

/** Look up an official capability definition by canonical id. */
export function getCatalogCapability(id: string): CapabilityDefinition | null {
  return CAPABILITY_BY_ID.get(id) ?? null;
}

/** Look up a catalog category by id. */
export function getCatalogCategory(id: string): CatalogCategory | null {
  return CATEGORY_BY_ID.get(id) ?? null;
}

/** Whether `id` is an official catalog capability (by canonical id). */
export function isOfficialCapability(id: string): boolean {
  return CAPABILITY_BY_ID.has(id);
}

// ─── Catalog-aware resolver ─────────────────────────────────────────────────
// The registry resolver (`capability-registry.ts`) only knows the 3 seed
// capabilities (it's the byte-duplicated sync path for Core's D2D ingress). The
// catalog knows all of them, so callers that need to recognise the FULL official
// vocabulary (provider-listing validation, mobile, future ingest) resolve here.
// Integrity validation already guaranteed no alias collisions, so the map build
// is safe.

const CATALOG_ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const cap of CATALOG_CAPABILITIES) {
    m.set(cap.id, cap.id);
    for (const alias of cap.aliases) m.set(alias, cap.id);
  }
  return m;
})();

/**
 * Resolve a raw capability string to its OFFICIAL catalog canonical id (folding
 * aliases), or `null` if it is not an official catalog capability. Unlike
 * `resolveCanonicalCapability` (registry-only, 3 caps), this knows the whole
 * catalog.
 */
export function resolveCatalogCapability(raw: string): string | null {
  const normalized = normalizeCapability(raw);
  if (normalized.length === 0) return null;
  return CATALOG_ALIAS_TO_CANONICAL.get(normalized) ?? null;
}

/** How a raw capability classifies against the official catalog + custom rules. */
export type CatalogCapabilityKind = 'official' | 'custom' | 'unknown';

/**
 * Classify a raw capability for provider-listing/publish purposes:
 *  - `official` — folds (via id or alias) to a catalog capability;
 *  - `custom`   — a well-formed namespaced custom id (`com.acme.thing`);
 *  - `unknown`  — neither (an unknown flat name → NOT publishable as official).
 *
 * `canonical` is the catalog id (official) or the normalised namespaced id
 * (custom); absent for `unknown`. Mirrors the registry's `classifyCapability`
 * but over the full catalog — the spec §6 anti-spoof rule (a provider cannot
 * make a flat name "official") is enforced here by deriving the kind from the
 * id, never trusting a provider-supplied `capability_kind`.
 */
export function classifyCatalogCapability(
  raw: string,
): { readonly kind: CatalogCapabilityKind; readonly canonical?: string } {
  const normalized = normalizeCapability(raw);
  if (normalized.length === 0) return { kind: 'unknown' };
  const official = CATALOG_ALIAS_TO_CANONICAL.get(normalized);
  if (official !== undefined) return { kind: 'official', canonical: official };
  if (isCustomCapability(normalized)) return { kind: 'custom', canonical: normalized };
  return { kind: 'unknown' };
}

// ─── Builder + canonical serialization ──────────────────────────────────────

export interface BuildCatalogInput {
  /** ISO timestamp from the serving layer (protocol stays clock-free). */
  readonly generatedAt: string;
  /** Canonical hash of the payload, computed by the serving layer. */
  readonly hash: string;
  readonly minClientVersion?: string;
}

/**
 * Assemble the `CapabilityCatalog` response. Deterministic — the caller
 * (AppView) supplies `generatedAt` + `hash` (protocol has no clock/crypto), the
 * same injection pattern as `buildCanonicalPayload`.
 */
export function buildCapabilityCatalog(input: BuildCatalogInput): CapabilityCatalog {
  const base: CapabilityCatalog = {
    catalog_version: CATALOG_VERSION,
    catalog_hash: input.hash,
    generated_at: input.generatedAt,
    categories: CATALOG_CATEGORIES,
    capabilities: CATALOG_CAPABILITIES,
    deprecated_capabilities: DEPRECATED_CAPABILITIES,
  };
  return input.minClientVersion !== undefined
    ? { ...base, min_client_version: input.minClientVersion }
    : base;
}

/**
 * Deterministic string of the catalog CONTENT (version + categories +
 * capabilities + deprecations) for the serving layer to hash. Excludes the
 * volatile `generated_at`/`hash` so the same content always hashes the same.
 */
export function serializeCatalogForHash(): string {
  return JSON.stringify({
    catalog_version: CATALOG_VERSION,
    categories: CATALOG_CATEGORIES,
    capabilities: CATALOG_CAPABILITIES,
    deprecated_capabilities: DEPRECATED_CAPABILITIES,
  });
}
