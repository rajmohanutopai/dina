import type { SupplierSettings } from './commerce_settings';
import type { CredentialStatus } from './credential_broker';
import type { CommerceOrderRef } from './order_refs';

/**
 * The supplier inbox (§18.6, WS-7.3).
 *
 * A PROJECTION over state that already exists — undecided orders, listing and
 * connector settings, catalog freshness — assembled into the seven things
 * §18.6 says an operator sees. It computes nothing new and stores nothing.
 *
 * WHY IT IS ONE FUNCTION AND NOT SEVEN SCREENS' WORTH OF QUERIES. The inbox's
 * job is to be the place a supplier looks when they wonder whether anything
 * needs them. Split across surfaces, the item nobody built a screen for is the
 * item nobody sees — and the two candidates for that are exactly the ones that
 * cost money: an order sitting undecided past its deadline, and an external
 * outcome nobody resolved.
 *
 * ORDERED BY WHAT IT COSTS TO IGNORE, not by recency. A stale catalog is a
 * slow leak; an order about to time out is a customer who ordered and heard
 * nothing. Sorting by arrival would put the second below the first on a busy
 * day, which is the day it matters.
 */

export type InboxItemKind =
  /** §9.9 — an order reserved and not yet decided. */
  | 'order_awaiting_decision'
  /** §12.7/§9.9 — an effect that may have fired and has not resolved. */
  | 'external_outcome_unresolved'
  /** §18.3 — a connector that is failing or whose credential stopped working. */
  | 'connector_failing'
  /** §10.4 — the catalog has not been confirmed healthy recently. */
  | 'catalog_stale'
  /** §19 — the listing is not answering, which the operator may not intend. */
  | 'listing_not_live';

export interface InboxItem {
  kind: InboxItemKind;
  /** What the operator is looking at: an order id, a connector name, the catalog. */
  subject: string;
  headline: string;
  /** Why this needs them, in their terms. Never a code. */
  detail: string;
  /**
   * How costly it is to ignore, highest first. Not a priority an operator sets
   * — a consequence this code can justify, which is why each value has a
   * comment rather than a name like "high".
   */
  urgency: number;
  /** Present when the item is an order they can act on. */
  actions: InboxAction[];
}

export type InboxAction =
  | 'accept'
  | 'reject'
  | 'counter'
  | 'reconcile'
  | 'open_settings'
  /** §12.5 — settle a cancellation this node parked for a human. */
  | 'finalize_cancellation';

/**
 * Urgency values, and the reason for each ordering.
 *
 * Deliberately spread out rather than 1/2/3: a future item must be insertable
 * between two of these without renumbering the rest, and renumbering is how an
 * ordering silently changes for items nobody touched.
 */
const URGENCY = {
  /** A customer ordered and has heard nothing; the deadline is running. */
  ORDER_PAST_DEADLINE: 100,
  /** Money may already have moved and nobody has resolved it. */
  EXTERNAL_UNRESOLVED: 90,
  /** An order waiting, with time left. */
  ORDER_WAITING: 70,
  /** Orders will start failing when this connector is needed. */
  CONNECTOR_FAILING: 50,
  /** The listing is closed — possibly on purpose, which is why it is not higher. */
  LISTING_NOT_LIVE: 30,
  /** A slow leak: buyers see prices nobody has confirmed lately. */
  CATALOG_STALE: 20,
} as const;

/** How long a catalog may go unconfirmed before it is worth mentioning. */
export const CATALOG_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface SupplierInbox {
  items: InboxItem[];
  /**
   * True when nothing needs the operator.
   *
   * It IS `items.length === 0` — this builder cannot fail, so there is no
   * second thing it could mean here. The field exists so that "nothing needs
   * you" is something a client is TOLD rather than something it derives: the
   * other reading of an empty list, "the inbox could not be built", is answered
   * one level up, where `GET /v1/commerce/inbox` returns 503 rather than an
   * empty list when this node has no commerce. Only one of those two has
   * earned the reassurance, and the boundary is where they are separated.
   */
  clear: boolean;
}

