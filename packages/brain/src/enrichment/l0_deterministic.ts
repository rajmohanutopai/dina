/**
 * L0 deterministic summary generation — fallback when LLM is unavailable.
 *
 * Pattern: "{type} from {sender} on {date}"
 * Self-authored content (sender=user/self/me): "{type} on {date}" (no "from" clause)
 * When a summary is already provided, it's used as-is (one-line).
 *
 * Trust caveats appended for low-trust or marketing content:
 *   - unknown: " (unverified sender)"
 *   - marketing: " (promotional)"
 *
 * Returns structured L0Result with text, confidence, and enrichment_version
 * matching Python's enrichment output format.
 *
 * Source: brain/src/service/enrichment.py, brain/tests/test_enrichment.py
 */

export interface L0Input {
  type: string;
  source: string;
  sender: string;
  timestamp: number;
  summary?: string;
  sender_trust?: string;
  confidence?: string;
}

/** Structured L0 result with metadata (matching Python enrichment output). */
export interface L0Result {
  /** The L0 one-line headline text. */
  text: string;
  /** Confidence level for this L0 generation. */
  confidence: 'high' | 'medium' | 'low';
  /** Structured enrichment version (matching Go's version tracking). */
  enrichment_version: {
    prompt_v: string;
    embed_model: string | null;
    timestamp: number;
  };
}

/** Trust levels that do NOT require a caveat. */
const TRUSTED_LEVELS = new Set(['self', 'contact_ring1', 'contact_ring2', 'verified']);

/** Trust caveats to append. */
const TRUST_CAVEATS: Record<string, string> = {
  unknown: ' (unverified sender)',
  marketing: ' (promotional)',
  spam: ' (likely spam)',
};

/**
 * Sender strings that indicate self-authored content.
 * Matching Python: sender exclusion when sender == "user".
 * These senders are excluded from the "from {sender}" clause
 * because "Note from user on 2023-11-14" is redundant.
 */
const SELF_SENDERS = new Set(['user', 'self', 'me']);

/**
 * Generate a deterministic L0 (one-line headline) from item metadata.
 *
 * If a summary is already provided, uses it directly.
 * For self-authored content: "{Type} on {date}" (sender excluded).
 * For others: "{Type} from {sender} on {date}"
 *
 * Appends trust caveat if sender_trust is low.
 */
export function generateL0(input: L0Input): string {
  if (!input.type && !input.sender && !input.summary) {
    return '';
  }

  let l0: string;

  if (input.summary) {
    // Use provided summary as L0
    l0 = input.summary;
  } else {
    // Construct from metadata
    const typeName = capitalizeFirst(input.type || 'item');
    const date = input.timestamp > 0 ? formatTimestamp(input.timestamp) : 'unknown date';

    // Exclude sender for self-authored content (matching Python)
    const senderLower = (input.sender || '').toLowerCase();
    if (SELF_SENDERS.has(senderLower) || !input.sender) {
      l0 = `${typeName} on ${date}`;
    } else {
      l0 = `${typeName} from ${input.sender} on ${date}`;
    }
  }

  // Add trust caveat if applicable
  if (input.sender_trust) {
    l0 = addTrustCaveat(l0, input.sender_trust);
  }

  return l0;
}

/**
 * Generate L0 with full metadata — text, confidence, enrichment version.
 *
 * This is the primary entry point for the enrichment pipeline.
 * Returns structured result matching Python's enrichment output format.
 */
export function generateL0WithMeta(input: L0Input): L0Result {
  const text = generateL0(input);
  const confidence = deriveConfidence(input);
  const enrichment_version = buildEnrichmentVersion();

  return { text, confidence, enrichment_version };
}

/**
 * Derive confidence level for the L0 generation.
 *
 * Rules (matching Python enrichment.py):
 *   - Summary provided → high (original author's description)
 *   - Explicit confidence field → use it
 *   - Self sender_trust → high
 *   - contact_ring1/contact_ring2 → medium
 *   - unknown/marketing → low
 *   - Default → medium
 */
function deriveConfidence(input: L0Input): 'high' | 'medium' | 'low' {
  // Explicit confidence from item takes precedence
  if (input.confidence === 'high' || input.confidence === 'medium' || input.confidence === 'low') {
    return input.confidence;
  }

  // Summary provided → high (human-authored headline)
  if (input.summary) return 'high';

  // Trust-based derivation
  if (input.sender_trust === 'self') return 'high';
  if (input.sender_trust === 'contact_ring1' || input.sender_trust === 'contact_ring2')
    return 'medium';
  if (input.sender_trust === 'unknown' || input.sender_trust === 'marketing') return 'low';

  return 'medium';
}

/**
 * Build structured enrichment version (matching Go's version tracking).
 *
 * Python uses: {prompt_v: "...", embed_model: "...", timestamp: unix}
 * This replaces the bare string "deterministic-v1".
 */
export function buildEnrichmentVersion(): L0Result['enrichment_version'] {
  return {
    prompt_v: 'deterministic-v1',
    embed_model: null, // no embedding in L0 deterministic
    timestamp: Math.floor(Date.now() / 1000),
  };
}

/**
 * Add trust caveat to L0 if sender_trust is low or marketing.
 * Trusted senders (self, contact_ring1, contact_ring2, verified) get no caveat.
 */
export function addTrustCaveat(l0: string, senderTrust: string): string {
  if (TRUSTED_LEVELS.has(senderTrust)) {
    return l0;
  }

  const caveat = TRUST_CAVEATS[senderTrust];
  if (caveat) {
    return l0 + caveat;
  }

  // Unrecognized trust level → generic caveat
  return l0 + ' (unverified sender)';
}

/**
 * Format a Unix timestamp as a human-readable date string.
 * Output: "YYYY-MM-DD" (short, suitable for L0 one-liners).
 */
export function formatTimestamp(timestamp: number): string {
  if (timestamp <= 0) return 'unknown date';

  const date = new Date(timestamp * 1000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Capitalize the first letter of a string. */
function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
