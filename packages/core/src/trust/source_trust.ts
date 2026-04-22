/**
 * Source trust classification — assigns trust metadata to vault items
 * based on sender identity and ingress channel.
 *
 * Rules (priority order):
 *   1. Self: sender is "user"/"self"/"me" or source is personal/cli/telegram
 *      → self, high, normal
 *   2. Contact Ring 1: sender matches a known contact DID
 *      → contact_ring1, medium/high, normal
 *   3. Marketing: sender matches noreply/newsletter/promo patterns
 *      → marketing, low, briefing_only
 *   4. Unknown: unrecognized sender
 *      → unknown, low, caveated (or quarantine for D2D)
 *
 * Source: core/test/source_trust_test.go
 */

export type SenderTrust = 'self' | 'contact_ring1' | 'unknown' | 'marketing';
export type Confidence = 'high' | 'medium' | 'low' | 'unverified';
export type RetrievalPolicy = 'normal' | 'caveated' | 'quarantine' | 'briefing_only';

export interface SourceTrustResult {
  sender_trust: SenderTrust;
  confidence: Confidence;
  retrieval_policy: RetrievalPolicy;
}

/** Sources that indicate self-authored content. */
const SELF_SOURCES = new Set(['personal', 'cli', 'telegram', 'chat', 'voice']);
const SELF_SENDERS = new Set(['user', 'self', 'me']);

/** Marketing sender patterns. */
const MARKETING_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^newsletter@/i,
  /^promo@/i,
  /^marketing@/i,
  /^updates@/i,
  /^info@.*\.com$/i,
];

/** Known contact DIDs (injectable for testing). */
const knownContacts = new Set<string>();

/** Add known contact (for testing). */
export function addKnownContact(did: string): void {
  knownContacts.add(did);
}

/** Clear known contacts (for testing). */
export function clearKnownContacts(): void {
  knownContacts.clear();
}

/**
 * Classify source trust for a vault item.
 */
export function classifySourceTrust(
  sender: string,
  source: string,
  ingressChannel: string,
): SourceTrustResult {
  // Rule 1: Self
  if (isSelfSender(sender, source)) {
    return { sender_trust: 'self', confidence: 'high', retrieval_policy: 'normal' };
  }

  // Rule 2: Known contact (ring 1)
  if (isContactRing1(sender)) {
    const confidence: Confidence = ingressChannel === 'd2d' ? 'high' : 'medium';
    return { sender_trust: 'contact_ring1', confidence, retrieval_policy: 'normal' };
  }

  // Rule 3: Marketing
  if (isMarketingSender(sender)) {
    return { sender_trust: 'marketing', confidence: 'low', retrieval_policy: 'briefing_only' };
  }

  // Rule 4: Unknown — quarantine for D2D, caveated for everything else
  const retrieval: RetrievalPolicy = ingressChannel === 'd2d' ? 'quarantine' : 'caveated';
  return { sender_trust: 'unknown', confidence: 'low', retrieval_policy: retrieval };
}

/** Check if a sender is the user themselves. */
export function isSelfSender(sender: string, source: string): boolean {
  return SELF_SENDERS.has(sender.toLowerCase()) || SELF_SOURCES.has(source.toLowerCase());
}

/** Check if a sender is a known contact (ring 1). */
export function isContactRing1(sender: string): boolean {
  return knownContacts.has(sender);
}

/** Check if a sender is marketing/automated. */
export function isMarketingSender(sender: string): boolean {
  if (!sender) return false;
  return MARKETING_PATTERNS.some((p) => p.test(sender));
}
