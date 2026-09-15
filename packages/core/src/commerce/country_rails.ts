/**
 * The KHATA → RAIL hooks (RESEARCHER_KERNEL_ARCHITECTURE.md §5.D): the moments
 * in the money line where an installed country pack has something to add, and
 * the one rule that governs all of them — a rail INFORMS, the owner DECIDES.
 *
 * THE FILING HOOK (the second). The supplier authors a DeliveryNote: goods are
 * on their way. With the India pack active that is the moment an e-way bill is
 * due (both parties' GSTINs and the consignment's value); with the USA pack, an
 * invoice with the order's net terms. Both are `write` capabilities, so both
 * card: the owner reads the exact numbers before anything is filed in their
 * name. The facts come from the places part 1–3 put them — the node's own
 * business settings, the counterparty's contact, and the bound quote — and
 * when one is missing the hook says so and asks nothing. A filing made from a
 * guess would be a filing made under someone's else's number.
 *
 * The first hook: a PaymentNote arrives from a buyer saying "paid, UPI, ref
 * 3141…". Today the supplier acknowledges it on trust. With the India pack
 * active, Dina can ask the pack's `upi-payment-status` rail whether that UTR
 * settled — through the same gate every plugin effect meets, so the owner
 * sees the exact UTR and amount before they leave the node (the rail is a
 * regulated read: it cards every time). The rail's answer lands on the task,
 * correlated to the note's digest; nothing here writes a PaymentAck. The khata
 * fold stays the owner's signed word, not a provider's.
 *
 * Why the hook lives in Core's commerce module and not in a route: the note
 * reaches this node through the D2D route, the inbox drain and the spool
 * replay, and every path must ask exactly once. The idempotency key is the
 * note's digest, so a re-delivered or replayed note answers with the task
 * that already asked.
 *
 * THE REMINDER HOOK (the third) is OWNER-INITIATED, and that is a rule, not a
 * convenience: TRADE_FIRST §4.5 makes an overdue due Solicited or Engagement
 * and "never an interruption — Silence First applies to money reminders too".
 * So nothing here watches a clock. The owner opens the statement, sees the
 * overdue row, and asks; this stages the ask, which then cards like every
 * other write. Dina never sends a counterparty a message the owner did not
 * decide to send.
 *
 * Nothing here moves money and nothing here calls a provider: the producer
 * stages a task on the plugin lane; the operator's paired runner, holding the
 * provider account outside this repo, is what answers.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  readPaymentNote,
  type DeliveryNote,
  type Money,
  type PaymentNote,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { getContactChannels, getPaperIdentity } from '../contacts/directory';
import { invokeToolCapability, isPluginInvocationTask, type InvokeToolCapabilityResult } from '../plugins/invoke';
import { getPluginInstallRepository, type PluginInstall } from '../plugins/registry';
import { getWorkflowService } from '../workflow/service';


import { COUNTRY_PACK_IDS, type CountryPack } from './country_packs';
import {
  rehydrateInvocationCapabilityId,
  rehydratePaymentRailAnswer,
  type PaymentRailAnswer,
} from './money_rehydrate';
import { getCommerceRuntime } from './runtime';
import { registrationFor, type TaxRegistrationScheme } from './trade_identity';

const hash: Sha256Fn = (data) => sha256(data);

/** Why a dispatch produced no filing. Each is a fact, never a failure. */
export type DeliveryFilingRefusal =
  | 'no_active_pack'
  | 'pack_has_no_filing'
  | 'no_own_registration'
  | 'no_counterparty_registration'
  | 'unpriceable'
  | 'terms_not_supported'
  | 'no_workflow'
  | 'refused';

export type DeliveryFilingRailOutcome =
  | { asked: true; pack: CountryPack; taskId: string; mode: 'dispatched' | 'approval_required' }
  | { asked: false; reason: DeliveryFilingRefusal; detail?: string };

/** Why an owner's reminder could not be staged. Each is a fact to show them. */
export type ReminderRefusal =
  | 'no_active_pack'
  | 'pack_has_no_reminder'
  | 'no_channel'
  | 'no_workflow'
  | 'refused';

export type ReminderRailOutcome =
  | { asked: true; pack: CountryPack; taskId: string; mode: 'dispatched' | 'approval_required' }
  | { asked: false; reason: ReminderRefusal; detail?: string };

