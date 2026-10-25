/**
 * The tender as one card (HOSTED_DINA §6.4).
 *
 * The phone, the owner's Dina page and the owner's ChatGPT dot each drew a
 * tender their own way; this is the one way. A pure function from what the
 * tender routes already return (the ranking, the story, the order) to a
 * CardSpec, the fixed block vocabulary every Dina surface draws
 * (`@dina/protocol` services/card-spec). Pure, so the phone calls it with
 * what it loaded and Core's routes call it with what they read: the same
 * tender reads the same everywhere.
 *
 * The card carries the decisions as buttons (`tender.award` on each offer,
 * `tender.send` on a held order). Only Dina's own cards may (the validator
 * strips them from anyone else's); each surface carries a button out its
 * own way and keeps its own gates — presence, a clerk's cap, a warning
 * before awarding a supplier the owner rated poorly.
 *
 * Product photos and the bargaining rounds are not drawn yet: the card
 * vocabulary has no photo or round block (decided 2026-10-25).
 */

import { formatMoney } from '../commerce/money_display';

import type {
  TenderExclusionReason,
  TenderNotAskedView,
  TenderOfferView,
  TenderRankingView,
  TenderStorySupplierView,
  TenderStoryView,
} from './tender_views';
import type { CardAction, CardBlock, CardSpec, ListRow, TimelineStep } from '@dina/protocol';

/** The order a tender sent, as the surface follows it (absent until sent). */
export interface TenderCardOrder {
  /** Core's one-line account of the order. */
  headline: string;
  /** How many of ORDER_STEPS it has reached; null when it has no track (refused, countered). */
  stepsReached: number | null;
}

export interface TenderCardInput {
  ranking: TenderRankingView;
  story?: TenderStoryView | null;
  /** The name a surface shows for a supplier; null when it knows none. */
  nameOf: (supplierDid: string) => string | null;
  /** PeerLens trust where the surface knows it. */
  trustOf?: (supplierDid: string) => { score: number | null; reviews: number } | null;
  order?: TenderCardOrder | null;
  /**
   * Who reads it. `agent` (the owner's dot) never sees the ceiling read back,
   * the owner's never-rules, or the owner's notes on suppliers not asked.
   */
  audience: 'owner' | 'staff' | 'agent';
  /** Whether to draw buttons; a read-only view (a list of past tenders) sets false. */
  buttons: boolean;
}

export const ORDER_STEPS = ['Sent', 'Accepted', 'Paid', 'Being made', 'On the way'] as const;

/** What `orderStepsReached` reads of a placed order. */
export interface OrderTrackInput {
  state: string;
  progress: {
    paymentRecorded: boolean;
    payment: { state: string } | null;
    fulfilment: { state: string } | null;
  } | null;
}

/** How many of ORDER_STEPS an order has reached; null when it has no track (refused, countered). */
export function orderStepsReached(order: OrderTrackInput): number | null {
  if (order.state === 'submitted_unconfirmed' || order.state === 'outcome_unknown') return 1;
  if (order.state !== 'accepted') return null;
  const progress = order.progress;
  const fulfilment = progress?.fulfilment?.state;
  if (fulfilment === 'handed_to_carrier') return 5;
  if (fulfilment === 'production_started' || fulfilment === 'ready') return 4;
  if (progress !== null && (progress.paymentRecorded || progress.payment?.state === 'captured'))
    return 3;
  return 2;
}

const STATE_HEADING: Record<TenderRankingView['state'], string> = {
  negotiating: 'Dina is asking the suppliers for better prices',
  ready: 'Ready to award',
  awarded: 'Awarded',
  closed: 'Closed',
  no_policy: 'Collecting quotes',
};

const EXCLUDED_LABEL: Record<TenderExclusionReason, string> = {
  no_quote: 'No quote yet',
  declined: 'Declined to quote',
  expired: 'Quote expired',
  currency_mismatch: 'Quoted in another currency',
  over_budget: 'Over your budget',
  ruled_out: 'Against one of your rules',
};

const NOT_ASKED_LABEL: Record<TenderNotAskedView['reason'], string> = {
  own_poor_review: 'you rated them poorly on PeerLens',
  low_peerlens_trust: 'low PeerLens trust',
};

function money(minor: string, currency: string): string {
  if (!/^\d+$/.test(minor) || currency === '') return minor;
  try {
    return formatMoney({ currency, minor_units: minor });
  } catch {
    return `${currency} ${minor}`;
  }
}

