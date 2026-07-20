/**
 * R2-05 / R3-02 / R3-04 / R3-05 — the SHARED watch-result delivery pipeline
 * (Four Laws: Silence First; nothing silently dropped).
 *
 * A standing-watch poll result flows through the same silence discipline as any
 * other candidate arrival (PUSH_SERVICES §8/§19):
 *
 *   1. only a RESOLVED poll carries a result (a failed/timeout poll just retries);
 *   2. R3-02 — the watch must be ACTIVE (a cancelled/unknown subscription fails
 *      CLOSED: instant cancel + default silence, never fire-always);
 *   3. R3-04 — bounded display is rendered ONLY from the validated CardSpec (never
 *      raw provider text); no valid card → fixed non-provider text;
 *   4. R2-04 wake FILTER — stay silent unless the result matches;
 *   5. the SILENCE classifier assigns a tier, capped at the subscription ceiling
 *      (owner-created watch = Solicited, never a self-escalated interrupt), user
 *      override honoured;
 *   6. R3-05 — the result is ALWAYS retained durably in the inbox (never dropped):
 *      Tier 1/2 → a `push` item, Tier 3 → a `briefing` item for the daily digest.
 *      DND / quiet-hours suppresses the BANNER (a downstream concern), not the
 *      inbox record — a quiet-hours Tier-2 result is still retained.
 *
 * This is the ONE pipeline both boots (mobile + split server) wire their
 * `notifyWatchInbox` sink to, so watch delivery cannot diverge between them.
 */

import { watchFilterMatches, type WatchFilter } from '@dina/core';
import { type CardSpec } from '@dina/protocol';

import { classifyDeterministic, getUserOverride, type PriorityTier } from '../guardian/silence';

import { shouldDeliverNotification } from './dnd';
import { appendNotificationDurable } from './inbox';

const MAX_TITLE = 120;
const MAX_BODY = 500;
const NO_CARD_TITLE = 'Subscription update';
const NO_CARD_BODY = 'A watch you set has an update.';

/** Render a bounded {title, body} EXCLUSIVELY from the validated CardSpec (R3-04).
 *  Never falls back to raw provider text: a null / text-less card yields fixed,
 *  non-provider copy. Renders the bounded text-bearing block kinds. */
function renderCard(card: CardSpec | null): { title: string; body: string } {
  if (card === null) return { title: NO_CARD_TITLE, body: NO_CARD_BODY };
  let title = '';
  const parts: string[] = [];
  for (const raw of card.blocks as {
    kind: string;
    text?: unknown;
    label?: unknown;
    value?: unknown;
    items?: unknown;
  }[]) {
    switch (raw.kind) {
      case 'title':
        if (title === '') title = String(raw.text ?? '');
        break;
      case 'body':
        parts.push(String(raw.text ?? ''));
        break;
      case 'section':
        parts.push(String(raw.label ?? ''));
        break;
      case 'stat':
      case 'keyValue':
        parts.push(`${String(raw.label ?? '')}: ${String(raw.value ?? '')}`);
        break;
      case 'list':
        if (Array.isArray(raw.items)) parts.push(raw.items.map((i) => String(i)).join(', '));
        break;
      // divider / badge / bar / rating / chips / timeline carry no bounded text → skip.
    }
  }
  const clean = parts.map((p) => p.trim()).filter((p) => p !== '' && p !== ':');
  return {
    title: (title !== '' ? title : NO_CARD_TITLE).slice(0, MAX_TITLE),
    body: (clean.length > 0 ? clean.join('\n') : NO_CARD_BODY).slice(0, MAX_BODY),
  };
}

export interface WatchDeliveryInput {
  subscriptionId: string;
  capability: string;
  serviceName: string;
  /** The service-query card status ('resolved' carries a result). */
  status: string;
  /** The UNTRUSTED-validated provider card (null on failure/non-success). */
  card: CardSpec | null;
  /** The formatted human text (unused for display — R3-04 renders card-only). */
  text: string;
  /** Idempotency source (the workflow task id). */
  sourceId: string;
  /** R2-04 wake filter — only fire when the result matches. Absent = fire always. */
  filter?: WatchFilter;
  /** Per-subscription priority ceiling (least-urgent floor). Default 2 = Solicited. */
  ceilingTier?: PriorityTier;
  /** R3-02 — whether the originating watch is still ACTIVE. `false` (cancelled /
   *  unknown / lookup miss) fails CLOSED: the result is suppressed. Default true. */
  watchActive?: boolean;
}

export type WatchDeliveryOutcome =
  | 'delivered'
  | 'briefing'
  | 'deferred_dnd'
  | 'suppressed_filter'
  | 'suppressed_inactive'
  | 'skipped';

/**
 * Run a watch poll result through the full silence pipeline and durably deliver
 * (or suppress) it. Pure over its inputs + the process-global silence/DND/inbox
 * state; returns the disposition so callers/tests can assert the decision.
 *
 * R5-04 — FAILURE-ATOMIC: the inbox append AWAITS the durable write and this
 * REJECTS when it fails, so a caller (the split server's `/chat/service-result`
 * route, the in-process workflow consumer) can refuse to acknowledge the
 * workflow event — Core redelivers, and the idempotent `sourceId` append makes
 * the retry safe. A resolved result is never silently lost to a crash between
 * the in-memory append and the durable commit.
 */
export async function deliverWatchResult(
  input: WatchDeliveryInput,
  now: Date = new Date(),
): Promise<WatchDeliveryOutcome> {
  if (input.status !== 'resolved') return 'skipped';
  // R3-02 — fail CLOSED for a cancelled/unknown watch (instant cancel + silence).
  if (input.watchActive === false) return 'suppressed_inactive';

  const { title, body } = renderCard(input.card);

  if (!watchFilterMatches(input.filter, `${title}\n${body}`)) return 'suppressed_filter';

  const source = `watch:${input.subscriptionId}`;
  const base = classifyDeterministic({ source, subject: title, body, type: 'watch' }).tier;
  const ceiling = input.ceilingTier ?? 2;
  // A FILTERED watch that matched = the owner conditioned on THIS exact event, so
  // it is at least Solicited (never briefing-only): floor its base at Tier 2. An
  // UNFILTERED watch fires on every poll, so the classifier decides (benign → Tier
  // 3 briefing) — the cry-wolf mitigation for unconditioned watches.
  const effectiveBase = input.filter !== undefined ? (Math.min(base, 2) as PriorityTier) : base;
  const override = getUserOverride(source);
  const tier: PriorityTier = override ?? (Math.max(effectiveBase, ceiling) as PriorityTier);

  // R3-05 — NEVER drop: always retain the result durably in the inbox. Tier 3 → a
  // `briefing` item (collected by the daily digest); Tier 1/2 → a `push` item. The
  // append is idempotent on the task id. R5-04 — awaited: a durable-write failure
  // rejects this delivery so the workflow event is NOT acknowledged and retries.
  await appendNotificationDurable({
    kind: tier === 3 ? 'briefing' : 'push',
    title,
    body,
    sourceId: input.sourceId,
    id: input.sourceId,
    deepLink: 'dina://subscriptions',
  });

  if (tier === 3) return 'briefing';
  // DND / quiet-hours governs the BANNER only — the record above is already
  // retained, so a suppressed banner is a deferral, not a drop.
  if (!shouldDeliverNotification(tier, now)) return 'deferred_dnd';
  return 'delivered';
}
