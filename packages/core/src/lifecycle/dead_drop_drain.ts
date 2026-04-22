/**
 * Dead drop drain — process spooled messages on persona unlock.
 *
 * When a persona vault is unlocked, messages that arrived while it was
 * locked are sitting in the dead drop spool. This module drains them
 * into the staging inbox for processing.
 *
 * Flow:
 *   1. Persona unlocked (e.g., health vault opened)
 *   2. Drain spool → get all spooled messages
 *   3. Ingest each into staging pipeline
 *   4. Staging will classify + enrich + resolve → store in vault
 *
 * Source: ARCHITECTURE.md Task 6.15
 */

import { DeadDropSpool, type SpoolMessage } from '../storage/spool';
import { ingest } from '../staging/service';

export interface DrainResult {
  drained: number;
  ingested: number;
  duplicates: number;
  errors: number;
}

/** Injectable spool provider (testing / multi-spool support). */
let spoolProvider: (() => DeadDropSpool) | null = null;

/** Register a spool provider. */
export function registerSpoolProvider(provider: () => DeadDropSpool): void {
  spoolProvider = provider;
}

/** Reset (for testing). */
export function resetDrainState(): void {
  spoolProvider = null;
}

/**
 * Drain the dead drop spool and ingest messages into staging.
 *
 * Called when a persona is unlocked. Each spooled message becomes
 * a staging inbox item that flows through the normal pipeline.
 *
 * Error-isolated per message — one failure doesn't stop the drain.
 */
export function drainSpoolToStaging(spool: DeadDropSpool): DrainResult {
  const result: DrainResult = { drained: 0, ingested: 0, duplicates: 0, errors: 0 };

  const messages = spool.drainSpool();
  result.drained = messages.length;

  for (const msg of messages) {
    try {
      const bodyText = new TextDecoder().decode(msg.blob);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(bodyText);
      } catch {
        data = { raw: bodyText };
      }

      const { duplicate } = ingest({
        source: 'dead_drop',
        source_id: msg.id,
        data,
      });

      if (duplicate) {
        result.duplicates++;
      } else {
        result.ingested++;
      }
    } catch {
      result.errors++;
    }
  }

  return result;
}

/**
 * Convenience: drain using the registered spool provider.
 */
export function drainRegisteredSpool(): DrainResult {
  if (!spoolProvider) {
    return { drained: 0, ingested: 0, duplicates: 0, errors: 0 };
  }
  return drainSpoolToStaging(spoolProvider());
}
