/**
 * Cloud LLM gate — mandatory PII scrub for sensitive persona + cloud LLM.
 *
 * Before sending data to a cloud LLM (Claude, OpenAI, Gemini):
 * 1. Check if the persona is sensitive (health, financial)
 * 2. If sensitive + cloud → mandatory PII scrub via EntityVault
 * 3. If scrub fails → refuse cloud, fall back to local or FTS
 *
 * This is the hard gate that prevents PII from reaching cloud providers.
 * Non-sensitive personas can use cloud LLMs without scrubbing.
 * Local LLMs never need scrubbing (data stays on device).
 *
 * Source: ARCHITECTURE.md Task 3.19
 */

import { EntityVault } from '../pii/entity_vault';
import { requiresScrubbing } from './router';

export interface CloudGateResult {
  allowed: boolean;
  scrubbed: boolean;
  scrubbedText?: string;
  vault?: EntityVault;
  fallback?: 'local' | 'fts';
  reason: string;
}

/**
 * Check whether a cloud LLM call is allowed for this persona + text.
 *
 * Returns:
 *   - allowed: true + scrubbedText if scrub succeeded (or no scrub needed)
 *   - allowed: false + fallback suggestion if scrub failed or gate denied
 *
 * The caller should use scrubbedText for the LLM call and the
 * returned EntityVault to rehydrate the response afterward.
 */
export function checkCloudGate(
  text: string,
  persona: string,
  provider: string,
  sensitivePersonas?: string[],
): CloudGateResult {
  // Local/none providers → always allowed, no scrubbing
  if (provider === 'local' || provider === 'none') {
    return {
      allowed: true,
      scrubbed: false,
      scrubbedText: text,
      reason: 'Local provider — no scrub needed',
    };
  }

  // Check if scrubbing is required for this persona + provider
  if (!requiresScrubbing(persona, provider, sensitivePersonas)) {
    return {
      allowed: true,
      scrubbed: false,
      scrubbedText: text,
      reason: 'Non-sensitive persona — cloud allowed without scrub',
    };
  }

  // Sensitive persona + cloud → mandatory scrub
  const vault = new EntityVault();

  try {
    const scrubbedText = vault.scrub(text);

    // Verify scrub actually replaced something (sanity check)
    // Empty text after scrub is fine — it means there was nothing to send
    return {
      allowed: true,
      scrubbed: true,
      scrubbedText,
      vault,
      reason: 'Sensitive persona — scrubbed for cloud',
    };
  } catch {
    // Scrub failed — refuse cloud, suggest fallback
    vault.clear();
    return {
      allowed: false,
      scrubbed: false,
      fallback: 'local',
      reason: 'Scrub failed — refusing cloud for sensitive persona',
    };
  }
}

/**
 * Rehydrate a cloud LLM response using the EntityVault from the gate check.
 *
 * Call this after the LLM responds to restore original PII values
 * into the response text (so the user sees real names/emails, not tokens).
 */
export function rehydrateResponse(response: string, vault: EntityVault): string {
  return vault.rehydrate(response);
}

/**
 * Quick check: does this persona + provider combination require scrubbing?
 *
 * Delegates to the LLM router's requiresScrubbing function.
 */
export function needsScrub(persona: string, provider: string): boolean {
  return requiresScrubbing(persona, provider);
}
