/**
 * Brain's door to the value model (COMMITMENT_KERNEL §7, §15 step 5).
 *
 *   GET  /v1/commitment/brain/:kind          — what Brain may see: the kind's
 *        vocabulary, and the entries it may read now (values only when the
 *        owner left them on for the kind). Never the Core form.
 *   POST /v1/commitment/brain/:kind/changes  — up to four changes from one
 *        turn of the owner's: { changes: [{ action: 'put', entry } |
 *        { action: 'remove', id }], proof: { release_session, turn_id,
 *        turn_text, start, end } }. Core checks each entry by the owner's own
 *        rules and Brain's narrower ones, and raises one card; nothing changes
 *        until the owner says yes.
 *   PUT  /v1/commitment/brain/goods.seller/saving-share — { share_bps }: the
 *        standing share of a cheaper day's saving passed on (§15 step 11),
 *        while the owner keeps Brain for selling goods; a verdict each.
 *
 * Brain only (authz.ts); the handler checks again.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { verifySpanProof } from '../../a2a/span_proof';
import { appendAudit } from '../../audit/service';
import { dealKind, type DealKind } from '../../commerce/deal_kinds';
import { getCommerceRuntime } from '../../commerce/runtime';
import {
  brainEntryView,
  brainVisibleEntries,
  MAX_CHANGES_PER_CARD,
  proposeModelChanges,
  type ModelChange,
} from '../../commitment/model_changes';
import { getValueModelStore } from '../../commitment/model_store';
import { getStandingChoiceStore, SAVING_SHARE_BPS, shareBpsOf } from '../../commitment/standing_choices';
import { getStrategyStore } from '../../commitment/strategy_store';
import { getWorkflowService } from '../../workflow/service';

import { parseEntry } from './commitment';

import type { CoreRequest, CoreResponse, CoreRouter } from '../router';

function isBrain(req: { callerType?: string; trustedInProcess?: boolean }): boolean {
  return (
    req.callerType === 'brain' || (req.trustedInProcess === true && req.callerType === undefined)
  );
}

function vocabularyView(kind: DealKind): Record<string, unknown> {
  return {
    choices: kind.vocabulary.choices,
    flags: kind.vocabulary.flags,
    promises: Object.fromEntries(
      Object.entries(kind.vocabulary.promises).map(([name, orders]) => [
        name,
        Object.fromEntries(
          Object.entries(orders).map(([d, order]) => [
            d,
            {
              order,
              ...(kind.promiseWords[name]?.[d] !== undefined
                ? { words: kind.promiseWords[name]?.[d] }
                : {}),
            },
          ]),
        ),
      ]),
    ),
    honours: [...kind.honours].sort(),
  };
}

export function registerCommitmentBrainRoutes(
  router: CoreRouter,
  opts: { nowMs?: () => number } = {},
): void {
  const now = opts.nowMs ?? Date.now;
  const FORBIDDEN: CoreResponse = { status: 403, body: { error: 'brain only' } };
  const UNKNOWN: CoreResponse = { status: 404, body: { error: 'unknown_kind' } };
  const NO_STORE: CoreResponse = { status: 503, body: { error: 'model_store_unavailable' } };
  const kindOf = (req: CoreRequest): DealKind | null => dealKind(req.params?.kind ?? '');

  router.get('/v1/commitment/brain/:kind', async (req): Promise<CoreResponse> => {
    if (!isBrain(req)) return FORBIDDEN;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const store = await getValueModelStore();
    if (store === null) return NO_STORE;
    const settings = (await getStrategyStore())?.settings(kind.id);
    const valuesOn = settings?.valuesOn ?? true;
    // One list for the view and for proposals: no never-rule with a figure,
    // never-rules as their parts only, no values or capacities with values off.
    const entries = brainVisibleEntries(store, kind.id, valuesOn).map(brainEntryView);
    return {
      status: 200,
      body: {
        kind: kind.id,
        holder: kind.holder,
        vocabulary: vocabularyView(kind),
        values_on: valuesOn,
        entries,
        // COMMITMENT_KERNEL §13 — past deals through the one projection: the
        // parties, dates and outcome always; the numbers only with values on.
        past_deals: pastDeals(kind.id, valuesOn && settings?.strategy === 'brain'),
        // §15 step 11 — the standing share Brain set, while it is Brain's to set.
        ...(kind.id === 'goods.seller' && settings?.strategy === 'brain'
          ? await standingShareView()
          : {}),
      },
    };
  });

  // COMMITMENT_KERNEL §15 step 11 — the share of a cheaper day's saving a
  // goods seller passes on, set by Brain's judgement. Only while the owner
  // keeps Brain for selling goods; each change spends a verdict, so Brain
  // cannot sweep the share to learn what buyers do. Core still applies the
  // floors and never-rules to every version it makes from it.
  router.put('/v1/commitment/brain/:kind/saving-share', async (req): Promise<CoreResponse> => {
    if (!isBrain(req)) return FORBIDDEN;
    if (req.params?.kind !== 'goods.seller') return UNKNOWN;
    const raw = ((req.body as Record<string, unknown> | null) ?? {}).share_bps;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 10_000)
      return {
        status: 400,
        body: { error: 'invalid_share', detail: 'share_bps: a whole number from 0 to 10000' },
      };
    const strategies = await getStrategyStore();
    const choices = await getStandingChoiceStore();
    const models = await getValueModelStore();
    if (strategies === null || choices === null || models === null) return NO_STORE;
    if (strategies.settings('goods.seller').strategy !== 'brain')
      return { status: 409, body: { error: 'not_brain', detail: 'the owner has not chosen Brain for selling goods' } };
    const nowMs = now();
    const charged = strategies.charge({
      kind: 'goods.seller',
      // A month's changes count as one negotiation: the cap renews each
      // month, and the owner's monthly budget bounds them all.
      negotiationId: `standing:saving_share:${new Date(nowMs).toISOString().slice(0, 7)}`,
      count: 1,
      nowMs,
      thresholdVersion: models.loadForBrain('goods.seller').version,
    });
    if (!charged.ok) return { status: 429, body: { error: 'budget_spent', spent: charged.spent } };
    choices.set('goods.seller', SAVING_SHARE_BPS, String(raw), 'brain', nowMs);
    appendAudit('commitment', 'saving_share_set', 'goods.seller', `bps=${String(raw)} by=brain`);
    return { status: 200, body: { ok: true, share_bps: raw } };
  });

  router.post('/v1/commitment/brain/:kind/changes', async (req): Promise<CoreResponse> => {
    if (!isBrain(req)) return FORBIDDEN;
    const kind = kindOf(req);
    if (kind === null) return UNKNOWN;
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const raw = Array.isArray(body.changes) ? (body.changes as unknown[]) : null;
    if (raw === null || raw.length === 0 || raw.length > MAX_CHANGES_PER_CARD)
      return {
        status: 400,
        body: { error: 'invalid_change', detail: `changes: 1 to ${String(MAX_CHANGES_PER_CARD)}` },
      };
    const changes: ModelChange[] = [];
    for (const item of raw) {
      const c = (item ?? {}) as Record<string, unknown>;
      if (c.action === 'remove' && typeof c.id === 'string') {
        changes.push({ action: 'remove', kind: kind.id, id: c.id });
      } else if (c.action === 'put') {
        // A new entry: Core chooses its id. An id Brain gives names one it can see.
        const given = (c.entry ?? {}) as Record<string, unknown>;
        // The seller's share of a saving is one setting under a reserved id
        // (parseEntry): Core gives it that id, whether it is new or replaces.
        const body = (given.body ?? {}) as Record<string, unknown>;
        const reserved = body.type === 'choice' && body.part === 'saving_share';
        const minted = given.id === undefined || reserved;
        const id = reserved
          ? 'saving_share'
          : minted
            ? `b-${bytesToHex(randomBytes(6))}`
            : given.id;
        const parsed = parseEntry(kind, { ...given, id });
        if (!parsed.ok)
          return { status: 400, body: { error: 'invalid_entry', detail: parsed.error } };
        changes.push({
          action: 'put',
          entry: { ...parsed.value, kind: kind.id },
          ...(minted ? { minted: true } : {}),
        });
      } else {
        return {
          status: 400,
          body: { error: 'invalid_change', detail: "action: 'put' | 'remove'" },
        };
      }
    }
    // The owner's own turn asked for this: a contact's message or another
    // agent's text cannot raise these cards (the proof works once per turn).
    const proof = (body.proof ?? {}) as Record<string, unknown>;
    const { release_session: session, turn_id: turnId, turn_text: turnText, start, end } = proof;
    if (
      typeof session !== 'string' ||
      typeof turnId !== 'string' ||
      typeof turnText !== 'string' ||
      typeof start !== 'number' ||
      typeof end !== 'number'
    )
      return {
        status: 400,
        body: { error: 'invalid_change', detail: 'proof of the owner’s turn' },
      };
    const store = await getValueModelStore();
    const workflow = getWorkflowService();
    if (store === null || workflow === null) return NO_STORE;
    const valuesOn = (await getStrategyStore())?.settings(kind.id).valuesOn ?? true;
    // The owner's own newest turn asked for this: a contact's message or another
    // agent's text cannot raise these cards. Checked last, so a refused
    // proposal does not spend the turn; a turn spent on a card stays spent.
    const result = proposeModelChanges({
      store,
      workflow,
      kind: kind.id,
      numbers: kind.vocabulary.numbers,
      valuesOn,
      changes,
      turn: { releaseSession: session, turnId },
      proveTurn: () =>
        verifySpanProof({ releaseSession: session, turnId, turnText, start, end }, 'value_model')
          .ok,
      nowMs: Date.now(),
    });
    if (!result.ok) return { status: 200, body: { status: 'refused', reason: result.error } };
    // Not the card's words: they may quote an entry Brain should not read back.
    return { status: 200, body: { status: 'pending_owner', task_id: result.taskId } };
  });
}

/** At most this many past deals in Brain's view, newest first. */
const PAST_DEALS = 10;

