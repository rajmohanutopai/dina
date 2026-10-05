/**
 * The server's approval cards on the paired phone (UCP plan §3.9; A2A plan
 * §3.20): each pending card the phone can show is mirrored there, and the
 * owner's decision on the phone is applied here through Core's owner path.
 * The source card stays authoritative; the phone's copy is a receipt.
 *
 * The phone takes a copy for fifteen minutes at most, so a longer card
 * travels in WINDOWS. Each window is a durable record written before its
 * first POST: the source task, the window number, its wire source id
 * (`<task id>:w<n>`, from which the phone derives the mirror id, so windows
 * never collide), the exact request body, and a fixed expiry, the earlier of
 * the source card's and fifteen minutes (less a minute for the clocks) from
 * the window's start.
 *
 *  - A window is POSTed once; the answer carries its decision. After any POST
 *    whose outcome is uncertain (no answer, a lost answer), the window is
 *    read through the phone's status GET (which has no expiry check), and
 *    POSTed again only when the phone says it does not exist and at least
 *    15 seconds of it are left.
 *  - Once a window exists, its state is read only through that GET, so a
 *    decision made just before it lapsed is still read after an outage, and
 *    a window that lapsed undecided reads `expired`, never a denial: it is
 *    retired, and the source card stays for the console and the next window.
 *  - In the last minute of a window, while the source is still pending and
 *    lives longer, the next window opens.
 *  - An approval or a denial in any window settles the source; the other
 *    windows are withdrawn once the source is no longer pending.
 *  - A yes to a presence-gated card counts only with the phone's
 *    `presence_verified`: Core refuses it otherwise.
 */

import { createHash } from 'node:crypto';

import {
  REMOTE_APPROVAL_API_PREFIX,
  applyOwnerWorkflowDecision,
  delegationConsentMirror,
  inboundReviewMirror,
  getWorkflowService,
  handoffCardMirror,
  parseCodingGateApprovalPayload,
  parseDelegationConsentCard,
  readHandoffCard,
  readOrderNoticeCard,
  orderNoticeDescription,
  readSearchReviewCard,
  readStartCard,
  searchReviewMirror,
  startCardMirror,
  parseInboundReviewCard,
  parseFacadeActionApprovalPayload,
  remoteApprovalProposalId,
  getUcpCheckoutRuntime,
  linkCardMirror,
  readLinkCard,
  UCP_HELD_CALLBACKS_ACK,
  UCP_HELD_CALLBACKS_PULL,
} from '@dina/core';
import { kvDelete, kvGet, kvList, kvSet } from '@dina/core/kv';

import type { WorkflowTask } from '@dina/core';

export interface PhoneApprovalResponse {
  status: number;
  body: unknown;
}

export interface PhoneApprovalClient {
  readonly did: string;
  request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<PhoneApprovalResponse>;
}

export interface PhoneApprovalSyncTickOptions {
  client: PhoneApprovalClient;
  nowMs?: number;
  limit?: number;
}

export interface PhoneApprovalSyncTickResult {
  /** Windows POSTed this tick. */
  proposed: number;
  pending: number;
  approved: number;
  denied: number;
  /** Windows that lapsed unanswered: the source card stays, for the console and the next window. */
  lapsed: number;
  withdrawn: number;
  failed: number;
}

export interface PhoneApprovalMirrorWithdrawalResult {
  withdrawn: number;
  failed: number;
}

interface ProposalWire {
  proposal_id: string;
  decision: 'pending' | 'approved' | 'denied' | 'expired';
  presence_verified: boolean;
  /** What the phone's copy is bound to; null from a phone that does not say. */
  source_payload_hash: string | null;
}

const RECEIPT_NAMESPACE = 'phone_approval_mirrors';

/**
 * The phone refused a card because this server is paired there as an ordinary agent (a
 * coding-agent code from before the Server node kind): its shopping cards stay on the
 * console until the owner re-pairs it. Learned again on the next refusal after a restart.
 */
