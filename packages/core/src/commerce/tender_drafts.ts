/**
 * Tender drafts from an outside agent (OPENAI_DOTS_INTEGRATION §6.3–§6.4).
 *
 * An agent the owner paired (an OpenAI dot through the Dina plugin, or any
 * `dina-agent`) may say WHAT the café needs: lines, a date. It never says who
 * is asked: Core fills the suppliers from the café's own list and trade
 * history, then from the network, so a bakery named in text the agent read
 * never reaches a tender.
 *
 * Who decides depends on the agent (HOSTED_DINA §6.3). The owner's ChatGPT
 * dot is the owner's own interface: it opens the draft with a target and
 * ceiling, reads the quotes and awards, and the order goes out. Any other
 * agent stops at the draft, and the owner opens it on a Core form that needs
 * a person present.
 *
 * What the agent reads back is one draft's progress: who it would ask, the
 * quotes ranked best first (with prices for the owner's dot alone), the held
 * order's state and the supplier's answer. Never the owner's ceiling or the
 * rules that ranked the quotes.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { validateQuantity, type Quantity, type RegionRef } from '@dina/commerce-protocol';
import { isValidServiceListingRkey } from '@dina/protocol';

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import { rankTender } from './buyer_negotiation';
import { getCommerceRuntime, type CommerceRuntime } from './runtime';
import { getSupplierDirectory, trustIsGood, type SupplierFinding } from './supplier_directory';
import { DEFAULT_TENDER_FANOUT } from './tender';


export const TENDER_DRAFT_TYPE = 'tender_draft';

/** How long a draft waits for the owner before it lapses. */
export const TENDER_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
/** Drafts one agent may have waiting at once. */
export const MAX_PENDING_DRAFTS_PER_AGENT = 5;
export const MAX_DRAFT_LINES = 20;
export const MAX_REQUIREMENT_TEXT = 200;
/**
 * Suppliers one draft may offer the owner: the café's own first, then
 * businesses found on the network (HOSTED_DINA §6.1). At most
 * DEFAULT_TENDER_FANOUT of them start ticked, since a tender asks no more.
 */
export const MAX_DRAFT_SUPPLIERS = 8;
/** Network searches one draft makes: one per line, the first lines only. */
export const MAX_NETWORK_SEARCHES = 3;

export type TenderDraftState = 'pending' | 'opened' | 'dismissed';

export interface TenderDraftLine {
  line_id: string;
  requirement: { text: string };
  quantity: Quantity;
}

export interface TenderDraftSupplier {
  supplier_did: string;
  service_rkey: string;
  /**
   * `known`: the owner's list or trade history. `network`: found on the
   * PeerLens AppView for this draft; the owner has not picked it. Absent on
   * a draft stored before network finds existed, and reads as `known`.
   */
  source?: 'known' | 'network';
  /** Ticked on the owner's open form. Absent reads as ticked. */
  selected?: boolean;
  /** A network find's listing name. */
  name?: string;
  /** A network find's PeerLens trust when the draft was made. */
  trust?: { score: number | null; reviews: number };
}

/** The suppliers a draft asks when the owner opens it without changing the ticks. */
export function selectedSuppliers(draft: TenderDraft): TenderDraftSupplier[] {
  return draft.suppliers.filter((s) => s.selected !== false);
}

export interface TenderDraft {
  draftId: string;
  agentDid: string;
  lines: TenderDraftLine[];
  /** ISO date-time, or '' when the agent named none. */
  requiredBy: string;
  suppliers: TenderDraftSupplier[];
  /** The café's first delivery area from its buyer settings; null when none is set. */
  region: RegionRef | null;
  /** The buyer settings currency; '' when none is set. */
  currency: string;
  state: TenderDraftState;
  tenderId: string;
  createdAt: number;
  expiresAt: number;
}


/**
 * The café's suppliers: first the ones the owner listed (HOSTED_DINA §6), then
 * every supplier it has ordered from or asked in a tender, most recent first,
 * one listing each, never a blocked one. Core's own records only — nothing an
 * agent wrote.
 */
export function knownSuppliers(runtime: CommerceRuntime, limit: number): TenderDraftSupplier[] {
  const buyer = runtime.settings.readBuyer();
  const blocked = new Set(buyer.ok ? buyer.settings.blockedSuppliers : []);
  const seen = new Map<string, TenderDraftSupplier>();
  const add = (supplierDid: string, serviceRkey: string): void => {
    if (supplierDid === '' || serviceRkey === '' || blocked.has(supplierDid)) return;
    if (!seen.has(supplierDid)) {
      seen.set(supplierDid, { supplier_did: supplierDid, service_rkey: serviceRkey });
    }
  };
  for (const listed of runtime.ownerSuppliers.list()) {
    add(listed.supplierDid, listed.serviceRkey);
  }
  for (const { supplierDid, record } of runtime.buyerOrders.listRecent(100)) {
    add(supplierDid, record.serviceRkey);
  }
  const tenders = [...runtime.tenders.listTenders()].sort((a, b) => b.createdAt - a.createdAt);
  for (const tender of tenders) {
    for (const member of runtime.tenders.listMembers(tender.tenderId)) {
      add(member.supplierDid, member.serviceRkey);
    }
  }
  return [...seen.values()].slice(0, limit).map((s) => ({ ...s, source: 'known', selected: true }));
}

