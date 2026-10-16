/**
 * COMMITMENT_KERNEL §13, §15 step 8 — the owner's evidence routes.
 *
 *   ER-01 the owner reads a relationship's records, its summary and both
 *         switches; Brain may not;
 *   ER-02 the owner amends their own answer; a protocol record is not theirs;
 *   ER-03 turning sharing on needs a person present; turning it off does not.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import { getEvidenceStore, installEvidenceStore } from '../../../src/commitment/evidence_handler';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerEvidenceRoutes } from '../../../src/server/routes/commitment_evidence';
import { setD2DSender } from '../../../src/server/routes/d2d_msg';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

const BRAND = 'did:plc:brand';
const OWNER_CAP = 'test-owner-capability';
let dir: string;
let db: NodeSQLiteAdapter;
let router: CoreRouter;

function call(
  method: 'GET' | 'POST' | 'PUT',
  p: string,
  body: unknown,
  query: Record<string, string> = {},
  callerType?: string,
): CoreRequest {
  return {
    method,
    path: p,
    query,
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined
      ? { callerType, callerDID: 'did:key:brain' }
      : { callerType: 'owner', ownerCapability: OWNER_CAP }),
  } as unknown as CoreRequest;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-evidence-routes-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  installEvidenceStore(db);
  setD2DSender(async () => undefined);
  installOwnerPresenceVerifier(async (p) => p === 'correct horse');
  router = new CoreRouter();
  registerEvidenceRoutes(router, OWNER_CAP);
  for (const [occurrence, outcome] of [
    ['2026-11-04', 'kept'],
    ['2026-11-11', 'broken'],
  ] as const)
    getEvidenceStore()?.record({
      counterpartyDid: BRAND,
      dealRef: 'deal-1',
      subject: 'promise',
      item: 'stock_run',
      occurrence,
      outcome,
      fault: outcome === 'broken' ? 'counterparty' : 'none',
      source: 'owner',
      note: '',
      facts: {},
      recordedAt: 1,
    });
});
afterEach(() => {
  installEvidenceStore(null);
  setD2DSender(null);
  installOwnerPresenceVerifier(null);
  clearOwnerPresence();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the owner's evidence routes", () => {
  it('ER-01: read by the owner, not by Brain', async () => {
    const res = await router.handle(
      call('GET', '/v1/commitment/evidence', undefined, { counterparty_did: BRAND }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      summary: { kept: 1, of: 2, no_fault: 0 },
      consent: { yours: false, theirs: false, shareable: false },
    });
    const brain = await router.handle(
      call('GET', '/v1/commitment/evidence', undefined, { counterparty_did: BRAND }, 'brain'),
    );
    expect(brain.status).toBe(403);
  });

  it("ER-02: amending one's own answer", async () => {
    const id = getEvidenceStore()?.forCounterparty(BRAND)[1]?.evidenceId ?? '';
    const res = await router.handle(
      call('POST', '/v1/commitment/evidence/amend', {
        evidence_id: id,
        outcome: 'kept',
        note: 'it came late',
      }),
    );
    expect(res).toMatchObject({ status: 200, body: { outcome: 'kept' } });
    expect(
      (
        await router.handle(
          call('POST', '/v1/commitment/evidence/amend', { evidence_id: 'nope', outcome: 'kept' }),
        )
      ).status,
    ).toBe(404);
  });

  it('ER-03: sharing on needs a person present; off does not', async () => {
    const on = () =>
      router.handle(
        call('PUT', '/v1/commitment/evidence/consent', { counterparty_did: BRAND, on: true }),
      );
    expect((await on()).status).toBe(403);
    await proveOwnerPresence('correct horse', Date.now(), OWNER_IN_PROCESS_PRINCIPAL);
    expect((await on()).status).toBe(200);
    expect(getEvidenceStore()?.consent(BRAND).self).toBe(true);
    clearOwnerPresence();
    const off = await router.handle(
      call('PUT', '/v1/commitment/evidence/consent', { counterparty_did: BRAND, on: false }),
    );
    expect(off.status).toBe(200);
  });
});
