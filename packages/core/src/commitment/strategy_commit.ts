/**
 * The reasoning commit bridge's one door for a strategy's move
 * (COMMITMENT_KERNEL §11, §15 step 11): routed by the brief's own kind, which
 * Core wrote and the job's input hash binds. Shelf kinds go to the term
 * engine; a goods counter to the tender loop; a shipper's fee to the option
 * family; a group's slot to the coordination service.
 */

import { commitGoodsCounterMove } from '../commerce/goods_counter_strategy';
import { commitTermStrategyMove } from '../commerce/term/term_runtime';
import { commitGroupSlotMove } from '../coordination/group_coordination_service';

import { commitShipperFeeMove } from './option_handler';

export async function commitStrategyMove(input: { input: unknown; result: unknown }): Promise<{
  state: 'committed';
  receipt: Record<string, unknown>;
}> {
  const kind = (input.input as { kind?: unknown } | null)?.kind;
  if (kind === 'delivery.shipper') return commitShipperFeeMove(input);
  if (kind === 'group.organizer') return commitGroupSlotMove(input);
  if (kind === 'goods.buyer') return commitGoodsCounterMove(input);
  return commitTermStrategyMove(input);
}
