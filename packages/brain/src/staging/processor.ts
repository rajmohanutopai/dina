/**
 * Staging processor — classify / enrich / trust-score helpers +
 * in-memory queue harness.
 *
 * TWO surfaces live in this module:
 *
 *   1. Standalone helpers: `classifyItem`, `enrichItem`,
 *      `applyTrustScoring`, `resolveContactDID`, `classifyPersonas`
 *      (via re-export). Unit-tested and reused by the production
 *      drain at `staging/drain.ts::runStagingDrainTick`.
 *
 *   2. In-memory queue pipeline: `addPendingItem` / `clearPendingItems`
 *      / `processPendingItems`. This is test-harness scaffolding, not
 *      the production path. The real ingest flow is
 *      `POST /v1/staging/ingest` → Core's SQLite `staging_inbox` →
 *      drained by `StagingDrainScheduler` (see `staging/scheduler.ts`).
 *      Do NOT add production callers to `addPendingItem` — wire
 *      through the drain instead. See `staging/drain.ts` for the
 *      rationale.
 *
 * classifyItem: uses keyword-based domain classifier to route items to personas.
 * enrichItem: generates deterministic L0 summary, preserves existing L1.
 * processPendingItems: orchestrates the helpers over the in-memory queue.
 *
 * Source: brain/tests/test_staging_processor.py
 */

import { classifySourceTrust } from '../../../core/src/trust/source_trust';
import { classifyDomain, classifyPersonas } from '../routing/domain';
import { generateL0 } from '../enrichment/l0_deterministic';
import {
  touchTopicsForItem,
  type TopicTouchPipelineOptions,
} from '../enrichment/topic_touch_pipeline';

export interface StagingProcessResult {
  itemId: string;
  persona: string;
  status: 'stored' | 'pending_unlock' | 'failed';
  enriched: boolean;
  /**
   * Populated only when `processPendingItems` runs with a
   * `topicTouch` option AND the item stored successfully. `touched`
   * counts ok + skipped, `failed` counts per-topic errors that the
   * pipeline swallowed (so the operator can see them in metrics).
   */
  topics?: { touched: number; failed: number };
  /**
   * Summary of the post-publish step (runs after a successful
   * resolve) — reminder-planner output, identity-link count, contact
   * last-interaction update, ambiguous-routing flag. Present only
   * when the drain actually called `handlePostPublish`. Missing on
   * failed items + on the legacy `processPendingItems` path.
   */
  postPublish?: {
    remindersCreated: number;
    identityLinksFound: number;
    contactUpdated: boolean;
    ambiguousRouting: boolean;
    llmRefinedReminders: boolean;
    errors: string[];
  };
}

/**
 * In-memory staging inbox — TEST HARNESS ONLY.
 *
 * Production ingest goes through Core's SQLite `staging_inbox` and is
 * drained by `StagingDrainScheduler` (see `staging/drain.ts`). This
 * array only exists to let unit tests exercise the helpers below
 * without setting up a Core repo. It's not a fallback ingress path.
 */
const pendingItems: Array<Record<string, unknown>> = [];

/** Clear pending items — TEST HARNESS ONLY. */
export function clearPendingItems(): void {
  pendingItems.length = 0;
}

/** Push an item into the test-only queue. Do NOT call from production
 *  code — use the `/v1/staging/ingest` path + `StagingDrainScheduler`. */
export function addPendingItem(item: Record<string, unknown>): void {
  pendingItems.push(item);
}

/** Options accepted by `processPendingItems`. */
export interface ProcessPendingItemsOptions {
  limit?: number;
  /**
   * Working-memory hook (WM-BRAIN-03). When supplied, each
   * successfully stored item is run through `touchTopicsForItem` so
   * its extracted topics land in the persona ToC. The pipeline is
   * fail-soft — topic failures never fail ingest.
   */
  topicTouch?: TopicTouchPipelineOptions;
}

/**
 * Process all pending staging items.
 *
 * Pipeline: claim → classify → enrich → resolve (→ optional
 * topic touch, WM-BRAIN-03). Returns results for each processed item.
 */