/**
 * Businesses on the network that sell what the lines ask for, in the café's
 * delivery area: never one already offered, blocked, or the café itself.
 * Ticked only when its PeerLens trust is good (`trustIsGood`), and only while
 * the ticked count stays within one tender's fan-out. The directory failing
 * or missing offers no one; the draft still has the café's own.
 */
export async function networkSuppliers(
  runtime: CommerceRuntime,
  lines: TenderDraftLine[],
  region: RegionRef | null,
  offered: TenderDraftSupplier[],
): Promise<TenderDraftSupplier[]> {
  const directory = getSupplierDirectory();
  if (directory === null || offered.length >= MAX_DRAFT_SUPPLIERS) return [];
  const buyer = runtime.settings.readBuyer();
  const skip = new Set([
    ...offered.map((s) => s.supplier_did),
    ...(buyer.ok ? buyer.settings.blockedSuppliers : []),
    runtime.nodeDid(),
  ]);
  const regionKey = region === null ? undefined : `${region.scheme}:${region.value}`;
  const found = new Map<string, SupplierFinding>();
  for (const line of lines.slice(0, MAX_NETWORK_SEARCHES)) {
    let findings: SupplierFinding[];
    try {
      findings = await directory.findSuppliers({
        text: line.requirement.text,
        ...(regionKey !== undefined ? { region: regionKey } : {}),
        limit: MAX_DRAFT_SUPPLIERS,
      });
    } catch {
      continue;
    }
    for (const f of findings) {
      // The AppView's word, checked before it is stored: one malformed entry
      // would make the whole stored draft fail its read-back check.
      if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]{1,2048}$/.test(f.supplierDid)) continue;
      if (!isValidServiceListingRkey(f.serviceRkey)) continue;
      if (!skip.has(f.supplierDid) && !found.has(f.supplierDid)) found.set(f.supplierDid, f);
    }
  }
  let ticked = offered.filter((s) => s.selected !== false).length;
  const out: TenderDraftSupplier[] = [];
  // Better-trusted first, so the ticks go to them.
  const ranked = [...found.values()].sort(
    (a, b) => (b.trust.score ?? -1) - (a.trust.score ?? -1) || b.trust.reviews - a.trust.reviews,
  );
  for (const f of ranked.slice(0, MAX_DRAFT_SUPPLIERS - offered.length)) {
    const selected = trustIsGood(f.trust) && ticked < DEFAULT_TENDER_FANOUT;
    if (selected) ticked += 1;
    out.push({
      supplier_did: f.supplierDid,
      service_rkey: f.serviceRkey,
      source: 'network',
      selected,
      ...(f.name !== null && f.name !== '' ? { name: f.name.slice(0, 120) } : {}),
      trust: { score: f.trust.score, reviews: f.trust.reviews },
    });
  }
  return out;
}

export type DraftLinesResult =
  | { ok: true; lines: TenderDraftLine[] }
  | { ok: false; detail: string };

/** The agent's lines: needs in words with a quantity, never a product or a price. */
export function parseDraftLines(value: unknown): DraftLinesResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: 'lines must be a non-empty array' };
  }
  if (value.length > MAX_DRAFT_LINES) {
    return { ok: false, detail: `at most ${String(MAX_DRAFT_LINES)} lines` };
  }
  const lines: TenderDraftLine[] = [];
  for (const [index, entry] of value.entries()) {
    const line = (entry ?? {}) as Record<string, unknown>;
    const text = typeof line.text === 'string' ? line.text.trim() : '';
    if (text === '' || text.length > MAX_REQUIREMENT_TEXT) {
      return {
        ok: false,
        detail: `lines[${String(index)}].text must be 1 to ${String(MAX_REQUIREMENT_TEXT)} characters`,
      };
    }
    const quantityError = validateQuantity(line.quantity, { require_positive: true });
    if (quantityError !== null) {
      return { ok: false, detail: `lines[${String(index)}].${quantityError}` };
    }
    const quantity = line.quantity as Quantity;
    lines.push({
      line_id: `l${String(index + 1)}`,
      requirement: { text },
      quantity: { value: quantity.value, unit_code: quantity.unit_code },
    });
  }
  return { ok: true, lines };
}

