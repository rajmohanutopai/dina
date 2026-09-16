/**
 * THE FOLD (docs/GROUP_COORDINATION_ARCHITECTURE.md §4) — the one piece of
 * group coordination that touches every guest's answer at once, so the one
 * piece that is code and not a model.
 *
 * A group plan is a star: the organizer's Dina asks each guest the built 1:1
 * `availability_coordination` question and folds the replies on its own
 * node. The fold is a deterministic intersection over the organizer's OWN
 * candidates. Three rules give it its shape, and each is a test:
 *
 *   ACCEPTANCE IS ECHOING A CANDIDATE. A guest accepts a slot by returning it
 *   as the organizer proposed it. A slot the organizer never proposed is a
 *   counter, whatever status the guest put on it — the organizer controls the
 *   vocabulary, so the fold never has to decide whether "Sat 26" and
 *   "Saturday the 26th" are the same day. They are compared by a canonical
 *   key (`slotKey`), and a guest's own wording is theirs to keep.
 *
 *   A NON-ANSWER IS NEVER A NO. A required guest who has not answered leaves
 *   the fold `waiting`; the intersection over the guests who DID answer is
 *   reported as provisional, and nobody's silence narrows it. An empty
 *   intersection names, as the guests who emptied it, only guests who
 *   answered.
 *
 *   ORDER-INDEPENDENT. The same replies in any order give the same fold. The
 *   output follows the organizer's candidate order and the plan's guest
 *   order, never arrival order — a fold that depended on who replied first
 *   would give different answers on different days.
 *
 * Bounds are refused at the plan (`group_plan.ts`), so this module can assume
 * a plan it is handed is one the bounds already admitted.
 */

/** A proposed meeting slot — the shape `availability_coordination` already uses. */
export interface MeetingSlot {
  start: string;
  end?: string;
  note?: string;
}

/**
 * One guest's reply, as the 1:1 capability's result schema defines it
 * (`AvailabilityCoordinationResultSchema`). Only `status` is required there,
 * and the same is true here: an `accepted` with no slots is an honest reply
 * that accepts nothing.
 */
export type SpokeReply =
  | { status: 'accepted'; accepted_slots?: MeetingSlot[]; message?: string }
  | { status: 'counter'; counter_slots?: MeetingSlot[]; message?: string }
  | { status: 'needs_more_info'; message?: string };

/** What the fold knows about one guest. `reply: null` means no answer — yet, or ever. */
export interface FoldGuest {
  contactDid: string;
  required: boolean;
  reply: SpokeReply | null;
}

export type FoldState =
  /** At least one required guest has not answered. `agreed` is provisional. */
  | 'waiting'
  /** Every required guest answered and at least one candidate suits them all. */
  | 'converged'
  /** Every required guest answered and no candidate suits them all. */
  | 'empty';

export interface FoldResult {
  state: FoldState;
  /** The organizer's candidates every answered REQUIRED guest accepted, in candidate order. */
  agreed: MeetingSlot[];
  /** Required guests with no answer, in plan order. */
  missingRequired: string[];
  /**
   * When `state` is `empty`: the answered required guests whose acceptance
   * has nothing in common with what the OTHER answered required guests agree
   * on. Empty when the others agree on nothing either — then no one guest
   * emptied it, and the fold says so by naming nobody rather than everybody.
   */
  emptiedBy: string[];
  /** Per answered OPTIONAL guest: which of `agreed` they accepted, in candidate order. */
  optionalFit: Record<string, MeetingSlot[]>;
  /**
   * Slots guests proposed that the organizer did not: `counter_slots`, plus
   * any "accepted" slot outside the candidate list, which is a counter in
   * fact whatever it was called. Per guest, in the guest's order, keyed
   * deduplicated.
   */
  counters: Record<string, MeetingSlot[]>;
  /** Guests who answered `needs_more_info`, in plan order. */
  needsMoreInfo: string[];
}

/**
 * The canonical key two slots are compared by: `start`, trimmed, whitespace
 * collapsed, case-folded. `end` and `note` are the guest's own commentary and
 * never decide identity — a guest who echoes "Sat 26" with a note about
 * parking has accepted Sat 26.
 */
export function slotKey(slot: MeetingSlot): string {
  return slot.start.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A well-formed slot: an object whose `start` is a non-empty string, `end`/`note` strings when present. */
export function isMeetingSlot(value: unknown): value is MeetingSlot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.start !== 'string' || s.start.trim() === '') return false;
  if (s.end !== undefined && typeof s.end !== 'string') return false;
  if (s.note !== undefined && typeof s.note !== 'string') return false;
  return true;
}

