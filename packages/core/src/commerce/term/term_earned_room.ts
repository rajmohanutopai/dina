/**
 * Earned room for the store's shelf floors (COMMITMENT_KERNEL §10 "Earned
 * room", §15 step 13). The kernel counts; this file says what a limit is for
 * shelf space: one automatic floor per resource and term, kept in the term
 * policy, with the floor card (`term_floor_approval`) between it and the hard
 * floor.
 *
 * Figures are compared in the policy's own terms, before any holding premium:
 * a card asked while a premium applied counts at the largest policy figure
 * whose premium-raised value does not pass the figure the owner said yes to.
 */

import {
  termValues,
  TERM_NAMES,
  type TermName,
  TermAgreementProposal,
} from '@dina/commerce-protocol';

import {
  insideEarnedRoom,
  limitStamp,
  narrowRoom,
  recordLimitCard,
  type LimitAnswer,
  type LimitPort,
} from '../../commitment/earned_room';
import { formatMoney } from '../money_display';

import { SHELF_HOST_KIND } from './term_model';
import { applyHoldingPremium, type TermPolicy, type TermResourcePolicy } from './term_policy';
import { readTermFloorRecord } from './term_rehydrate';

export function shelfLimitKey(resourceRef: string, term: TermName): string {
  return `${resourceRef}|${term}`;
}

function splitKey(key: string): { resourceRef: string; term: TermName } | null {
  const at = key.lastIndexOf('|');
  if (at <= 0) return null;
  const term = key.slice(at + 1);
  if (!(TERM_NAMES as readonly string[]).includes(term)) return null;
  return { resourceRef: key.slice(0, at), term: term as TermName };
}

/**
 * The policy figure behind a value offered under a holding premium: the
 * largest figure whose premium-raised value is at most `value`. Without a
 * premium it is the value itself.
 */
export function floorBase(name: TermName, value: bigint, held: number, premiumBps: number): bigint {
  if (value <= 0n || held <= 0 || premiumBps <= 0) return value < 0n ? 0n : value;
  let low = 0n;
  let high = value;
  while (low < high) {
    const mid = (low + high + 1n) / 2n;
    if (applyHoldingPremium(name, mid, held, premiumBps) <= value) low = mid;
    else high = mid - 1n;
  }
  return low;
}

const TERM_WORDS: Record<TermName, string> = { fee: 'rent', share_bps: 'share of sales' };

/** The store's floors as the kernel reads and writes them. */
export function shelfLimitPort(engine: {
  policy(): TermPolicy;
  writeEarnedAutoFloor(resourceRef: string, term: TermName, value: bigint): boolean;
}): LimitPort {
  const floorOf = (key: string) => {
    const at = splitKey(key);
    if (at === null) return null;
    const resource = engine.policy().resources.find((r) => r.resource_ref === at.resourceRef);
    const floor = resource?.floors[at.term];
    if (resource === undefined || floor === undefined) return null;
    return { at, resource, floor };
  };
  return {
    kind: SHELF_HOST_KIND,
    read(key) {
      const found = floorOf(key);
      if (found === null) return null;
      return {
        hard: BigInt(found.floor.hard),
        auto: BigInt(found.floor.auto ?? found.floor.hard),
        basis: shelfBasis(found.resource, found.at.term),
      };
    },
    writeAuto(key, value) {
      const at = splitKey(key);
      return at !== null && engine.writeEarnedAutoFloor(at.resourceRef, at.term, value);
    },
    describe(key) {
      const at = splitKey(key);
      return at === null ? 'offers' : `offers on the ${TERM_WORDS[at.term]} for ${at.resourceRef}`;
    },
    format(key, value) {
      const found = floorOf(key);
      if (found === null) return value.toString(10);
      if (found.at.term === 'share_bps') {
        const whole = value / 100n;
        const part = value % 100n;
        return part === 0n
          ? `${whole.toString(10)}%`
          : `${whole.toString(10)}.${part.toString(10).padStart(2, '0')}%`;
      }
      try {
        return formatMoney({ currency: found.resource.currency, minor_units: value.toString(10) });
      } catch {
        return value.toString(10);
      }
    },
  };
}

/** A floor's figures and currency together: a record counts only while they stand. */
export function shelfBasis(resource: TermResourcePolicy, term: TermName): string {
  const floor = resource.floors[term];
  return `${floor.hard}|${floor.auto ?? floor.hard}|${resource.currency}`;
}

/**
 * What a floor card adds for the record: each asked term's policy figure, and
 * the generation of its limit when asked (`limitStamp`).
 */
export function floorCardRecord(
  resourceRef: string,
  asked: Partial<Record<TermName, bigint>>,
  held: number,
  premiumBps: number,
): { asked_base: Record<string, string>; asked_stamp: Record<string, string> } {
  const base: Record<string, string> = {};
  const stamp: Record<string, string> = {};
  for (const [name, value] of Object.entries(asked)) {
    if (value === undefined) continue;
    base[name] = floorBase(name as TermName, value, held, premiumBps).toString(10);
    // A limit with no generation here (no port, unreadable) is left off: its
    // answer is not counted.
    const now = limitStamp(SHELF_HOST_KIND, shelfLimitKey(resourceRef, name as TermName));
    if (now !== null && now !== '') stamp[name] = now;
  }
  return { asked_base: base, asked_stamp: stamp };
}

/** A floor card was answered: each term it asked about joins its limit's record. */
export function noteFloorAnswer(
  card: { cardId: string; materialJson: string },
  answer: LimitAnswer,
  nowMs: number,
): void {
  // A card raised before the record began carries no policy figures: it is not counted.
  const record = readTermFloorRecord(card.materialJson);
  if (record === null) return;
  for (const term of record.terms) {
    recordLimitCard(
      {
        kind: SHELF_HOST_KIND,
        limitKey: shelfLimitKey(record.resourceRef, term.name),
        cardId: card.cardId,
        figure: BigInt(term.figure),
        stamp: term.stamp,
        answer,
      },
      nowMs,
    );
  }
}

/**
 * The owner declined an agreement. Any term inside the room Dina had earned
 * puts the owner's own floor back for that term.
 */
export function noteDeclinedDeal(
  proposal: Pick<TermAgreementProposal, 'resource_ref' | 'terms'>,
  held: number,
  premiumBps: number,
  nowMs: number,
): void {
  const values = termValues(proposal.terms);
  for (const name of TERM_NAMES) {
    const value = values[name];
    if (value === undefined) continue;
    const key = shelfLimitKey(proposal.resource_ref, name);
    const base = floorBase(name, value, held, premiumBps);
    if (insideEarnedRoom(SHELF_HOST_KIND, key, base))
      narrowRoom(SHELF_HOST_KIND, key, 'declined', nowMs);
  }
}