let serverNodePairingNeeded = false;
/** The flag as last stored (it outlives a restart: a refused card is never sent again). */
const STATUS_NAMESPACE = 'phone_approval_status';
const PAIRING_KEY = 'server_node_pairing_needed';
let pairingLoaded = false;

/** Whether the paired phone wants this server re-paired as a Server node. */
export function phoneNeedsServerNodePairing(): boolean {
  return serverNodePairingNeeded;
}

/** The phone refused this server as an ordinary agent: say so until it is re-paired. */
export async function markServerNodePairingNeeded(): Promise<void> {
  await setPairingNeeded(true);
}

/** Forget it (a new phone was paired). */
export async function resetServerNodePairingNeeded(): Promise<void> {
  await setPairingNeeded(false);
}

async function setPairingNeeded(value: boolean): Promise<void> {
  pairingLoaded = true;
  if (serverNodePairingNeeded === value) return;
  serverNodePairingNeeded = value;
  if (value) await kvSet(PAIRING_KEY, '1', STATUS_NAMESPACE);
  else await kvDelete(PAIRING_KEY, STATUS_NAMESPACE);
}

async function loadPairingNeeded(): Promise<void> {
  if (pairingLoaded) return;
  pairingLoaded = true;
  serverNodePairingNeeded = (await kvGet(PAIRING_KEY, STATUS_NAMESPACE)) !== null;
}

/** Whether a window's card needs the phone to know this server as a Server node (`node` scope). */
function needsNodeScope(w: MirrorWindow): boolean {
  if (w.body === null) return false;
  const b = JSON.parse(w.body) as Record<string, unknown>;
  return (
    (typeof b.action === 'string' && b.action.startsWith('ucp_')) ||
    (typeof b.agent_did === 'string' && b.agent_did.startsWith('ucp:')) ||
    b.link_url !== undefined ||
    b.presence_required === true
  );
}
/** The phone's cap on a copy, less a minute for the two clocks. */
const WINDOW_SECONDS = 15 * 60 - 60;
/** The phone refuses a copy with less left than this. */
const MIN_WINDOW_SECONDS = 15;
/** The next window opens in the last minute of the current one. */
const OVERLAP_SECONDS = 60;
/** An order or checkout notice (§3.14): news, paced as such on the phone. */
const isNotice = (action: string): boolean =>
  action === 'ucp_order_notice' || action === 'ucp_checkout_notice';
/** How many windows an order notice gets on the phone, and how far apart they open. */
const NOTICE_WINDOWS = 3;
const NOTICE_EVERY_SECONDS = 24 * 60 * 60;

/** One window of one source card, as stored before its first POST. */
interface MirrorWindow {
  sourceTaskId: string;
  window: number;
  wireSourceId: string;
  proposalId: string;
  /** Epoch seconds. */
  expiresAt: number;
  /** The exact POST body, sent byte for byte on every attempt. */
  body: string | null;
  /** The phone answered a POST or GET for it: it exists there. */
  confirmed: boolean;
  /**
   * Read no more: the phone's yes on this card was refused here (no proof of presence), so
   * the card is the console's; kept only so it is withdrawn when the card ends.
   */
  retired: boolean;
  /**
   * Lapsed on the phone with no decision. Kept (rather than deleted) only for a notice, whose
   * windows open a day apart: its count and end time pace the next, and the next is numbered
   * above it (re-posting a used window id is a conflict on the phone).
   */
  lapsed: boolean;
}

interface PhoneProposalSource {
  payloadHash: string;
  agentDid: string;
  action: string;
  toolName: string;
  proposalType?: 'facade_action';
  displayTitle?: string;
  displayDetail?: string;
  linkUrl?: string;
  presenceRequired?: true;
}

/**
 * Reconcile the server's pending approval cards with their phone windows.
 * Fail closed: a transport failure leaves every source card pending and
 * stops the batch (the phone or relay is down for all of them).
 */
