/**
 * Inbound executor bindings (design §7.3): which paired device may run A2A
 * work on an `mcpServer` lane. D2D lets any paired agent claim a lane's task
 * by naming it; A2A does not. A lane with no live binding is not executable
 * over A2A, so the card leaves its skills out and ingress refuses them, and
 * the binding's device DID is what an A2A operation's snapshot pins as its
 * PEP: the only claimant its children accept.
 *
 * The bound device must be an active paired delegation runner (role
 * `agent`, not a coding agent). A device revoked later stops counting at
 * once: `liveRunnerBinding` checks the registry on every read. Every write
 * here bumps `service_configs.revision` on each listing whose capabilities
 * name the lane, in the same commit, because a snapshot that pinned the old
 * binding must void (§7.2 step 9, §9).
 *
 * Plugin lanes and the in-process Tier 1 lane have their own executor
 * bindings (the plugin claim guard, the in-process runner) and are refused
 * here, as is every reserved lane.
 */

import { getDeviceByDID } from '../devices/registry';
import { isReservedLane } from '../service/reserved_lanes';

import type { A2AStore } from './store';
import type { DBRow } from '../storage/db_adapter';

const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RunnerBindingRow {
  lane: string;
  device_did: string;
  created_at: number;
  revoked_at: number | null;
}

export type RunnerBindingRefusal = 'lane_malformed' | 'lane_reserved' | 'device_not_runner' | 'not_found';

function isRunnerDevice(did: string): boolean {
  const device = getDeviceByDID(did);
  return device !== null && !device.revoked && device.role === 'agent' && device.scope !== 'coding';
}

/** Bump the revision of every listing whose capabilities name `lane`. */
function bumpListingsUsing(store: A2AStore, lane: string): number {
  const rows = store.db.query('SELECT rkey, config_json FROM service_configs') as DBRow[];
  let bumped = 0;
  for (const row of rows) {
    let usesLane = false;
    try {
      const config = JSON.parse(String(row.config_json)) as { capabilities?: Record<string, { mcpServer?: unknown }> };
      usesLane = Object.values(config.capabilities ?? {}).some((cap) => cap?.mcpServer === lane);
    } catch {
      usesLane = false;
    }
    if (!usesLane) continue;
    store.db.execute('UPDATE service_configs SET revision = revision + 1 WHERE rkey = ?', [row.rkey]);
    bumped += 1;
  }
  return bumped;
}

/** Bind a lane to a paired runner, replacing any earlier binding of that lane. */
export function bindRunner(
  store: A2AStore,
  input: { lane: unknown; device_did: unknown },
  nowMs: number,
): { ok: true; binding: RunnerBindingRow } | { ok: false; reason: RunnerBindingRefusal } {
  const lane = typeof input.lane === 'string' ? input.lane : '';
  if (!LANE_RE.test(lane)) return { ok: false, reason: 'lane_malformed' };
  if (isReservedLane(lane)) return { ok: false, reason: 'lane_reserved' };
  const did = typeof input.device_did === 'string' ? input.device_did : '';
  if (!isRunnerDevice(did)) return { ok: false, reason: 'device_not_runner' };
  store.transaction(() => {
    store.db.execute(
      `INSERT INTO a2a_runner_bindings (lane, device_did, created_at, revoked_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(lane) DO UPDATE SET device_did = excluded.device_did,
         created_at = excluded.created_at, revoked_at = NULL`,
      [lane, did, nowMs],
    );
    bumpListingsUsing(store, lane);
  });
  return { ok: true, binding: { lane, device_did: did, created_at: nowMs, revoked_at: null } };
}

/** End a lane's binding: A2A work on it stops being executable. */
export function unbindRunner(
  store: A2AStore,
  lane: string,
  nowMs: number,
): { ok: true } | { ok: false; reason: 'not_found' } {
  let changed = 0;
  store.transaction(() => {
    changed = store.db.run('UPDATE a2a_runner_bindings SET revoked_at = ? WHERE lane = ? AND revoked_at IS NULL', [
      nowMs,
      lane,
    ]);
    if (changed > 0) bumpListingsUsing(store, lane);
  });
  return changed > 0 ? { ok: true } : { ok: false, reason: 'not_found' };
}

/** Every binding, live and ended, newest first. */
export function listRunnerBindings(store: A2AStore): (RunnerBindingRow & { live: boolean })[] {
  const rows = store.db.query('SELECT * FROM a2a_runner_bindings ORDER BY created_at DESC, lane') as unknown as RunnerBindingRow[];
  return rows.map((r) => ({ ...r, live: r.revoked_at === null && isRunnerDevice(r.device_did) }));
}

/**
 * The binding A2A work on `lane` runs under: unrevoked, and its device still
 * an active paired runner. `null` means the lane is not executable over A2A.
 */
export function liveRunnerBinding(store: A2AStore, lane: string): RunnerBindingRow | null {
  const rows = store.db.query('SELECT * FROM a2a_runner_bindings WHERE lane = ? AND revoked_at IS NULL', [
    lane,
  ]) as unknown as RunnerBindingRow[];
  const row = rows[0];
  return row !== undefined && isRunnerDevice(row.device_did) ? row : null;
}
