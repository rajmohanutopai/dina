/**
 * Digest assembler — Silence-First briefing composer (M2 briefing gate).
 *
 * The Silence-First law means Dina never pushes content — the daily
 * briefing is the primary engagement surface. This primitive takes
 * the day's accumulated signal and produces a structured digest the
 * user can read at their leisure:
 *
 *   - **Fiduciary bucket** (never batched — these interrupted already;
 *     listed here only for completeness of the daily record).
 *   - **Solicited bucket** (things the user asked about).
 *   - **Engagement bucket** (notable activity worth surfacing —
 *     Silence-First's entire point).
 *
 * **Pure composition** — no IO, no clock reads except via
 * `nowSec` (passed in). Caller supplies already-fetched items,
 * topics, events, reminders. Output is a structured `Digest` that
 * CLI / Telegram / admin UI renders as they see fit.
 *
 * **Bucketing rules** (deterministic):
 *
 *   - Reminders with `triggerAt <= nowSec + dueWithinSec` →
 *     solicited (the user asked for them; due soon means surface now).
 *   - Calendar events in the next `eventWindowSec` → solicited.
 *   - Vault items with an explicit `priority` field → that priority.
 *   - Vault items without priority → engagement (default).
 *
 * **Deduping**: items with the same `id` appear once — priority of
 * the FIRST occurrence wins (caller ordering is authoritative).
 *
 * **Counts + truncation** — each bucket has a configurable cap.
 * Excess items drop to `overflow` counts so the UI can render
 * "… and 12 more".
 */

import type { NotifyPriority } from './priority';
import type { Topic } from './topic_extractor';

export interface DigestItem {
  /** Unique item id (vault id, event id, reminder id, etc.). */
  id: string;
  /** Short headline the UI renders. */
  title: string;
  /** Optional body the UI may show when expanded. */
  body?: string;
  /** Optional explicit priority — overrides default rules. */
  priority?: NotifyPriority;
  /** Unix seconds when the item became relevant. */
  at: number;
  /** Free-form tag — `vault`, `nudge`, `event`, `reminder`. */
  kind: 'vault' | 'nudge' | 'event' | 'reminder';
  /** Optional ISO-country tag for spatial filtering (used by some callers). */
  locale?: string;
}

export interface DigestTopic {
  label: string;
  salience: number;
}

export interface DigestContact {
  id: string;
  name: string;
  note?: string;
}

export interface AssembleDigestInput {
  /** Unix seconds. Anchors "due" / "upcoming" checks. */
  nowSec: number;
  /** All candidate items. Caller pre-filters by recency. */
  items?: ReadonlyArray<DigestItem>;
  /** Topic ToC snapshot. */
  topics?: ReadonlyArray<Topic | DigestTopic>;
  /** Contacts the digest calls out by name. */
  contacts?: ReadonlyArray<DigestContact>;
  /** Optional headline the digest leads with (set by an orchestrator). */
  headline?: string;
}

export interface AssembleDigestOptions {
  /** Reminders within this window count as solicited. Default 24h (86400s). */
  dueWithinSec?: number;
  /** Events within this window count as solicited. Default 24h. */
  eventWindowSec?: number;
  /** Max items per bucket. Default 10. */
  maxPerBucket?: number;
  /** Max topics to render. Default 5. */
  maxTopics?: number;
  /** Max contacts to surface. Default 5. */
  maxContacts?: number;
}

export interface DigestBucket {
  priority: NotifyPriority;
  items: DigestItem[];
  overflow: number;
}

export interface Digest {
  nowSec: number;
  headline: string | null;
  buckets: {
    fiduciary: DigestBucket;
    solicited: DigestBucket;
    engagement: DigestBucket;
  };
  topics: DigestTopic[];
  contacts: DigestContact[];
  totals: {
    itemsConsidered: number;
    itemsIncluded: number;
    itemsDropped: number;
  };
}

export const DEFAULT_DUE_WITHIN_SEC = 24 * 60 * 60;
export const DEFAULT_EVENT_WINDOW_SEC = 24 * 60 * 60;
export const DEFAULT_MAX_PER_BUCKET = 10;
export const DEFAULT_MAX_TOPICS = 5;
export const DEFAULT_MAX_CONTACTS = 5;

/**
 * Compose a structured Silence-First digest. Deterministic: same
 * input → same output.
 */
export function assembleDigest(
  input: AssembleDigestInput,
  opts: AssembleDigestOptions = {},
): Digest {
  validateInput(input);
  const dueWithinSec = opts.dueWithinSec ?? DEFAULT_DUE_WITHIN_SEC;
  const eventWindowSec = opts.eventWindowSec ?? DEFAULT_EVENT_WINDOW_SEC;
  const maxPerBucket = opts.maxPerBucket ?? DEFAULT_MAX_PER_BUCKET;
  const maxTopics = opts.maxTopics ?? DEFAULT_MAX_TOPICS;
  const maxContacts = opts.maxContacts ?? DEFAULT_MAX_CONTACTS;

  const buckets: Digest['buckets'] = {
    fiduciary: { priority: 'fiduciary', items: [], overflow: 0 },
    solicited: { priority: 'solicited', items: [], overflow: 0 },
    engagement: { priority: 'engagement', items: [], overflow: 0 },
  };

  const seen = new Set<string>();
  let itemsConsidered = 0;
  let itemsIncluded = 0;
  let itemsDropped = 0;

  for (const item of input.items ?? []) {
    itemsConsidered += 1;
    if (seen.has(item.id)) {
      itemsDropped += 1;
      continue;
    }
    seen.add(item.id);
    const priority = classifyItem(item, input.nowSec, dueWithinSec, eventWindowSec);
    const bucket = buckets[priority];
    if (bucket.items.length >= maxPerBucket) {
      bucket.overflow += 1;
      itemsDropped += 1;
      continue;
    }
    bucket.items.push(item);
    itemsIncluded += 1;
  }

  // Sort each bucket by `at` desc so the most recent lands first.
  for (const b of Object.values(buckets)) {
    b.items.sort((a, c) => c.at - a.at);
  }

  const topics = (input.topics ?? [])
    .map((t) => ({ label: t.label, salience: t.salience }))
    .sort((a, b) => b.salience - a.salience)
    .slice(0, maxTopics);
  const contacts = (input.contacts ?? []).slice(0, maxContacts).map((c) => ({ ...c }));

  return {
    nowSec: input.nowSec,
    headline: input.headline ?? null,
    buckets,
    topics,
    contacts,
    totals: {
      itemsConsidered,
      itemsIncluded,
      itemsDropped,
    },
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validateInput(input: AssembleDigestInput): void {
  if (!input || typeof input !== 'object') {
    throw new TypeError('assembleDigest: input required');
  }
  if (!Number.isFinite(input.nowSec)) {
    throw new TypeError('assembleDigest: nowSec must be finite');
  }
}

function classifyItem(
  item: DigestItem,
  nowSec: number,
  dueWithinSec: number,
  eventWindowSec: number,
): NotifyPriority {
  if (item.priority) return item.priority;
  if (item.kind === 'reminder') {
    if (item.at - nowSec <= dueWithinSec && item.at >= nowSec) return 'solicited';
    return 'engagement';
  }
  if (item.kind === 'event') {
    if (item.at - nowSec <= eventWindowSec && item.at >= nowSec) return 'solicited';
    return 'engagement';
  }
  // vault / nudge items default to engagement without an explicit priority.
  return 'engagement';
}
