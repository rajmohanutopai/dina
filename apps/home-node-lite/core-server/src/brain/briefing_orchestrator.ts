/**
 * Briefing orchestrator — /api/v1/briefing composition primitive.
 *
 * Composes three primitives into the daily-briefing pipeline:
 *
 *   1. `CoreClient.queryVault` — pulls recent items for the persona.
 *   2. `TopicTocStore.snapshot` — returns the working-memory ToC
 *      (short + long EWMA weights merged).
 *   3. `assembleDigest` — buckets everything into fiduciary / solicited
 *      / engagement with overflow counts.
 *
 * **Pure orchestration** — every IO point is injected:
 *   - `core` (CoreClient) for the vault query.
 *   - `topicStore` (TopicTocStore) for the working-memory snapshot.
 *   - Optional `reminders` + `events` callbacks for extra item streams.
 *   - `nowSec` + `nowMsFn` so tests don't need the real clock.
 *
 * **Failure taxonomy** (tagged, never throws):
 *   - `invalid_input` — request shape check.
 *   - `vault_query_failed` — CoreClient returned `ok: false`.
 *   - `reminders_failed` — optional reminders fetcher threw.
 *   - `events_failed` — optional events fetcher threw.
 *
 * **Why separate reminders/events callbacks**: the CoreClient has no
 * "list reminders" or "list events" method today (staged for 1.32
 * refactor). Callers that DO have other sources pass them in; callers
 * that don't simply omit them + the briefing only surfaces vault
 * items + topics.
 */

import type { CoreClient, VaultItem } from './core_client';
import {
  type AssembleDigestInput,
  type AssembleDigestOptions,
  type Digest,
  type DigestContact,
  type DigestItem,
  assembleDigest,
} from './digest_assembler';
import type { TopicTocStore } from './topic_toc_store';

export interface BriefingRequest {
  persona: string;
  /** Optional query passed through to CoreClient.queryVault; defaults to "". */
  query?: string;
  /** Max vault items to pull. Default 30. */
  maxItems?: number;
  /** Optional vault item type filter passed through to CoreClient. */
  types?: string[];
  /** Optional "since" cutoff (unix seconds) for the vault query. */
  sinceSeconds?: number;
  /** Optional headline the caller injects (e.g. "Good morning, Alonso"). */
  headline?: string;
  /** Optional contact list surfaced in the digest. */
  contacts?: ReadonlyArray<DigestContact>;
  /** Digest-assembler options forwarded as-is. */
  digestOptions?: AssembleDigestOptions;
}

export type BriefingFailureReason =
  | 'invalid_input'
  | 'vault_query_failed'
  | 'reminders_failed'
  | 'events_failed';

export interface BriefingSuccess {
  ok: true;
  digest: Digest;
  itemsFetched: number;
  topicsConsidered: number;
}

export interface BriefingFailure {
  ok: false;
  reason: BriefingFailureReason;
  detail?: string;
}

export type BriefingOutcome = BriefingSuccess | BriefingFailure;

export type RemindersFn = (persona: string) => Promise<
  ReadonlyArray<DigestItem>
>;
export type EventsFn = (persona: string) => Promise<ReadonlyArray<DigestItem>>;

export interface BriefingOrchestratorOptions {
  core: CoreClient;
  topicStore: TopicTocStore;
  /** Optional reminders source — callers without one omit. */
  reminders?: RemindersFn;
  /** Optional events source. */
  events?: EventsFn;
  /** Clock. Defaults to `Date.now` for `nowSec` derivation. */
  nowMsFn?: () => number;
  /** Max topics returned in the digest — default 5 (same as assembler default). */
  maxTopics?: number;
}

export const DEFAULT_MAX_ITEMS = 30;

/**
 * Build the orchestrator. Returns a function the briefing route
 * invokes per request.
 */
export function createBriefingOrchestrator(
  opts: BriefingOrchestratorOptions,
): (req: BriefingRequest) => Promise<BriefingOutcome> {
  if (!opts?.core) throw new TypeError('createBriefingOrchestrator: core required');
  if (!opts.topicStore) throw new TypeError('createBriefingOrchestrator: topicStore required');
  const { core, topicStore, reminders, events } = opts;
  const nowMsFn = opts.nowMsFn ?? (() => Date.now());
  const maxTopics = opts.maxTopics ?? 5;

  return async function briefing(req: BriefingRequest): Promise<BriefingOutcome> {
    const validation = validate(req);
    if (validation !== null) {
      return { ok: false, reason: 'invalid_input', detail: validation };
    }

    const maxItems = req.maxItems ?? DEFAULT_MAX_ITEMS;
    const nowSec = Math.floor(nowMsFn() / 1000);

    // 1. Vault query.
    const vaultQuery: Parameters<CoreClient['queryVault']>[0] = {
      persona: req.persona,
      query: req.query ?? '',
      maxItems,
    };
    if (req.types !== undefined) vaultQuery.types = req.types;
    if (req.sinceSeconds !== undefined) vaultQuery.sinceSeconds = req.sinceSeconds;
    const vaultResult = await core.queryVault(vaultQuery);
    if (!vaultResult.ok) {
      return {
        ok: false,
        reason: 'vault_query_failed',
        detail: vaultResult.error.message,
      };
    }
    const vaultItems: DigestItem[] = vaultResult.value.map(toDigestItem);

    // 2. Reminders (optional).
    let reminderItems: DigestItem[] = [];
    if (reminders) {
      try {
        reminderItems = [...(await reminders(req.persona))];
      } catch (err) {
        return {
          ok: false,
          reason: 'reminders_failed',
          detail: extractMessage(err),
        };
      }
    }

    // 3. Events (optional).
    let eventItems: DigestItem[] = [];
    if (events) {
      try {
        eventItems = [...(await events(req.persona))];
      } catch (err) {
        return {
          ok: false,
          reason: 'events_failed',
          detail: extractMessage(err),
        };
      }
    }

    // 4. Topic snapshot.
    const topicSnapshot = topicStore.snapshot({ limit: maxTopics });

    // 5. Assemble.
    const digestInput: AssembleDigestInput = {
      nowSec,
      items: [...vaultItems, ...reminderItems, ...eventItems],
      topics: topicSnapshot.map((e) => ({ label: e.label, salience: e.score })),
    };
    if (req.headline !== undefined) digestInput.headline = req.headline;
    if (req.contacts !== undefined) digestInput.contacts = req.contacts;
    const digestOpts: AssembleDigestOptions = {
      maxTopics,
      ...(req.digestOptions ?? {}),
    };
    const digest = assembleDigest(digestInput, digestOpts);

    return {
      ok: true,
      digest,
      itemsFetched:
        vaultItems.length + reminderItems.length + eventItems.length,
      topicsConsidered: topicSnapshot.length,
    };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(req: BriefingRequest): string | null {
  if (!req || typeof req !== 'object') return 'request required';
  if (typeof req.persona !== 'string' || req.persona === '') return 'persona required';
  if (req.maxItems !== undefined) {
    if (!Number.isInteger(req.maxItems) || req.maxItems < 1) {
      return 'maxItems must be a positive integer';
    }
  }
  if (req.sinceSeconds !== undefined && !Number.isFinite(req.sinceSeconds)) {
    return 'sinceSeconds must be finite';
  }
  return null;
}

function toDigestItem(item: VaultItem): DigestItem {
  const out: DigestItem = {
    id: item.id,
    title: item.summary,
    at: item.timestamp,
    kind: 'vault',
  };
  if (item.body !== undefined) out.body = item.body;
  else if (item.bodyText !== undefined) out.body = item.bodyText;
  return out;
}

function extractMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