export type PaymentStatusRailOutcome =
  | { asked: true; pack: CountryPack; taskId: string; mode: 'dispatched' | 'approval_required' }
  | {
      asked: false;
      reason: 'unreadable' | 'no_reference' | 'method_has_no_rail' | 'no_active_pack' | 'no_workflow' | 'refused';
      detail?: string;
    };

/**
 * Every active country pack install the owner holds (§5.D — first-party
 * anchor only), oldest first. A trader selling in two markets may hold both;
 * the rail is chosen by the NOTE's method, never by which pack came first.
 */
export function activeCountryPacks(): { pack: CountryPack; install: PluginInstall }[] {
  const installs = getPluginInstallRepository();
  if (installs === null) return [];
  const out: { pack: CountryPack; install: PluginInstall }[] = [];
  for (const install of installs.list()) {
    if (install.status !== 'active' || install.trustAnchor.kind !== 'local_publisher_key') continue;
    const pack = (Object.keys(COUNTRY_PACK_IDS) as CountryPack[]).find((p) => COUNTRY_PACK_IDS[p] === install.pluginId);
    if (pack !== undefined) out.push({ pack, install });
  }
  return out;
}


/**
 * Which rail answers "did this payment settle?" for a note's method, and the
 * params it takes — the note's own fields, nothing composed.
 */
function statusRailFor(
  pack: CountryPack,
  note: PaymentNote,
): { capabilityId: string; params: Record<string, unknown> } | null {
  const ref = note.external_ref ?? '';
  if (ref === '') return null;
  if (pack === 'in' && note.method === 'upi') {
    return {
      capabilityId: `${COUNTRY_PACK_IDS.in}.upi-payment-status`,
      params: { utr: ref, expected_amount: note.amount },
    };
  }
  if (pack === 'us' && note.method === 'transfer') {
    return {
      capabilityId: `${COUNTRY_PACK_IDS.us}.settlement-status`,
      params: { payment_ref: ref, rail: 'ach', expected_amount: note.amount },
    };
  }
  return null;
}

/**
 * Ask the active pack whether the payment a note reports has settled.
 *
 * `askAtMs` is the WALL CLOCK of the ask, not the note's arrival: a note that
 * waited in the spool while the money line was closed replays with its
 * arrival time for the ledger (order is what matters there), but the card it
 * raises must live from now — a card whose 24 h began days ago would be
 * expired before the owner ever saw it.
 *
 * Never throws into the ingress path: the note has already been stored when
 * this runs, and a fault here (a registry read that fails, a producer bug)
 * must not turn an accepted note into a failed receive. Every way the ask
 * cannot happen is a typed reason the caller may record.
 */
export function askPaymentStatusRail(rawNote: unknown, askAtMs: number): PaymentStatusRailOutcome {
  try {
    return askPaymentStatusRailUnguarded(rawNote, askAtMs);
  } catch (err) {
    return { asked: false, reason: 'refused', detail: err instanceof Error ? err.constructor.name : typeof err };
  }
}

function askPaymentStatusRailUnguarded(rawNote: unknown, askAtMs: number): PaymentStatusRailOutcome {
  // The verifier already accepted these bytes; reading them again here is
  // what gives this hook a typed note without the verifier returning one.
  const read = readPaymentNote(rawNote, hash);
  if (!read.ok) return { asked: false, reason: 'unreadable', detail: read.error };
  const note = read.note;
  if ((note.external_ref ?? '') === '') return { asked: false, reason: 'no_reference' };
  const packs = activeCountryPacks();
  if (packs.length === 0) return { asked: false, reason: 'no_active_pack' };
  // The pack whose rail answers THIS note's method — with both packs active,
  // a UPI note asks India and a transfer asks the USA, whichever came first.
  let chosen: { pack: CountryPack; install: PluginInstall; rail: NonNullable<ReturnType<typeof statusRailFor>> } | null =
    null;
  for (const candidate of packs) {
    const rail = statusRailFor(candidate.pack, note);
    if (rail !== null) {
      chosen = { ...candidate, rail };
      break;
    }
  }
  if (chosen === null) return { asked: false, reason: 'method_has_no_rail' };
  const workflow = getWorkflowService();
  if (workflow === null) return { asked: false, reason: 'no_workflow' };

  const result: InvokeToolCapabilityResult = invokeToolCapability(
    {
      installId: chosen.install.installId,
      capabilityId: chosen.rail.capabilityId,
      params: chosen.rail.params,
      paramCategories: ['payment'],
      // §11 — WHO and WHAT, so Core can project its own context. The note is
      // the subject; the payer is the counterparty this supplier is checking.
      subject: { contactDid: note.buyer_did, documentDigest: note.note_digest },
      // One ask per note, whichever path delivered it.
      idempotencyKey: `khata:payment-status:${note.note_digest}`,
      correlationId: note.note_digest,
      origin: 'system',
      nowMs: askAtMs,
    },
    { workflow },
  );
  if (!result.ok) return { asked: false, reason: 'refused', detail: result.code };
  return { asked: true, pack: chosen.pack, taskId: result.taskId, mode: result.mode };
}

