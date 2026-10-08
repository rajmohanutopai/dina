/**
 * Messaging a contact from the owner's chat (REAL_LIFE_FIXES §7).
 *
 * "Tell Sancho I'm running late" sends a message to Sancho's Dina. The send
 * binds to what the owner said in this turn, so text from a contact's
 * message, a service reply or a web page in the conversation can never make
 * Dina message someone:
 *
 *   - Brain presents a span proof over the owner's turn (§0.1 A); Core
 *     re-hashes the turn and reads the instruction from it with a fixed
 *     form ("tell / message / text <recipient> <payload>", "let <recipient>
 *     know <payload>", "send <recipient> <payload>"). No model decides.
 *   - It is sent at once only when that instruction names one recipient who
 *     resolves to the chosen contact, the model's text uses only the owner's
 *     words, and no other send has used this turn. What is sent is then the
 *     owner's payload itself, exactly — never the model's version of it.
 *   - Anything else (a reworded draft, a recipient the owner did not name,
 *     a second send in a turn) becomes a confirm card that holds the exact
 *     recipient and text; approving it sends exactly those.
 *
 * Sending is contact-only (dina_details.md 3.5), through the normal D2D
 * egress gates, as the Talk thread's `coordination.request {text}`.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { drawsOnlyFrom, parseSendInstruction, verifySpanProof, type SpanProof } from '../a2a/span_proof';
import { getContact, listContacts, type Contact } from '../contacts/directory';
import { normalizeAlias } from '../contacts/validation';
import { getD2DSender } from '../server/routes/d2d_msg';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

export const OWNER_TALK_SEND_APPROVAL_TYPE = 'owner_talk_send';
const TALK_FAMILY = 'coordination.request';
const CONFIRM_TTL_SEC = 30 * 60;

export type OwnerSendResult =
  | { status: 'sent'; recipient_did: string; recipient_name: string; text: string }
  | { status: 'confirm_pending'; task_id: string; recipient_did: string; recipient_name: string; text: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_a_contact' }
  | { status: 'no_owner_turn'; reason: string }
  | { status: 'failed'; reason: string };

/** Resolve a name, alias or DID to exactly one contact. */
export function resolveContactRef(
  ref: string,
): { kind: 'one'; contact: Contact } | { kind: 'ambiguous'; names: string[] } | { kind: 'none' } {
  const r = ref.trim();
  if (r === '') return { kind: 'none' };
  if (r.startsWith('did:')) {
    const c = getContact(r);
    return c !== null ? { kind: 'one', contact: c } : { kind: 'none' };
  }
  const want = normalizeAlias(r).split(' ').filter((t) => t !== '');
  if (want.length === 0) return { kind: 'none' };
  const matches = listContacts().filter((c) => {
    const forms = [c.displayName, ...(c.aliases ?? [])];
    return forms.some((f) => {
      const tokens = new Set(normalizeAlias(f).split(' ').filter((t) => t !== ''));
      // "Sancho" finds "Sancho Panza"; "Sancho Panza" finds "Sancho Panza".
      return want.every((t) => tokens.has(t));
    });
  });
  if (matches.length === 1) return { kind: 'one', contact: matches[0]! };
  if (matches.length > 1) return { kind: 'ambiguous', names: matches.map((c) => c.displayName) };
  return { kind: 'none' };
}

async function sendNow(contact: Contact, text: string): Promise<OwnerSendResult> {
  const sender = getD2DSender();
  if (sender === null) return { status: 'failed', reason: 'messaging is not connected' };
  try {
    await sender(contact.did, TALK_FAMILY, { text });
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : 'send failed' };
  }
  return { status: 'sent', recipient_did: contact.did, recipient_name: contact.displayName, text };
}

function confirmCard(contact: Contact, text: string): OwnerSendResult {
  const service = getWorkflowService();
  if (service === null) return { status: 'failed', reason: 'approvals are not available' };
  const id = `talk-${bytesToHex(randomBytes(8))}`;
  service.create({
    id,
    kind: WorkflowTaskKind.Approval,
    description: `Send to ${contact.displayName}: "${text.slice(0, 200)}"`,
    payload: JSON.stringify({
      type: OWNER_TALK_SEND_APPROVAL_TYPE,
      recipient_did: contact.did,
      recipient_name: contact.displayName,
      text,
    }),
    expiresAtSec: Math.floor(Date.now() / 1000) + CONFIRM_TTL_SEC,
    origin: 'system',
    initialState: WorkflowTaskState.PendingApproval,
  });
  return {
    status: 'confirm_pending',
    task_id: id,
    recipient_did: contact.did,
    recipient_name: contact.displayName,
    text,
  };
}

/** The owner asked to message a contact from chat. */
export async function ownerSendToContact(input: {
  proof: SpanProof;
  contact: string;
  proposedText: string;
}): Promise<OwnerSendResult> {
  const text = input.proposedText.trim();
  if (text === '' || text.length > 4_000) return { status: 'failed', reason: 'message text is required' };
  const chosen = resolveContactRef(input.contact);
  if (chosen.kind === 'ambiguous') return { status: 'ambiguous', candidates: chosen.names };
  if (chosen.kind === 'none') return { status: 'not_a_contact' };

  const checked = verifySpanProof(input.proof, 'send');
  if (!checked.ok) {
    // A second send in the same turn is still the owner's turn: ask first.
    if (checked.reason === 'already_used') return confirmCard(chosen.contact, text);
    return { status: 'no_owner_turn', reason: checked.reason };
  }

  const instruction = parseSendInstruction(checked.turnText);
  const named = instruction !== null ? resolveContactRef(instruction.recipient) : null;
  const direct =
    instruction !== null &&
    named !== null &&
    named.kind === 'one' &&
    named.contact.did === chosen.contact.did &&
    drawsOnlyFrom(text, instruction.payload);
  return direct ? sendNow(chosen.contact, instruction.payload) : confirmCard(chosen.contact, text);
}

/** Read a confirm card's frozen payload, or null when it is not one. */
export function parseOwnerTalkSendPayload(
  raw: string,
): { recipient_did: string; recipient_name: string; text: string } | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p.type !== OWNER_TALK_SEND_APPROVAL_TYPE) return null;
    if (typeof p.recipient_did !== 'string' || typeof p.text !== 'string' || p.text === '') return null;
    return {
      recipient_did: p.recipient_did,
      recipient_name: typeof p.recipient_name === 'string' ? p.recipient_name : '',
      text: p.text,
    };
  } catch {
    return null;
  }
}

/** True for a pending owner-talk confirm card. */
export function isOwnerTalkSendApproval(task: WorkflowTask | null): boolean {
  return (
    task !== null &&
    task.kind === WorkflowTaskKind.Approval &&
    parseOwnerTalkSendPayload(task.payload) !== null
  );
}

/** Send exactly what an approved confirm card holds. */
export async function sendApprovedOwnerTalk(task: WorkflowTask): Promise<OwnerSendResult> {
  const p = parseOwnerTalkSendPayload(task.payload);
  if (p === null) return { status: 'failed', reason: 'not a confirm card' };
  const contact = getContact(p.recipient_did);
  if (contact === null) return { status: 'not_a_contact' };
  return sendNow(contact, p.text);
}
