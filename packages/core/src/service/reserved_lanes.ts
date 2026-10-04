/**
 * Runner lanes only Core fills (A2A design §6.3, plan §4.2a): the in-process
 * Tier 1 lane `dina.local`, and every `plugin:`, `a2a:` and `reasoning:`
 * lane. The create route refuses them to every caller, the service-query
 * ingress never queues a stranger's query on one, a listing that names one
 * as its `mcpServer` cannot be saved, and a generic claim never takes one.
 *
 * ONE rule, in code and in SQL, and deliberately broad: compared after
 * trimming and without ASCII case, and a reserved prefix with nothing after
 * it is reserved too. A lane that only looks like a reserved one is refused
 * everywhere rather than claimed by one store and stranded by the other.
 * (Exact-lane claims stay exact: a runner names its own lane.)
 */

import { LOCAL_RUNNER_NAME } from '@dina/protocol';

import type { ServiceCapabilityConfig } from '@dina/protocol';

const RESERVED_PREFIXES = ['plugin:', 'a2a:', 'reasoning:'] as const;

export function isReservedLane(lane: string): boolean {
  const l = lane.trim().toLowerCase();
  return l === LOCAL_RUNNER_NAME || RESERVED_PREFIXES.some((p) => l.startsWith(p));
}

/**
 * The same rule as a SQL condition over `column` (SQLite: `lower`, `trim`,
 * and `LIKE`, which already ignores ASCII case). True for a reserved lane.
 */
export function reservedLaneSql(column: string): string {
  const v = `lower(trim(${column}))`;
  return `(${v} = '${LOCAL_RUNNER_NAME}' OR ${RESERVED_PREFIXES.map((p) => `${v} LIKE '${p}%'`).join(' OR ')})`;
}

/** A listing capability whose `mcpServer` names a reserved lane: never a valid agent binding. */
export function namesReservedLane(cap: ServiceCapabilityConfig): boolean {
  return typeof cap.mcpServer === 'string' && cap.mcpServer !== '' && isReservedLane(cap.mcpServer);
}