/**
 * A dispatch the owner just authored → the pack's filing rail (§5.D).
 *
 * Guarded like the payment hook: a fault here must never sink a delivery note
 * that is already signed, stored and sent. The caller supplies the facts it
 * already holds (the note, the buyer, the dispatch's value and the order's
 * credit days); this reads the two paper identities and stages ONE task per
 * note, so a re-issued route call answers with the task that already asked.
 */
export function askDeliveryFilingRail(args: {
  note: DeliveryNote;
  counterpartyDid: string;
  /** The dispatch priced against the bound quote, or null when unpriceable. */
  value: Money | null;
  /** The order's credit days, or null when the quote states no terms. */
  creditDays: number | null;
  askAtMs: number;
}): DeliveryFilingRailOutcome {
  try {
    return askDeliveryFilingRailUnguarded(args);
  } catch (err) {
    return { asked: false, reason: 'refused', detail: err instanceof Error ? err.constructor.name : typeof err };
  }
}

/** The net-day terms the USA pack's invoice capability admits (its own enum). */
const INVOICE_NET_DAYS = [0, 15, 30, 45, 60];

function askDeliveryFilingRailUnguarded(args: {
  note: DeliveryNote;
  counterpartyDid: string;
  value: Money | null;
  creditDays: number | null;
  askAtMs: number;
}): DeliveryFilingRailOutcome {
  const packs = activeCountryPacks();
  if (packs.length === 0) return { asked: false, reason: 'no_active_pack' };
  const workflow = getWorkflowService();
  if (workflow === null) return { asked: false, reason: 'no_workflow' };

  // The first pack that HAS a filing for a dispatch decides the market. A
  // trader holding both packs files where the pack the goods move in says.
  for (const candidate of packs) {
    const filing = filingFor(candidate.pack, args);
    if (filing === null) continue;
    if ('reason' in filing) return { asked: false, reason: filing.reason, detail: filing.detail };
    const result: InvokeToolCapabilityResult = invokeToolCapability(
      {
        installId: candidate.install.installId,
        capabilityId: filing.capabilityId,
        params: filing.params,
        paramCategories: filing.categories,
        // §11 — the two parties a filing names. Core reads their paper
        // identities itself; this hook states only who they are.
        subject: { contactDid: args.counterpartyDid, documentDigest: args.note.note_digest },
        // One filing per dispatch, whichever path authored it.
        idempotencyKey: `khata:delivery-filing:${args.note.note_digest}`,
        correlationId: args.note.note_digest,
        origin: 'system',
        nowMs: args.askAtMs,
      },
      { workflow },
    );
    if (!result.ok) return { asked: false, reason: 'refused', detail: result.code };
    return { asked: true, pack: candidate.pack, taskId: result.taskId, mode: result.mode };
  }
  return { asked: false, reason: 'pack_has_no_filing' };
}

/**
 * The filing a pack makes when goods are dispatched, and the params it takes —
 * or the reason the node cannot make it yet. `null` means this pack files
 * nothing for a dispatch, so the caller tries the next one.
 */
