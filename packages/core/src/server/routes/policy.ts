/**
 * Action risk policy routes — GET + PUT for the operator's risk table.
 *
 * GET /v1/policy/actions          — current merged policy (defaults + KV overrides)
 * PUT /v1/policy/actions/:action  — set one action's risk level
 *
 * Storage: KV key `policy:action_risk` in the same nested format the
 * Python admin-cli uses:
 *   { "blocked": [...], "high": [...], "moderate": [...], "safe": [...] }
 *
 * The GET response is a flat array merged with DEFAULT_POLICY so the
 * mobile UI always sees all known actions with their effective risk.
 */

import { DEFAULT_POLICY, BRAIN_DENIED } from '../../gatekeeper/intent';
import { kvGet, kvSet } from '../../kv/store';

// BRAIN_DENIED used only by PUT/DELETE guards — not included in GET response (internal ops, not operator-facing)
import type { RiskLevel } from '../../gatekeeper/intent';
import type { CoreRouter } from '../router';

const POLICY_KV_KEY = 'policy:action_risk';
const ADMIN_POLICY_KV_KEY = 'admin:action_risk_policy';
const VALID_RISKS: ReadonlySet<string> = new Set(['SAFE', 'MODERATE', 'HIGH', 'BLOCKED']);

export interface ActionPolicyEntry {
  action: string;
  risk: RiskLevel;
  /** true when there is no KV override for this action. */
  isDefault: boolean;
  /** true for BRAIN_DENIED actions — never configurable. */
  locked: boolean;
  /** true when this action is part of the hardcoded DEFAULT_POLICY table. */
  inDefaultPolicy: boolean;
}

/** Parse the KV nested format to a flat action→risk map. */
function parseKVPolicy(raw: string | null): Map<string, RiskLevel> {
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result = new Map<string, RiskLevel>();
    for (const [level, actions] of Object.entries(parsed)) {
      const risk = level.toUpperCase() as RiskLevel;
      if (!VALID_RISKS.has(risk)) continue;
      if (!Array.isArray(actions)) continue;
      for (const action of actions) {
        if (typeof action === 'string') result.set(action, risk);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

/** Convert a flat action→risk map back to nested KV format. */
function toKVFormat(overrides: Map<string, RiskLevel>): Record<string, string[]> {
  const result: Record<string, string[]> = { blocked: [], high: [], moderate: [], safe: [] };
  for (const [action, risk] of overrides) {
    const key = risk.toLowerCase();
    if (!result[key]) result[key] = [];
    result[key]!.push(action);
  }
  for (const key of Object.keys(result)) {
    result[key] = (result[key] ?? []).sort();
  }
  return result;
}

export function registerPolicyRoutes(router: CoreRouter): void {
  router.get('/v1/policy/actions', async () => {
    const raw = await kvGet(POLICY_KV_KEY);
    const overrides = parseKVPolicy(raw);

    // Build merged list: all known actions from DEFAULT_POLICY + overrides
    const allActions = new Set([...Object.keys(DEFAULT_POLICY), ...overrides.keys()]);
    const entries: ActionPolicyEntry[] = [];

    for (const action of [...allActions].sort()) {
      const defaultRisk = (DEFAULT_POLICY as Record<string, RiskLevel>)[action] ?? 'MODERATE';
      const effectiveRisk = overrides.get(action) ?? defaultRisk;
      entries.push({
        action,
        risk: effectiveRisk,
        isDefault: !overrides.has(action),
        locked: false,
        inDefaultPolicy: Object.prototype.hasOwnProperty.call(DEFAULT_POLICY, action),
      });
    }

    entries.sort((a, b) => a.action.localeCompare(b.action));

    return { status: 200, body: { actions: entries } };
  });

  router.put('/v1/policy/actions/:action', async (req) => {
    const action = req.params.action;
    if (!action || typeof action !== 'string') {
      return { status: 400, body: { error: 'action path param required' } };
    }
    if (BRAIN_DENIED.has(action)) {
      return { status: 403, body: { error: 'Brain-denied actions are not configurable' } };
    }

    const body = (req.body as Record<string, unknown>) ?? {};
    const rawRisk = typeof body.risk === 'string' ? body.risk.toUpperCase() : '';
    if (!VALID_RISKS.has(rawRisk)) {
      return { status: 400, body: { error: `risk must be one of: ${[...VALID_RISKS].join(', ')}` } };
    }
    const risk = rawRisk as RiskLevel;

    const existing = await kvGet(POLICY_KV_KEY);
    const overrides = parseKVPolicy(existing);

    const defaultRisk = (DEFAULT_POLICY as Record<string, RiskLevel>)[action] ?? 'MODERATE';
    if (risk === defaultRisk) {
      // Reset to default — remove the override
      overrides.delete(action);
    } else {
      overrides.set(action, risk);
    }

    const nested = toKVFormat(overrides);
    const serialized = JSON.stringify(nested);
    await Promise.all([kvSet(POLICY_KV_KEY, serialized), kvSet(ADMIN_POLICY_KV_KEY, serialized)]);

    return {
      status: 200,
      body: {
        action,
        risk,
        isDefault: risk === defaultRisk,
        locked: false,
        inDefaultPolicy: Object.prototype.hasOwnProperty.call(DEFAULT_POLICY, action),
      } satisfies ActionPolicyEntry,
    };
  });

  router.delete('/v1/policy/actions/:action', async (req) => {
    const action = req.params.action;
    if (!action || typeof action !== 'string') {
      return { status: 400, body: { error: 'action path param required' } };
    }
    if (BRAIN_DENIED.has(action)) {
      return { status: 403, body: { error: 'Brain-denied actions are not configurable' } };
    }

    const existing = await kvGet(POLICY_KV_KEY);
    const overrides = parseKVPolicy(existing);
    overrides.delete(action);

    const nested = toKVFormat(overrides);
    const serialized = JSON.stringify(nested);
    await Promise.all([kvSet(POLICY_KV_KEY, serialized), kvSet(ADMIN_POLICY_KV_KEY, serialized)]);

    return { status: 204, body: null };
  });
}
