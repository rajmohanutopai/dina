/**
 * Trust scoring — assigns sender_trust, confidence, retrieval_policy,
 * and source_type to vault items based on sender identity, source,
 * ingress channel, and contact status.
 *
 * Ingress channel dispatch (matching Python trust_scorer.py):
 *   connector → service/medium/normal (anti-spoofing: never falls through)
 *   d2d       → contact check → contact_ring1 or unknown/quarantine
 *   cli/chat/telegram/admin → normal scoring pipeline
 *
 * Normal scoring rules (in priority order):
 *   1. Self: source is personal/cli/telegram/admin, or sender is "user"
 *      → self, high confidence, normal retrieval
 *   2. Known contact: sender matches a contact by email, name, or alias
 *      → contact_ring1, medium confidence, normal retrieval
 *   3. Verified service: sender email domain is a known service
 *      → service, medium confidence, normal retrieval
 *   4. Marketing: sender matches noreply/promo/newsletter/subdomain patterns
 *      → marketing, low confidence, briefing_only retrieval
 *   5. Unknown: default for unrecognized senders
 *      → unknown, low confidence, caveated retrieval
 *
 * Source: brain/src/service/trust_scorer.py
 */

export type SenderTrust = 'self' | 'contact_ring1' | 'service' | 'unknown' | 'marketing';
export type SourceType = 'self' | 'service' | 'contact' | 'unknown' | 'marketing';

export interface TrustScore {
  sender_trust: SenderTrust;
  confidence: string;
  retrieval_policy: string;
  source_type: SourceType;
}

/** Sources that indicate self-authored content. */
const SELF_SOURCES = new Set(['personal', 'cli', 'telegram', 'chat', 'voice', 'admin', 'dina-cli']);

/** Sender strings that indicate self. */
const SELF_SENDERS = new Set(['user', 'self', 'me', 'admin']);

/**
 * Marketing sender patterns (case-insensitive).
 *
 * Includes prefix patterns (noreply@, newsletter@, etc.) and
 * subdomain infixes (@notifications., @bounce., @updates.) matching
 * Python's 10-pattern set.
 */
const MARKETING_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /newsletter@/i,
  /promo@/i,
  /marketing@/i,
  /info@.*\.com$/i,
  /unsubscribe/i,
  // Subdomain infixes (from Python, missing from mobile)
  /@notifications\./i,
  /@bounce\./i,
  /@updates\./i,
];

/**
 * Verified service domains — emails from these domains get
 * service/medium/normal trust. Matches Python's 15-domain set.
 *
 * Banks, hospitals, government, major tech — organizations whose
 * emails carry institutional trust even if the sender isn't a contact.
 */
const VERIFIED_SERVICE_DOMAINS = new Set([
  'chase.com',
  'bankofamerica.com',
  'wellsfargo.com',
  'citi.com',
  'google.com',
  'apple.com',
  'microsoft.com',
  'amazon.com',
  'irs.gov',
  'ssa.gov',
  'medicare.gov',
  'mayoclinic.org',
  'clevelandclinic.org',
  'paypal.com',
  'stripe.com',
]);

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Score the trust of a vault item's sender.
 *
 * Uses ingress channel dispatch (matching Python) before
 * falling into the normal scoring pipeline.
 *
 * @param sender - Sender identifier (email, name, or "user")
 * @param source - Ingress source (gmail, personal, cli, etc.)
 * @param ingressChannel - How the item arrived (connector, d2d, cli, chat, etc.)
 * @param contacts - Known contacts for matching
 */