export type CreateDraftOutcome =
  | { ok: true; draft: TenderDraft }
  | {
      ok: false;
      refusal: 'commerce_unavailable' | 'no_known_suppliers' | 'too_many_pending_drafts';
    };

/** Store the draft and raise the owner's card. */
export async function createTenderDraft(args: {
  agentDid: string;
  lines: TenderDraftLine[];
  requiredBy: string;
  nowMs: number;
}): Promise<CreateDraftOutcome> {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { ok: false, refusal: 'commerce_unavailable' };
  if (
    runtime.tenderDrafts.countPending(args.agentDid, args.nowMs) >= MAX_PENDING_DRAFTS_PER_AGENT
  ) {
    return { ok: false, refusal: 'too_many_pending_drafts' };
  }
  const buyer = runtime.settings.readBuyer();
  const region = buyer.ok ? (buyer.settings.locations[0] ?? null) : null;
  const known = knownSuppliers(runtime, DEFAULT_TENDER_FANOUT);
  const suppliers = [...known, ...(await networkSuppliers(runtime, args.lines, region, known))];
  if (suppliers.length === 0) return { ok: false, refusal: 'no_known_suppliers' };
  const draft: TenderDraft = {
    draftId: `tdr_${bytesToHex(randomBytes(12))}`,
    agentDid: args.agentDid,
    lines: args.lines,
    requiredBy: args.requiredBy,
    suppliers,
    region,
    currency: buyer.ok ? buyer.settings.currency : '',
    state: 'pending',
    tenderId: '',
    createdAt: args.nowMs,
    expiresAt: args.nowMs + TENDER_DRAFT_TTL_MS,
  };
  runtime.tenderDrafts.put(draft);
  appendAudit('negotiation', 'tender_draft', draft.draftId, `lines=${String(draft.lines.length)}`);
  raiseDraftCard(draft);
  return { ok: true, draft };
}

export interface TenderDraftCardPayload {
  type: typeof TENDER_DRAFT_TYPE;
  draft_id: string;
  agent_did: string;
  lines: number;
  suppliers: number;
}

function draftSubject(draft: TenderDraft): string {
  const first = draft.lines[0]?.requirement.text ?? 'items';
  const shown = first.length > 60 ? `${first.slice(0, 57)}…` : first;
  const more = draft.lines.length > 1 ? ` and ${String(draft.lines.length - 1)} more` : '';
  return `“${shown}”${more}`;
}

/** Who the draft would ask, as the owner's card says it. */
function draftAudience(draft: TenderDraft): string {
  const known = draft.suppliers.filter((s) => s.source !== 'network').length;
  const found = draft.suppliers.length - known;
  const parts = [
    ...(known > 0 ? [`${String(known)} of your suppliers`] : []),
    ...(found > 0 ? [`${String(found)} found on the network`] : []),
  ];
  return parts.length === 0 ? '' : ` to ${parts.join(' and ')}`;
}

function raiseDraftCard(draft: TenderDraft): void {
  const workflow = getWorkflowService();
  if (workflow === null) return;
  const payload: TenderDraftCardPayload = {
    type: TENDER_DRAFT_TYPE,
    draft_id: draft.draftId,
    agent_did: draft.agentDid,
    lines: draft.lines.length,
    suppliers: draft.suppliers.length,
  };
  try {
    workflow.create({
      id: `tender-draft-${draft.draftId}`,
      kind: WorkflowTaskKind.Approval,
      description: `An agent drafted a tender for ${draftSubject(draft)}${draftAudience(draft)}. Add your target and ceiling to open it.`,
      payload: JSON.stringify(payload),
      idempotencyKey: `tender_draft:${draft.draftId}`,
      correlationId: draft.draftId,
      origin: 'agent',
      initialState: WorkflowTaskState.PendingApproval,
      expiresAtSec: Math.floor(draft.expiresAt / 1000),
    });
  } catch {
    /* already raised */
  }
}

/** The draft's card asks nothing once the owner opened or dismissed the draft. */
export function retireDraftCard(draftId: string, reason: 'draft_opened' | 'draft_dismissed'): void {
  const workflow = getWorkflowService();
  if (workflow === null) return;
  const id = `tender-draft-${draftId}`;
  const task = workflow.store().getById(id);
  if (task === null) return;
  try {
    if (task.status === WorkflowTaskState.PendingApproval) workflow.cancel(id, reason);
  } catch {
    /* the owner cleared it first */
  }
}

export type SupplierAnswer = 'none' | 'waiting' | 'accepted' | 'rejected' | 'countered' | 'unknown';

