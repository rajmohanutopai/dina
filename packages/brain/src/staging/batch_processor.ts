/**
 * Staging batch processor — full lifecycle for claimed items.
 *
 * For each claimed item:
 *   1. Classify via persona selector (keyword → optional LLM)
 *   2. Trust scoring (sender trust level)
 *   3. Enrich L0 (deterministic headline)
 *   4. Resolve (store in vault or pending_unlock)
 *   5. Post-publish (extract reminders, update contact)
 *
 * Error-isolated per item — one failure doesn't stop the batch.
 * Uses staging heartbeat to extend lease during slow processing.
 *
 * Source: ARCHITECTURE.md Tasks 3.13, 3.16
 */

import { resolve, fail, type StagingItem } from '../../../core/src/staging/service';
import { selectPersona } from '../routing/persona_selector';
import { enrichItem, applyTrustScoring } from './processor';
import { handlePostPublish } from '../pipeline/post_publish';
import { isVaultItemType } from '../../../core/src/vault/validation';
import type { VaultItemType } from '../../../core/src/vault/validation';
import { isPersonaOpen } from '../../../core/src/persona/service';
import { beatOnce } from '../../../core/src/staging/heartbeat';

export interface BatchItemResult {
  itemId: string;
  persona: string;
  status: 'stored' | 'pending_unlock' | 'failed';
  enriched: boolean;
  postPublishResult?: {
    remindersCreated: number;
    contactUpdated: boolean;
  };
  error?: string;
}

export interface BatchResult {
  processed: number;
  stored: number;
  pendingUnlock: number;
  failed: number;
  results: BatchItemResult[];
}

/**
 * Process a batch of claimed staging items through the full pipeline.
 *
 * Each item is processed independently — failures are isolated.
 * Extends lease heartbeat between items for slow batches.
 */
export async function processClaimedBatch(items: StagingItem[]): Promise<BatchResult> {
  const result: BatchResult = {
    processed: 0,
    stored: 0,
    pendingUnlock: 0,
    failed: 0,
    results: [],
  };

  for (const item of items) {
    const itemResult = await processOneItem(item);
    result.results.push(itemResult);
    result.processed++;

    if (itemResult.status === 'stored') result.stored++;
    else if (itemResult.status === 'pending_unlock') result.pendingUnlock++;
    else result.failed++;

    // Extend lease on remaining items to prevent timeout
    for (const remaining of items) {
      if (remaining.status === 'classifying') {
        beatOnce(remaining.id, 300);
      }
    }
  }

  return result;
}

/**
 * Process a single claimed item through the full pipeline.
 */
async function processOneItem(item: StagingItem): Promise<BatchItemResult> {
  const data = item.data as Record<string, unknown>;

  try {
    // 1. Classify — determine target persona
    const classification = await selectPersona({
      type: String(data.type ?? ''),
      source: String(data.source ?? ''),
      sender: String(data.sender ?? ''),
      subject: String(data.summary ?? data.subject ?? ''),
      body: String(data.body ?? ''),
    });

    const persona = classification.persona;

    // 2. Trust scoring
    const scored = applyTrustScoring(data);

    // 3. Enrich L0
    const enriched = await enrichItem({ ...data, ...scored });

    // 4. Resolve — store or pending_unlock
    // Pass enriched data so resolve() writes it to the vault (Fix: Codex #1)
    const personaOpen = isPersonaOpen(persona);
    resolve(item.id, persona, personaOpen, enriched as Record<string, unknown>);

    const status = personaOpen ? 'stored' : 'pending_unlock';

    // 5. Post-publish (only for stored items)
    let postPublishResult;
    if (status === 'stored') {
      const rawType = String(enriched.type ?? '');
      const itemType: VaultItemType = isVaultItemType(rawType) ? rawType : 'note';
      const ppResult = await handlePostPublish({
        id: item.id,
        type: itemType,
        summary: String(enriched.content_l0 ?? enriched.summary ?? ''),
        body: String(enriched.body ?? ''),
        timestamp: Number(data.timestamp ?? Date.now()),
        persona,
        sender_did: data.sender_did ? String(data.sender_did) : undefined,
        confidence: classification.confidence,
      });
      postPublishResult = {
        remindersCreated: ppResult.remindersCreated,
        contactUpdated: ppResult.contactUpdated,
      };
    }

    return {
      itemId: item.id,
      persona,
      status,
      enriched: true,
      postPublishResult,
    };
  } catch (err) {
    // Mark item as failed in staging
    try {
      fail(item.id);
    } catch {
      /* already failed or resolved */
    }

    return {
      itemId: item.id,
      persona: 'general',
      status: 'failed',
      enriched: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