/**
 * The owner's past deals of this kind, as Brain may read them: for a shelf
 * kind, each agreement this node made in that role — its state, the other
 * party, its dates — and, only when the owner let values reach Brain, its
 * terms and notice — and those only where the owner chose Brain as the
 * strategy for the kind (§11: where Brain is not the strategy, it sees no
 * number). Nothing for kinds with no past deals to show yet.
 */
function pastDeals(kindId: string, numbers: boolean): Record<string, unknown>[] {
  const role =
    kindId === 'shelf_space.host' ? 'host' : kindId === 'shelf_space.vendor' ? 'vendor' : null;
  const runtime = getCommerceRuntime();
  if (role === null || runtime === null) return [];
  return runtime.terms
    .agreements()
    .filter((a) => a.role === role)
    .sort((a, b) => (a.general.start < b.general.start ? 1 : -1))
    .slice(0, PAST_DEALS)
    .map((a) => ({
      state: a.state,
      counterparty_did: a.counterpartyDid,
      start: a.general.start,
      end: a.general.end,
      ...(numbers
        ? {
            terms: a.terms.map((t) => ({ name: t.name, value: t.value })),
            exit_notice_days: a.general.exit_notice_days,
          }
        : {}),
    }));
}

/** The standing share of a saving Brain set, for its own view. */
async function standingShareView(): Promise<{ standing?: { saving_share_bps: number } }> {
  const choice = (await getStandingChoiceStore())?.get('goods.seller', SAVING_SHARE_BPS) ?? null;
  const bps = choice?.setBy === 'brain' ? shareBpsOf(choice) : undefined;
  return bps === undefined ? {} : { standing: { saving_share_bps: bps } };
}
