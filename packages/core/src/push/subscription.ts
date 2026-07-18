/**
 * Push subscription store (PUSH_SERVICES_ARCHITECTURE.md §6/§15). A
 * subscriber-authored, standing, revocable, persona-scoped, rate-budgeted
 * authorization — the ONLY thing that admits an inbound push. It serves both the
 * authorization lookup (an inbound `push.event` must match an active row) and
 * the local config/counters (rate bucket + cry-wolf/suspicion). Default-deny:
 * no active matching subscription ⇒ the push is dropped and quarantined.
 */

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

export type PushCeiling = 'engagement' | 'solicited' | 'fiduciary';
export type PushFulfilment = 'push' | 'poll' | 'push_with_poll_fallback';

export interface PushSubscriptionRecord {
  subscription_id: string;
  provider_did: string;
  service_uri: string;
  push_capability: string;
  persona: string;
  topic_id: string;
  condition_ref: string;
  condition_json: string;
  priority_ceiling: PushCeiling;
  rate_budget_tokens: number;
  rate_window_seconds: number;
  rate_tokens_remaining: number;
  rate_window_started_at: number; // ms
  fulfilment: PushFulfilment;
  poll_interval_seconds: number | null;
  delivery_evidence: 'none' | 'trigger_evidence_required';
  cry_wolf_dismissals: number;
  suspicion_score: number;
  expires_at: number; // ms
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PushSubscriptionRepository {
  create(sub: PushSubscriptionRecord): void;
  getById(subscriptionId: string): PushSubscriptionRecord | null;
  /** The authorization lookup (§8 step 4): an active (not revoked, not expired)
   *  subscription matching the arrival's identity, or null (default-deny). */
  getActive(
    args: { provider_did: string; service_uri: string; push_capability: string; subscription_id: string },
    nowMs: number,
  ): PushSubscriptionRecord | null;
  listByPersona(persona: string): PushSubscriptionRecord[];
  /** Instant local exit (§12): fence the subscription (next push fails). */
  revoke(subscriptionId: string, nowMs: number): boolean;
  /** Refill (windowed) then consume one token for a logical event (§8 step 7).
   *  Returns true iff a token was available (consumed); false = over budget. */
  consumeToken(subscriptionId: string, nowMs: number): boolean;
  /** Cry-wolf: an immediately-dismissed loud push increments the counter (§12). */
  recordDismissal(subscriptionId: string, nowMs: number): number;
  /** Over-fire clamp: budget-overage / condition-mismatch raise suspicion (§12). */
  addSuspicion(subscriptionId: string, delta: number, nowMs: number): number;
  size(): number;
}

const COLS = [
  'subscription_id', 'provider_did', 'service_uri', 'push_capability', 'persona', 'topic_id',
  'condition_ref', 'condition_json', 'priority_ceiling', 'rate_budget_tokens', 'rate_window_seconds',
  'rate_tokens_remaining', 'rate_window_started_at', 'fulfilment', 'poll_interval_seconds',
  'delivery_evidence', 'cry_wolf_dismissals', 'suspicion_score', 'expires_at', 'revoked_at',
  'created_at', 'updated_at',
] as const;

function rowToSub(row: DBRow): PushSubscriptionRecord {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    subscription_id: String(row.subscription_id),
    provider_did: String(row.provider_did),
    service_uri: String(row.service_uri),
    push_capability: String(row.push_capability),
    persona: String(row.persona),
    topic_id: String(row.topic_id),
    condition_ref: String(row.condition_ref),
    condition_json: String(row.condition_json ?? '{}'),
    priority_ceiling: String(row.priority_ceiling) as PushCeiling,
    rate_budget_tokens: Number(row.rate_budget_tokens),
    rate_window_seconds: Number(row.rate_window_seconds),
    rate_tokens_remaining: Number(row.rate_tokens_remaining),
    rate_window_started_at: Number(row.rate_window_started_at),
    fulfilment: String(row.fulfilment) as PushFulfilment,
    poll_interval_seconds: n(row.poll_interval_seconds),
    delivery_evidence: String(row.delivery_evidence) as 'none' | 'trigger_evidence_required',
    cry_wolf_dismissals: Number(row.cry_wolf_dismissals),
    suspicion_score: Number(row.suspicion_score),
    expires_at: Number(row.expires_at),
    revoked_at: n(row.revoked_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** Refill the token bucket if the window elapsed; returns the possibly-updated
 *  {remaining, windowStart}. Pure. */
function refill(
  sub: Pick<PushSubscriptionRecord, 'rate_budget_tokens' | 'rate_window_seconds' | 'rate_tokens_remaining' | 'rate_window_started_at'>,
  nowMs: number,
): { remaining: number; windowStart: number } {
  const windowMs = sub.rate_window_seconds * 1000;
  if (nowMs - sub.rate_window_started_at >= windowMs) {
    return { remaining: sub.rate_budget_tokens, windowStart: nowMs };
  }
  return { remaining: sub.rate_tokens_remaining, windowStart: sub.rate_window_started_at };
}

export class SQLitePushSubscriptionRepository implements PushSubscriptionRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  create(sub: PushSubscriptionRecord): void {
    const placeholders = COLS.map(() => '?').join(', ');
    this.db.execute(
      `INSERT INTO push_subscriptions (${COLS.join(', ')}) VALUES (${placeholders})`,
      COLS.map((c) => sub[c as keyof PushSubscriptionRecord] ?? null),
    );
  }
  getById(subscriptionId: string): PushSubscriptionRecord | null {
    const rows = this.db.query('SELECT * FROM push_subscriptions WHERE subscription_id = ? LIMIT 1', [subscriptionId]);
    return rows.length > 0 ? rowToSub(rows[0]) : null;
  }
  getActive(
    args: { provider_did: string; service_uri: string; push_capability: string; subscription_id: string },
    nowMs: number,
  ): PushSubscriptionRecord | null {
    const rows = this.db.query(
      `SELECT * FROM push_subscriptions
         WHERE subscription_id = ? AND provider_did = ? AND service_uri = ? AND push_capability = ?
           AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
      [args.subscription_id, args.provider_did, args.service_uri, args.push_capability, nowMs],
    );
    return rows.length > 0 ? rowToSub(rows[0]) : null;
  }
  listByPersona(persona: string): PushSubscriptionRecord[] {
    return this.db.query('SELECT * FROM push_subscriptions WHERE persona = ? ORDER BY created_at ASC', [persona]).map(rowToSub);
  }
  revoke(subscriptionId: string, nowMs: number): boolean {
    return this.db.run('UPDATE push_subscriptions SET revoked_at = ?, updated_at = ? WHERE subscription_id = ? AND revoked_at IS NULL', [nowMs, nowMs, subscriptionId]) > 0;
  }
  consumeToken(subscriptionId: string, nowMs: number): boolean {
    const sub = this.getById(subscriptionId);
    if (sub === null) return false;
    const { remaining, windowStart } = refill(sub, nowMs);
    if (remaining <= 0) {
      // persist any window reset even on empty
      this.db.run('UPDATE push_subscriptions SET rate_tokens_remaining = ?, rate_window_started_at = ?, updated_at = ? WHERE subscription_id = ?', [remaining, windowStart, nowMs, subscriptionId]);
      return false;
    }
    this.db.run('UPDATE push_subscriptions SET rate_tokens_remaining = ?, rate_window_started_at = ?, updated_at = ? WHERE subscription_id = ?', [remaining - 1, windowStart, nowMs, subscriptionId]);
    return true;
  }
  recordDismissal(subscriptionId: string, nowMs: number): number {
    this.db.run('UPDATE push_subscriptions SET cry_wolf_dismissals = cry_wolf_dismissals + 1, updated_at = ? WHERE subscription_id = ?', [nowMs, subscriptionId]);
    return this.getById(subscriptionId)?.cry_wolf_dismissals ?? 0;
  }
  addSuspicion(subscriptionId: string, delta: number, nowMs: number): number {
    this.db.run('UPDATE push_subscriptions SET suspicion_score = suspicion_score + ?, updated_at = ? WHERE subscription_id = ?', [delta, nowMs, subscriptionId]);
    return this.getById(subscriptionId)?.suspicion_score ?? 0;
  }
  size(): number {
    return this.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions')[0]?.n ?? 0;
  }
}

export class InMemoryPushSubscriptionRepository implements PushSubscriptionRepository {
  private readonly rows = new Map<string, PushSubscriptionRecord>();
  create(sub: PushSubscriptionRecord): void {
    this.rows.set(sub.subscription_id, { ...sub });
  }
  getById(id: string): PushSubscriptionRecord | null {
    const r = this.rows.get(id);
    return r ? { ...r } : null;
  }
  getActive(a: { provider_did: string; service_uri: string; push_capability: string; subscription_id: string }, nowMs: number): PushSubscriptionRecord | null {
    const r = this.rows.get(a.subscription_id);
    if (!r || r.revoked_at !== null || r.expires_at <= nowMs) return null;
    if (r.provider_did !== a.provider_did || r.service_uri !== a.service_uri || r.push_capability !== a.push_capability) return null;
    return { ...r };
  }
  listByPersona(persona: string): PushSubscriptionRecord[] {
    return [...this.rows.values()].filter((r) => r.persona === persona).sort((a, b) => a.created_at - b.created_at).map((r) => ({ ...r }));
  }
  revoke(id: string, nowMs: number): boolean {
    const r = this.rows.get(id);
    if (!r || r.revoked_at !== null) return false;
    r.revoked_at = nowMs;
    r.updated_at = nowMs;
    return true;
  }
  consumeToken(id: string, nowMs: number): boolean {
    const r = this.rows.get(id);
    if (!r) return false;
    const { remaining, windowStart } = refill(r, nowMs);
    r.rate_window_started_at = windowStart;
    if (remaining <= 0) {
      r.rate_tokens_remaining = remaining;
      r.updated_at = nowMs;
      return false;
    }
    r.rate_tokens_remaining = remaining - 1;
    r.updated_at = nowMs;
    return true;
  }
  recordDismissal(id: string, nowMs: number): number {
    const r = this.rows.get(id);
    if (!r) return 0;
    r.cry_wolf_dismissals += 1;
    r.updated_at = nowMs;
    return r.cry_wolf_dismissals;
  }
  addSuspicion(id: string, delta: number, nowMs: number): number {
    const r = this.rows.get(id);
    if (!r) return 0;
    r.suspicion_score += delta;
    r.updated_at = nowMs;
    return r.suspicion_score;
  }
  size(): number {
    return this.rows.size;
  }
}

let repo: PushSubscriptionRepository | null = null;
export function setPushSubscriptionRepository(r: PushSubscriptionRepository | null): void {
  repo = r;
}
export function getPushSubscriptionRepository(): PushSubscriptionRepository | null {
  return repo;
}
