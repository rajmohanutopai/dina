/**
 * COMMITMENT_KERNEL §13, §15 step 8 — evidence on a node.
 *
 *   EH-01 a run this node took up, a day after it: "did it happen?"; yes
 *         records it kept, no records it broken against the shipper; asked
 *         once;
 *   EH-02 a weekly promise the other side owes under a live shelf agreement:
 *         one card per day it fell due; the owner's own promises are not asked;
 *   EH-03 a run that ended without fault is recorded on both nodes with the
 *         facts each kept, against nobody;
 *   EH-04 consent: the owner's switch is sent to the other side; theirs is
 *         kept; a stranger's is refused;
 *   EH-05 a consent the sender did not take is sent again by the tick.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import {
  evidenceWorkflowHooks,
  getEvidenceStore,
  handleConsentMessage,
  installEvidenceStore,
  runEvidenceTick,
  setOwnerConsent,
} from '../../src/commitment/evidence_handler';
import {
  getSellerOptionStore,
  getShipperOptionStore,
  installOptionStores,
} from '../../src/commitment/option_handler';
import { setD2DSender } from '../../src/server/routes/d2d_msg';
import { setOwnerTimeZone } from '../../src/settings/owner_settings';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

import type { OptionBody } from '../../src/commitment/options';

const D = 24 * 3600_000;
const SHIPPER = 'did:plc:shipper';
const SELLER = 'did:plc:seller';
const BRAND = 'did:plc:brand';
const RUN_AT = '2026-11-10T09:00:00Z';
const NOW = Date.parse('2026-11-12T09:00:00Z');

const option: OptionBody = {
  v: 1,
  kind: 'option',
  option_id: 'opt-1',
  request_id: 'req-0011223344556677',
  service_at: RUN_AT,
  crates: 1,
  fee_minor: '30000',
  currency: 'INR',
  issued_at: '2026-11-02T09:00:00.000Z',
  hold_until: '2026-11-05T09:00:00.000Z',
  lead_time_s: 86_400,
  model_version: 1,
};

let dir: string;
let db: NodeSQLiteAdapter;
let workflow: WorkflowService;
let repo: InMemoryWorkflowRepository;
let sent: { to: string; type: string; body: Record<string, unknown> }[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-evidence-handler-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  installOptionStores(db);
  installEvidenceStore(db);
  repo = new InMemoryWorkflowRepository();
  workflow = new WorkflowService({
    repository: repo,
    nowMsFn: () => NOW,
    ...evidenceWorkflowHooks({ nowMs: () => NOW }),
  });
  setWorkflowService(workflow);
  sent = [];
  setD2DSender(async (to, type, body) => {
    sent.push({ to, type, body });
  });
  await setOwnerTimeZone('UTC');
});

afterEach(() => {
  installCommerceRuntime(null);
  setWorkflowService(null);
  setD2DSender(null);
  installEvidenceStore(null);
  installOptionStores(null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A run this seller took up and the shipper admitted. */
function boundRun(): void {
  const store = getSellerOptionStore();
  const request = {
    v: 1 as const,
    kind: 'request' as const,
    request_id: option.request_id,
    service_at: RUN_AT,
    crates: 1,
    postal_code: '560001',
  };
  store?.ask(
    { requestId: request.request_id, shipperDid: SHIPPER, dealRef: 'q-1', request },
    NOW - 9 * D,
  );
  store?.settleAsk(request.request_id, option, NOW - 9 * D);
  store?.clear(request.request_id, NOW - 9 * D);
  store?.takeUp(request.request_id, 'did:plc:buyer po-1', NOW - 8 * D);
  store?.receipt(request.request_id, { answer: 'admitted', atMs: NOW - 8 * D }, NOW - 8 * D);
}