export async function runPhoneApprovalSyncTick(
  options: PhoneApprovalSyncTickOptions,
): Promise<PhoneApprovalSyncTickResult> {
  const result: PhoneApprovalSyncTickResult = {
    proposed: 0,
    pending: 0,
    approved: 0,
    denied: 0,
    lapsed: 0,
    withdrawn: 0,
    failed: 0,
  };
  const service = getWorkflowService();
  if (service === null) return result;
  await loadPairingNeeded();
  const { client } = options;
  const nowMs = options.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  // Withdraw the windows of sources no longer pending. Records are durable, so a source
  // cancelled before a restart is still withdrawn after it.
  const windows = await listWindows();
  for (const w of windows) {
    const source = service.store().getById(w.sourceTaskId);
    if (source !== null && source.status === 'pending_approval') continue;
    try {
      const withdrawn = await client.request('DELETE', proposalPath(w.proposalId));
      if ((withdrawn.status >= 200 && withdrawn.status < 300) || withdrawn.status === 404) {
        await kvDelete(w.wireSourceId, RECEIPT_NAMESPACE);
        result.withdrawn++;
      } else {
        result.failed++;
      }
    } catch {
      result.failed++;
      return result;
    }
  }

  const tasks = service
    .store()
    .listByKindAndState('approval', 'pending_approval', options.limit ?? 50);
  const byTask = new Map<string, MirrorWindow[]>();
  for (const w of await listWindows()) {
    const list = byTask.get(w.sourceTaskId) ?? [];
    list.push(w);
    byTask.set(w.sourceTaskId, list);
  }

  for (const task of tasks) {
    const proposal = proposalForTask(task.payload);
    if (proposal === null || typeof task.expires_at !== 'number') continue;
    try {
      const own = (byTask.get(task.id) ?? []).sort((a, b) => a.window - b.window);
      let settled = false;
      // The windows already made: their decisions first.
      // A card the phone cannot decide (its yes was refused here) is the console's.
      if (own.some((w) => w.retired)) continue;
      for (const w of own) {
        // A notice's lapsed window is a record of pacing only: nothing more to read.
        if (w.lapsed) continue;
        const outcome = await readWindow(client, w, nowSec);
        if (outcome === 'gone') continue;
        if (outcome.kind === 'pending') {
          result.pending++;
          continue;
        }
        if (outcome.kind === 'mismatch' || outcome.kind === 'refused') {
          await retireCard(task.id);
          result.failed++;
          settled = true;
          break;
        }
        if (outcome.kind === 'expired') {
          // Nobody decided: this window retires; the source card stays. A notice's is kept,
          // marked, to pace its next window.
          if (isNotice(proposal.action)) await storeWindow({ ...w, lapsed: true });
          else await kvDelete(w.wireSourceId, RECEIPT_NAMESPACE);
          result.lapsed++;
          continue;
        }
        settled = true;
        await settle(task, outcome, result);
        break;
      }
      if (settled) continue;
      // An order or checkout notice is news, not a decision: a window on the phone once a day,
      // three in all (a reminder, never a new card every quarter hour for its 30 days). After
      // the third lapses unseen, it stays the console's until "Seen".
      if (isNotice(proposal.action)) {
        if (own.some((w) => !w.lapsed && w.expiresAt - nowSec > MIN_WINDOW_SECONDS)) continue;
        if (own.length >= NOTICE_WINDOWS) {
          await retireCard(task.id);
          continue;
        }
        const lastEnd = Math.max(0, ...own.map((w) => w.expiresAt));
        if (own.length > 0 && nowSec < lastEnd + NOTICE_EVERY_SECONDS - WINDOW_SECONDS) continue;
      }
      // A new window when none is live past its last minute, and the source still has time.
      const live = own.filter((w) => w.expiresAt - nowSec > OVERLAP_SECONDS);
      const stillOpen = await listWindowsOf(task.id);
      const covered = live.some((w) => stillOpen.some((s) => s.wireSourceId === w.wireSourceId));
      if (covered || task.expires_at - nowSec < MIN_WINDOW_SECONDS) continue;
      const next = Math.max(0, ...own.map((w) => w.window)) + 1;
      const opened = await openWindow(client, task, proposal, next, nowSec);
      result.proposed++;
      if (opened.kind === 'mismatch' || opened.kind === 'refused') {
        await retireCard(task.id);
        result.failed++;
      } else if (opened.kind === 'pending') result.pending++;
      else if (opened.kind === 'approved' || opened.kind === 'denied') {
        await settle(task, opened, result);
      } else if (opened.kind === 'expired') result.lapsed++;
      else result.failed++;
    } catch {
      // A relay, phone or storage failure leaves the source pending; never infer a
      // decision. The phone is shared by every card: stop this batch.
      result.failed++;
      break;
    }
  }
  return result;
}