function day(iso: string | undefined): string {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

function shortDid(did: string): string {
  return did.length > 22 ? `${did.slice(0, 14)}…${did.slice(-4)}` : did;
}

/** What the supplier offered, in its own signed words: "200 each · Butter croissant". */
function offered(story: TenderStorySupplierView | undefined): string {
  const line = story?.lines[0];
  if (line === undefined) return '';
  const more =
    story !== undefined && story.lines.length > 1
      ? ` and ${String(story.lines.length - 1)} more`
      : '';
  const name = line.name ?? line.product.value;
  return `${line.quantity.value} ${line.quantity.unit_code} · ${name}${more}`;
}

function trustText(trust: { score: number | null; reviews: number } | null | undefined): string {
  if (trust === null || trust === undefined) return '';
  if (trust.score === null || trust.reviews === 0) return 'No reviews yet';
  return `Trust ${trust.score.toFixed(2)} · ${String(trust.reviews)} review${trust.reviews === 1 ? '' : 's'}`;
}

/** The line under an offer: what it is, its terms, and anything that changes the price. */
function offerSub(
  offer: TenderOfferView,
  story: TenderStorySupplierView | undefined,
  trust: string,
  audience: TenderCardInput['audience'],
): string {
  const parts = [offered(story), trust].filter((p) => p !== '');
  const terms: string[] = [];
  if (offer.credit_days > 0) terms.push(`${String(offer.credit_days)} days' credit`);
  terms.push(`valid until ${day(offer.valid_until)}`);
  if (offer.revision !== '1') terms.push(`revised ${String(Number(offer.revision) - 1)}×`);
  if (offer.estimated_delivery_at !== undefined)
    terms.push(`delivered ${day(offer.estimated_delivery_at)}`);
  parts.push(terms.join(' · '));
  // The cost after credit weighs the owner's own worths: not for the dot.
  if (audience !== 'agent' && offer.comparison_cost_minor !== offer.total_minor) {
    parts.push(`costs you ${money(offer.comparison_cost_minor, offer.currency)} after the credit`);
  }
  const run = offer.partner_run;
  if (run !== undefined) {
    const fallback = `${run.fallback_delivery_at !== undefined ? ` on ${day(run.fallback_delivery_at)}` : ''} at ${money(run.fallback_total_minor, offer.currency)}`;
    parts.push(
      `on a partner's delivery run: award by ${run.offer_ends_at.slice(0, 16).replace('T', ' ')} UTC; if it falls through, standard delivery${fallback}${run.exit_if_run_fails === true ? ', or cancel without charge' : ''}`,
    );
  }
  return parts.join('\n');
}

export function buildTenderCard(input: TenderCardInput): CardSpec {
  const { ranking, audience } = input;
  const story = new Map((input.story?.suppliers ?? []).map((s) => [s.supplier_did, s]));
  const nameOf = (did: string): string => input.nameOf(did) ?? shortDid(did);
  const blocks: CardBlock[] = [];
  const waiting =
    ranking.ranked.length === 0 &&
    ranking.excluded.length > 0 &&
    ranking.excluded.every((r) => r.reason === 'no_quote');
  const open =
    ranking.state === 'ready' || ranking.state === 'no_policy' || ranking.state === 'negotiating';
  const heading =
    waiting && (ranking.state === 'negotiating' || ranking.state === 'no_policy')
      ? 'Waiting for the suppliers to quote'
      : STATE_HEADING[ranking.state];
  blocks.push({
    kind: 'title',
    text: heading,
    ...(ranking.state === 'ready' ? { tone: 'positive' as const } : {}),
  });

  if (ranking.target_total !== undefined && ranking.currency !== undefined) {
    blocks.push({
      kind: 'keyValue',
      label: 'Your target',
      value: money(ranking.target_total, ranking.currency),
    });
    if (ranking.budget_ceiling !== undefined && audience !== 'agent') {
      blocks.push({
        kind: 'keyValue',
        label: 'Most you will pay',
        value: money(ranking.budget_ceiling, ranking.currency),
      });
    }
  }
  if (ranking.state === 'negotiating') {
    blocks.push({
      kind: 'body',
      text: 'You can award now, or wait: Dina tells you once when the tender is ready.',
    });
  }

  // The offers, best first, each with its Award.
  blocks.push({ kind: 'section', label: 'Offers' });
  if (ranking.ranked.length === 0) {
    blocks.push({ kind: 'body', text: 'No offer can be awarded yet.' });
  } else {
    const best = ranking.ranked[0];
    if (best !== undefined) {
      blocks.push({
        kind: 'stat',
        value: money(best.total_minor, best.currency),
        caption: `Best offer · ${nameOf(best.supplier_did)}`,
        tone: 'positive',
      });
    }
    const rows: ListRow[] = ranking.ranked.map((offer, index) => {
      const awarded =
        ranking.state === 'awarded' && ranking.awarded_supplier_did === offer.supplier_did;
      const row: ListRow = {
        text: `${String(index + 1)}. ${nameOf(offer.supplier_did)}`,
        sub: offerSub(
          offer,
          story.get(offer.supplier_did),
          trustText(input.trustOf?.(offer.supplier_did)),
          audience,
        ),
        trailing: awarded
          ? `Awarded · ${money(offer.total_minor, offer.currency)}`
          : money(offer.total_minor, offer.currency),
        ...(index === 0 || awarded ? { tone: 'positive' as const } : {}),
      };
      if (input.buttons && open) {
        const action: CardAction = {
          label: 'Award',
          command: 'tender.award',
          params: {
            tender_id: ranking.tender_id,
            supplier_did: offer.supplier_did,
            ...(offer.alternative_id !== undefined ? { alternative_id: offer.alternative_id } : {}),
          },
          ...(index === 0 ? { tone: 'positive' as const } : {}),
        };
        row.action = action;
      }
      return row;
    });
    blocks.push({ kind: 'list', rows });
  }

  // Out of the running: with the price, so an exclusion never reads as arbitrary.
  const excluded = ranking.excluded.filter((r) => audience !== 'agent' || r.reason !== 'ruled_out');
  if (excluded.length > 0) {
    blocks.push({ kind: 'section', label: 'Not in the running' });
    blocks.push({
      kind: 'list',
      rows: excluded.map((r) => {
        const head = story.get(r.supplier_did)?.revisions.at(-1);
        return {
          text: nameOf(r.supplier_did),
          sub: EXCLUDED_LABEL[r.reason],
          ...(head !== undefined
            ? { trailing: money(head.total.minor_units, head.total.currency) }
            : {}),
        };
      }),
    });
  }

  const notAsked = audience === 'agent' ? [] : (ranking.not_asked ?? []);
  if (notAsked.length > 0) {
    blocks.push({ kind: 'section', label: 'Not asked' });
    blocks.push({
      kind: 'list',
      rows: notAsked.map((n) => ({
        text: nameOf(n.supplier_did),
        sub: `${NOT_ASKED_LABEL[n.reason]}${n.note !== '' ? ` · “${n.note}”` : ''}`,
        ...(n.listed_from !== undefined
          ? { trailing: `from ${money(n.listed_from.minor_units, n.listed_from.currency)}` }
          : {}),
      })),
    });
  }

  // The order.
  if (ranking.state === 'awarded') {
    if (ranking.held_order === 'held') {
      blocks.push({ kind: 'section', label: 'Order held' });
      blocks.push({
        kind: 'body',
        text: 'Nothing has gone to the supplier yet. Send it when you are ready.',
      });
      // The owner's dot never holds an order (its award sends at once), so
      // Send is for the owner's and a clerk's own screens.
      if (input.buttons && audience !== 'agent' && ranking.approval_id !== undefined) {
        blocks.push({
          kind: 'action',
          action: {
            label: 'Send order',
            command: 'tender.send',
            params: { approval_id: ranking.approval_id },
            tone: 'positive',
          },
        });
      }
    } else if (ranking.held_order === 'sent') {
      blocks.push({ kind: 'section', label: 'Your order' });
      blocks.push({ kind: 'body', text: input.order?.headline ?? 'Order sent to the supplier.' });
      const reached =
        input.order?.stepsReached ?? (input.order === undefined || input.order === null ? 1 : null);
      if (reached !== null) {
        const steps: TimelineStep[] = ORDER_STEPS.map((label, i) => ({
          label,
          state: i < reached ? 'done' : i === reached ? 'active' : 'upcoming',
        }));
        blocks.push({ kind: 'timeline', steps });
      }
    } else if (ranking.held_order === 'lapsed') {
      blocks.push({ kind: 'body', text: 'The held order lapsed before it was sent.' });
    }
  }

  return { version: 1, blocks, sourceLabel: 'Dina · every quote is signed by its supplier' };
}

/** A drafted tender's supplier, as the owner's dot reads it. */
export interface TenderDraftCardSupplier {
  name: string | null;
  source: 'known' | 'network';
  selected: boolean;
  trust?: { score: number | null; reviews: number };
}

/** A tender drafted but not yet sent: who Dina would ask. */
export function buildTenderDraftCard(suppliers: readonly TenderDraftCardSupplier[]): CardSpec {
  const rows: ListRow[] = suppliers.map((s) => ({
    text: s.name ?? 'Unnamed supplier',
    sub: `${s.source === 'network' ? 'Found on the network' : 'Your supplier'}${
      s.trust !== undefined ? ` · ${trustText(s.trust)}` : ''
    }`,
    trailing: s.selected ? 'Will ask' : 'Not ticked',
    ...(s.selected ? { tone: 'positive' as const } : {}),
  }));
  const blocks: CardBlock[] = [
    { kind: 'title', text: 'Tender draft · not sent yet' },
    { kind: 'section', label: 'Who Dina would ask' },
  ];
  if (rows.length > 0) blocks.push({ kind: 'list', rows });
  blocks.push({
    kind: 'body',
    text: 'Give a target and the most you will pay, and Dina sends it.',
  });
  return { version: 1, blocks, sourceLabel: 'Dina · every quote is signed by its supplier' };
}
