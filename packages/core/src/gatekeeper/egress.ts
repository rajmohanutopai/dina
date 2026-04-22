/**
 * Gatekeeper egress filtering — enforce sharing policy + PII scrub before send.
 *
 * Before any data leaves the device (D2D, agent response, export):
 * 1. Check sharing policy for the destination contact + data categories
 * 2. Apply tier-based filtering (none → block, summary → strip body, full → pass)
 * 3. Scrub PII from outbound text
 *
 * This is the final gate before data exits the trust boundary.
 *
 * Source: ARCHITECTURE.md Task 2.54
 */

import { checkSharingPolicy, filterByTier, type SharingTier } from './sharing';
import { scrubPII } from '../pii/patterns';

export interface EgressData {
  text: string;
  categories: string[];
  body?: string;
  metadata?: Record<string, unknown>;
}

export interface EgressResult {
  allowed: boolean;
  filteredText: string;
  filteredBody?: string;
  scrubbed: boolean;
  blockedCategories: string[];
  appliedTier: SharingTier;
  reason?: string;
}

/**
 * Check and filter outbound data for a specific contact.
 *
 * Steps:
 * 1. Check sharing policy for each data category
 * 2. If any category is denied → block entire payload
 * 3. Apply tier-based filtering (summary strips body)
 * 4. Scrub PII from all text fields
 */
export function checkEgress(data: EgressData, contactDID: string): EgressResult {
  // 1. Check sharing policy
  const sharingDecision = checkSharingPolicy(contactDID, data.categories);

  if (!sharingDecision.allowed) {
    return {
      allowed: false,
      filteredText: '',
      scrubbed: false,
      blockedCategories: sharingDecision.filteredCategories,
      appliedTier: sharingDecision.tier,
      reason: sharingDecision.reason ?? 'Sharing policy denied',
    };
  }

  // 2. Apply tier-based filtering
  const tier = sharingDecision.tier;
  let filteredBody = data.body;

  if (tier === 'summary') {
    // Summary tier: strip body, keep only text (L0/L1 summaries)
    filteredBody = undefined;
  } else if (tier === 'none' || tier === 'locked') {
    // Should have been caught by sharing check, but defense-in-depth
    return {
      allowed: false,
      filteredText: '',
      scrubbed: false,
      blockedCategories: data.categories,
      appliedTier: tier,
      reason: `Sharing tier "${tier}" denies all data`,
    };
  }

  // 3. Scrub PII from outbound text
  const scrubResult = scrubPII(data.text);
  const filteredText = scrubResult.scrubbed;

  let scrubbedBody: string | undefined;
  if (filteredBody) {
    scrubbedBody = scrubPII(filteredBody).scrubbed;
  }

  return {
    allowed: true,
    filteredText,
    filteredBody: scrubbedBody,
    scrubbed:
      scrubResult.entities.length > 0 ||
      (filteredBody !== undefined && scrubbedBody !== filteredBody),
    blockedCategories: [],
    appliedTier: tier,
  };
}

/**
 * Quick check: is egress allowed for this contact + categories?
 * Does NOT filter or scrub — just checks the policy.
 */
export function isEgressAllowed(contactDID: string, categories: string[]): boolean {
  return checkSharingPolicy(contactDID, categories).allowed;
}
