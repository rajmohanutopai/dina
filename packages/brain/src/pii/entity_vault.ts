/**
 * Entity Vault — ephemeral PII token mapping for cloud LLM calls.
 *
 * Created per-LLM-call. Maps [TYPE_N] tokens to original PII values.
 * Used for scrub → LLM → rehydrate cycle. NEVER persisted, NEVER logged.
 * Each concurrent call has its own isolated vault (no cross-contamination).
 *
 * Source: brain/tests/test_pii.py (Entity Vault section)
 */

import { getNameLexicon, type NameMatcher } from './names';
import { PiiSession } from './session';

export interface EntityVaultEntry {
  token: string; // e.g., "[EMAIL_1]"
  type: string; // e.g., "EMAIL"
  value: string; // e.g., "john@example.com"
}

/**
 * The cloud gate's and safe embeddings' view of a PII session
 * (docs/PII_ARCHITECTURE_V2.md §4): structured patterns (Core Tier 1, Brain
 * Tier 2) and the known names, one token table for the vault's life.
 */
export class EntityVault {
  private readonly session: PiiSession;

  /**
   * `names` is the known-names matcher to scrub with. Code that sends text
   * off the node must use `EntityVault.create()`, which fetches a list at
   * least as new as Core's (REAL_LIFE_FIXES §4.3); the bare constructor is
   * for callers that already hold a fresh matcher, or tests.
   */
  constructor(names?: NameMatcher) {
    this.session = new PiiSession(names);
  }

  /**
   * A vault scrubbing with the host's names, checked current with Core at
   * this moment. Throws `NamesUnavailableError` when Core cannot confirm
   * it: the caller must not send. With no lexicon installed (no Core on
   * this host), patterns alone apply, as before.
   */
  static async create(): Promise<EntityVault> {
    const lexicon = getNameLexicon();
    return new EntityVault(lexicon !== null ? await lexicon.freshMatcher() : undefined);
  }

  /** Replace private values with tokens, remembering each one. */
  scrub(text: string): string {
    return this.session.scrub(text);
  }

  /** Restore original values; tokens not in the vault are left as they are. */
  rehydrate(text: string): string {
    return this.session.rehydrate(text);
  }

  /** Get all entries in the vault. */
  entries(): EntityVaultEntry[] {
    return this.session.entries();
  }

  /** Check if the vault has any entries. */
  isEmpty(): boolean {
    return this.session.size === 0;
  }

  /** Number of tracked entities. */
  size(): number {
    return this.session.size;
  }

  /** Clear all entries, so no value outlives the call. */
  clear(): void {
    this.session.clear();
  }
}
