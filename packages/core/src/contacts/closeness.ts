/**
 * Closeness — the relationship tier that drives Contact Services default-grant
 * policy (docs/CONTACT_SERVICES_ARCHITECTURE.md §5.1 / §5.2).
 *
 * Pure function over a contact's `relationship` + `trustLevel`. The tier
 * decides how an UN-GRANTED request from that contact is handled:
 *   - `close`   → auto-grant (ONLY for services the owner marked default-offerable)
 *   - `medium`  → a one-time "ask to enable" prompt
 *   - `distant` → silent soft-reject, no prompt to the owner
 *   - `unknown` → silent soft-reject, no prompt to the owner
 *
 * DESIGN DECISION (spec gives a relationship-only mapping but lists
 * `trust_level` as an available input, so the combination is left to us):
 * closeness is **relationship-primary, trust demote-only**. A `blocked`
 * contact is forced to `unknown` (the safety floor). Trust NEVER elevates —
 * a merely `verified`/`trusted` contact with no close relationship is not
 * treated as close, so identity verification alone never opens the auto-grant
 * door. Auto-grant is reserved for relationships the owner deliberately tagged
 * (spouse/child/parent/sibling), matching the product intent that "verified"
 * is not the same as "may act through me". See implementation-notes.html for
 * the rationale + the open question on whether trusted should elevate.
 *
 * This is a SIGNAL for policy, never an authorization decision on its own:
 * the actual gate is always a `service_grants` row (ingress is grant-table
 * only). Closeness only decides whether/how a grant gets *materialized*.
 */

import type { Contact, Relationship } from './directory';

export type Closeness = 'close' | 'medium' | 'distant' | 'unknown';

const CLOSE_RELATIONSHIPS: ReadonlySet<Relationship> = new Set<Relationship>([
  'spouse',
  'child',
  'parent',
  'sibling',
]);

const DISTANT_RELATIONSHIPS: ReadonlySet<Relationship> = new Set<Relationship>([
  'colleague',
  'acquaintance',
]);

/**
 * Classify a contact's closeness from its `relationship` + `trustLevel`.
 * Accepts a structural subset of `Contact` so callers (and tests) need not
 * build a full record.
 */
export function closeness(contact: Pick<Contact, 'relationship' | 'trustLevel'>): Closeness {
  // Safety floor: a blocked contact is never close, whatever the relationship.
  if (contact.trustLevel === 'blocked') return 'unknown';
  const rel = contact.relationship;
  if (CLOSE_RELATIONSHIPS.has(rel)) return 'close';
  if (rel === 'friend') return 'medium';
  if (DISTANT_RELATIONSHIPS.has(rel)) return 'distant';
  return 'unknown';
}
