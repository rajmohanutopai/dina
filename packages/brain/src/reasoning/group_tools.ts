/**
 * `coordinate_group` — the ONE tool that touches N contacts
 * (docs/GROUP_COORDINATION_ARCHITECTURE.md §11, §16 rule 10).
 *
 * "Plan Emma's birthday with the Garcias, the Millers and the Johnsons" is
 * one question asked of three households. `query_service` is terminal and
 * refuses a second dispatch of the same capability in a turn, for good
 * reason; a group plan needs the opposite, N identical asks that are one
 * question. So the model hands the guest list and the candidates to Core in
 * one call, and Core fans out, bounds, collapses each spoke's failure and
 * folds. The model never sees a per-guest dispatch: it cannot fan out
 * selectively, retry one family five times, or narrate who answered first.
 *
 * Names become contacts HERE, in routing, not in the vault: a guest is named
 * as the owner names them ("the Millers", "Miller") and matched against the
 * contact directory's display names and aliases. One match is the guest; two
 * is a question back to the owner; none is a refusal that names the name.
 * Fire-and-forget and turn-ending: the replies land on the plan card.
 */

import type { AgentTool } from './tool_registry';
import type { Contact, CoreClient, GroupPlanWire } from '@dina/core';

export type CoordinateGroupCoreClient = Pick<CoreClient, 'openGroupPlan' | 'listContacts'>;

export interface CoordinateGroupToolOptions {
  core: CoordinateGroupCoreClient;
  /** Metadata only: counts and the plan id, never a guest, an intent or a slot. */
  logger?: (entry: Record<string, unknown>) => void;
}

export interface CoordinateGroupOutcome {
  status: 'pending';
  plan_id: string;
  intent: string;
  guests: { contact_did: string; display_name: string; required: boolean }[];
  candidates: GroupPlanWire['candidates'];
  window_closes_at: number | null;
  note: string;
}

/** The comparable form of a name: case-folded, trimmed, the leading article dropped. */
export function nameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ');
}

export type GuestMatch =
  | { kind: 'one'; contact: Contact }
  | { kind: 'many'; names: string[] }
  | { kind: 'none' };

/**
 * A guest as the owner named them, against the contacts. A DID is taken as
 * is. An exact match on a display name or alias wins; otherwise a name that
 * is contained in, or contains, a display name matches — "Millers" finds
 * "The Millers" — and two such matches are an ambiguity, never a guess.
 */
export function matchGuest(name: string, contacts: readonly Contact[]): GuestMatch {
  const trimmed = name.trim();
  if (trimmed.startsWith('did:')) {
    const byDid = contacts.find((c) => c.did === trimmed);
    return byDid === undefined ? { kind: 'none' } : { kind: 'one', contact: byDid };
  }
  const key = nameKey(trimmed);
  if (key === '') return { kind: 'none' };
  const exact = contacts.filter(
    (c) => nameKey(c.displayName) === key || (c.aliases ?? []).some((a) => nameKey(a) === key),
  );
  if (exact.length === 1) return { kind: 'one', contact: exact[0] };
  if (exact.length > 1) return { kind: 'many', names: exact.map((c) => c.displayName) };
  const loose = contacts.filter((c) => {
    const display = nameKey(c.displayName);
    return display.includes(key) || key.includes(display);
  });
  if (loose.length === 1) return { kind: 'one', contact: loose[0] };
  if (loose.length > 1) return { kind: 'many', names: loose.map((c) => c.displayName) };
  return { kind: 'none' };
}

function readSlots(raw: unknown): { start: string; end?: string; note?: string }[] {
  if (!Array.isArray(raw)) throw new Error('coordinate_group: candidate_slots must be an array');
  return raw.map((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`coordinate_group: candidate_slots[${i}] must be an object with a start`);
    }
    const slot = s as { start?: unknown; end?: unknown; note?: unknown };
    if (typeof slot.start !== 'string' || slot.start.trim() === '') {
      throw new Error(`coordinate_group: candidate_slots[${i}].start is required`);
    }
    return {
      start: slot.start,
      ...(typeof slot.end === 'string' ? { end: slot.end } : {}),
      ...(typeof slot.note === 'string' ? { note: slot.note } : {}),
    };
  });
}