/** Deduplicate by key, keeping first occurrence and its wording. */
function uniqueByKey(slots: readonly MeetingSlot[]): MeetingSlot[] {
  const seen = new Set<string>();
  const out: MeetingSlot[] = [];
  for (const slot of slots) {
    const key = slotKey(slot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out;
}

/** Split a guest's slots into candidates they echoed and proposals of their own. */
function partition(
  slots: readonly MeetingSlot[] | undefined,
  candidateKeys: ReadonlySet<string>,
): { echoed: Set<string>; own: MeetingSlot[] } {
  const echoed = new Set<string>();
  const own: MeetingSlot[] = [];
  for (const slot of uniqueByKey(slots ?? [])) {
    const key = slotKey(slot);
    if (candidateKeys.has(key)) echoed.add(key);
    else own.push(slot);
  }
  return { echoed, own };
}

/**
 * Fold one round of replies over the organizer's candidates.
 *
 * `candidates` is the organizer's list for THIS round, in the order the
 * organizer prefers — that order is the only preference the fold carries.
 * `guests` is the plan's guest list, in plan order, with whatever each has
 * answered so far.
 */
export function foldGroupPlan(args: {
  candidates: readonly MeetingSlot[];
  guests: readonly FoldGuest[];
}): FoldResult {
  const candidates = uniqueByKey(args.candidates);
  const candidateKeys = new Set(candidates.map(slotKey));
  const inCandidateOrder = (keys: ReadonlySet<string>): MeetingSlot[] =>
    candidates.filter((slot) => keys.has(slotKey(slot)));

  const missingRequired: string[] = [];
  const needsMoreInfo: string[] = [];
  const counters: Record<string, MeetingSlot[]> = {};
  const optionalFit: Record<string, MeetingSlot[]> = {};
  /** Per answered required guest, the candidate keys they echoed. */
  const requiredAccepted: { contactDid: string; keys: Set<string> }[] = [];
  /** Per answered optional guest, the same. */
  const optionalAccepted: { contactDid: string; keys: Set<string> }[] = [];

  for (const guest of args.guests) {
    if (guest.reply === null) {
      if (guest.required) missingRequired.push(guest.contactDid);
      continue;
    }
    const reply = guest.reply;
    if (reply.status === 'needs_more_info') {
      needsMoreInfo.push(guest.contactDid);
      // A guest asking for more says nothing about the candidates; for the
      // intersection they count as having accepted none, which is what
      // "I cannot say yet" means for a plan that needs a yes.
      (guest.required ? requiredAccepted : optionalAccepted).push({
        contactDid: guest.contactDid,
        keys: new Set(),
      });
      continue;
    }
    const slots = reply.status === 'accepted' ? reply.accepted_slots : reply.counter_slots;
    const { echoed, own } = partition(slots, candidateKeys);
    // A counter reply's echoed slots are still counters in spirit — the guest
    // did not say yes — so only an `accepted` reply's echoes count as
    // acceptance. Its non-candidate slots are the guest's own proposals.
    const accepted = reply.status === 'accepted' ? echoed : new Set<string>();
    const proposals = reply.status === 'accepted' ? own : [...inCandidateOrder(echoed), ...own];
    if (proposals.length > 0) counters[guest.contactDid] = uniqueByKey(proposals);
    (guest.required ? requiredAccepted : optionalAccepted).push({
      contactDid: guest.contactDid,
      keys: accepted,
    });
  }

  // The intersection over answered required guests, in candidate order.
  const agreedKeys = new Set(candidateKeys);
  for (const { keys } of requiredAccepted) {
    for (const key of [...agreedKeys]) if (!keys.has(key)) agreedKeys.delete(key);
  }
  // With no required guest answered yet, nothing has been agreed by anyone:
  // an intersection over an empty set would otherwise be "everything".
  if (requiredAccepted.length === 0) agreedKeys.clear();
  const agreed = inCandidateOrder(agreedKeys);

  for (const { contactDid, keys } of optionalAccepted) {
    optionalFit[contactDid] = agreed.filter((slot) => keys.has(slotKey(slot)));
  }

  let state: FoldState;
  const emptiedBy: string[] = [];
  if (missingRequired.length > 0) {
    state = 'waiting';
  } else if (agreed.length > 0) {
    state = 'converged';
  } else {
    state = 'empty';
    // Who emptied it: a guest whose acceptance shares nothing with what the
    // OTHERS agree on — only meaningful when the others agree on something.
    for (const guest of requiredAccepted) {
      // A guest who asked for more information has not said no to anything;
      // they are listed under `needsMoreInfo`, never as the one who emptied
      // it — the organizer's next move for them is an answer, not a widen.
      if (needsMoreInfo.includes(guest.contactDid)) continue;
      const others = requiredAccepted.filter((g) => g.contactDid !== guest.contactDid);
      if (others.length === 0) {
        // A lone required guest who accepted nothing emptied it alone.
        if (guest.keys.size === 0) emptiedBy.push(guest.contactDid);
        continue;
      }
      const othersAgree = new Set(candidateKeys);
      for (const { keys } of others) {
        for (const key of [...othersAgree]) if (!keys.has(key)) othersAgree.delete(key);
      }
      if (othersAgree.size === 0) continue;
      let shares = false;
      for (const key of othersAgree) if (guest.keys.has(key)) shares = true;
      if (!shares) emptiedBy.push(guest.contactDid);
    }
  }

  return { state, agreed, missingRequired, emptiedBy, optionalFit, counters, needsMoreInfo };
}