function filingFor(
  pack: CountryPack,
  args: { note: DeliveryNote; counterpartyDid: string; value: Money | null; creditDays: number | null },
):
  | { capabilityId: string; params: Record<string, unknown>; categories: string[] }
  | { reason: DeliveryFilingRefusal; detail?: string }
  | null {
  if (pack === 'in') {
    // An e-way bill names both parties by GSTIN and declares a value.
    const own = ownRegistration('gstin');
    if (own === null) return { reason: 'no_own_registration', detail: 'no GSTIN in your business settings' };
    const theirs = counterpartyRegistration(args.counterpartyDid, 'gstin');
    if (theirs === null) {
      return { reason: 'no_counterparty_registration', detail: 'no GSTIN on this buyer’s contact' };
    }
    if (args.value === null) return { reason: 'unpriceable', detail: 'the dispatch has no value from a bound quote' };
    return {
      capabilityId: `${COUNTRY_PACK_IDS.in}.eway-bill`,
      params: {
        delivery_note_digest: args.note.note_digest,
        consignor_gstin: own,
        consignee_gstin: theirs,
        value: args.value,
      },
      categories: ['business_registry', 'delivery', 'tax_filing'],
    };
  }
  if (pack === 'us') {
    // An invoice states the order's net terms and the delivered total.
    if (args.value === null) return { reason: 'unpriceable', detail: 'the dispatch has no value from a bound quote' };
    if (args.creditDays === null) {
      return { reason: 'terms_not_supported', detail: 'the bound quote states no payment terms' };
    }
    if (!INVOICE_NET_DAYS.includes(args.creditDays)) {
      return {
        reason: 'terms_not_supported',
        detail: `net ${String(args.creditDays)} is not one of the pack's terms (${INVOICE_NET_DAYS.join(', ')})`,
      };
    }
    return {
      capabilityId: `${COUNTRY_PACK_IDS.us}.invoice-terms`,
      params: {
        delivery_note_digest: args.note.note_digest,
        net_days: args.creditDays,
        total: args.value,
      },
      categories: ['delivery', 'invoice'],
    };
  }
  return null;
}

/**
 * The owner asks a counterparty for a payment that has matured (§5.D).
 *
 * OWNER-INITIATED (TRADE_FIRST §4.5): the caller is the owner's tap on an
 * overdue row, never a sweep. The message itself is the pack's — a template
 * name and the khata document it is about, never free text — so a runner
 * cannot be talked into saying something the owner did not approve.
 *
 * The channel comes from the counterparty's contact (the people graph's
 * identity slot); with none stated, nothing is asked and the owner is told
 * which is missing.
 */
export function askPaymentReminderRail(args: {
  counterpartyDid: string;
  /** The khata document the reminder is about — an order's digest. */
  subjectDigest: string;
  dueAt: string;
  amount: Money;
  askAtMs: number;
}): ReminderRailOutcome {
  try {
    return askPaymentReminderRailUnguarded(args);
  } catch (err) {
    return { asked: false, reason: 'refused', detail: err instanceof Error ? err.constructor.name : typeof err };
  }
}

function askPaymentReminderRailUnguarded(args: {
  counterpartyDid: string;
  subjectDigest: string;
  dueAt: string;
  amount: Money;
  askAtMs: number;
}): ReminderRailOutcome {
  const packs = activeCountryPacks();
  if (packs.length === 0) return { asked: false, reason: 'no_active_pack' };
  const workflow = getWorkflowService();
  if (workflow === null) return { asked: false, reason: 'no_workflow' };
  const channels = getContactChannels(args.counterpartyDid);

  for (const candidate of packs) {
    const reminder = reminderFor(candidate.pack, channels, args);
    if (reminder === null) continue;
    if ('reason' in reminder) return { asked: false, reason: reminder.reason, detail: reminder.detail };
    const result: InvokeToolCapabilityResult = invokeToolCapability(
      {
        installId: candidate.install.installId,
        capabilityId: reminder.capabilityId,
        params: reminder.params,
        paramCategories: ['contact', 'payment'],
        // §11 — who the reminder is for and which document it is about.
        subject: { contactDid: args.counterpartyDid, documentDigest: args.subjectDigest },
        // One reminder per due PER DAY: two taps on the same row are one
        // message, and next week's reminder is a new decision.
        idempotencyKey: `khata:reminder:${args.subjectDigest}:${args.dueAt}:${new Date(args.askAtMs)
          .toISOString()
          .slice(0, 10)}`,
        correlationId: args.subjectDigest,
        origin: 'api',
        nowMs: args.askAtMs,
      },
      { workflow },
    );
    if (!result.ok) return { asked: false, reason: 'refused', detail: result.code };
    return { asked: true, pack: candidate.pack, taskId: result.taskId, mode: result.mode };
  }
  return { asked: false, reason: 'pack_has_no_reminder' };
}