type WindowOutcome =
  /** The phone's copy is not bound to what this window sent: nothing it says counts. */
  | { kind: 'mismatch' }
  /** The phone refused the window outright (a 4xx): the card is the console's. */
  | { kind: 'refused' }
  | { kind: 'pending' }
  | { kind: 'approved'; presenceVerified: boolean }
  | { kind: 'denied' }
  | { kind: 'expired' };

/** Apply a window's decision to its source card, through Core's owner path. */
async function settle(
  task: WorkflowTask,
  outcome: { kind: 'approved'; presenceVerified: boolean } | { kind: 'denied' },
  result: PhoneApprovalSyncTickResult,
): Promise<void> {
  if (outcome.kind === 'approved') {
    try {
      await applyOwnerWorkflowDecision(task.id, 'approve', null, {
        presenceVerified: outcome.presenceVerified,
      });
      result.approved++;
    } catch {
      // Refused (a presence-gated card without proof of presence): the card stays for the
      // console, and no window of it is read or opened again; they are withdrawn when it ends.
      result.failed++;
      await retireCard(task.id);
    }
    return;
  }
  await applyOwnerWorkflowDecision(task.id, 'deny', { reason: 'denied on owner phone' });
  result.denied++;
}

/**
 * A window's state. A confirmed window is read through the status GET; an
 * unconfirmed one (its POST's outcome uncertain) too, and POSTed again only
 * when the phone does not have it and it has 15 seconds left.
 */
async function readWindow(
  client: PhoneApprovalClient,
  w: MirrorWindow,
  nowSec: number,
): Promise<WindowOutcome | 'gone'> {
  const status = await client.request('GET', `${proposalPath(w.proposalId)}/status`);
  if (status.status === 404) {
    if (w.confirmed || w.body === null || w.expiresAt - nowSec < MIN_WINDOW_SECONDS) {
      // Not there and not to be made again: retired.
      await kvDelete(w.wireSourceId, RECEIPT_NAMESPACE);
      return 'gone';
    }
    return postWindow(client, w);
  }
  if (status.status < 200 || status.status >= 300) throw new Error('status unavailable');
  const decision = parseProposalWire(status.body);
  if (decision === null || decision.proposal_id !== w.proposalId)
    throw new Error('status answer invalid');
  if (!w.confirmed) await storeWindow({ ...w, confirmed: true });
  return outcomeOf(decision, w);
}

/** Write a new window's record, then POST it. */
async function openWindow(
  client: PhoneApprovalClient,
  task: WorkflowTask,
  proposal: PhoneProposalSource,
  window: number,
  nowSec: number,
): Promise<WindowOutcome | { kind: 'failed' }> {
  const wireSourceId = `${task.id}:w${window}`;
  const expiresAt = Math.min(task.expires_at as number, nowSec + WINDOW_SECONDS);
  const body = JSON.stringify({
    source_task_id: wireSourceId,
    source_payload_hash: proposal.payloadHash,
    agent_did: proposal.agentDid,
    action: proposal.action,
    risk_level: 'HIGH',
    tool_name: proposal.toolName,
    expires_at: expiresAt,
    ...(proposal.proposalType !== undefined ? { proposal_type: proposal.proposalType } : {}),
    ...(proposal.displayTitle !== undefined ? { display_title: proposal.displayTitle } : {}),
    ...(proposal.displayDetail !== undefined ? { display_detail: proposal.displayDetail } : {}),
    ...(proposal.linkUrl !== undefined ? { link_url: proposal.linkUrl } : {}),
    ...(proposal.presenceRequired === true ? { presence_required: true } : {}),
  });
  const w: MirrorWindow = {
    sourceTaskId: task.id,
    window,
    wireSourceId,
    proposalId: remoteApprovalProposalId(client.did, wireSourceId),
    expiresAt,
    body,
    confirmed: false,
    retired: false,
    lapsed: false,
  };
  // Persisted before transport: a window the phone made while this process died is still
  // read, and withdrawn, after a restart.
  await storeWindow(w);
  const outcome = await postWindow(client, w);
  return outcome === 'gone' ? { kind: 'failed' } : outcome;
}