export function buildSupplierInbox(args: {
  /** Orders reserved and not yet decided (§9.9). */
  undecided: CommerceOrderRef[];
  settings: SupplierSettings | null;
  /**
   * §18.3 — live credential status from the broker (WS-9.3).
   *
   * The settings record carries `credentialValid` as a DECLARED value, which
   * stopped being true the moment the other end rotated their key. The broker
   * knows whether the last real call worked. Where they disagree the broker
   * wins, and a credential that failed with no connector declared for it still
   * surfaces — otherwise the connector nobody remembered to list is the one
   * that fails silently.
   */
  credentials?: CredentialStatus[];
  /**
   * §12.5 — purchase order ids with a cancellation parked for a human.
   *
   * PASSED IN rather than looked up. This projection does no I/O, which is
   * what lets it be tested as a pure function and keeps the inbox free of a
   * transaction handle. The caller already holds the order list and does the
   * one scan per order.
   */
  cancellationsAwaitingReview?: ReadonlySet<string>;
  nowMs: number;
}): SupplierInbox {
  const items: InboxItem[] = [];
  const byResource = new Map((args.credentials ?? []).map((status) => [status.resource, status]));
  const awaitingReview = args.cancellationsAwaitingReview ?? new Set<string>();

  for (const ref of args.undecided) {
    const overdue = ref.decisionDeadlineAt !== null && ref.decisionDeadlineAt <= args.nowMs;
    // §9.9's `effect_started` means the external boundary was crossed: the
    // effect MAY have fired, so this is not "waiting for a decision" any more
    // — it is money that may already have moved.
    const unresolved = ref.effectPhase === 'effect_started';

    if (unresolved) {
      items.push({
        kind: 'external_outcome_unresolved',
        subject: ref.purchaseOrderId,
        headline: 'An order may have gone through and has not been resolved.',
        detail: awaitingReview.has(ref.purchaseOrderId)
          ? 'The buyer asked to cancel while the external system was working. Check there whether the order really went through, then record the answer here — this node will not guess it for you.'
          : 'The external system was asked and did not answer. Resolve it there first — accepting or rejecting here could double the work. This node will not decide it for you, and it will not lapse on its own.',
        urgency: URGENCY.EXTERNAL_UNRESOLVED,
        // ONE ACTION, AND ONLY WHEN SOMETHING SERVES IT. `reconcile` was
        // offered here once and was wrong: the only reconcile command,
        // `POST /v1/commerce/orders/command`, is BUYER-side — it loads
        // `runtime.buyerOrders`, and this is a supplier's order. An action a
        // projection offers and no command performs is FR-P10 broken from the
        // other end, and an owner tapping it got nothing.
        //
        // `finalize_cancellation` appears only for an order that actually has
        // a cancellation parked in `pending_review`, which the caller
        // establishes by scanning the receipts. Where there is no such
        // cancellation the item still carries NO actions, because the
        // remaining half of this case — an effect that fired with no
        // cancellation attached — has no command yet either.
        //
        // This item is the more dangerous of the two to get wrong. An
        // `effect_started` order is deliberately excluded from the decision
        // sweeper (`listExpiredPreEffect` selects `pre_effect` only), because
        // money may already have moved and auto-rejecting it would be a lie.
        // So it never lapses, and with nothing to resolve it the order stays
        // non-terminal for ever — holding quote capacity and blocking both
        // continuity release and plugin uninstall.
        actions: awaitingReview.has(ref.purchaseOrderId) ? ['finalize_cancellation'] : [],
      });
      continue;
    }

    items.push({
      kind: 'order_awaiting_decision',
      subject: ref.purchaseOrderId,
      headline: overdue
        ? 'An order is past its decision deadline.'
        : 'An order is waiting for your decision.',
      detail: overdue
        ? 'The buyer has heard nothing and their quote hold is expiring.'
        : 'Accept or reject it. If nobody does, the order lapses at its decision deadline.',
      urgency: overdue ? URGENCY.ORDER_PAST_DEADLINE : URGENCY.ORDER_WAITING,
      // RESTORED, now that something serves them. These were stripped when
      // §15.2b had no owner decision route: the projection offered commands
      // that did not exist, so an owner tapped and nothing happened — FR-P10
      // broken from the other end.
      //
      // `POST /v1/commerce/orders/decide` now answers both, replaying the
      // pack's held answer under the owner's approval.
      //
      // `counter` STAYS ABSENT, and this is settled rather than outstanding.
      // The first reading was that the card simply cannot collect replacement
      // terms; the real reason is one level down. Core does not mint quotes —
      // it REGISTERS ones a supplier's pack signed, because only the pack
      // knows this business's prices. An owner-composed counter would have
      // Core inventing terms, which is the same rule that stops it inventing
      // an acknowledgement.
      //
      // §18.6's "counterproposal controls" are therefore served where a
      // counter is actually composed: the pack answers `submit_order` with a
      // `counterproposal` carrying its replacement quote, and the owner sees
      // it in the decision history.
      //
      // And a counter is deliberately NOT gated for approval (see
      // `order_decision.ts`): a replacement quote reserves nothing —
      // `QuoteFamily.hold` takes a purchase order id, so capacity is held by
      // an ORDER and never by a quote — and §9.11 makes accepting a counter
      // create a NEW purchase order, whose acceptance is gated in its own
      // right. The obligation is created there, once, not twice.
      actions: ['accept', 'reject'],
    });
  }

  const declared = new Set<string>();
  if (args.settings !== null) {
    for (const connector of args.settings.connectors) {
      declared.add(connector.name);
      // THE BROKER OVERRIDES THE DECLARATION, in one direction only. A failed
      // brokered call is evidence; a settings row saying the credential is
      // fine is a claim somebody typed. The reverse override is deliberately
      // absent: the broker never marks a declared-broken connector working.
      const brokered = byResource.get(connector.name);
      const credentialValid = connector.credentialValid && brokered?.lastResult !== 'failed';
      if (connector.healthy && credentialValid) continue;
      items.push({
        kind: 'connector_failing',
        subject: connector.name,
        headline: credentialValid
          ? `${connector.name} is not responding.`
          : `${connector.name} needs its credential renewed.`,
        // Named, never quoted: the credential is not here to leak, and the
        // operator needs to know WHICH connector rather than what it holds.
        detail: 'Orders that need it will start failing.',
        urgency: URGENCY.CONNECTOR_FAILING,
        actions: ['open_settings'],
      });
    }

    if (args.settings.listingState !== 'live') {
      items.push({
        kind: 'listing_not_live',
        subject: 'listing',
        headline:
          args.settings.listingState === 'paused'
            ? 'Your listing is paused.'
            : 'Your listing has been withdrawn.',
        // Lower urgency than a failing connector ON PURPOSE: a closed listing
        // is usually a decision, and nagging an operator about a choice they
        // made is how an inbox becomes something people stop reading.
        detail: 'Buyers cannot request quotes while it is closed.',
        urgency: URGENCY.LISTING_NOT_LIVE,
        actions: ['open_settings'],
      });
    }

    const lastHealthy = args.settings.catalogSource.lastHealthyAtIso;
    const staleSince = lastHealthy === null ? null : Date.parse(lastHealthy);
    if (staleSince === null || args.nowMs - staleSince > CATALOG_STALE_AFTER_MS) {
      items.push({
        kind: 'catalog_stale',
        subject: 'catalog',
        headline:
          lastHealthy === null
            ? 'Your catalog has never been confirmed.'
            : 'Your catalog has not been confirmed recently.',
        // §10.4: AppView must not present a snapshot as live stock or price.
        // This is the supplier's side of the same rule — buyers are being
        // shown numbers nobody has stood behind lately.
        detail: 'Buyers may be seeing prices you have not checked.',
        urgency: URGENCY.CATALOG_STALE,
        actions: ['open_settings'],
      });
    }
  }

  // A credential whose last real call FAILED and which no connector row
  // declares. Reported OUTSIDE the settings block on purpose: this is the
  // connector nobody remembered to list, so gating it on a settings record
  // existing would hide exactly the case it exists for.
  for (const status of byResource.values()) {
    if (status.lastResult !== 'failed' || declared.has(status.resource)) continue;
    items.push({
      kind: 'connector_failing',
      subject: status.resource,
      headline: `${status.resource} needs its credential renewed.`,
      detail: 'Its last call was refused. Orders that need it will start failing.',
      urgency: URGENCY.CONNECTOR_FAILING,
      actions: ['open_settings'],
    });
  }

  // Ordered by what it costs to ignore, with a deterministic tiebreak so two
  // reads of an unchanged inbox never disagree about the order.
  items.sort((a, b) =>
    b.urgency !== a.urgency
      ? b.urgency - a.urgency
      : a.subject < b.subject
        ? -1
        : a.subject > b.subject
          ? 1
          : 0,
  );

  return { items, clear: items.length === 0 };
}