/** The reminder a pack sends, and on which channel — or why it cannot. */
function reminderFor(
  pack: CountryPack,
  channels: { phone: string | null; email: string | null },
  args: { subjectDigest: string; dueAt: string; amount: Money },
):
  | { capabilityId: string; params: Record<string, unknown> }
  | { reason: ReminderRefusal; detail?: string }
  | null {
  if (pack === 'in') {
    if (channels.phone === null) {
      return { reason: 'no_channel', detail: 'no phone on this counterparty’s contact' };
    }
    return {
      capabilityId: `${COUNTRY_PACK_IDS.in}.whatsapp-reminder`,
      params: {
        to: channels.phone,
        template: 'payment_due',
        subject_digest: args.subjectDigest,
        due_at: args.dueAt,
        amount: args.amount,
      },
    };
  }
  if (pack === 'us') {
    // SMS where there is a number, e-mail otherwise — the pack carries both.
    const channel = channels.phone !== null ? 'sms' : channels.email !== null ? 'email' : null;
    if (channel === null) {
      return { reason: 'no_channel', detail: 'no phone or e-mail on this counterparty’s contact' };
    }
    return {
      capabilityId: `${COUNTRY_PACK_IDS.us}.notice`,
      params: {
        to: channel === 'sms' ? channels.phone : channels.email,
        channel,
        template: 'payment_due',
        subject_digest: args.subjectDigest,
        due_at: args.dueAt,
        amount: args.amount,
      },
    };
  }
  return null;
}

/** This node's own registration for a scheme, from the business settings. */
function ownRegistration(scheme: TaxRegistrationScheme): string | null {
  const runtime = getCommerceRuntime();
  if (runtime === null) return null;
  const read = runtime.settings.readBusiness();
  if (!read.ok) return null;
  return registrationFor(read.settings.registrations, scheme);
}

/** A counterparty's registration for a scheme, from their contact row. */
function counterpartyRegistration(did: string, scheme: TaxRegistrationScheme): string | null {
  return registrationFor(getPaperIdentity(did).registrations, scheme);
}

// ── Reading the rail's answer back beside the khata document ────────────────

/** Where the rail check for a payment note stands, metadata-shaped for any surface. */
export type PaymentRailCheckState =
  /** The card is waiting for the owner (§15.5). */
  | 'awaiting_owner'
  /** Approved or grant-silenced; the runner has not answered yet. */
  | 'asked'
  /** The runner answered and the answer fit the pinned schema. */
  | 'answered'
  /** Denied, failed (a non-conforming answer included), expired, or outcome unknown. */
  | 'closed';

export type { PaymentRailAnswer } from './money_rehydrate';

export interface PaymentRailCheck {
  state: PaymentRailCheckState;
  /** Present only when `state` is `answered`; one of the schema's enum values, never text. */
  answer?: PaymentRailAnswer;
  /** The task a surface may open for the full record. */
  taskId: string;
}

/**
 * The rail check raised for a payment note, if any: the invocation task is
 * correlated to the note's digest (`askPaymentStatusRail`). Metadata only —
 * a state name and a schema-enum answer — so it can ride the khata inbox,
 * which never carries line contents (a staff grant may see it). The result
 * is read from the task the runner completed; the `/complete` route already
 * validated it against the pinned schema, and anything that still is not one
 * of the four values reads as `unknown`.
 */
export function paymentRailCheck(noteDigest: string): PaymentRailCheck | null {
  const workflow = getWorkflowService();
  if (workflow === null) return null;
  // Only the STATUS rails answer this question; a later hook correlated to the
  // same note (a filing, a reminder) is a different check and must not be
  // read as the payment's. Newest first: a re-ask after a denial supersedes.
  const statusRails = new Set<string>([
    `${COUNTRY_PACK_IDS.in}.upi-payment-status`,
    `${COUNTRY_PACK_IDS.us}.settlement-status`,
  ]);
  const tasks = workflow
    .store()
    .getByCorrelationId(noteDigest)
    .filter((task) => {
      if (!isPluginInvocationTask(task)) return false;
      const capability = rehydrateInvocationCapabilityId(task.payload);
      return capability !== null && statusRails.has(capability);
    })
    .sort((a, b) => b.created_at - a.created_at);
  const task = tasks[0];
  if (task === undefined) return null;
  switch (task.status) {
    case 'pending_approval':
      return { state: 'awaiting_owner', taskId: task.id };
    case 'queued':
    case 'running':
      return { state: 'asked', taskId: task.id };
    case 'completed':
      return { state: 'answered', answer: rehydratePaymentRailAnswer(task.result), taskId: task.id };
    default:
      return { state: 'closed', taskId: task.id };
  }
}