/** POST a window's stored bytes; an answer that is not its own is no answer. */
async function postWindow(
  client: PhoneApprovalClient,
  w: MirrorWindow,
): Promise<WindowOutcome | 'gone'> {
  const created = await client.request(
    'POST',
    `${REMOTE_APPROVAL_API_PREFIX}/proposals`,
    JSON.parse(w.body as string) as unknown,
  );
  // Too many cards wait on the phone: try this window again later.
  if (created.status === 429) return { kind: 'pending' };
  // The phone refused these bytes (invalid, a conflict, or not from a sender allowed to send
  // them): they will never be taken, so the card is left to the console rather than sent
  // again every tick. A 403 means this server is paired there as an ordinary agent, not as a
  // Server node: the console says so.
  if (created.status >= 400 && created.status < 500) {
    if (created.status === 403) await markServerNodePairingNeeded();
    return { kind: 'refused' };
  }
  if (created.status < 200 || created.status >= 300) return { kind: 'pending' };
  const decision = parseProposalWire(created.body);
  if (decision === null) return { kind: 'pending' };
  if (decision.proposal_id !== w.proposalId) {
    // A response that breaks the deterministic protocol cannot authorize anything:
    // close the unexpected card and keep the expected record for later.
    await client.request('DELETE', proposalPath(decision.proposal_id)).catch(() => undefined);
    return { kind: 'pending' };
  }
  await storeWindow({ ...w, confirmed: true });
  // A card only a Server node may send was taken: the phone knows this server as one now.
  if (needsNodeScope(w)) await setPairingNeeded(false);
  return outcomeOf(decision, w);
}

/**
 * A window's answer, if the phone's copy is bound to the hash this window sent (a copy made
 * from other bytes under the same id decides nothing). A window from before windows has no
 * stored bytes to check against: only its silence counts.
 */
function outcomeOf(decision: ProposalWire, w: MirrorWindow): WindowOutcome {
  const sent = w.body === null ? null : (JSON.parse(w.body) as { source_payload_hash?: unknown });
  const bound =
    sent !== null &&
    typeof sent.source_payload_hash === 'string' &&
    decision.source_payload_hash === sent.source_payload_hash;
  // Silence or a lapse is nobody's decision: it needs no binding (the lapse retires only its
  // window). A yes or a no counts only from the copy this window sent.
  if (!bound)
    return decision.decision === 'pending' || decision.decision === 'expired'
      ? { kind: decision.decision }
      : { kind: 'mismatch' };
  switch (decision.decision) {
    case 'approved':
      return { kind: 'approved', presenceVerified: decision.presence_verified };
    case 'denied':
      return { kind: 'denied' };
    case 'expired':
      return { kind: 'expired' };
    default:
      return { kind: 'pending' };
  }
}

const proposalPath = (proposalId: string) =>
  `${REMOTE_APPROVAL_API_PREFIX}/proposals/${encodeURIComponent(proposalId)}`;