export interface AgentDraftStatus {
  draft_id: string;
  /** `lapsed`: still pending past its window. */
  draft_state: TenderDraftState | 'lapsed';
  /** Who the draft would ask; `selected` ones are asked when it opens without a list. */
  suppliers: {
    name: string | null;
    /** The owner's dot only, so it can name who to ask. */
    supplier_did?: string;
    source: 'known' | 'network';
    selected: boolean;
    trust?: { score: number | null; reviews: number };
  }[];
  /** The delivery area and currency an open takes when the dot names none. */
  region: unknown;
  currency: string | null;
  tender?: {
    state: string;
    /**
     * Best first, each supplier at its best version. The owner reads and
     * decides through the dot (HOSTED_DINA §6.3), so the price is here.
     */
    ranked: {
      rank: number;
      name: string | null;
      /** The owner's dot only; any other agent reads ranks and names. */
      total?: { currency: string; minor_units: string };
      valid_until?: string;
      estimated_delivery_at?: string;
    }[];
    excluded: number;
    held_order?: 'held' | 'sent' | 'lapsed';
    supplier_answer: SupplierAnswer;
    awarded_to?: string | null;
  };
}

/**
 * What the agent may read about its own draft. Names come from the owner's
 * contacts; a supplier who is not a contact reads as null.
 */
export function agentDraftStatus(
  draft: TenderDraft,
  nowMs: number,
  nameFor: (did: string) => string | null,
  opts: { prices: boolean } = { prices: false },
): AgentDraftStatus {
  const runtime = getCommerceRuntime();
  const lapsed = draft.state === 'pending' && draft.expiresAt <= nowMs;
  const status: AgentDraftStatus = {
    draft_id: draft.draftId,
    draft_state: lapsed ? 'lapsed' : draft.state,
    suppliers: draft.suppliers.map((s) => ({
      name: nameFor(s.supplier_did) ?? s.name ?? null,
      ...(opts.prices ? { supplier_did: s.supplier_did } : {}),
      source: s.source ?? 'known',
      selected: s.selected !== false,
      ...(s.trust !== undefined ? { trust: s.trust } : {}),
    })),
    region: draft.region,
    currency: draft.currency === '' ? null : draft.currency,
  };
  if (runtime === null || draft.state !== 'opened' || draft.tenderId === '') return status;
  const policy = runtime.buyerNegotiation.getTender(draft.tenderId);
  const ranking = rankTender({ tenderId: draft.tenderId, nowMs });
  const ranked = ranking.ok ? ranking.ranking.ranked : [];
  const firsts: typeof ranked = [];
  for (const offer of ranked) {
    if (!firsts.some((f) => f.supplier_did === offer.supplier_did)) firsts.push(offer);
  }
  const tender: NonNullable<AgentDraftStatus['tender']> = {
    state: policy?.state ?? 'no_policy',
    ranked: firsts.map((offer, index) => ({
      rank: index + 1,
      name: nameFor(offer.supplier_did) ?? draftName(draft, offer.supplier_did),
      ...(opts.prices
        ? {
            total: { currency: offer.currency, minor_units: offer.total_minor },
            valid_until: offer.valid_until,
            ...(offer.estimated_delivery_at !== undefined
              ? { estimated_delivery_at: offer.estimated_delivery_at }
              : {}),
          }
        : {}),
    })),
    excluded: ranking.ok ? ranking.ranking.excluded.length : 0,
    supplier_answer: 'none',
  };
  if (policy !== null && policy.state === 'awarded' && policy.approvalId !== '') {
    tender.awarded_to =
      nameFor(policy.awardedSupplierDid) ?? draftName(draft, policy.awardedSupplierDid);
    const approval = runtime.orderApprovals.get(policy.approvalId);
    if (approval === null) {
      tender.held_order = 'lapsed';
    } else if (approval.consumedAt !== null) {
      tender.held_order = 'sent';
      tender.supplier_answer = supplierAnswer(
        runtime,
        approval.order.supplier_did,
        approval.order.purchase_order_id,
      );
    } else {
      tender.held_order = approval.expiresAt <= nowMs ? 'lapsed' : 'held';
    }
  }
  status.tender = tender;
  return status;
}

/** The name the draft kept for a supplier (a network find's listing name). */
function draftName(draft: TenderDraft, supplierDid: string): string | null {
  return draft.suppliers.find((s) => s.supplier_did === supplierDid)?.name ?? null;
}

function supplierAnswer(
  runtime: CommerceRuntime,
  supplierDid: string,
  purchaseOrderId: string,
): SupplierAnswer {
  const record = runtime.buyerOrders.get(supplierDid, purchaseOrderId);
  if (record === null) return 'waiting';
  switch (record.state) {
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'countered':
      return 'countered';
    case 'submitted_unconfirmed':
      return 'waiting';
    default:
      return 'unknown';
  }
}