export async function processPendingItems(
  limitOrOptions?: number | ProcessPendingItemsOptions,
): Promise<StagingProcessResult[]> {
  const options: ProcessPendingItemsOptions =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : (limitOrOptions ?? {});
  const batchSize = options.limit ?? 10;
  const batch = pendingItems.splice(0, batchSize);
  const results: StagingProcessResult[] = [];

  for (const item of batch) {
    try {
      // 1. Classify into target personas. `classifyItem` returns the
      // single best match (for the legacy `persona` field on the
      // result); `classifyPersonas` fans out to every persona whose
      // confidence crossed the threshold — matching main-dina's
      // `_classify_personas` behaviour. A clinic email about a
      // child's vaccination lands on both `health` and `family`.
      const classification = await classifyItem(item);
      const personas = classifyPersonas({
        type: String(item.type ?? ''),
        source: String(item.source ?? ''),
        sender: String(item.sender ?? ''),
        subject: String(item.summary ?? item.subject ?? ''),
        body: String(item.body ?? ''),
      });

      // 2. Enrich with L0/L1 summaries
      const enriched = await enrichItem(item);

      const result: StagingProcessResult = {
        itemId: String(item.id ?? 'unknown'),
        persona: classification.persona,
        status: 'stored',
        enriched: true,
      };

      // 3. Optional WM-BRAIN-03 hook — touch topics for the stored
      // item. Runs AFTER resolve success so topics only land when
      // the vault row is durable. Pipeline is fail-soft.
      if (options.topicTouch !== undefined) {
        const touchResult = await touchTopicsForItem(
          {
            id: String(item.id ?? 'unknown'),
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
    } catch {
      results.push({
        itemId: String(item.id ?? 'unknown'),
        persona: 'general',
        status: 'failed',
        enriched: false,
      });
    }
  }

  return results;
}

/**
 * Classify a single item into a target persona.
 *
 * Uses the keyword-based domain classifier for deterministic routing.
 * Falls back to "general" when no strong domain match.
 */
export async function classifyItem(
  item: Record<string, unknown>,
): Promise<{ persona: string; confidence: number }> {
  const result = classifyDomain({
    type: String(item.type ?? ''),
    source: String(item.source ?? ''),
    sender: String(item.sender ?? ''),
    subject: String(item.summary ?? item.subject ?? ''),
    body: String(item.body ?? ''),
  });

  return {
    persona: result.persona,
    confidence: result.confidence,
  };
}

/**
 * Enrich a classified item with L0/L1 summaries.
 *
 * L0: deterministic one-line headline (generateL0).
 * L1: preserved if already present; LLM enrichment deferred to Phase 3.14.
 */
export async function enrichItem(item: Record<string, unknown>): Promise<Record<string, unknown>> {
  const l0 = generateL0({
    type: String(item.type ?? ''),
    source: String(item.source ?? ''),
    sender: String(item.sender ?? ''),
    timestamp: Number(item.timestamp ?? 0),
    summary: item.summary ? String(item.summary) : undefined,
    sender_trust: item.sender_trust ? String(item.sender_trust) : undefined,
  });

  return {
    ...item,
    content_l0: l0,
    content_l1: item.content_l1 ?? '',
    enrichment_status: 'l0_complete',
    enrichment_version: 'deterministic-v1',
  };
}

/**
 * Apply trust scoring to a staging item.
 * Uses classifySourceTrust to assign sender_trust, confidence, retrieval_policy.
 */
export function applyTrustScoring(item: Record<string, unknown>): Record<string, unknown> {
  const sender = String(item.sender ?? '');
  const source = String(item.source ?? '');
  const ingressChannel = String(item.ingress_channel ?? item.connector_id ?? '');

  const trust = classifySourceTrust(sender, source, ingressChannel);

  return {
    ...item,
    sender_trust: trust.sender_trust,
    confidence: trust.confidence,
    retrieval_policy: trust.retrieval_policy,
  };
}

/**
 * Resolve contact DID from sender.
 * If sender starts with "did:", it IS the DID. Otherwise resolve by alias/name.
 * Returns null for unresolvable senders.
 */
export function resolveContactDID(sender: string): string | null {
  if (!sender) return null;
  if (sender.startsWith('did:')) return sender;
  return null;
}