function proposalForTask(raw: string): PhoneProposalSource | null {
  const coding = parseCodingGateApprovalPayload(raw);
  if (coding !== null && coding.risk === 'HIGH') {
    return {
      payloadHash: coding.payload_hash,
      agentDid: coding.agent_did,
      action: coding.action,
      toolName: coding.tool,
    };
  }
  // A2A Lane 1 (plan §3.20): the server runs the lane and the paired phone
  // decides its consent cards. Mirrored only when the phone can show every
  // byte that would be sent; otherwise the owner decides on the console.
  const consent = parseDelegationConsentCard(raw);
  if (consent !== null) {
    const mirror = delegationConsentMirror(consent);
    if (mirror === null) return null;
    return {
      payloadHash: consent.consent_hash,
      agentDid: `a2a:${consent.consent.remote_agent_id}`,
      action: 'a2a_delegate',
      toolName: 'a2a_delegate',
      proposalType: 'facade_action',
      displayTitle: mirror.title,
      displayDetail: mirror.detail,
    };
  }
  // A2A Lane 2 (design §7.3): an outside agent's call under review. The
  // phone shows Core's words and the exact params; the decision binds to the
  // hash of the normalized call.
  const inbound = parseInboundReviewCard(raw);
  if (inbound !== null) {
    const mirror = inboundReviewMirror(inbound);
    if (mirror === null) return null;
    return {
      payloadHash: inbound.post_hash,
      agentDid: `a2a:${inbound.client_id}`,
      action: 'a2a_inbound',
      toolName: 'a2a_inbound',
      proposalType: 'facade_action',
      displayTitle: mirror.title,
      displayDetail: mirror.detail,
    };
  }
  // UCP (plan §3.16): a search Dina held before it left. The phone shows every
  // shop and the exact query; the decision binds to the card's binding (the
  // conversation, the query and the shops).
  const review = readSearchReviewCard(raw);
  if (review !== null) {
    const mirror = searchReviewMirror(review);
    if (mirror === null) return null;
    return {
      payloadHash: review.binding,
      agentDid: 'ucp:search',
      action: 'ucp_search',
      toolName: 'ucp_search',
      proposalType: 'facade_action',
      displayTitle: mirror.title,
      displayDetail: mirror.detail,
    };
  }
  // UCP checkout (plan §3.7, §3.9): the start card, mirrored only when every line it covers
  // fits; the hand-off card, whose yes needs a person present on the phone and opens the
  // merchant's page there. Each decision binds to the card's own bytes.
  const start = readStartCard(raw);
  if (start !== null) {
    const mirror = startCardMirror(start);
    if (mirror === null) return null;
    return {
      payloadHash: start.intent_hash,
      agentDid: 'ucp:checkout',
      action: 'ucp_checkout_start',
      toolName: 'ucp_checkout_start',
      proposalType: 'facade_action',
      displayTitle: mirror.title,
      displayDetail: mirror.detail,
    };
  }
  const handoff = readHandoffCard(raw);
  if (handoff !== null) {
    const mirror = handoffCardMirror(handoff);
    if (mirror === null) return null;
    return {
      payloadHash: createHash('sha256').update(raw).digest('hex'),
      agentDid: 'ucp:checkout',
      action: 'ucp_checkout_handoff',
      toolName: 'ucp_checkout_handoff',
      proposalType: 'facade_action',
      displayTitle: mirror.title,
      displayDetail: mirror.detail,
      ...(mirror.linkUrl !== undefined ? { linkUrl: mirror.linkUrl } : {}),
      ...(mirror.presenceRequired === true ? { presenceRequired: true as const } : {}),
    };
  }
  // A linked-account card (plan §3.17): this server has no public origin, so the merchant's
  // sign-in page opens on the phone, whose app catches the answer for this server to pull.
  // Its yes needs a person present there; it binds to the card's own bytes.
  const link = readLinkCard(raw);
  if (link !== null) {
    const mirror = linkCardMirror(link);
    if (mirror === null) return null;
    return {
      payloadHash: createHash('sha256').update(raw).digest('hex'),
      agentDid: 'ucp:link',
      action: 'ucp_link_handoff',
      toolName: 'ucp_link_handoff',
      proposalType: 'facade_action',
      displayTitle: mirror.title,
      displayDetail: mirror.detail,
      linkUrl: mirror.linkUrl,
      presenceRequired: true as const,
    };
  }
  // An order notice (plan §3.14): a failure, cancellation or dispute, in Core's words, with
  // the shop's order page; its one action, "Seen", binds to the card's own bytes.
  const notice = readOrderNoticeCard(raw);
  if (notice !== null) {
    const title = orderNoticeDescription(notice);
    // A checkout that ended unconfirmed points at the store; an order at its own page.
    const checkout = notice.notice.kind === 'checkout';
    const action = checkout ? 'ucp_checkout_notice' : 'ucp_order_notice';
    return {
      payloadHash: createHash('sha256').update(raw).digest('hex'),
      agentDid: 'ucp:order',
      action,
      toolName: action,
      proposalType: 'facade_action',
      displayTitle: title,
      displayDetail: `${title}\n${checkout ? 'Go to' : 'Track or return at'} ${notice.merchant_host}.`,
      linkUrl: notice.permalink_url,
    };
  }
  const facade = parseFacadeActionApprovalPayload(raw);
  if (facade === null) return null;
  return {
    payloadHash: facade.payload_hash,
    agentDid: facade.agent_did,
    action: facade.action,
    toolName: `dina_${facade.action}`,
    proposalType: 'facade_action',
    displayTitle: facade.display_title,
    displayDetail: facade.display_detail,
  };
}