describe('evidence on a node', () => {
  it('EH-01: did the run happen?', async () => {
    boundRun();
    expect(await runEvidenceTick(NOW)).toBe(1);
    const card = workflow
      .store()
      .getByCorrelationId('q-1')
      .find((t) => t.payload.includes('evidence_ask'));
    expect(card?.description).toMatch(
      /Did your shipper run the delivery they promised for 2026-11-10\?/,
    );
    expect(await runEvidenceTick(NOW + 3600_000)).toBe(0); // asked once
    workflow.cancel(card?.id ?? '', 'denied_by_operator'); // the owner's no
    expect(getEvidenceStore()?.forCounterparty(SHIPPER)).toMatchObject([
      {
        subject: 'run',
        item: 'opt-1',
        occurrence: '2026-11-10',
        outcome: 'broken',
        fault: 'counterparty',
        source: 'owner',
      },
    ]);
    expect(await runEvidenceTick(NOW + 2 * 3600_000)).toBe(0); // recorded: not asked again
  });

  it("EH-02: the other side's weekly promise, one card per day it fell due", async () => {
    installCommerceRuntime({
      terms: {
        agreements: () => [
          {
            proposalDigest: 'deal-1',
            role: 'host',
            counterpartyDid: BRAND,
            state: 'accepted',
            resourceRef: 'slot-3',
            general: { start: '2026-11-02T00:00:00Z', end: '2027-02-01T00:00:00Z' },
            terms: [],
            promises: [
              { name: 'stock_run', by: 'buyer', dimensions: { crates: '2', day: 'wed' } },
              { name: 'shelf_clean', by: 'seller', dimensions: { day: 'mon' } },
            ],
            endsAt: '2027-02-01T00:00:00Z',
            delivery: null,
          },
        ],
      },
    } as unknown as CommerceRuntime);
    // Wednesday the 4th and the 11th are over by Thursday the 12th.
    expect(await runEvidenceTick(NOW)).toBe(2);
    const card = workflow
      .store()
      .getByCorrelationId('deal-1')
      .find((t) => t.description?.includes('2026-11-04') === true);
    expect(card?.description).toMatch(/on 2026-11-04: stock run \(crates 2, day wed\)/);
    workflow.approve(card?.id ?? '');
    expect(getEvidenceStore()?.forCounterparty(BRAND)).toMatchObject([
      {
        subject: 'promise',
        item: 'stock_run',
        occurrence: '2026-11-04',
        outcome: 'kept',
        fault: 'none',
      },
    ]);
    expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
  });

  it('EH-03: a no-fault lapse is recorded on both sides, against nobody', async () => {
    const store = getSellerOptionStore();
    const request = {
      v: 1 as const,
      kind: 'request' as const,
      request_id: option.request_id,
      service_at: RUN_AT,
      crates: 1,
      postal_code: '560001',
    };
    store?.ask(
      { requestId: request.request_id, shipperDid: SHIPPER, dealRef: 'q-1', request },
      NOW - 9 * D,
    );
    store?.settleAsk(request.request_id, option, NOW - 9 * D);
    store?.clear(request.request_id, NOW - 9 * D);
    store?.takeUp(request.request_id, 'did:plc:buyer po-1', NOW - 8 * D);
    store?.receipt(
      request.request_id,
      { answer: 'arrived_after_grace', atMs: NOW - 2 * D },
      NOW - 2 * D,
    );
    // The shipper's side of the same run (here on the same database).
    getShipperOptionStore()?.issue(SELLER, option, '2026-11-10', NOW - 9 * D);
    getShipperOptionStore()?.answer(SELLER, option.option_id, {
      answer: 'arrived_after_grace',
      atMs: NOW - 2 * D,
    });
    await runEvidenceTick(NOW);
    expect(getEvidenceStore()?.forCounterparty(SHIPPER)).toMatchObject([
      {
        subject: 'run',
        outcome: 'no_fault',
        fault: 'none',
        source: 'protocol',
        facts: { answer: 'arrived_after_grace' },
      },
    ]);
    expect(getEvidenceStore()?.forCounterparty(SELLER)).toMatchObject([
      {
        subject: 'run',
        outcome: 'no_fault',
        fault: 'none',
        facts: { answer: 'arrived_after_grace' },
      },
    ]);
    expect(getEvidenceStore()?.forCounterparty(SHIPPER)[0]?.facts.accepted_at).toBe(
      new Date(NOW - 8 * D).toISOString(),
    );
  });

  it('EH-04: consent', async () => {
    expect(await setOwnerConsent(BRAND, true, NOW)).toBe(true);
    expect(sent).toEqual([
      {
        to: BRAND,
        type: 'commitment.consent',
        body: { v: 1, on: true, rev: NOW, at: new Date(NOW).toISOString() },
      },
    ]);
    expect(
      handleConsentMessage(BRAND, { v: 1, on: true, rev: 2, at: '2026-11-12T09:00:00.000Z' }, NOW),
    ).toBe('kept');
    expect(getEvidenceStore()?.consent(BRAND)).toEqual({ self: true, peer: true });
    // A delayed older word does not undo it; a replay is ignored.
    expect(
      handleConsentMessage(BRAND, { v: 1, on: false, rev: 1, at: '2026-11-11T09:00:00.000Z' }, NOW),
    ).toBe('refused');
    expect(
      handleConsentMessage(BRAND, { v: 1, on: true, rev: 2, at: '2026-11-12T09:00:00.000Z' }, NOW),
    ).toBe('refused');
    expect(getEvidenceStore()?.consent(BRAND)).toEqual({ self: true, peer: true });
    expect(handleConsentMessage(BRAND, { v: 2, on: false }, NOW)).toBe('refused');
  });

  it('EH-05: a consent the sender did not take is sent again', async () => {
    setD2DSender(async () => {
      throw new Error('relay down');
    });
    await setOwnerConsent(BRAND, true, NOW);
    expect(getEvidenceStore()?.untold()).toEqual([
      { counterpartyDid: BRAND, on: true, rev: NOW, ask: '', echo: '' },
    ]);
    setD2DSender(async (to, type, body) => {
      sent.push({ to, type, body });
      return { messageId: 'm', delivered: false, buffered: true, queued: false };
    });
    await runEvidenceTick(NOW + 3600_000);
    expect(sent.map((m) => m.type)).toEqual(['commitment.consent']);
    expect(getEvidenceStore()?.untold()).toEqual([]);
  });

  it('EH-06: an answer a crash kept from being recorded is recorded by the tick', async () => {
    boundRun();
    await runEvidenceTick(NOW);
    const card = workflow
      .store()
      .getByCorrelationId('q-1')
      .find((t) => t.payload.includes('evidence_ask'));
    // The owner's yes lands, but nothing records it.
    new WorkflowService({ repository: repo, nowMsFn: () => NOW }).approve(card?.id ?? '');
    expect(getEvidenceStore()?.forCounterparty(SHIPPER)).toEqual([]);
    await runEvidenceTick(NOW + 3600_000);
    expect(getEvidenceStore()?.forCounterparty(SHIPPER)).toMatchObject([
      { outcome: 'kept', source: 'owner' },
    ]);
    expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
  });

  it('EH-07: a shelf answer a crash kept from being recorded is recovered long after its day', async () => {
    installCommerceRuntime({
      terms: {
        agreements: () => [
          {
            proposalDigest: 'deal-1',
            role: 'host',
            counterpartyDid: BRAND,
            state: 'accepted',
            resourceRef: 'slot-3',
            general: { start: '2026-11-02T00:00:00Z', end: '2027-02-01T00:00:00Z' },
            terms: [],
            promises: [{ name: 'stock_run', by: 'buyer', dimensions: { day: 'wed' } }],
            endsAt: '2027-02-01T00:00:00Z',
            delivery: null,
          },
        ],
      },
    } as unknown as CommerceRuntime);
    await runEvidenceTick(NOW);
    const card = workflow
      .store()
      .getByCorrelationId('deal-1')
      .find((t) => t.description?.includes('2026-11-04') === true);
    new WorkflowService({ repository: repo, nowMsFn: () => NOW }).approve(card?.id ?? '');
    // A month later the 4th is far outside the look-back; the answer is still kept.
    await runEvidenceTick(NOW + 30 * D);
    expect(getEvidenceStore()?.forCounterparty(BRAND)).toMatchObject([
      { occurrence: '2026-11-04', outcome: 'kept' },
    ]);
  });

  it('EH-08: a restored node asks with a challenge; only the echoing reply counts', async () => {
    // This node answers a restored peer's challenge with its own switch.
    await setOwnerConsent(BRAND, true, NOW);
    sent.length = 0;
    const nonce = 'ab'.repeat(16);
    expect(
      handleConsentMessage(
        BRAND,
        { v: 1, on: false, rev: NOW + 1, ask: nonce, at: '2026-11-12T09:00:00.000Z' },
        NOW,
      ),
    ).toBe('kept');
    await runEvidenceTick(NOW + 60_000);
    expect(sent).toMatchObject([
      { to: BRAND, type: 'commitment.consent', body: { on: true, reply_to: nonce } },
    ]);
    // A restored node of its own: the other side's word forgotten, a challenge out.
    db.execute(
      `UPDATE commitment_evidence_consent SET peer_on = 0, peer_rev = 0, ask_peer = 1, ask_nonce = ? WHERE counterparty_did = ?`,
      ['cd'.repeat(16), BRAND],
    );
    // A delayed message from before the restore does not stand in for their word.
    expect(
      handleConsentMessage(
        BRAND,
        { v: 1, on: true, rev: NOW + 5, at: '2026-11-12T09:00:00.000Z' },
        NOW,
      ),
    ).toBe('refused');
    expect(getEvidenceStore()?.consent(BRAND).peer).toBe(false);
    // Asked again on each tick until the echoing reply comes.
    sent.length = 0;
    await runEvidenceTick(NOW + 2 * 60_000);
    expect(sent[0]?.body).toMatchObject({ ask: 'cd'.repeat(16) });
    expect(
      handleConsentMessage(
        BRAND,
        {
          v: 1,
          on: false,
          rev: NOW + 6,
          reply_to: 'cd'.repeat(16),
          at: '2026-11-12T09:00:00.000Z',
        },
        NOW,
      ),
    ).toBe('kept');
    expect(getEvidenceStore()?.consent(BRAND).peer).toBe(false);
    expect(getEvidenceStore()?.untold()).toEqual([]);
  });

  it('EH-09: a revocation that overtakes the echoing reply still stands', async () => {
    await setOwnerConsent(BRAND, true, NOW);
    db.execute(
      `UPDATE commitment_evidence_consent SET peer_on = 0, peer_rev = 0, ask_peer = 1, ask_nonce = ? WHERE counterparty_did = ?`,
      ['ef'.repeat(16), BRAND],
    );
    // Their revocation (rev 11) arrives first, without the echo; then their older echoing yes (rev 10).
    expect(
      handleConsentMessage(
        BRAND,
        { v: 1, on: false, rev: 11, at: '2026-11-12T09:00:00.000Z' },
        NOW,
      ),
    ).toBe('refused');
    expect(
      handleConsentMessage(
        BRAND,
        { v: 1, on: true, rev: 10, reply_to: 'ef'.repeat(16), at: '2026-11-12T09:00:00.000Z' },
        NOW,
      ),
    ).toBe('kept');
    expect(getEvidenceStore()?.consent(BRAND).peer).toBe(false);
  });

  it('EH-10: a yes recorded before a crash, its card left open: the tick closes it', async () => {
    boundRun();
    await runEvidenceTick(NOW);
    const card = workflow
      .store()
      .getByCorrelationId('q-1')
      .find((t) => t.payload.includes('evidence_ask'));
    new WorkflowService({ repository: repo, nowMsFn: () => NOW }).approve(card?.id ?? '');
    // The record landed; the card did not close.
    getEvidenceStore()?.record({
      counterpartyDid: SHIPPER,
      dealRef: 'q-1',
      subject: 'run',
      item: 'opt-1',
      occurrence: '2026-11-10',
      outcome: 'kept',
      fault: 'none',
      source: 'owner',
      note: '',
      facts: {},
      recordedAt: NOW,
    });
    // The first try to close fails: the ask is kept for the next tick.
    const complete = workflow.complete.bind(workflow);
    workflow.complete = () => {
      throw new Error('disk full');
    };
    await runEvidenceTick(NOW + 3600_000);
    expect(getEvidenceStore()?.openAsks()).toHaveLength(1);
    workflow.complete = complete;
    await runEvidenceTick(NOW + 2 * 3600_000);
    expect(workflow.store().getById(card?.id ?? '')?.status).toBe('completed');
    expect(getEvidenceStore()?.openAsks()).toEqual([]);
  });
});
