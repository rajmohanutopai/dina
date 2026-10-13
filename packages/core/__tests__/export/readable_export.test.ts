/** REAL_LIFE_FIXES_2 §5 — the owner's readable export: manifest to Brain, document to the owner, once. */

import { cancelReadableExports, prepareReadableExport, takeReadableExport } from '../../src/export/readable';
import { setNodeDID } from '../../src/pairing/ceremony';
import { closePersona, createPersona, openPersona, resetPersonaState } from '../../src/persona/service';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerOwnerExportRoutes } from '../../src/server/routes/owner_export';
import { storeItem } from '../../src/vault/crud';
import { InMemoryVaultRepository, setVaultRepository } from '../../src/vault/repository';

const CAP = 'cap-export';

beforeEach(() => {
  resetPersonaState();
  setNodeDID('did:plc:owner');
  for (const [name, tier] of [['general', 'default'], ['finance', 'locked']] as const) {
    createPersona(name, tier);
    openPersona(name, true);
    setVaultRepository(name, new InMemoryVaultRepository());
  }
  storeItem('general', { type: 'note', summary: 'bike lock code 1234', body: 'bike lock code 1234' });
  storeItem('finance', { type: 'note', summary: 'mortgage with Halcyon', body: 'mortgage with Halcyon' });
  cancelReadableExports();
});

function req(method: CoreRequest['method'], path: string, caller: 'brain' | 'owner'): CoreRequest {
  return {
    method,
    path,
    query: {},
    headers: {},
    body: null,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: caller,
    ...(caller === 'owner' ? { ownerCapability: CAP } : {}),
  } as CoreRequest;
}

it('a locked persona is excluded while closed and included once unlocked', async () => {
  closePersona('finance');
  const closed = await prepareReadableExport();
  expect(closed.manifest.personas.find((p) => p.persona === 'finance')).toMatchObject({ included: false, why: expect.stringMatching(/passphrase/) });
  openPersona('finance', true);
  const open = await prepareReadableExport();
  expect(open.manifest.personas.find((p) => p.persona === 'finance')).toMatchObject({ included: true, items: 1 });
});

it('Brain gets a manifest and an id, never the document; the owner takes it once', async () => {
  const router = new CoreRouter();
  registerOwnerExportRoutes(router, CAP);
  const prep = await router.handle(req('POST', '/v1/owner-export/prepare', 'brain'));
  expect(prep.status).toBe(200);
  const { id } = prep.body as { id: string };
  expect(JSON.stringify(prep.body)).not.toContain('bike lock code');
  expect((await router.handle({ ...req('GET', `/v1/owner-export/${id}`, 'brain'), params: { id } })).status).toBe(403);
  const doc = await router.handle({ ...req('GET', `/v1/owner-export/${id}`, 'owner'), params: { id } });
  expect(doc.status).toBe(200);
  expect(JSON.stringify(doc.body)).toContain('bike lock code 1234');
  expect((await router.handle({ ...req('GET', `/v1/owner-export/${id}`, 'owner'), params: { id } })).status).toBe(404);
});

it('expires, and a forget cancels exports not yet taken', async () => {
  const a = await prepareReadableExport(1_000);
  expect(takeReadableExport(a.id, 1_000 + 16 * 60_000)).toBeNull();
  const b = await prepareReadableExport();
  expect(cancelReadableExports()).toBe(1);
  expect(takeReadableExport(b.id)).toBeNull();
});

it('a forget during preparation leaves no export holding the forgotten item', async () => {
  const { setTopicRepository, InMemoryTopicRepository } = await import('../../src/memory/repository');
  const { getVaultRepository } = await import('../../src/vault/repository');
  const id = storeItem('general', { type: 'note', summary: 'Vesna owes rent', body: 'Vesna owes rent' });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let paused = false;
  const slow = new InMemoryTopicRepository();
  const top = slow.top.bind(slow);
  slow.top = async (...a: Parameters<typeof top>) => {
    if (!paused) {
      paused = true;
      await gate; // preparation stops here, after reading the vault
    }
    return top(...a);
  };
  setTopicRepository('general', slow);
  const pending = prepareReadableExport();
  await new Promise((r) => setTimeout(r, 10));
  getVaultRepository('general')!.forgetItemSync(id);
  cancelReadableExports();
  release();
  const out = await pending;
  expect(takeReadableExport(out.id)).not.toMatch(/Vesna/);
  setTopicRepository('general', null);
});
