/**
 * Production staging drain loop (GAP-RT-01).
 *
 * `processPendingItems` in `processor.ts` is a test-harness primitive:
 * it operates on an in-memory queue populated by `addPendingItem`. The
 * production ingest path lives in Core's SQLite `staging_inbox`, filled by
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
 * to the direct processor path. The only difference is the claim + resolve edges,
 * which talk to Core instead of the in-memory queue.
 */

import { listContacts, getContact, updateContact, getVaultRepository } from '@dina/core';
import { isVaultItemType } from '@dina/core';
import { enrichItem as enrichVaultItem } from '../enrichment/pipeline';
import {
  touchTopicsForItem,
  type TopicTouchPipelineOptions,
} from '../enrichment/topic_touch_pipeline';
import { processEvent } from '../pipeline/event_processor';
import { handlePostPublish } from '../pipeline/post_publish';
import { type Reminder } from '@dina/core/reminders';
import { listRemindersByPersonaRouted } from '../reminders/backend';
import { classifyDomain, classifyPersonas } from '../routing/domain';
import { selectPersonaRich } from '../routing/persona_selector';
import { scoreSender } from '../peerlens/scorer';
import { getAccessiblePersonas } from '../vault_context/assembly';
import { recallSenderSubjectMemories } from '../vault_context/subject_recall';
import { getPeopleRepository } from '@dina/core';

import type { StagingProcessResult } from './processor';
import type { VaultItemType } from '@dina/core';
import type { CoreClient, ApplyExtractionResponse, ExtractionResult } from '@dina/core';
import type { RememberTurnInput, RememberTurnResult } from '../composition/remember_runtime';