export function scoreSender(
  sender: string,
  source: string,
  ingressChannel: string,
  contacts: Array<{ name: string; email?: string; aliases?: string[] }>,
): TrustScore {
  const channel = ingressChannel.toLowerCase();

  // ---- Ingress channel dispatch ----

  // Connector anti-spoofing: connector items are trusted as service.
  // A connector claiming source="telegram" must NOT get self trust.
  // Python: returns immediately, never falls through to source matching.
  if (channel === 'connector') {
    return {
      sender_trust: 'service',
      confidence: 'medium',
      retrieval_policy: 'normal',
      source_type: 'service',
    };
  }

  // D2D: check contacts with medium confidence, unknown → quarantine
  if (channel === 'd2d') {
    const contactMatch = matchSenderToContact(sender, contacts);
    if (contactMatch.matched) {
      return {
        sender_trust: 'contact_ring1',
        confidence: 'medium',
        retrieval_policy: 'normal',
        source_type: 'contact',
      };
    }
    return {
      sender_trust: 'unknown',
      confidence: 'low',
      retrieval_policy: 'quarantine',
      source_type: 'unknown',
    };
  }

  // ---- Normal scoring pipeline (cli, chat, telegram, admin, etc.) ----

  // Rule 1: Self-authored content
  if (SELF_SENDERS.has(sender.toLowerCase()) || SELF_SOURCES.has(source.toLowerCase())) {
    return {
      sender_trust: 'self',
      confidence: 'high',
      retrieval_policy: 'normal',
      source_type: 'self',
    };
  }

  // Rule 2: Known contact
  const contactMatch = matchSenderToContact(sender, contacts);
  if (contactMatch.matched) {
    return {
      sender_trust: 'contact_ring1',
      confidence: 'medium',
      retrieval_policy: 'normal',
      source_type: 'contact',
    };
  }

  // Rule 3: Verified service domain
  if (isVerifiedService(sender)) {
    return {
      sender_trust: 'service',
      confidence: 'medium',
      retrieval_policy: 'normal',
      source_type: 'service',
    };
  }

  // Rule 4: Marketing sender (check before unknown — marketing is a specific subcategory)
  if (isMarketingSender(sender)) {
    return {
      sender_trust: 'marketing',
      confidence: 'low',
      retrieval_policy: 'briefing_only',
      source_type: 'marketing',
    };
  }

  // Rule 5: Unknown sender (empty sender also falls here)
  return {
    sender_trust: 'unknown',
    confidence: 'low',
    retrieval_policy: 'caveated',
    source_type: 'unknown',
  };
}

// ---------------------------------------------------------------
// Contact matching
// ---------------------------------------------------------------

/**
 * Match a sender against known contacts by name, email, or alias.
 * Case-insensitive on all comparisons.
 */
export function matchSenderToContact(
  sender: string,
  contacts: Array<{ name: string; email?: string; aliases?: string[] }>,
): { matched: boolean; contactName?: string } {
  if (!sender) return { matched: false };

  const senderLower = sender.toLowerCase();

  for (const contact of contacts) {
    // Match by email
    if (contact.email && contact.email.toLowerCase() === senderLower) {
      return { matched: true, contactName: contact.name };
    }

    // Match by name
    if (contact.name.toLowerCase() === senderLower) {
      return { matched: true, contactName: contact.name };
    }

    // Match by alias
    if (contact.aliases && matchByAlias(sender, contact.aliases)) {
      return { matched: true, contactName: contact.name };
    }
  }

  return { matched: false };
}

/**
 * Check if sender matches by alias (case-insensitive).
 */
export function matchByAlias(sender: string, aliases: string[]): boolean {
  if (!sender || !aliases || aliases.length === 0) return false;
  const senderLower = sender.toLowerCase();
  return aliases.some((alias) => alias.toLowerCase() === senderLower);
}

// ---------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------

/** Check if a sender matches marketing patterns. */
function isMarketingSender(sender: string): boolean {
  return MARKETING_PATTERNS.some((pattern) => pattern.test(sender));
}

/**
 * Check if a sender email is from a verified service domain.
 *
 * Extracts the domain from the email address and checks against
 * the known service domains set (banks, hospitals, government, tech).
 */
function isVerifiedService(sender: string): boolean {
  if (!sender || !sender.includes('@')) return false;
  const domain = sender.split('@')[1]?.toLowerCase();
  return domain ? VERIFIED_SERVICE_DOMAINS.has(domain) : false;
}
