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

import { listContacts, getContact } from '../../../core/src/contacts/directory';
import { isVaultItemType } from '../../../core/src/vault/validation';
import { generateL0 } from '../enrichment/l0_deterministic';
import {
  touchTopicsForItem,
  type TopicTouchPipelineOptions,
} from '../enrichment/topic_touch_pipeline';
import { processEvent } from '../pipeline/event_processor';
import { handlePostPublish } from '../pipeline/post_publish';
import { classifyDomain, classifyPersonas } from '../routing/domain';
import { selectPersonaRich } from '../routing/persona_selector';
import { scoreSender } from '../trust/scorer';

import type { StagingProcessResult } from './processor';
import type { VaultItemType } from '../../../core/src/vault/validation';
import type { CoreClient } from '@dina/core';

/**
 * Minimal subset of `CoreClient` the drain needs.
 *
 * Task 1.32 migration — the drain historically took a `BrainCoreClient`
 * Pick. Switching to the transport-agnostic `CoreClient` surface means
 * a drain scheduler can be wired against either `InProcessTransport`
 * (mobile) or `HttpCoreTransport` (server) without a second import
 * path. Mobile bootstraps that still hold a legacy `BrainCoreClient`
 * pass a thin per-method adapter — see `apps/mobile/src/services/bootstrap.ts`.
 */
export type StagingDrainCoreClient = Pick<
  CoreClient,
  'stagingClaim' | 'stagingResolve' | 'stagingFail' | 'stagingExtendLease'
>;

/**
 * Lease heartbeat cadence — Python extends the lease every 5 min
 * during slow LLM enrichment. Keeps parity with
 * `staging_processor._lease_heartbeat`. Not user-tunable; deliberate
 * constant so the heartbeat never drifts out of sync with Core's
 * default lease TTL.
 */
const LEASE_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Lease extension per heartbeat tick (seconds). Additive from the
 * current lease deadline, so every tick pushes the expiry +15 min.
 * Python uses 900s (15 min) as well — must match so parallel drain
 * workers on the same inbox stay consistent.
 */
const LEASE_HEARTBEAT_EXTENSION_SECONDS = 15 * 60;

/**
 * Shape of the D2D-arrival notification the drain hands to the outer
 * layer after a D2D item lands in the vault. The outer layer (mobile
 * boot / home-node brain-server) is responsible for actually
 * delivering the push — this type is the narrow seam between the
 * drain's "here's the nudge I built" and the transport's "send it
 * over WebSocket".
 */
export interface D2DReceivedNotification {
  /** Correlation id — pass-through of the staging item id so the
   *  delivery layer can ack / retry. */
  taskId: string;
  title: string;
  body: string;
  persona: string;
  priority: string;
  interrupt: boolean;
  /** Silence-First priority tier — 1 (fiduciary, interrupt) or 2
   *  (solicited, notify). Tier 3 never reaches this envelope; it
   *  logs silently + batches into the daily briefing. */
  tier: 1 | 2;
  /** How many vault items the nudge assembler pulled in as context
   *  (0 when assembly skipped — unknown sender or empty vault). */
  nudgeItems: number;
}

/**
 * Drain-tick configuration. Fields group into three semantic buckets:
 *
 *   1. **Batch sizing** — `limit` caps per-tick throughput.
 *   2. **Pipeline hooks** — `topicTouch` and `onD2DReceived` are NOT
 *      interchangeable; they fire at DIFFERENT pipeline stages and
 *      are kept distinct on purpose:
 *        - `topicTouch` runs on every successful resolve, immediately
 *          after the vault row is durable, BEFORE post-publish. Drives
 *          working-memory ToC writes per extracted topic (WM-BRAIN-03)
 *          + preference binding (PC-BRAIN-13). Unconditional when the
 *          pipeline options are supplied.
 *        - `onD2DReceived` runs AFTER post-publish, and ONLY when the
 *          item arrived via `ingress_channel='d2d'` and the
 *          `d2d_received` event classifier picks tier 1 (fiduciary)
 *          or tier 2 (solicited). Mobile boot wires this to Core's
 *          `/v1/notify` push channel. An earlier iteration considered
 *          consolidating both into a single `postResolve(item, result)`
 *          channel, but that would push the tier-filtering + working-
 *          memory-specific branching into every caller — the two hooks
 *          are correctly separated by pipeline stage + classification.
 *   3. **Injected deps** — `logger`, `setInterval`, `clearInterval`.
 *      The timer pair drives the per-item lease heartbeat; tests that
 *      need deterministic heartbeat behaviour inject fakes here
 *      (`StagingDrainScheduler` forwards its own pair through so a
 *      single fake covers both tick cadence + heartbeat).
 */