/**
 * Minimal subset of `CoreClient` the drain needs.
 *
 * The drain depends on the transport-agnostic `CoreClient` surface so
 * mobile and server home nodes share the same claim/resolve contract.
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

function vectorToJsonArray(vector: Float32Array | undefined): number[] | undefined {
  return vector === undefined ? undefined : Array.from(vector);
}

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
  /**
   * [pipeline hook] Fires for each reminder the post-publish step
   * planned from a D2D-channel item — so the host can surface it (e.g.
   * a scheduled reminder card in chat) the moment the inbound message
   * lands, rather than only when it fires. The drain stays headless:
   * it emits the reminder; the host decides how/where to render it.
   * (Owner-direct `/remember` reminders are surfaced inline by the chat
   * orchestrator instead — there's a live chat turn to post into.)
   * Fail-soft: a throwing host hook is logged, never blocks the drain.
   */
  onD2DReminderCreated?: (reminder: Reminder) => Promise<void> | void;
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
  /**
   * [pipeline hook] Called for each target persona BEFORE resolve when
   * the item source is owner-direct (`user_remember`). Should open the
   * persona vault so the resolve can write immediately instead of parking
   * as pending_unlock. Mobile bootstrap injects `openPersonaDB`; server
   * and test harnesses leave this undefined (vaults are always open there).
   */
  ownerPersonaOpener?: (persona: string) => Promise<void>;
  /**
   * [pipeline hook] Out-of-process people-graph writer. When set, the
   * post-publish people-graph extractor routes the structured result
   * through this callback instead of the local `PeopleRepository`
   * singleton. Home-node-lite's brain-server wires
   * `(r) => coreClient.peopleApplyExtraction(r)`; mobile leaves this
   * undefined so the in-process repo handles the write directly.
   */
  peopleGraphApply?: (
    result: ExtractionResult,
    persona?: string,
  ) => Promise<ApplyExtractionResponse>;
  /**
   * [pipeline hook] The per-item agentic loop. **REQUIRED in production**;
   * `runStagingDrainTick` throws on the first item if it's missing.
   * Tests that don't care about classification omit this and the drain
   * defaults the route to `general`, skips people-graph + preferences,
   * still runs trust scoring + topic touch + vault write. This lets
   * legacy fixtures keep passing while the new path proves out.
   *
   * Built via `buildRememberRuntime({ llm, personas, ... })` in the
   * host's boot (lite brain-server + mobile `boot_capabilities`).
   */
  rememberRuntime?: {
    run(turn: RememberTurnInput): Promise<RememberTurnResult>;
  };
  /**
   * [config] `today` ISO date string passed into the remember runtime's
   * system prompt. Tests use this to make scripted-LLM scenarios
   * deterministic against fixed dates. Defaults to current date.
   */
  rememberToday?: string;
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
    // `packages/core/src/staging/service.ts`. Pull from `item.data`
    // first so classifier/enrichment see the actual remember body;
    // the fallback keeps narrow unit-test fixtures readable.
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
      // the PeerLens scorer's D2D branch (contacts-only, unknowns
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

      // ────────────────────────────────────────────────────────────────
      // Per-item agentic loop (preferred path). When `rememberRuntime`
      // is wired (lite brain-server + mobile boot when an LLM is
      // configured), the loop sees the item once and emits tool calls
      // for every side effect: persona routing, reminders, people
      // links, preferences. The drain reads `turn.sideEffects` and
      // applies them after vault storage.
      //
      // Fallback (no runtime): the original separate
      // `classifyDomain` → `selectPersonaRich` → keyword fallback +
      // `handlePostPublish` pipeline runs. This keeps legacy fixtures
      // and integration tests green while the new path proves out in
      // production. A future cleanup pass removes the fallback once
      // every consumer wires the runtime.
      // ────────────────────────────────────────────────────────────────
      let turn: RememberTurnResult | null = null;
      if (options.rememberRuntime !== undefined) {
        try {
          const memoryText =
            classifyInput.body !== '' ? classifyInput.body : classifyInput.subject;
          // Structured recall: for a D2D arrival (originDid set), resolve
          // the sender → person and pull their subject-linked memories so
          // the agentic loop can enrich a terse "I'm coming over" with the
          // sender's remembered preferences — works in-process (mobile) and
          // out-of-process (lite, via Core HTTP backends). Fail-soft.
          let relatedMemories: string[] = [];
          if (originDid !== '') {
            try {
              relatedMemories = await recallSenderSubjectMemories(
                originDid,
                getAccessiblePersonas(),
                5,
              );
            } catch (err) {
              log({
                event: 'staging.drain.subject_recall_failed',
                item_id: itemId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          turn = await options.rememberRuntime.run({
            memoryText,
            metadata: {
              type: classifyInput.type,
              source: classifyInput.source,
              sender: classifyInput.sender,
              subject: classifyInput.subject,
            },
            ...(relatedMemories.length > 0 ? { relatedMemories } : {}),
          });
        } catch (err) {
          log({
            event: 'staging.drain.remember_runtime_failed',
            item_id: itemId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Falls through to the keyword classifier below.
        }
      }

      let personas: string[];
      let classifierMethod: 'agentic' | 'llm' | 'keyword' = 'keyword';
      let classifierConfidence = 0;
      let classifierReason = '';
      const classification = classifyDomain(classifyInput);
      if (turn !== null) {
        const routedPrimary = turn.sideEffects.routes[0]?.primary;
        const routedSecondary = turn.sideEffects.routes[0]?.secondary ?? [];
        personas = [routedPrimary ?? 'general', ...routedSecondary];
        classifierMethod = 'agentic';
        classifierConfidence = 1;
        classifierReason = turn.text ?? '';
      } else {
        const rich = await selectPersonaRich(classifyInput);
        if (rich !== null) {
          personas = [rich.primary ?? rich.persona, ...(rich.secondary ?? [])];
          classifierMethod = 'llm';
          classifierConfidence = rich.confidence ?? 0;
          classifierReason = rich.reason ?? '';
        } else {
          personas = classifyPersonas(classifyInput);
          classifierMethod = 'keyword';
          classifierConfidence = classification.confidence;
        }
      }
      log({
        event: 'staging.drain.classified',
        item_id: itemId,
        personas,
        method: classifierMethod,
        confidence: classifierConfidence,
        ...(turn !== null ? { toolNames: turn.toolNames } : {}),
      });

      // PeerLens rating — stamp provenance onto the vault row BEFORE
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

      // D2D contact_did — when the item came in over D2D, the sender's
      // DID is already known (it's the `origin_did` Core stamped).
      // Thread it onto the row so downstream lookups can find the
      // contact ring without re-matching the display name.
      // Python: `if ingress_channel == "d2d" and origin_did:
      // item_dict["contact_did"] = origin_did`.
      const d2dContactDid =
        ingressChannel.toLowerCase() === 'd2d' && originDid !== '' ? originDid : '';

      // Resolve the inbound sender DID to a canonical person_id so the
      // stored row records WHO authored it (people graph). Fail-soft:
      // no people repo / unknown DID leaves it ''. See IDENTITY_HUB §3.5.
      let d2dAuthorPersonId = '';
      if (d2dContactDid !== '') {
        try {
          d2dAuthorPersonId =
            getPeopleRepository()?.resolveByIdentity('did', d2dContactDid)?.personId ?? '';
        } catch {
          /* enrichment metadata, never blocks ingest */
        }
      }

      // Routing metadata — stash the classifier's primary/secondary/
      // confidence/reason in the item metadata blob. `/ask` diagnostics
      // surface this to explain why a row landed where.
      const routingMeta = {
        primary: personas[0] ?? 'general',
        secondary: personas.slice(1),
        confidence: classifierConfidence,
        reason: classifierReason,
        method: classifierMethod,
      };

      const enrichment = await enrichVaultItem({
        type: pickString('type') || 'note',
        source: pickString('source'),
        sender: pickString('sender'),
        timestamp: originalTimestamp,
        summary: pick('summary') !== undefined ? pickString('summary') : undefined,
        body: pickString('body'),
        sender_trust: senderScore.sender_trust,
      });
      const embedding = vectorToJsonArray(enrichment.embedding);
      const enrichmentMeta = {
        status: enrichment.enrichment_status,
        version: enrichment.enrichment_version,
        stages: enrichment.stages,
        confidence: enrichment.confidence,
        has_l1: enrichment.content_l1.trim() !== '',
        has_embedding: embedding !== undefined,
      };
      let mergedMetadata = metaRaw;
      if (typeof mergedMetadata === 'string' && mergedMetadata !== '') {
        try {
          const parsed = JSON.parse(mergedMetadata) as Record<string, unknown>;
          parsed.routing = routingMeta;
          parsed.enrichment = enrichmentMeta;
          mergedMetadata = JSON.stringify(parsed);
        } catch {
          mergedMetadata = JSON.stringify({ routing: routingMeta, enrichment: enrichmentMeta });
        }
      } else {
        mergedMetadata = JSON.stringify({ routing: routingMeta, enrichment: enrichmentMeta });
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
        ...(d2dAuthorPersonId !== '' ? { author_person_id: d2dAuthorPersonId } : {}),
        // Preserved original event time.
        ...(originalTimestamp > 0 ? { timestamp: originalTimestamp } : {}),
        // Routing metadata inside the metadata blob.
        metadata: mergedMetadata,
        // Lineage — staging id so vault-side diagnostics can trace
        // back to the original staging row.
        staging_id: itemId,
        content_l0: enrichment.content_l0,
        content_l1: enrichment.content_l1,
        enrichment_status: enrichment.enrichment_status,
        enrichment_version: JSON.stringify(enrichment.enrichment_version),
        ...(embedding !== undefined ? { embedding } : {}),
      };

      // GAP-MULTI-01 + STG-004: resolve under every persona the
      // classifier flagged, with explicit access for each target.
      // Core must never infer "open" for a secondary persona just
      // because Brain routed to it.
      //
      // Owner-direct writes (user_remember): open each target persona
      // before resolve so the item stores immediately. The owner has
      // unconditional write access to their own vaults — no approval,
      // no unlock prompt. CAPABILITIES.md §vault-compartments.
      const isOwnerDirect = classifyInput.source === 'user_remember';
      if (isOwnerDirect && options.ownerPersonaOpener !== undefined) {
        for (const persona of personas) {
          try {
            await options.ownerPersonaOpener(persona);
          } catch {
            // Already open or opener failed — proceed; if the vault
            // still isn't registered, stagingResolve will surface the
            // real error and the item will be marked failed/retried.
          }
        }
      }
      const accessiblePersonas = new Set(getAccessiblePersonas());
      const personaAccess = Object.fromEntries(
        personas.map((persona) => [
          persona,
          isOwnerDirect ? true : accessiblePersonas.has(persona),
        ]),
      );
      const resolveResult = await core.stagingResolve({
        itemId,
        persona: personas,
        personaAccess,
        data: enriched,
      });
      if (resolveResult.status !== 'stored') {
        // Use the storage target (`personas[0]`), not the keyword
        // classifier's raw output. Same reasoning as the stored
        // branch below: the keyword DOMAINS table includes legacy
        // persona names (`social`, `legal`, `professional`) that
        // may not be installed on this device, while `personas[0]`
        // comes from the LLM-rich selector or the threshold fan-out
        // — both of which target real, installed personas.
        const result: StagingProcessResult = {
          itemId,
          persona: personas[0] ?? 'general',
          status: resolveResult.status === 'pending_unlock' ? 'pending_unlock' : 'failed',
          enriched: true,
        };
        results.push(result);
        log({
          event: 'staging.drain.deferred',
          item_id: itemId,
          personas,
          status: resolveResult.status,
        });
        continue;
      }

      stored++;
      log({
        event: 'staging.drain.resolved',
        item_id: itemId,
        personas,
      });

      // The primary persona where the item actually got stored is
      // `personas[0]`, not `classification.persona`. `classification`
      // is the keyword-classifier's best-match output (used as a
      // weak prior); the actual storage destination is the rich-LLM
      // primary (when registered) or the threshold-gated keyword
      // fan-out, both of which can differ from the bare keyword
      // best-match. Reporting `classification.persona` here led to
      // "Stored in Social vault" replies in chat while the row
      // actually landed in `general` — the keyword classifier scored
      // 'birthday' as a weak social signal, while the LLM (or the
      // 0.5-threshold fan-out) correctly fell back to general.
      const result: StagingProcessResult = {
        itemId,
        persona: personas[0] ?? 'general',
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

      // ────────────────────────────────────────────────────────────────
      // Post-storage side effects. Two paths:
      //
      // (A) Agentic — `turn` is non-null because `rememberRuntime` ran.
      //     Apply the loop's collected side effects: people-graph link,
      //     reminders already fired mid-loop, preferences logged. The
      //     contact last-seen update is deterministic and runs regardless.
      //
      // (B) Legacy — no runtime injected. `handlePostPublish` does the
      //     reminder_planner LLM call, identity-link extraction, etc.
      //     This is the path existing tests + the Python-parity pipeline
      //     still use until every consumer wires the runtime.
      // ────────────────────────────────────────────────────────────────
      if (turn !== null) {
        const postErrors: string[] = [];
        let peopleGraphTelemetry: {
          applied: number;
          created: number;
          updated: number;
          conflicts: number;
          skipped: boolean;
        } | null = null;
        let contactUpdated = false;
        const ambiguousRouting = turn.sideEffects.routes.length === 0;

        if (turn.sideEffects.people.length > 0) {
          const extraction: ExtractionResult = {
            sourceItemId: itemId,
            extractorVersion: 'remember_runtime/v1',
            results: turn.sideEffects.people.map((p) => ({
              canonicalName: p.canonicalName,
              relationshipHint: p.relationshipHint,
              sourceExcerpt: p.sourceExcerpt,
              surfaces: [
                {
                  surface: p.surface,
                  surfaceType: p.surfaceType,
                  confidence: 'high' as const,
                },
              ],
            })),
          };
          try {
            const applyFn =
              options.peopleGraphApply ??
              (async (r: ExtractionResult) => {
                const repo = getPeopleRepository();
                if (repo === null) {
                  return {
                    created: 0,
                    updated: 0,
                    conflicts: [],
                    skipped: true,
                  } as ApplyExtractionResponse;
                }
                return repo.applyExtraction(r);
              });
            // Pass the target persona so the out-of-process writer (Core)
            // links the subjects into the right vault. The in-process
            // fallback ignores it (post-store subject linking is handled
            // by the in-process repo path / post_publish).
            const applyPersona = personas[0] ?? 'general';
            const applied = await applyFn(extraction, applyPersona);
            // In-process agentic path: Core isn't doing the linking, so
            // write the subject edges locally for each resolved person.
            if (options.peopleGraphApply === undefined && applied.personIds) {
              const vaultRepo = getVaultRepository(applyPersona);
              if (vaultRepo !== null) {
                for (const personId of applied.personIds) {
                  try {
                    vaultRepo.linkSubjectSync(itemId, personId, {
                      source: 'llm',
                      confidence: 'medium',
                    });
                  } catch {
                    /* subject link is enrichment — never fail the drain */
                  }
                }
              }
            }
            peopleGraphTelemetry = {
              applied: applied.created + applied.updated,
              created: applied.created,
              updated: applied.updated,
              conflicts: applied.conflicts.length,
              skipped: applied.skipped,
            };
          } catch (err) {
            postErrors.push(
              `people_graph: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        if (turn.sideEffects.preferences.length > 0) {
          // No dedicated preferences table yet — log for telemetry.
          log({
            event: 'staging.drain.preferences_recorded',
            item_id: itemId,
            count: turn.sideEffects.preferences.length,
            preferences: turn.sideEffects.preferences,
          });
        }

        if (d2dContactDid !== '') {
          try {
            const contact = getContact(d2dContactDid);
            if (contact) {
              updateContact(d2dContactDid, {});
              contactUpdated = true;
            }
          } catch (err) {
            postErrors.push(
              `contact_last_seen: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        result.postPublish = {
          remindersCreated: turn.toolNames.filter((n) => n === 'schedule_reminder').length,
          identityLinksFound: turn.sideEffects.people.length,
          contactUpdated,
          ambiguousRouting,
          llmRefinedReminders: true,
          peopleGraph: peopleGraphTelemetry,
          errors: postErrors,
        };
      } else {
        // Legacy path — handlePostPublish does reminder_planner LLM
        // call, identity extraction, contact last-seen, ambiguous flag.
        try {
          const primaryPersona = personas[0] ?? 'general';
          const rawType = pickString('type');
          const itemType: VaultItemType = isVaultItemType(rawType) ? rawType : 'note';
          const postResult = await handlePostPublish(
            {
              id: itemId,
              type: itemType,
              summary: pickString('summary'),
              body: pickString('body'),
              timestamp: originalTimestamp > 0 ? originalTimestamp : Date.now(),
              persona: primaryPersona,
              sender_did: d2dContactDid !== '' ? d2dContactDid : undefined,
              confidence: classifierConfidence,
              metadata: routingMeta,
            },
            {
              ...(options.peopleGraphApply !== undefined
                ? { peopleGraphApply: options.peopleGraphApply }
                : {}),
            },
          );
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
        // Hand each reminder the post-publish step planned from this
        // inbound message to the host's hook, so it can surface it (e.g.
        // a scheduled card in chat) the moment the message lands. The
        // drain stays headless — it emits; the host renders. Fail-soft:
        // a throwing hook is logged, never blocks the tick.
        if (options.onD2DReminderCreated !== undefined) {
          // The reminder-card read + emit is pure enrichment. In lite
          // `listRemindersByPersonaRouted` is a Core HTTP call that can
          // throw on a route/network blip — and the item's storage +
          // post-publish have ALREADY succeeded by this point. Keep the
          // whole block fail-soft (read AND each hook call) so an optional
          // card never flips the staging item to `failed`.
          try {
            const planned = (
              await listRemindersByPersonaRouted(personas[0] ?? 'general')
            ).filter((r) => r.source_item_id === itemId);
            for (const r of planned) {
              try {
                await options.onD2DReminderCreated(r);
              } catch (cbErr) {
                log({
                  event: 'staging.drain.d2d_reminder_hook_failed',
                  item_id: itemId,
                  error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                });
              }
            }
          } catch (readErr) {
            log({
              event: 'staging.drain.d2d_reminder_read_failed',
              item_id: itemId,
              error: readErr instanceof Error ? readErr.message : String(readErr),
            });
          }
        }

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