export function createCoordinateGroupTool(options: CoordinateGroupToolOptions): AgentTool {
  // One plan per request: a second call would open a second plan for the same
  // question. Terminal ends the turn on success; this refuses a repeat when a
  // refusal was relayed and the model tries again with the same guests.
  let opened = false;
  return {
    name: 'coordinate_group',
    terminal: true,
    description:
      "Find a time that works for several of the user's contacts at once — \"plan X with A, B and C\". Name each guest as the user did (a family or a person from their contacts) and say whether they are required; give the concrete candidate slots (dates or times in words, e.g. \"Sat 26 Sep afternoon\") you derived from what the user said. Core asks every guest the same question privately, waits one shared window, and folds the answers; nobody sees anyone else's reply. Fire-and-forget and turn-ending: say in one line what you are asking BEFORE calling this; the replies land on a plan card in the chat, not here. Use once per request, never `query_service` for a guest. Ask the user when a name matches more than one contact.",
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: "What the plan is, in the user's words (e.g. \"Emma's 8th birthday, a Saturday this month\").",
        },
        guests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The contact as the user named them, or their DID.' },
              required: {
                type: 'boolean',
                description: 'True when the plan needs this guest (default); false for a guest who would be nice to have.',
              },
            },
            required: ['name'],
          },
          description: 'Up to 8 guests. At least one must be required.',
        },
        candidate_slots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              start: { type: 'string' },
              end: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['start'],
          },
          description: 'Up to 12 candidate slots in the order the user prefers them.',
        },
        window_seconds: {
          type: 'number',
          description: 'How long to wait for replies (1–300). Omit for the default.',
        },
      },
      required: ['intent', 'guests', 'candidate_slots'],
    },
    async execute(args): Promise<CoordinateGroupOutcome> {
      if (opened) {
        throw new Error('coordinate_group: a plan was already opened this request. Wait for its card; a new plan is a new request.');
      }
      const intent = typeof args.intent === 'string' ? args.intent.trim() : '';
      if (intent === '') throw new Error('coordinate_group: intent is required');
      if (!Array.isArray(args.guests) || args.guests.length === 0) {
        throw new Error('coordinate_group: guests must be a non-empty array');
      }
      const candidates = readSlots(args.candidate_slots);
      const contacts = await options.core.listContacts();
      const guests: { contactDid: string; required: boolean; displayName: string }[] = [];
      const unknown: string[] = [];
      const ambiguous: string[] = [];
      for (const raw of args.guests) {
        const g = raw as { name?: unknown; required?: unknown };
        const name = typeof g?.name === 'string' ? g.name : '';
        if (name.trim() === '') throw new Error('coordinate_group: every guest needs a name');
        const match = matchGuest(name, contacts);
        if (match.kind === 'none') {
          unknown.push(name);
        } else if (match.kind === 'many') {
          ambiguous.push(`${name} (${match.names.join(', ')})`);
        } else if (!guests.some((x) => x.contactDid === match.contact.did)) {
          guests.push({
            contactDid: match.contact.did,
            required: g.required !== false,
            displayName: match.contact.displayName,
          });
        }
      }
      if (unknown.length > 0 || ambiguous.length > 0) {
        const parts: string[] = [];
        if (unknown.length > 0) parts.push(`not in the user's contacts: ${unknown.join(', ')}`);
        if (ambiguous.length > 0) parts.push(`more than one contact matches: ${ambiguous.join('; ')}`);
        throw new Error(`coordinate_group: ${parts.join('. ')}. Ask the user which contact they mean; do not guess.`);
      }
      const result = await options.core.openGroupPlan({
        intent,
        guests: guests.map((g) => ({ contactDid: g.contactDid, required: g.required })),
        candidates,
        ...(typeof args.window_seconds === 'number' ? { windowSeconds: args.window_seconds } : {}),
      });
      options.logger?.({
        event: 'group_plan_requested',
        guests: guests.length,
        candidates: candidates.length,
        outcome: result.ok ? 'opened' : `refused:${result.refusal}`,
      });
      if (!result.ok) {
        if (result.refusal === 'response_malformed') {
          opened = true;
          return {
            status: 'pending',
            plan_id: '',
            intent,
            guests: guests.map((g) => ({ contact_did: g.contactDid, display_name: g.displayName, required: g.required })),
            candidates,
            window_closes_at: null,
            note: 'Dina opened the plan, but the reply could not be read. Do not ask again; the plan is in Activity.',
          };
        }
        // A refusal is an error, not a value: it names the bound or the guest,
        // and the model relays it instead of ending the turn with nothing said.
        throw new Error(
          `coordinate_group refused (${result.refusal})${result.detail !== undefined ? `: ${result.detail}` : ''}`,
        );
      }
      opened = true;
      const plan = result.plan;
      const names = new Map(guests.map((g) => [g.contactDid, g.displayName]));
      return {
        status: 'pending',
        plan_id: plan.plan_id,
        intent: plan.intent,
        guests: plan.guests.map((g) => ({
          contact_did: g.contact_did,
          display_name: names.get(g.contact_did) ?? g.contact_did,
          required: g.required,
        })),
        candidates: plan.candidates,
        window_closes_at: plan.window_closes_at,
        note: `Asked ${plan.guests.length} ${plan.guests.length === 1 ? 'household' : 'households'} privately. Their answers will fold onto the plan card in this chat; nobody sees anyone else's reply.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The hand-off (§10): what a settled plan yields to the vendor lane
// ---------------------------------------------------------------------------

export type GroupPlanHandoffCoreClient = Pick<CoreClient, 'getGroupPlan' | 'listGroupPlanHandles'>;

export interface GroupPlanHandoffToolOptions {
  core: GroupPlanHandoffCoreClient;
  logger?: (entry: Record<string, unknown>) => void;
}

/**
 * What leaves the plan for a vendor: the slot and the de-identified
 * requirements. No household, no name, no line of text a guest wrote.
 */
export interface GroupPlanHandoff {
  plan_id: string;
  state: GroupPlanWire['state'];
  intent: string;
  /** The slot every required household confirmed; null until the plan settled. */
  chosen: GroupPlanWire['chosen'];
  /** Kinds, counts and needs (§6 point 4): `{ kind: 'dietary', count: 1, needs: ['gluten-free'] }`. */
  requirements: GroupPlanWire['requirements'];
  /** True once a slot is chosen — the moment a venue or a bakery can be asked. */
  ready: boolean;
  note: string;
}

/** What the tool answers when it cannot name ONE plan: the handles, for the model to pick from. */
export interface GroupPlanChoice {
  status: 'choose_plan';
  plans: { plan_id: string; intent: string; state: GroupPlanWire['state']; chosen: GroupPlanWire['chosen'] }[];
  note: string;
}

/**
 * `group_plan_handoff` — the bridge from a plan to `search_provider_services`
 * → `query_service`. It hands the model the two things the vendor lane
 * consumes and nothing else: `requirements` leave de-identified (§16 rule 7),
 * and the guests, their replies and their disclosures never pass through
 * this tool at all.
 */
export function createGroupPlanHandoffTool(options: GroupPlanHandoffToolOptions): AgentTool {
  return {
    name: 'group_plan_handoff',
    description:
      "What a group plan Dina coordinated yields — whether a time is settled, the chosen slot, and the de-identified requirements: kinds, counts and needs (e.g. dietary ×1: gluten-free). Use it whenever the user asks about a plan with several contacts (\"is a time settled with X and Y?\", \"book the bakery for the party\"): pass `chosen` as the time and turn each requirement into a portion or a provision for the provider (\"one gluten-free portion\"). It never returns who is coming, and you must never tell a provider whose need it is or that it came from a guest. Call it WITHOUT plan_id when you do not have one — it lists the recent plans (id, intent, state) so you can pick, or picks for you when only one fits. `ready` is false until a slot is chosen — then say so and stop.",
    parameters: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The plan id from the plan card or from coordinate_group. Omit to list the recent plans and pick.',
        },
      },
      required: [],
    },
    async execute(args): Promise<GroupPlanHandoff | GroupPlanChoice> {
      let planId = typeof args.plan_id === 'string' ? args.plan_id.trim() : '';
      if (planId === '') {
        // No id in hand: the recent plans as handles — id, intent, state and
        // chosen slot, nothing about the households. One plan in a state a
        // booking can follow is picked; several are handed back to choose from.
        const handles = await options.core.listGroupPlanHandles();
        options.logger?.({ event: 'group_plan_handles_listed', count: handles.length });
        if (handles.length === 0) {
          throw new Error('group_plan_handoff: Dina has coordinated no plan yet. Offer to plan one with coordinate_group.');
        }
        const bookable = handles.filter((h) => h.state === 'settled' || h.state === 'confirming');
        if (handles.length === 1) {
          planId = handles[0].plan_id;
        } else if (bookable.length === 1) {
          planId = bookable[0].plan_id;
        } else {
          return {
            status: 'choose_plan',
            plans: handles.map((h) => ({ plan_id: h.plan_id, intent: h.intent, state: h.state, chosen: h.chosen })),
            note: 'More than one plan could be meant. Pick the one the user means by its intent and call again with its plan_id; ask the user if it is not clear.',
          };
        }
      }
      const plan = await options.core.getGroupPlan(planId);
      if (plan === null) throw new Error(`group_plan_handoff: no plan ${planId}`);
      const ready = plan.chosen !== null && (plan.state === 'settled' || plan.state === 'confirming');
      options.logger?.({
        event: 'group_plan_handoff',
        state: plan.state,
        ready,
        requirements: plan.requirements.length,
      });
      return {
        plan_id: plan.plan_id,
        state: plan.state,
        intent: plan.intent,
        chosen: plan.chosen,
        requirements: plan.requirements,
        ready,
        note: ready
          ? plan.state === 'settled'
            ? 'Every required guest confirmed this slot. Book against it; phrase each need as a portion or provision, never as whose it is.'
            : 'The slot is chosen and being confirmed with the guests; a booking now is on the organizer’s say.'
          : plan.state === 'abandoned'
            ? 'The organizer stopped this plan; there is nothing to book.'
            : 'No slot is chosen yet; the plan card is where the organizer picks one.',
      };
    },
  };
}