export interface StagingDrainOptions {
  /** [batch] Max items to claim per tick. Defaults to 10. */
  limit?: number;
  /**
   * [pipeline hook] Working-memory touch bundle. Runs on every
   * successful resolve, BEFORE post-publish. See module docstring
   * (§2) for why this is separate from `onD2DReceived`.
   */
  topicTouch?: TopicTouchPipelineOptions;
  /**
   * [pipeline hook] Fires AFTER post-publish on D2D-channel items
   * whose `d2d_received` event classifies as fiduciary/solicited.
   * Fail-soft: any throw is logged but never blocks the drain tick.
   * See module docstring (§2) for the stage + filter contract.
   */
  onD2DReceived?: (notification: D2DReceivedNotification) => Promise<void> | void;
  /** [deps] Structured log sink. Defaults to no-op. */
  logger?: (entry: Record<string, unknown>) => void;
  /**
   * [deps] Injectable timer for the per-item lease heartbeat.
   * Defaults to Node's global `setInterval`. `StagingDrainScheduler`
   * forwards its own pair through so one pair covers both tick
   * cadence + heartbeat, letting fake-timer harnesses stay fully
   * deterministic.
   */
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** [deps] Clears handles minted by `setInterval`. */
  clearInterval?: (handle: unknown) => void;
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
  // Heartbeat timers — fall back to Node globals only when the caller
  // didn't inject (scheduler always does). Tests that need deterministic
  // heartbeat behaviour pass fakes through `StagingDrainOptions`.
  const setIntervalFn =
    options.setInterval ?? ((fn, ms): ReturnType<typeof setInterval> => setInterval(fn, ms));
  const clearIntervalFn =
    options.clearInterval ??
    ((h): void => clearInterval(h as ReturnType<typeof setInterval>));

