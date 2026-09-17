/**
 * How a plan card READS its plan (GROUP_COORDINATION §9) — WEB.
 *
 * The Brain-served page reads through Brain's own door
 * (`GET /api/v1/coordination/plans/:id`, proxied to Core with Brain's
 * authority). No owner capability is involved: reading a plan is what Brain
 * may do; deciding one is the owner's and lives on Core's own owner surface,
 * so the web card renders the fold and points decisions there — the same
 * posture as the run and watch UI (`owner_run_client.web.ts`).
 */

import type { GroupPlanReader } from './group_plan_reader';
import type { GroupPlanWire } from '@dina/core';

const httpReader: GroupPlanReader = {
  async get(planId: string): Promise<GroupPlanWire | null> {
    const res = await fetch(`/api/v1/coordination/plans/${encodeURIComponent(planId)}`);
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
