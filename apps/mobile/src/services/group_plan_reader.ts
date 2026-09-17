/**
 * How a plan card READS its plan (GROUP_COORDINATION §9) — native.
 *
 * On the phone the whole node runs in-process, so the card reads through the
 * owner-marked coordination client the boot installed. The web host swaps in
 * `group_plan_reader.web.ts`, which reads through Brain's own door instead:
 * reading a plan is Brain's authority, deciding one is the owner's, and the
 * two clients keep that line.
 */

import { getOwnerCoordinationClient } from './owner_coordination_client';

import type { GroupPlanWire } from '@dina/core';

export interface GroupPlanReader {
  get(planId: string): Promise<GroupPlanWire | null>;
}

/** Null before boot; the card says so instead of spinning. */
export function getGroupPlanReader(): GroupPlanReader | null {
  return getOwnerCoordinationClient();
}