  let items: unknown[];
  try {
    // `stagingClaim` returns `{items, count}` — the drain only needs
    // the envelopes themselves. `count` is kept on the wire for UX,
    // but mirrors `items.length` so we drop it here.
    const result = await core.stagingClaim(limit);
    items = result.items;
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

    // The staging inbox shape nests payload fields (summary, body, type,
    // source, sender, timestamp) inside `item.data` — see
    // `StagingItem.data: Record<string, unknown>` in
    // `packages/core/src/staging/service.ts`. Previously this loop read
    // `item.summary` / `item.body` at the top level, which is always
    // undefined — the classifier + enrichment then saw empty strings,
    // storeItem persisted a vault row with `summary="" body=""`, and
    // `/ask` FTS searches never matched anything. Pull from `item.data`
    // with a top-level fallback so legacy callers that pre-flattened
    // still work.
    const data = (item.data as Record<string, unknown> | undefined) ?? {};
    const pick = (key: string): unknown => data[key] ?? item[key];
    const pickString = (key: string): string => {
      const v = pick(key);
      return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
    };

    // Lease heartbeat — start a timer that bumps the lease deadline
    // every 5 min so slow LLM classification can't leave the item
    // lease-expired mid-flight (another worker would claim it and
    // we'd double-process). Matches `staging_processor._lease_heartbeat`.
    // Clears in the finally-block after resolve/fail land. Timer pair
    // comes from `options.setInterval`/`clearInterval` so tests can
    // inject deterministic fakes — `StagingDrainScheduler` forwards
    // its own pair through.
    let leaseHeartbeat: unknown = setIntervalFn(() => {
      core
        .stagingExtendLease(itemId, LEASE_HEARTBEAT_EXTENSION_SECONDS)
        .catch(() => {
          /* best-effort — Python swallows extend-lease failures too */
        });
    }, LEASE_HEARTBEAT_INTERVAL_MS);
    const stopHeartbeat = (): void => {
      if (leaseHeartbeat !== null) {
        clearIntervalFn(leaseHeartbeat);
        leaseHeartbeat = null;
      }
    };

    try {
      // Ingress channel / origin DID — Python uses these to drive
      // the trust scorer's D2D branch (contacts-only, unknowns
      // quarantined) and the connector-anti-spoof path.
      const ingressChannel = pickString('ingress_channel');
      const originDid = pickString('origin_did');

      const classifyInput = {
        type: pickString('type'),
        source: pickString('source'),
        sender: pickString('sender'),
        subject: pickString('summary') || pickString('subject'),
        body: pickString('body'),
      };
      const classification = classifyDomain(classifyInput);

      // LLM-first routing — if `registerPersonaSelector` installed a
      // provider at boot (mobile's `boot_capabilities.ts` does this
      // when an API key is configured), trust its primary + secondary
      // directly. This matches Python's `staging_processor.py` which
      // calls `PersonaSelector.select()` with no keyword pre-pass —
      // the LLM sees installed-persona names + descriptions and picks
      // accordingly. The keyword `classifyPersonas` is a fallback for
      // boot-time / no-key runs, not a co-classifier.
      let personas: string[];
      const rich = await selectPersonaRich(classifyInput);
      if (rich !== null) {
        personas = [rich.primary ?? rich.persona, ...(rich.secondary ?? [])];
      } else {
        personas = classifyPersonas(classifyInput);
      }
      log({
        event: 'staging.drain.classified',
        item_id: itemId,
        personas,
        method: rich !== null ? 'llm' : 'keyword',
        confidence: rich?.confidence ?? classification.confidence,
      });

      // Trust scoring — stamp provenance onto the vault row BEFORE
      // resolve so VAULT_CONTEXT's source-trust rules ("items with
      // sender_trust 'self' are the user's own notes — highest
      // trust") have something to match against. Matches Python's
      // `_trust_scorer.score(item_dict)` call. Contacts are loaded
      // from Core's in-memory directory; the scorer matches senders
      // to contacts (name + email + aliases) to flip unknown →
      // contact_ring1.
      // Core's Contact record carries `displayName` + `aliases`. No
      // dedicated `email` slot — emails live in `aliases` alongside
      // other name variants (how Core's contact directory models it).
      // TrustScorer's per-pattern matcher handles emails in the
      // aliases list the same as names.
      const contacts = listContacts().map((c) => ({
        name: c.displayName,
        aliases: Array.isArray(c.aliases) ? c.aliases : undefined,
      }));
      const senderScore = scoreSender(
        pickString('sender'),
        pickString('source'),
        ingressChannel,
        contacts,
      );

      // Original event timestamp — Python reads `metadata.timestamp`
      // so a vault item for an email received 3 days ago shows that
      // date, not "now". Fall back to the staging envelope's timestamp
      // field, then 0 (storeItem defaults to Date.now() when 0).
      const metaRaw = pick('metadata');
      let originalTimestamp = 0;
      if (typeof metaRaw === 'string' && metaRaw !== '') {
        try {
          const parsed = JSON.parse(metaRaw) as Record<string, unknown>;
          const ts = parsed.timestamp;
          if (typeof ts === 'number' && ts > 0) originalTimestamp = ts;
        } catch {
          /* non-JSON metadata — skip */
        }
      }
      if (originalTimestamp === 0) {
        const topTs = pick('timestamp');
        if (typeof topTs === 'number' && topTs > 0) originalTimestamp = topTs;
      }

      const l0 = generateL0({
        type: pickString('type'),
        source: pickString('source'),
        sender: pickString('sender'),
        timestamp: originalTimestamp,
        summary: pick('summary') !== undefined ? pickString('summary') : undefined,
        sender_trust: senderScore.sender_trust,
      });

      // D2D contact_did — when the item came in over D2D, the sender's
      // DID is already known (it's the `origin_did` Core stamped).
      // Thread it onto the row so downstream lookups can find the
      // contact ring without re-matching the display name.
      // Python: `if ingress_channel == "d2d" and origin_did:
      // item_dict["contact_did"] = origin_did`.
      const d2dContactDid =
        ingressChannel.toLowerCase() === 'd2d' && originDid !== '' ? originDid : '';

      // Routing metadata — stash the classifier's primary/secondary/
      // confidence/reason in the item metadata blob. Matches Python's
      // `base_classified["metadata"] = json.dumps({...existing, routing: routing_meta})`.
      // Lets `/ask` diagnostics explain why a row landed where.
      const routingMeta = {
        primary: personas[0] ?? 'general',
        secondary: personas.slice(1),
        confidence: rich?.confidence ?? classification.confidence,
        reason: rich?.reason ?? '',
        method: rich !== null ? 'llm' : 'keyword',
      };
      let mergedMetadata = metaRaw;
      if (typeof mergedMetadata === 'string' && mergedMetadata !== '') {
        try {
          const parsed = JSON.parse(mergedMetadata) as Record<string, unknown>;
          parsed.routing = routingMeta;
          mergedMetadata = JSON.stringify(parsed);
        } catch {
          mergedMetadata = JSON.stringify({ routing: routingMeta });
        }
      } else {
        mergedMetadata = JSON.stringify({ routing: routingMeta });
      }

      // Build the vault row with fields flattened from data so storeItem
      // populates summary/body/etc. The staging envelope's top-level
      // fields (source_id, status, lease_until, etc.) are dropped —
      // they're not vault concerns.
      const enriched: Record<string, unknown> = {
        ...data,
        // Preserve top-level overrides where callers had them.
        ...(item.type !== undefined ? { type: item.type } : {}),
        ...(item.source !== undefined ? { source: item.source } : {}),
        ...(item.sender !== undefined ? { sender: item.sender } : {}),
        // Trust provenance — overrides whatever the ingest envelope
        // may have carried so the scorer has final say. Empty
        // `contact_did` when neither D2D nor contact-match
        // populated one.
        sender_trust: senderScore.sender_trust,
        source_type: senderScore.source_type,
        confidence: senderScore.confidence,
        retrieval_policy: senderScore.retrieval_policy,
        ...(d2dContactDid !== '' ? { contact_did: d2dContactDid } : {}),
        // Preserved original event time.
        ...(originalTimestamp > 0 ? { timestamp: originalTimestamp } : {}),
        // Routing metadata inside the metadata blob.
        metadata: mergedMetadata,
        // Lineage — staging id so vault-side diagnostics can trace
        // back to the original staging row.
        staging_id: itemId,
        content_l0: l0,
        content_l1: pick('content_l1') ?? '',
        enrichment_status: 'l0_complete',
        enrichment_version: 'deterministic-v1',
      };

      // GAP-MULTI-01: resolve under EVERY persona the classifier
      // flagged, not just the primary. Main-dina's
      // `staging_resolve_multi` writes a vault row per persona so a
      // pediatric-vaccination note lands on both `health` and
      // `family`. When only one persona matched, this is equivalent
      // to the legacy single-persona path — CoreClient's
      // `stagingResolve` handles array-vs-string routing internally
      // (array → `personas` wire field; string → `persona`).
      await core.stagingResolve({
        itemId,
        persona: personas,
        data: enriched,
      });
      stored++;
      log({
        event: 'staging.drain.resolved',
        item_id: itemId,
        personas,
      });

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
        const summaryValue = pick('summary');
        const bodyValue = pick('body');
        const touchResult = await touchTopicsForItem(
          {
            id: itemId,
            personas,
            summary: typeof summaryValue === 'string' ? summaryValue : undefined,
            content_l0: typeof enriched.content_l0 === 'string' ? enriched.content_l0 : undefined,
            content_l1: typeof enriched.content_l1 === 'string' ? enriched.content_l1 : undefined,
            body: typeof bodyValue === 'string' ? bodyValue : undefined,
          },
          options.topicTouch,
        );
        result.topics = touchResult;
      }

      // Post-publish — reminder planning, identity-link extraction,
      // contact last-seen update, ambiguous-routing flag. Runs AFTER
      // a successful resolve so failed items don't generate orphan
      // reminders; runs against the primary persona only (Python's
      // staging_processor hands one persona to post_publish even for
      // multi-persona fan-outs, since reminders live in the identity
      // DB and aren't persona-scoped).
      //
      // Fail-soft: `handlePostPublish` catches its own errors — if
      // the reminder planner throws or the identity extractor times
      // out, the item still counts as stored. Errors land in
      // `result.postPublish.errors` for telemetry.
      try {
        const primaryPersona = personas[0] ?? 'general';
        // The vault validator already accepted the row on store
        // (validateVaultItem rejects unknown types), so a SQL value that
        // reaches us here must be a real VaultItemType. Narrow at the
        // boundary instead of casting blindly — if someone bypasses the
        // validator, post-publish gets 'note' rather than crashing.
        const rawType = pickString('type');
        const itemType: VaultItemType = isVaultItemType(rawType) ? rawType : 'note';
        const postResult = await handlePostPublish({
          id: itemId,
          type: itemType,
          summary: pickString('summary'),
          body: pickString('body'),
          timestamp: originalTimestamp > 0 ? originalTimestamp : Date.now(),
          persona: primaryPersona,
          sender_did: d2dContactDid !== '' ? d2dContactDid : undefined,
          confidence: rich?.confidence ?? classification.confidence,
          metadata: routingMeta,
        });
        result.postPublish = {
          remindersCreated: postResult.remindersCreated,
          identityLinksFound: postResult.identityLinksFound,
          contactUpdated: postResult.contactUpdated,
          ambiguousRouting: postResult.ambiguousRouting,
          llmRefinedReminders: postResult.llmRefinedReminders,
          peopleGraph: postResult.peopleGraph,
          errors: postResult.errors,
        };
      } catch (err) {
        // `handlePostPublish` is fail-soft by design — any throw here
        // is a programming bug, not a runtime condition. Surface it
        // on the telemetry result but keep the drain moving.
        const reason = err instanceof Error ? err.message : String(err);
        log({
          event: 'staging.drain.post_publish_threw',
          item_id: itemId,
          error: reason,
        });
        result.postPublish = {
          remindersCreated: 0,
          identityLinksFound: 0,
          contactUpdated: false,
          ambiguousRouting: false,
          llmRefinedReminders: false,
          peopleGraph: null,
          errors: [`post_publish threw: ${reason}`],
        };
      }

      // D2D → nudge chain. Fires only for items that came in over
      // D2D (ingress_channel='d2d'). The event processor classifies
      // Silence-First priority, assembles a nudge from the sender's
      // vault history, scratchpad-checkpoints step 1+2 for crash
      // recovery, then returns a notification envelope. We hand the
      // envelope to `options.onD2DReceived` so mobile boot can push
      // it through Core's `/v1/notify`. Silent / engagement tiers
      // don't produce a notification (Silence First — Law 1).
      if (ingressChannel.toLowerCase() === 'd2d') {
        try {
          const contactForSender =
            d2dContactDid !== '' ? getContact(d2dContactDid) : null;
          const evResult = await processEvent({
            event: 'd2d_received',
            data: {
              task_id: itemId,
              item_id: itemId,
              sender_did: d2dContactDid,
              sender_name: contactForSender?.displayName ?? '',
              persona: personas[0] ?? 'general',
              summary: pickString('summary'),
              body: pickString('body'),
              type: pickString('type'),
              source: pickString('source'),
            },
          });
          // Only surface a notification envelope — other result
          // shapes (silent_log) mean the silence-first classifier
          // decided this doesn't warrant a push.
          if (
            evResult.handled &&
            evResult.result !== null &&
            typeof evResult.result === 'object' &&
            (evResult.result as { type?: string }).type === 'notification' &&
            options.onD2DReceived !== undefined
          ) {
            const n = evResult.result as {
              taskId: string;
              title: string;
              body: string;
              persona: string;
              priority: string;
              interrupt: boolean;
              tier: 1 | 2;
              nudgeItems: number;
            };
            try {
              await options.onD2DReceived({
                taskId: n.taskId,
                title: n.title,
                body: n.body,
                persona: n.persona,
                priority: n.priority,
                interrupt: n.interrupt,
                tier: n.tier,
                nudgeItems: n.nudgeItems,
              });
            } catch (notifyErr) {
              log({
                event: 'staging.drain.d2d_notify_failed',
                item_id: itemId,
                error:
                  notifyErr instanceof Error
                    ? notifyErr.message
                    : String(notifyErr),
              });
            }
          }
        } catch (evErr) {
          // `processEvent` is fail-safe internally; a throw here is
          // a plumbing bug. Log + keep the drain moving.
          log({
            event: 'staging.drain.d2d_event_threw',
            item_id: itemId,
            error: evErr instanceof Error ? evErr.message : String(evErr),
          });
        }
      }

      results.push(result);
    } catch (err) {
      failed++;
      const reason = err instanceof Error ? err.message : String(err);
      log({ event: 'staging.drain.item_failed', item_id: itemId, error: reason });
      try {
        await core.stagingFail(itemId, reason);
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
    } finally {
      stopHeartbeat();
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
