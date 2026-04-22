/**
 * Production staging drain loop (GAP-RT-01).
 *
 * `processPendingItems` in `processor.ts` is a test-harness primitive —
 * it operates on an in-memory queue populated by `addPendingItem`. The
 * real ingest path lives in Core's SQLite `staging_inbox`, filled by
 * `POST /v1/staging/ingest`. Python's home node polls
 * `/v1/staging/claim` on a timer; the mobile app needs the same loop.
 *
 * This module provides `runStagingDrainTick(coreClient, options)` —
 * one tick of: claim → classify → enrich → resolve via core. Fail-soft
 * per item so a single bad record doesn't block the rest of the batch.
 * A scheduler (timer / app-foreground / background fetch) calls this
 * from the app bootstrap.
 *
 * Pipeline matches `processPendingItems` so L0/L1 enrichment + persona
 * fanout + the optional WM-BRAIN-03 topic-touch hook behave identically
 * to the test path. The only difference is the claim + resolve edges,
 * which talk to Core instead of the in-memory queue.
 */

import type { BrainCoreClient } from '../core_client/http';
import { classifyDomain, classifyPersonas } from '../routing/domain';
import { generateL0 } from '../enrichment/l0_deterministic';
import {
  touchTopicsForItem,
  type TopicTouchPipelineOptions,
} from '../enrichment/topic_touch_pipeline';
import type { StagingProcessResult } from './processor';

/** Minimal subset of `BrainCoreClient` the drain needs. */
export type StagingDrainCoreClient = Pick<
  BrainCoreClient,
  'claimStagingItems' | 'resolveStagingItem' | 'failStagingItem'
>;

export interface StagingDrainOptions {
  /** Max items to claim per tick. Defaults to 10. */
  limit?: number;
  /** Optional WM-BRAIN-03 hook — see `processor.ProcessPendingItemsOptions.topicTouch`. */
  topicTouch?: TopicTouchPipelineOptions;
  /** Structured log sink. Defaults to no-op. */
  logger?: (entry: Record<string, unknown>) => void;
}

export interface StagingDrainTickResult {
  claimed: number;
  stored: number;
  failed: number;
  /** Per-item detail for tests / telemetry. */
  results: StagingProcessResult[];
}

/**
 * One tick of the staging drain loop. Returns per-item outcomes so the
 * caller can record telemetry / decide whether to schedule another tick
 * immediately (when the batch was full).
 *
 * Never throws — per-item errors are logged and the item is marked
 * failed in core so the retry counter increments. A claim-level error
 * (core unreachable) bubbles via the log sink and returns a zero-item
 * result; the scheduler decides retry cadence.
 */
export async function runStagingDrainTick(
  core: StagingDrainCoreClient,
  options: StagingDrainOptions = {},
): Promise<StagingDrainTickResult> {
  const limit = options.limit ?? 10;
  const log =
    options.logger ??
    ((): void => {
      /* no-op */
    });

  let items: unknown[];
  try {
    items = await core.claimStagingItems(limit);
  } catch (err) {
    log({
      event: 'staging.drain.claim_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return { claimed: 0, stored: 0, failed: 0, results: [] };
  }
  if (items.length === 0) {
    return { claimed: 0, stored: 0, failed: 0, results: [] };
  }

  const results: StagingProcessResult[] = [];
  let stored = 0;
  let failed = 0;

  for (const raw of items) {
    const item = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const itemId = String(item.id ?? 'unknown');

    try {
      const classification = classifyDomain({
        type: String(item.type ?? ''),
        source: String(item.source ?? ''),
        sender: String(item.sender ?? ''),
        subject: String(item.summary ?? item.subject ?? ''),
        body: String(item.body ?? ''),
      });
      const personas = classifyPersonas({
        type: String(item.type ?? ''),
        source: String(item.source ?? ''),
        sender: String(item.sender ?? ''),
        subject: String(item.summary ?? item.subject ?? ''),
        body: String(item.body ?? ''),
      });

      const l0 = generateL0({
        type: String(item.type ?? ''),
        source: String(item.source ?? ''),
        sender: String(item.sender ?? ''),
        timestamp: Number(item.timestamp ?? 0),
        summary: item.summary ? String(item.summary) : undefined,
        sender_trust: item.sender_trust ? String(item.sender_trust) : undefined,
      });
      const enriched: Record<string, unknown> = {
        ...item,
        content_l0: l0,
        content_l1: item.content_l1 ?? '',
        enrichment_status: 'l0_complete',
        enrichment_version: 'deterministic-v1',
      };

      // GAP-MULTI-01: resolve under EVERY persona the classifier
      // flagged, not just the primary. Main-dina's
      // `staging_resolve_multi` writes a vault row per persona so a
      // pediatric-vaccination note lands on both `health` and
      // `family`. When only one persona matched, this is equivalent
      // to the legacy single-persona path.
      await core.resolveStagingItem(itemId, personas, enriched);
      stored++;

      const result: StagingProcessResult = {
        itemId,
        persona: classification.persona,
        status: 'stored',
        enriched: true,
      };

      // GAP-RT-02 wire-point: topic-touch hook runs AFTER a durable
      // resolve, never before — topics must never outlive the item
      // they describe.
      if (options.topicTouch !== undefined) {
        const touchResult = await touchTopicsForItem(
          {
            id: itemId,
            personas,
            summary: typeof item.summary === 'string' ? item.summary : undefined,
            content_l0: typeof enriched.content_l0 === 'string' ? enriched.content_l0 : undefined,
            content_l1: typeof enriched.content_l1 === 'string' ? enriched.content_l1 : undefined,
            body: typeof item.body === 'string' ? item.body : undefined,
          },
          options.topicTouch,
        );
        result.topics = touchResult;
      }

      results.push(result);
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      log({ event: 'staging.drain.item_failed', item_id: itemId, error: reason });
      try {
        await core.failStagingItem(itemId, reason);
      } catch (failErr) {
        log({
          event: 'staging.drain.fail_call_errored',
          item_id: itemId,
          error: failErr instanceof Error ? failErr.message : String(failErr),
        });
      }
      results.push({
        itemId,
        persona: 'general',
        status: 'failed',
        enriched: false,
      });
    }
  }

  log({
    event: 'staging.drain.tick',
    claimed: items.length,
    stored,
    failed,
  });

  return { claimed: items.length, stored, failed, results };
}
