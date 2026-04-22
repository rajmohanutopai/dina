/**
 * D2D egress 4-gate enforcement.
 *
 * Before sending any D2D message, four gates are checked in order:
 *   1. Contact check  — recipient must be in contacts (unknown → deny)
 *   2. Scenario policy — message type must be allowed for this contact
 *   3. Sharing policy  — if message contains vault data, check category tier
 *   4. Audit trail     — log the send (always passes, never blocks)
 *
 * safety.alert bypasses gates 2 and 3 (cannot be blocked by policy).
 *
 * The gate module uses an injectable contact/policy store for testability.
 * In production, these are backed by the identity DB.
 *
 * Source: core/internal/service/transport.go (SendMessage egress)
 */

import { alwaysPasses } from './families';

export interface EgressCheckResult {
  allowed: boolean;
  deniedAt?: 'contact' | 'scenario' | 'sharing' | 'audit';
  reason?: string;
}

// ---------------------------------------------------------------
// In-memory stores (populated by setContacts/setPolicies for testing,
// backed by identity DB in production)
// ---------------------------------------------------------------

/** Known contact DIDs. */
const knownContacts = new Set<string>();

/** Per-contact scenario policies: contact DID → set of denied message types. */
const scenarioDeny = new Map<string, Set<string>>();

/** Per-contact sharing policies: contact DID → set of restricted data categories. */
const sharingRestrictions = new Map<string, Set<string>>();

/** Default restricted data categories for contacts without explicit policy. */
const DEFAULT_RESTRICTED_CATEGORIES = new Set(['health', 'financial', 'medical_record']);

/**
 * Blocked destination DIDs — always denied, bypasses all gates.
 * Matching Go's blocked destination list for egress.
 */
const blockedDestinations = new Set<string>();

/**
 * Trusted destination DIDs — bypass tier/scenario checks.
 * Still logged via audit gate. Matching Go's trusted destination list.
 */
const trustedDestinations = new Set<string>();

// ---------------------------------------------------------------
// Configuration (for testing)
// ---------------------------------------------------------------

/** Register a known contact. */
export function addContact(did: string): void {
  knownContacts.add(did);
}

/** Set scenario deny list for a contact. */
export function setScenarioDeny(did: string, deniedTypes: string[]): void {
  scenarioDeny.set(did, new Set(deniedTypes));
}

/** Set sharing restrictions for a contact. */
export function setSharingRestrictions(did: string, restrictedCategories: string[]): void {
  sharingRestrictions.set(did, new Set(restrictedCategories));
}

/** Add a DID to the blocked destination list. */
export function blockDestination(did: string): void {
  blockedDestinations.add(did);
  trustedDestinations.delete(did); // can't be both
}

/** Remove a DID from the blocked destination list. */
export function unblockDestination(did: string): void {
  blockedDestinations.delete(did);
}

/** Add a DID to the trusted destination list. */
export function trustDestination(did: string): void {
  trustedDestinations.add(did);
  blockedDestinations.delete(did); // can't be both
}

/** Remove a DID from the trusted destination list. */
export function untrustDestination(did: string): void {
  trustedDestinations.delete(did);
}

/** Check if a DID is blocked. */
export function isDestinationBlocked(did: string): boolean {
  return blockedDestinations.has(did);
}

/** Check if a DID is trusted. */
export function isDestinationTrusted(did: string): boolean {
  return trustedDestinations.has(did);
}

/** Clear all gates state (for testing). */
export function clearGatesState(): void {
  knownContacts.clear();
  scenarioDeny.clear();
  sharingRestrictions.clear();
  blockedDestinations.clear();
  trustedDestinations.clear();
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Run all 4 egress gates for a D2D message.
 *
 * @param recipientDID - Recipient's DID
 * @param messageType  - V1 message family (e.g., "social.update")
 * @param dataCategories - Vault data categories included (e.g., ["health"])
 */
export function checkEgressGates(
  recipientDID: string,
  messageType: string,
  dataCategories: string[],
): EgressCheckResult {
  // Pre-gate: Blocked destination list — always denied
  if (isDestinationBlocked(recipientDID)) {
    return { allowed: false, deniedAt: 'contact', reason: 'Destination is blocked' };
  }

  // Pre-gate: Trusted destination list — bypass gates 1-3
  if (isDestinationTrusted(recipientDID)) {
    return { allowed: true };
  }

  // Gate 1: Contact check
  if (!checkContactGate(recipientDID)) {
    return { allowed: false, deniedAt: 'contact', reason: 'Recipient is not a known contact' };
  }

  // Gate 2: Scenario policy (safety.alert bypasses)
  if (!checkScenarioGate(recipientDID, messageType)) {
    return {
      allowed: false,
      deniedAt: 'scenario',
      reason: `Message type "${messageType}" denied by scenario policy`,
    };
  }

  // Gate 3: Sharing policy (safety.alert bypasses)
  if (!checkSharingGate(recipientDID, dataCategories)) {
    return {
      allowed: false,
      deniedAt: 'sharing',
      reason: 'Data categories restricted by sharing policy',
    };
  }

  // Gate 4: Audit trail (always passes — just logs the send)
  // In production: appendAudit('d2d_send', recipientDID, messageType, ...)

  return { allowed: true };
}

/**
 * Gate 1: Is the recipient a known contact?
 */
export function checkContactGate(recipientDID: string): boolean {
  if (!recipientDID) return false;
  return knownContacts.has(recipientDID);
}

/**
 * Gate 2: Is this message type allowed for this contact (scenario policy)?
 * safety.alert always passes regardless of policy.
 */
export function checkScenarioGate(recipientDID: string, messageType: string): boolean {
  // safety.alert cannot be blocked
  if (alwaysPasses(messageType)) return true;

  const denied = scenarioDeny.get(recipientDID);
  if (!denied) return true; // no deny list = all allowed
  return !denied.has(messageType);
}

/**
 * Gate 3: Are the data categories allowed for this contact (sharing policy)?
 * Empty categories always pass. If ANY category is restricted, deny the entire send.
 */
export function checkSharingGate(recipientDID: string, dataCategories: string[]): boolean {
  if (dataCategories.length === 0) return true;

  const restricted = sharingRestrictions.get(recipientDID) ?? DEFAULT_RESTRICTED_CATEGORIES;
  return !dataCategories.some((cat) => restricted.has(cat));
}
