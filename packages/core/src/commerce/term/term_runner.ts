/**
 * The first-party term runner (SHELF_SPACE_NEGOTIATION §4, §10 step 6) — the
 * reference strategy for a seller's answers, as a PURE function.
 *
 * WHAT IT DECIDES, AND WHAT IT DOES NOT. It proposes terms: the first offer
 * from the store's private asking terms, and each revision a step toward the
 * buyer's targets. It signs nothing and knows no floor — Core clamps every
 * proposal to the owner's floors afterwards (`reviseWithinLimits`), so a runner bug
 * cannot sell below a floor. The split mirrors the goods runner
 * (`supplier_runner.ts`): the runner proposes, Core decides.
 *
 * WHY IN-PROCESS, NOT A WORKFLOW TASK. The goods runner claims tasks over
 * Core's routes because an external runner must authenticate as a paired
 * device. This handler is Core's own first-party code configured only by the
 * pack's pinned parameters, so a device and a task round-trip would add
 * latency and no authority (implementation-notes: shelf deviations). An
 * out-of-process runner for third-party packs is the spec's Q6.
 */

import { TERM_NAMES, type TermName } from '@dina/commerce-protocol';

import { termPart } from './term_policy';

/** The runner's parameters, pinned per pack in `FIRST_PARTY_PACKS`. */
export interface TermRunnerParams {
  /** How far toward the buyer's target each revision moves, in percent (1–100). */
  stepPercent: number;
}

export const DEFAULT_TERM_RUNNER_PARAMS: TermRunnerParams = { stepPercent: 50 };

/** The first offer: the store's private asking terms, unchanged. */
export function proposeFirstOffer(asking: Record<TermName, bigint>): Record<TermName, bigint> {
  return { ...asking };
}

/**
 * A revision: for each term the buyer named, move from the current value
 * toward the target by `stepPercent`, rounding toward the CURRENT value (in
 * the seller's favour, so a step never overshoots). A term the buyer did not
 * name, or whose target the current value already meets, is unchanged.
 */
export function proposeRevision(args: {
  current: Record<TermName, bigint>;
  targets: Partial<Record<TermName, bigint>>;
  params: TermRunnerParams;
}): Record<TermName, bigint> {
  const out = { ...args.current };
  for (const name of TERM_NAMES) {
    const target = args.targets[name];
    if (target === undefined) continue;
    const current = args.current[name];
    // The buyer pays every part it bargains down: lower is its side.
    const lower = termPart(name).payer === 'buyer';
    const gap = lower ? current - target : target - current;
    if (gap <= 0n) continue; // already at or past what the buyer asked
    const step = (gap * BigInt(args.params.stepPercent)) / 100n; // floors toward current
    out[name] = lower ? current - step : current + step;
  }
  return out;
}
