/**
 * Enrichment batch sweep — process pending/failed items through the enrichment pipeline.
 *
 * Queries vault items with enrichment_status of 'l0_complete' or 'failed'
 * and runs them through the full enrichment pipeline (L1 via LLM + embedding).
 *
 * Matching Python's `enrich_pending()`:
 *   1. Query items with status 'l0_complete' across all personas
 *   2. For each item, run enrichItem() to get L1 + embedding
 *   3. Update the vault item with enriched fields
 *   4. Set enrichment_status to 'ready' on success, 'failed' on error
 *
 * The sweep is designed to run periodically (e.g., every 5 minutes)
 * or on-demand after a batch of items is ingested.
 *
 * Source: brain/src/service/enrichment.py — enrich_pending(), enrich_item()
 */

import { enrichItem, type EnrichmentResult } from './pipeline';
import { queryByEnrichmentStatus, updateEnrichment, getItem } from '../../../core/src/vault/crud';
import { listPersonas } from '../../../core/src/persona/service';

// ---------------------------------------------------------------
// Types
// ---------------------------------------------------------------

export interface SweepResult {
  /** Total items found with pending enrichment. */
  found: number;
  /** Items successfully enriched to 'ready' status. */
  enriched: number;
  /** Items that failed enrichment (status set to 'failed'). */
  failed: number;
  /** Items skipped (already processed or deleted). */
  skipped: number;
  /** Per-persona breakdown. */
  byPersona: Record<string, { found: number; enriched: number; failed: number }>;
}

export interface SweepConfig {
  /** Maximum items to process per sweep. Default: 50. */
  batchSize?: number;
  /** Enrichment statuses to sweep. Default: ['l0_complete']. */
  statuses?: string[];
}

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Run a batch enrichment sweep across all accessible personas.
 *
 * Processes items with enrichment_status 'l0_complete' through the
 * full enrichment pipeline (L1 via LLM + embedding generation).
 *
 * Safe: catches errors per-item. One failure does not stop the sweep.
 */
export async function sweepEnrichment(config?: SweepConfig): Promise<SweepResult> {
  const batchSize = config?.batchSize ?? 50;
  const statuses = config?.statuses ?? ['l0_complete'];

  const result: SweepResult = {
    found: 0,
    enriched: 0,
    failed: 0,
    skipped: 0,
    byPersona: {},
  };

  const personas = listPersonas();

  for (const persona of personas) {
    const personaStats = { found: 0, enriched: 0, failed: 0 };
    if (result.found >= batchSize) break;

    for (const status of statuses) {
      const remaining = batchSize - result.found;
      if (remaining <= 0) break;
      const items = queryByEnrichmentStatus(persona.name, status, remaining);
      personaStats.found += items.length;
      result.found += items.length;

      for (const item of items) {
        try {
          const enriched = await enrichItem({
            type: item.type,
            source: item.source,
            sender: item.sender,
            timestamp: item.timestamp,
            summary: item.summary,
            body: item.body,
            sender_trust: item.sender_trust,
          });

          const updated = updateEnrichment(persona.name, item.id, {
            content_l0: enriched.content_l0,
            content_l1: enriched.content_l1 || undefined,
            enrichment_status: enriched.enrichment_status,
            enrichment_version: JSON.stringify(enriched.enrichment_version),
            embedding: enriched.embedding
              ? new Uint8Array(
                  enriched.embedding.buffer,
                  enriched.embedding.byteOffset,
                  enriched.embedding.byteLength,
                )
              : undefined,
            confidence: enriched.confidence,
          });

          if (updated) {
            if (enriched.enrichment_status === 'ready') {
              personaStats.enriched++;
              result.enriched++;
            } else {
              // L0 only — not fully enriched but not failed either
              result.skipped++;
            }
          } else {
            result.skipped++;
          }
        } catch {
          // Mark as failed in vault
          updateEnrichment(persona.name, item.id, { enrichment_status: 'failed' });
          personaStats.failed++;
          result.failed++;
        }
      }
    }

    result.byPersona[persona.name] = personaStats;
  }

  return result;
}

/**
 * Enrich a single vault item by ID.
 *
 * Fetches the item from the vault, runs enrichment, and updates in place.
 * Returns the enrichment result or null if item not found.
 *
 * Matching Python's `enrich_item()` — single-item via Core.
 */
export async function enrichSingleItem(
  persona: string,
  itemId: string,
): Promise<EnrichmentResult | null> {
  const item = getItem(persona, itemId);
  if (!item) return null;

  const enriched = await enrichItem({
    type: item.type,
    source: item.source,
    sender: item.sender,
    timestamp: item.timestamp,
    summary: item.summary,
    body: item.body,
    sender_trust: item.sender_trust,
  });

  updateEnrichment(persona, itemId, {
    content_l0: enriched.content_l0,
    content_l1: enriched.content_l1 || undefined,
    enrichment_status: enriched.enrichment_status,
    enrichment_version: JSON.stringify(enriched.enrichment_version),
    embedding: enriched.embedding
      ? new Uint8Array(
          enriched.embedding.buffer,
          enriched.embedding.byteOffset,
          enriched.embedding.byteLength,
        )
      : undefined,
    confidence: enriched.confidence,
  });

  return enriched;
}