/**
 * Pull the callbacks the paired phone's claimed link caught for this node's
 * linked-account flows (UCP plan §3.17), finish each, then acknowledge them.
 * Only while a link waits; by the states it waits on (each this node's own
 * secret), so the phone hands over nothing else. A state finished from a
 * pull stays among those asked for until the phone acknowledges dropping it,
 * so a crash before the acknowledgement pulls again: an attempt that ended is
 * refused as a repeat and acknowledged, and one a crash left part-way is
 * finished then. One another run is still finishing ('busy') is not
 * acknowledged yet. How each attempt ended is kept for the owner's Linked
 * accounts. Returns how many were taken.
 */
export async function pullUcpLinkCallbacks(client: PhoneApprovalClient): Promise<number> {
  const links = getUcpCheckoutRuntime()?.links;
  if (links === undefined) return 0;
  const states = links.waitingStates();
  if (states.length === 0) return 0;
  const pulled = await client.request('POST', UCP_HELD_CALLBACKS_PULL, { states });
  if (pulled.status !== 200) return 0;
  const asked = new Set(states);
  const done: string[] = [];
  for (const cb of heldCallbacksOf(pulled.body)) {
    if (!asked.has(cb.state) || cb.params.state !== cb.state) continue;
    const out = await links.complete(cb.params, { relayed: true });
    if (!out.ok && out.reason === 'busy') continue;
    done.push(cb.state);
  }
  if (done.length === 0) return 0;
  const acked = await client.request('POST', UCP_HELD_CALLBACKS_ACK, { states: done });
  if (acked.status === 200) links.markRelayed(done);
  return done.length;
}

/** The phone's answer to a pull, strictly: entries that do not read are left. */
function heldCallbacksOf(body: unknown): { state: string; params: Record<string, string> }[] {
  const list = (body as { callbacks?: unknown } | null)?.callbacks;
  if (!Array.isArray(list)) return [];
  const out: { state: string; params: Record<string, string> }[] = [];
  for (const entry of list) {
    const e = entry as { state?: unknown; params?: unknown } | null;
    if (e === null || typeof e !== 'object' || typeof e.state !== 'string') continue;
    const p = e.params;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue;
    const params: Record<string, string> = {};
    let readable = true;
    for (const [k, v] of Object.entries(p)) {
      if (typeof v !== 'string') readable = false;
      else params[k] = v;
    }
    if (readable) out.push({ state: e.state, params });
  }
  return out;
}

export class PhoneApprovalSyncWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<PhoneApprovalSyncTickResult> | null = null;

  constructor(
    private readonly client: PhoneApprovalClient,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.tick().catch(() => undefined);
    this.timer = setInterval(() => void this.tick().catch(() => undefined), this.intervalMs);
    this.timer.unref?.();
  }

  async tick(): Promise<PhoneApprovalSyncTickResult> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = (async () => {
      // A linked-account callback waits on the owner at the merchant: finished first.
      await pullUcpLinkCallbacks(this.client).catch(() => 0);
      return runPhoneApprovalSyncTick({ client: this.client });
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight !== null) {
      try {
        await this.inFlight;
      } catch {
        // The worker is fail-closed. Shutdown only needs the attempt settled.
      }
    }
  }
}

