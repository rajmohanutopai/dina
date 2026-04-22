/**
 * Entity Vault — ephemeral PII token mapping for cloud LLM calls.
 *
 * Created per-LLM-call. Maps [TYPE_N] tokens to original PII values.
 * Used for scrub → LLM → rehydrate cycle. NEVER persisted, NEVER logged.
 * Each concurrent call has its own isolated vault (no cross-contamination).
 *
 * Source: brain/tests/test_pii.py (Entity Vault section)
 */

import { scrubPII, rehydratePII, type ScrubResult } from '../../../core/src/pii/patterns';
import { detectTier2, type PatternMatch } from './tier2_patterns';

export interface EntityVaultEntry {
  token: string; // e.g., "[EMAIL_1]"
  type: string; // e.g., "EMAIL"
  value: string; // e.g., "john@example.com"
}

export class EntityVault {
  private readonly map: Map<string, EntityVaultEntry> = new Map();
  /** Per-type counters for sequential token numbering across both tiers. */
  private readonly typeCounts: Record<string, number> = {};

  /**
   * Two-tier scrub, storing token→value mappings in the vault.
   *
   * Tier 1 (Go regex): emails, phones, cards, SSNs, bank accounts,
   *   addresses, Aadhaar, PAN, IFSC, UPI, IPs
   * Tier 2 (Presidio-equivalent): DE_STEUER_ID, FR_NIR, NL_BSN,
   *   SWIFT_BIC, IN_PASSPORT — runs on the ALREADY-TOKENIZED Tier 1
   *   output to avoid double-detection.
   *
   * Returns the scrubbed text with PII replaced by tokens.
   */
  scrub(text: string): string {
    // Tier 1: Core regex patterns
    const tier1Result = scrubPII(text);

    for (const entity of tier1Result.entities) {
      this.map.set(entity.token, {
        token: entity.token,
        type: entity.type,
        value: entity.value,
      });
      // Track type counts for Tier 2 numbering continuity
      const count = (this.typeCounts[entity.type] || 0) + 1;
      this.typeCounts[entity.type] = count;
    }

    // Tier 2: Run on ALREADY-TOKENIZED text (critical: avoids double-detection).
    // Tier 2 patterns see [EMAIL_1] tokens, not raw PII.
    const tier2Matches = detectTier2(tier1Result.scrubbed);

    // Filter Tier 2 matches: skip any that overlap with existing tokens
    // (Tier 1 already handled them)
    let scrubbed = tier1Result.scrubbed;
    const tier2Hits = tier2Matches.filter((m) => {
      // Skip if the matched text is already a Tier 1 token
      return !m.value.startsWith('[') || !m.value.endsWith(']');
    });

    // Apply Tier 2 scrubs (back-to-front to preserve positions)
    const sorted = [...tier2Hits].sort((a, b) => b.start - a.start);
    for (const match of sorted) {
      const count = (this.typeCounts[match.entity_type] || 0) + 1;
      this.typeCounts[match.entity_type] = count;
      const token = `[${match.entity_type}_${count}]`;

      this.map.set(token, {
        token,
        type: match.entity_type,
        value: match.value,
      });

      scrubbed = scrubbed.slice(0, match.start) + token + scrubbed.slice(match.end);
    }

    return scrubbed;
  }

  /**
   * Rehydrate text, restoring original values from vault.
   * Tokens not in the vault are left as-is.
   */
  rehydrate(text: string): string {
    const entities = Array.from(this.map.values()).map((e) => ({
      token: e.token,
      value: e.value,
    }));
    return rehydratePII(text, entities);
  }

  /** Get all entries in the vault. */
  entries(): EntityVaultEntry[] {
    return Array.from(this.map.values());
  }

  /** Check if the vault has any entries. */
  isEmpty(): boolean {
    return this.map.size === 0;
  }

  /** Number of tracked entities. */
  size(): number {
    return this.map.size;
  }

  /**
   * Clear all entries.
   * Called after rehydration is complete to ensure PII is not retained.
   */
  clear(): void {
    this.map.clear();
  }
}
