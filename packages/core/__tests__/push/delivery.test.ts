/**
 * PSVC-2/3 — push authority: silence reconciliation + the §8 delivery decision
 * + the subscription store (PUSH_SERVICES_ARCHITECTURE.md §5/§8/§9/§12/§20).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  classifyPushTier,
  cryWolfFloor,
  decidePushDelivery,
  overBudgetDisposition,
  type PushPipelineInput,
} from '../../src/push/delivery';
import {
  InMemoryPushSubscriptionRepository,
  SQLitePushSubscriptionRepository,
  type PushSubscriptionRecord,
  type PushSubscriptionRepository,
} from '../../src/push/subscription';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

const NOW = 1_700_000_000_000;

describe('classifyPushTier (§9 — provider proposes, Dina disposes)', () => {
  it('caps the provider claim at the ceiling (quieter-of); no self-elevation', () => {
    // provider claims Fiduciary(1) on an Engagement(3) ceiling → briefing
    expect(
      classifyPushTier({ claimed_priority: 'fiduciary', priority_ceiling: 'engagement', harm_topic: true, harm_concurs: true }),
    ).toBe(3);
    // provider claims Solicited on a Solicited ceiling → Solicited
    expect(
      classifyPushTier({ claimed_priority: 'solicited', priority_ceiling: 'solicited', harm_topic: false, harm_concurs: false }),
    ).toBe(2);
  });

  it('Fiduciary requires TWO independent yeses (harm topic AND Dina concurs)', () => {
    const base = { claimed_priority: 'fiduciary' as const, priority_ceiling: 'fiduciary' as const };
    expect(classifyPushTier({ ...base, harm_topic: true, harm_concurs: true })).toBe(1);
    expect(classifyPushTier({ ...base, harm_topic: true, harm_concurs: false })).toBe(2); // one yes → not Fiduciary
    expect(classifyPushTier({ ...base, harm_topic: false, harm_concurs: true })).toBe(2);
  });

  it('a cry-wolf floor downgrades but never makes it louder', () => {
    expect(
      classifyPushTier({ claimed_priority: 'solicited', priority_ceiling: 'solicited', harm_topic: false, harm_concurs: false, cry_wolf_floor: 3 }),
    ).toBe(3);
  });

  it('cryWolfFloor triggers at the threshold', () => {
    expect(cryWolfFloor(2, 3)).toBeUndefined();
    expect(cryWolfFloor(3, 3)).toBe(3);
  });
});

describe('overBudgetDisposition (§8 by kind)', () => {
  it('informational → demote to briefing; action → retryable reject', () => {
    expect(overBudgetDisposition('informational')).toEqual({ disposition: 'demote_to_briefing', tier: 3 });
    expect(overBudgetDisposition('action')).toEqual({ disposition: 'retryable_reject' });
  });
});

describe('decidePushDelivery (§8 pipeline)', () => {
  function input(over: Partial<PushPipelineInput> = {}): PushPipelineInput {
    return {
      authorized: true, condition_matches: true, sender_blocked: false, stale: false, duplicate: false,
      budget_available: true, kind: 'informational', tier: 2, persona_locked: false, ...over,
    };
  }
  it('blocking always wins, then default-deny for the unauthorized', () => {
    expect(decidePushDelivery(input({ sender_blocked: true, authorized: true }))).toEqual({ action: 'drop', reason: 'blocked' });
    expect(decidePushDelivery(input({ authorized: false }))).toEqual({ action: 'drop', reason: 'unauthorized' });
    expect(decidePushDelivery(input({ condition_matches: false }))).toEqual({ action: 'drop', reason: 'condition_mismatch' });
    expect(decidePushDelivery(input({ stale: true }))).toEqual({ action: 'drop', reason: 'stale' });
  });
  it('collapses a duplicate', () => {
    expect(decidePushDelivery(input({ duplicate: true }))).toEqual({ action: 'collapse', reason: 'duplicate' });
  });
  it('over-budget: informational demotes to briefing, action retryably rejects', () => {
    expect(decidePushDelivery(input({ budget_available: false, kind: 'informational', tier: 2 }))).toEqual({
      action: 'deliver', tier: 3, demoted: true,
    });
    expect(decidePushDelivery(input({ budget_available: false, kind: 'action' }))).toEqual({ action: 'reject', reason: 'over_budget_action' });
  });
  it('holds for a locked persona; otherwise delivers at the classified tier', () => {
    expect(decidePushDelivery(input({ persona_locked: true, tier: 2 }))).toEqual({ action: 'hold', reason: 'persona_locked', tier: 2 });
    expect(decidePushDelivery(input({ tier: 2 }))).toEqual({ action: 'deliver', tier: 2, demoted: false });
  });
});

function makeSub(over: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
  return {
    subscription_id: 'sub-1', provider_did: 'did:plc:prov', service_uri: 'at://svc', push_capability: 'push_notify',
    persona: 'general', topic_id: 't', condition_ref: 'c', condition_json: '{}', priority_ceiling: 'engagement',
    rate_budget_tokens: 2, rate_window_seconds: 3600, rate_tokens_remaining: 2, rate_window_started_at: NOW,
    fulfilment: 'push', poll_interval_seconds: null, delivery_evidence: 'none', cry_wolf_dismissals: 0,
    suspicion_score: 0, expires_at: NOW + 86_400_000, revoked_at: null, created_at: NOW, updated_at: NOW, ...over,
  };
}

function subSuite(makeRepo: () => PushSubscriptionRepository): void {
  const authArgs = { provider_did: 'did:plc:prov', service_uri: 'at://svc', push_capability: 'push_notify', subscription_id: 'sub-1' };

  it('getActive is the default-deny authorization gate', () => {
    const repo = makeRepo();
    repo.create(makeSub());
    expect(repo.getActive(authArgs, NOW)).not.toBeNull();
    // revoked → denied on the very next lookup
    repo.revoke('sub-1', NOW);
    expect(repo.getActive(authArgs, NOW)).toBeNull();
  });

  it('an expired subscription is denied', () => {
    const repo = makeRepo();
    repo.create(makeSub({ expires_at: NOW - 1 }));
    expect(repo.getActive(authArgs, NOW)).toBeNull();
  });

  it('a mismatched provider/service/capability is denied', () => {
    const repo = makeRepo();
    repo.create(makeSub());
    expect(repo.getActive({ ...authArgs, provider_did: 'did:plc:other' }, NOW)).toBeNull();
  });

  it('the rate bucket consumes then refills on the window boundary', () => {
    const repo = makeRepo();
    repo.create(makeSub({ rate_budget_tokens: 2, rate_tokens_remaining: 2, rate_window_seconds: 3600 }));
    expect(repo.consumeToken('sub-1', NOW)).toBe(true);
    expect(repo.consumeToken('sub-1', NOW)).toBe(true);
    expect(repo.consumeToken('sub-1', NOW)).toBe(false); // over budget
    // window elapses → refill
    expect(repo.consumeToken('sub-1', NOW + 3_600_001)).toBe(true);
  });

  it('cry-wolf + suspicion counters accumulate', () => {
    const repo = makeRepo();
    repo.create(makeSub());
    expect(repo.recordDismissal('sub-1', NOW)).toBe(1);
    expect(repo.recordDismissal('sub-1', NOW)).toBe(2);
    expect(repo.addSuspicion('sub-1', 5, NOW)).toBe(5);
  });
}

describe('InMemoryPushSubscriptionRepository', () => {
  subSuite(() => new InMemoryPushSubscriptionRepository());
});

describe('SQLitePushSubscriptionRepository (real SQLite, v26)', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  subSuite(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'psvc-'));
    adapter = new NodeSQLiteAdapter({ path: path.join(dir, 'identity.sqlite'), passphraseHex: randomBytes(32).toString('hex'), journalMode: 'WAL', synchronous: 'NORMAL' });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    return new SQLitePushSubscriptionRepository(adapter);
  });
  afterEach(() => {
    adapter?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
