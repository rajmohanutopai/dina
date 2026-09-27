/**
 * How a plan card READS its plan (GROUP_COORDINATION §9) — WEB.
 *
 * The web app reads through Brain's own door
 * (`GET /api/v1/coordination/plans/:id`, cross-origin, proxied to Core with
 * Brain's authority): reading a plan is what Brain may do. Deciding one is the
 * owner's, and goes to Core as this browser's owner device through the owner
 * coordination client, as on the phone.
 */

import { brainFetch } from './web_runtime';

import type { GroupPlanReader } from './group_plan_reader';
import type { GroupPlanWire } from '@dina/core';

const httpReader: GroupPlanReader = {
  async get(planId: string): Promise<GroupPlanWire | null> {
    const res = await brainFetch(`/api/v1/coordination/plans/${encodeURIComponent(planId)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`group plan: ${res.status} ${detail.slice(0, 200)}`);
    }
    const body = (await res.json()) as { plan?: GroupPlanWire };
    return body.plan ?? null;
  },
};

export function getGroupPlanReader(): GroupPlanReader | null {
  return httpReader;
}