/** Withdraw every durable phone window before revoking or replacing the phone. */
export async function withdrawAllPhoneApprovalMirrors(
  client: PhoneApprovalClient,
): Promise<PhoneApprovalMirrorWithdrawalResult> {
  const result: PhoneApprovalMirrorWithdrawalResult = { withdrawn: 0, failed: 0 };
  for (const w of await listWindows()) {
    try {
      const response = await client.request('DELETE', proposalPath(w.proposalId));
      if ((response.status >= 200 && response.status < 300) || response.status === 404) {
        await kvDelete(w.wireSourceId, RECEIPT_NAMESPACE);
        result.withdrawn++;
      } else {
        result.failed++;
      }
    } catch {
      result.failed++;
      break;
    }
  }
  return result;
}

/** The card is the console's from now on: no window of it is read or opened again. */
async function retireCard(sourceTaskId: string): Promise<void> {
  for (const w of await listWindowsOf(sourceTaskId)) await storeWindow({ ...w, retired: true });
}

async function storeWindow(w: MirrorWindow): Promise<void> {
  await kvSet(
    w.wireSourceId,
    JSON.stringify({
      source_task_id: w.sourceTaskId,
      window: w.window,
      wire_source_id: w.wireSourceId,
      proposal_id: w.proposalId,
      expires_at: w.expiresAt,
      body: w.body,
      confirmed: w.confirmed,
      retired: w.retired,
      lapsed: w.lapsed,
    }),
    RECEIPT_NAMESPACE,
  );
}

async function listWindowsOf(sourceTaskId: string): Promise<MirrorWindow[]> {
  return (await listWindows()).filter((w) => w.sourceTaskId === sourceTaskId);
}

async function listWindows(): Promise<MirrorWindow[]> {
  const entries = await kvList(RECEIPT_NAMESPACE);
  const windows: MirrorWindow[] = [];
  for (const entry of entries) {
    try {
      const v = JSON.parse(entry.value) as Record<string, unknown>;
      const ok =
        typeof v.source_task_id === 'string' &&
        v.source_task_id !== '' &&
        typeof v.proposal_id === 'string' &&
        v.proposal_id !== '';
      if (!ok) {
        await deleteReceiptEntry(entry.key);
        continue;
      }
      // A record from before windows (one receipt per card): window 0, read through the GET
      // only, never POSTed again.
      const legacy = typeof v.wire_source_id !== 'string';
      windows.push({
        sourceTaskId: v.source_task_id as string,
        window: legacy ? 0 : Number(v.window),
        wireSourceId: legacy ? (v.source_task_id as string) : (v.wire_source_id as string),
        proposalId: v.proposal_id as string,
        expiresAt: typeof v.expires_at === 'number' ? v.expires_at : 0,
        body: typeof v.body === 'string' ? v.body : null,
        confirmed: legacy || v.confirmed === true,
        retired: v.retired === true,
        lapsed: v.lapsed === true,
      });
    } catch {
      // Malformed local metadata carries no authority; keeping it could only block cleanup.
      await deleteReceiptEntry(entry.key);
    }
  }
  return windows;
}

function parseProposalWire(value: unknown): ProposalWire | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.proposal_id !== 'string' ||
    body.proposal_id === '' ||
    (body.decision !== 'pending' &&
      body.decision !== 'approved' &&
      body.decision !== 'denied' &&
      body.decision !== 'expired')
  ) {
    return null;
  }
  return {
    proposal_id: body.proposal_id,
    decision: body.decision,
    presence_verified: body.presence_verified === true,
    source_payload_hash:
      typeof body.source_payload_hash === 'string' ? body.source_payload_hash : null,
  };
}

async function deleteReceiptEntry(entryKey: string): Promise<void> {
  const key = entryKey.startsWith(`${RECEIPT_NAMESPACE}:`)
    ? entryKey.slice(RECEIPT_NAMESPACE.length + 1)
    : entryKey;
  await kvDelete(key, RECEIPT_NAMESPACE);
}
