/**
 * REAL_LIFE_FIXES_2 §15 — agent spend allowance: the owner pre-approves a
 * budget; a declared purchase inside it is answered without a card; anything
 * else goes to the owner. Dina never moves money.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2AReleaseLog, installA2AReleaseLog } from '../../src/a2a';
import { cleanForProvenance } from '../../src/a2a/provenance_text';
import { resetSpanProofs, type SpanProof } from '../../src/a2a/span_proof';
import { registerDevice, resetDeviceRegistry, revokeDevice } from '../../src/devices/registry';
import { resetKVStore } from '../../src/kv/store';
import { setOwnerTimeZone } from '../../src/settings/owner_settings';
import {
  activateAllowance,
  allowanceStatus,
  evaluateSpend,
  listSpendUses,
  reconcileSpend,
  recordApprovedSpend,
  periodKey,
  proposeAllowance,
  revokeAllowance,
} from '../../src/spend/allowance';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, getWorkflowService, setWorkflowService } from '../../src/workflow/service';

const SESSION = 'chat:main';
let dir: string;
let db: NodeSQLiteAdapter;
let log: A2AReleaseLog;
let n = 0;
let agentDid = '';
let agentId = '';

async function turn(text: string): Promise<SpanProof> {
  await new Promise((r) => setTimeout(r, 3));
  const id = `t${++n}`;
  log.recordUtterance(SESSION, id, text);
  return { releaseSession: SESSION, turnId: id, turnText: text, start: 0, end: cleanForProvenance(text).length };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'spend-'));
  db = new NodeSQLiteAdapter({ path: path.join(dir, 'id.sqlite'), passphraseHex: 'ee'.repeat(32), journalMode: 'WAL', synchronous: 'NORMAL' });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  log = new A2AReleaseLog(db, () => Date.now(), { chatLivesIn: 'brain' });
  installA2AReleaseLog(log);
  resetSpanProofs();
  resetKVStore();
  resetDeviceRegistry();
  setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
  await setOwnerTimeZone('Asia/Kolkata');
  const d = registerDevice('pantry-bot', `z6Mk${'q'.repeat(44)}`, 'agent');
  agentDid = d.did;
  agentId = d.deviceId;
});

afterEach(() => {
  installA2AReleaseLog(null);
  db.close?.();
  rmSync(dir, { recursive: true, force: true });
});

async function liveAllowance(amountMinor = 500_000, perItemCapMinor?: number): Promise<string> {
  const out = await proposeAllowance({
    proof: await turn('let pantry-bot spend up to 5000 rupees a month on household supplies'),
    agent: 'pantry-bot',
    amountMinor,
    currency: 'INR',
    period: 'month',
    category: 'household supplies',
    ...(perItemCapMinor !== undefined ? { perItemCapMinor } : {}),
  });
  if (out.status !== 'confirm_pending') throw new Error(JSON.stringify(out));
  expect(await activateAllowance(getWorkflowService()!.approve(out.task_id))).toBe(true);
  return out.task_id;
}

const buy = (value: unknown, key: string, over: Partial<{ currency: string; category: string }> = {}) =>
  evaluateSpend({
    agentDid,
    amount: { value_minor: value, currency: over.currency ?? 'INR' },
    merchant: 'Kirana Plus',
    category: over.category ?? 'household cleaning supplies',
    requestKey: key,
  });

it('within the allowance: answered without a card; over it: a card', async () => {
  await liveAllowance();
  expect((await buy(300_000, 'k1')).kind).toBe('auto');
  expect((await buy(150_000, 'k2')).kind).toBe('auto');
  expect((await buy(100_000, 'k3')).kind).toBe('review'); // 4,500 spent; 1,000 more is over
});

it('wrong currency, wrong category, over the per-item cap: a card', async () => {
  await liveAllowance(500_000, 100_000);
  expect((await buy(10_000, 'c1', { currency: 'USD' })).kind).toBe('review');
  expect((await buy(10_000, 'c2', { category: 'concert tickets' })).kind).toBe('review');
  expect((await buy(150_000, 'c3')).kind).toBe('review');
});

it('zero, negative, fractional, oversized and wrong-type amounts are refused with nothing recorded', async () => {
  await liveAllowance();
  for (const bad of [0, -100, 12.5, 1e16, '100', null]) {
    expect((await buy(bad, `bad-${String(bad)}`)).kind).toBe('invalid');
  }
  expect((await buy(500_000, 'whole')).kind).toBe('auto'); // the whole budget is still there
});

it('a retry with the same key counts once; a changed payload is a conflict', async () => {
  await liveAllowance();
  const first = await buy(400_000, 'same');
  const again = await buy(400_000, 'same');
  expect(again).toEqual(first);
  expect((await buy(100_000, 'other')).kind).toBe('auto'); // only 4,000 was counted
  expect((await buy(1, 'same')).kind).toBe('conflict');
});

it('two requests at once cannot both take the last of the budget', async () => {
  await liveAllowance(100_000);
  const [a, b] = await Promise.all([buy(80_000, 'r1'), buy(80_000, 'r2')]);
  expect([a.kind, b.kind].sort()).toEqual(['auto', 'review']);
});

it('revoking the allowance, or the agent device, ends it', async () => {
  const id = await liveAllowance();
  await revokeAllowance(id);
  expect((await buy(1_000, 'after-revoke')).kind).toBe('review');
  await liveAllowance();
  revokeDevice(agentId);
  await new Promise((r) => setTimeout(r, 20));
  expect((await buy(1_000, 'after-device')).kind).toBe('review');
});

it("periods are the allowance's own zone, pinned when it was set", () => {
  // 31 Oct 2026 20:00 UTC is already 1 November in Kolkata.
  const at = Date.UTC(2026, 9, 31, 20, 0);
  expect(periodKey(at, 'month', 'Asia/Kolkata')).toBe('2026-11');
  expect(periodKey(at, 'month', 'UTC')).toBe('2026-10');
});

it('the category must be the owner\'s words, and only a paired agent can be named', async () => {
  const words = await proposeAllowance({
    proof: await turn('let pantry-bot spend up to 5000 a month on household supplies'),
    agent: 'pantry-bot',
    amountMinor: 500_000,
    currency: 'INR',
    period: 'month',
    category: 'anything at all',
  });
  expect(words.status).toBe('refused');
  const nobody = await proposeAllowance({
    proof: await turn('let the travel bot spend 5000 a month on household supplies'),
    agent: 'travel bot',
    amountMinor: 500_000,
    currency: 'INR',
    period: 'month',
    category: 'household supplies',
  });
  expect(nobody.status).toBe('refused');
});

it('an approved purchase counts once, even if recorded twice; a crash before counting is settled at boot', async () => {
  await liveAllowance(500_000);
  const review = await buy(600_000, 'big-1'); // over the budget: the owner decides
  if (review.kind !== 'review') throw new Error(review.kind);
  // The route raises the card under the recorded id.
  getWorkflowService()!.create({
    id: review.proposalId,
    kind: 'approval' as never,
    description: 'purchase',
    payload: JSON.stringify({ type: 'intent_validation', agent_did: agentDid, spend: { request_key: 'big-1' } }),
    expiresAtSec: Math.floor(Date.now() / 1000) + 600,
    origin: 'agent',
    initialState: 'pending_approval' as never,
  });
  getWorkflowService()!.approve(review.proposalId);
  // The crash came before the count: boot settles it.
  await reconcileSpend();
  await recordApprovedSpend({ agentDid, requestKey: 'big-1', proposalId: review.proposalId });
  const [status] = (await allowanceStatus()).filter((x) => x.allowance.state === 'active');
  expect(status!.spentMinor).toBe(600_000);
  // A different card id cannot claim this purchase.
  await recordApprovedSpend({ agentDid, requestKey: 'big-1', proposalId: 'prop-intent-other' });
  expect((await allowanceStatus()).find((x) => x.allowance.state === 'active')!.spentMinor).toBe(600_000);
  const uses = await listSpendUses();
  expect(uses.map((u) => [u.decision, u.amountMinor, u.merchant])).toEqual([['approved', 600_000, 'Kirana Plus']]);
});

it('cards show the currency in its own decimals', async () => {
  registerDevice('yen-bot', `z6Mk${'r'.repeat(44)}`, 'agent');
  const out = await proposeAllowance({
    proof: await turn('let yen-bot spend up to 5000 yen a month on household supplies'),
    agent: 'yen-bot',
    amountMinor: 5000,
    currency: 'JPY',
    period: 'month',
    category: 'household supplies',
  });
  if (out.status !== 'confirm_pending') throw new Error(JSON.stringify(out));
  expect(out.summary).toContain('JPY 5000');
});


it('boot settles the card of a budget that went live before its card was settled', async () => {
  const out = await proposeAllowance({
    proof: await turn('let pantry-bot spend up to 5000 rupees a month on household supplies'),
    agent: 'pantry-bot',
    amountMinor: 500_000,
    currency: 'INR',
    period: 'month',
    category: 'household supplies',
  });
  if (out.status !== 'confirm_pending') throw new Error('no card');
  // Approved and turned on, then a crash before the card was settled.
  await activateAllowance(getWorkflowService()!.approve(out.task_id));
  expect(getWorkflowService()!.store().getById(out.task_id)!.status).toBe('queued');
  const { recoverOwnerApprovals } = await import('../../src/approvals_recovery');
  expect(await recoverOwnerApprovals()).toEqual({ ran: true });
  expect(getWorkflowService()!.store().getById(out.task_id)!.status).toBe('completed');
});

it('the agent can be named the way people say it: "my agent pantry-bot"', async () => {
  const out = await proposeAllowance({
    proof: await turn('let my agent pantry-bot spend up to 5000 a month on household supplies'),
    agent: 'my agent pantry-bot',
    amountMinor: 500_000,
    currency: 'INR',
    period: 'month',
    category: 'household supplies',
  });
  expect(out.status).toBe('confirm_pending');
  // A name that matches two agents is still refused.
  registerDevice('pantry-bot-2', `z6Mk${'s'.repeat(44)}`, 'agent');
  const two = await proposeAllowance({
    proof: await turn('let my agent pantry spend up to 5000 a month on household supplies'),
    agent: 'my agent pantry',
    amountMinor: 500_000,
    currency: 'INR',
    period: 'month',
    category: 'household supplies',
  });
  expect(two.status).toBe('refused');
});
