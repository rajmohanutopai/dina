/**
 * The node's directory publication (design §8.2, §9, M5): the projection
 * revision every card-affecting write bumps in its own transaction (the
 * triggers), the row and its defaults, the owner's switch, the publication
 * predicate, and the guarded steps the publisher drives, each refusing to
 * land once anything it was built on has moved. Then the owner routes.
 */

import {
  beginDeactivation,
  bindRunner,
  claimAttempt,
  completeDeactivation,
  completePublish,
  completeUnpublish,
  ensurePublication,
  failAttempt,
  installA2APublisher,
  publicationEligible,
  readPublication,
  recordActivation,
  recordFenceKey,
  recordStandDown,
  setDirectoryListing,
  unbindRunner,
  type A2APublisherPort,
  type PublicationAttempt,
  type PublicationRow,
} from '../../src/a2a';
import { newA2AId } from '../../src/a2a/ids';
import { isAuthorized } from '../../src/auth/authz';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';
import { clearServiceConfigDurable } from '../../src/service/service_config';

import { InboundWorld, listing, save } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => {
  installA2APublisher(null);
  iw.close();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const row = (): PublicationRow => {
  const r = readPublication(iw.world.store);
  if (r === null) throw new Error('no publication');
  return r;
};
const revision = () => row().card_projection_revision;
const make = () => ensurePublication(iw.world.store, iw.world.clock, newA2AId);

describe('the projection revision: every card-affecting write bumps it, in its own transaction', () => {
  it('a listing saved, changed, or deleted', async () => {
    make();
    const before = revision();
    await save(listing({ name: 'Bus 43' }), 'other');
    expect(revision()).toBeGreaterThan(before);
    const afterSave = revision();
    await save(listing({ name: 'Bus 44' }), 'other');
    expect(revision()).toBeGreaterThan(afterSave);
    const afterEdit = revision();
    await clearServiceConfigDurable('other');
    expect(revision()).toBeGreaterThan(afterEdit);
  });

  it('a runner bound to, or unbound from, a lane a listing names', () => {
    make();
    const before = revision();
    expect(unbindRunner(iw.world.store, 'transit', iw.world.clock).ok).toBe(true);
    expect(revision()).toBeGreaterThan(before);
    const afterUnbind = revision();
    bindRunner(iw.world.store, { lane: 'transit', device_did: iw.runnerDid }, iw.world.clock);
    expect(revision()).toBeGreaterThan(afterUnbind);
  });

  it('a plugin install made, changed, or removed', () => {
    make();
    const db = iw.world.store.db;
    const before = revision();
    db.execute(
      `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode, current_cid,
         current_version, manifest_json, install_scope_hash, capability_hashes_json, behavior_hash,
         presentation_hash, trust_anchor_json, created_at, updated_at)
       VALUES ('pi-1', 'did:plc:pub', 'p', 'active', 'runner', 'bafy', '1.0.0', '{}', 'h', '{}', 'h', 'h', '{}', 1, 1)`,
    );
    expect(revision()).toBe(before + 1);
    db.execute(`UPDATE plugin_installs SET status = 'paused', pause_reason = 'manual' WHERE install_id = 'pi-1'`);
    expect(revision()).toBe(before + 2);
    db.execute(`DELETE FROM plugin_installs WHERE install_id = 'pi-1'`);
    expect(revision()).toBe(before + 3);
  });

  it('before the row exists, writes go through and change nothing', async () => {
    expect(readPublication(iw.world.store)).toBeNull();
    await save(listing({ name: 'Bus 45' }), 'later');
    expect(readPublication(iw.world.store)).toBeNull();
    expect(make().card_projection_revision).toBe(0);
  });
});

describe('the row', () => {
  it('starts switched off, inactive, unpublished, under a fresh UUID instance', () => {
    const r = make();
    expect(r).toEqual(
      expect.objectContaining({
        listing_enabled: 0,
        publication_active: 0,
        state: 'not_published',
        publisher_epoch: 0,
        fencing_generation: 0,
        freshness_epoch: 0,
        card_maybe_present: 0,
        fence_key_id: null,
      }),
    );
    expect(r.publisher_instance).toMatch(UUID);
    // Made once: a second call keeps the instance.
    expect(make().publisher_instance).toBe(r.publisher_instance);
  });

  it('the switch bumps the projection either way, and drops an earlier failure’s backoff: the owner just acted', () => {
    const before = make().card_projection_revision;
    expect(setDirectoryListing(iw.world.store, true, iw.world.clock, newA2AId)).toEqual(
      expect.objectContaining({ listing_enabled: 1, card_projection_revision: before + 1 }),
    );
    iw.world.store.db.execute(`UPDATE a2a_card_publication SET attempts = 3, next_retry_at = ? WHERE id = 1`, [iw.world.clock + 600_000]);
    expect(setDirectoryListing(iw.world.store, false, iw.world.clock, newA2AId)).toEqual(
      expect.objectContaining({ listing_enabled: 0, card_projection_revision: before + 2, attempts: 0, next_retry_at: null }),
    );
  });

  it('fresh installs and upgrades start switched off: discoverable listings never imply the directory', async () => {
    // A node upgraded with listings of both kinds (§8.2: no aggregate default is inferred).
    await save(listing({ name: 'Open' }), 'open');
    await save({ ...listing({ name: 'Closed' }), isDiscoverable: false }, 'closed');
    const r = make();
    expect(r.listing_enabled).toBe(0);
    expect(publicationEligible({ ...r, publication_active: 1 }, { gatewayLive: true, projectableSkills: 2 })).toBe(false);
  });
});

describe('the publication predicate (design §8.2)', () => {
  const live = { gatewayLive: true, projectableSkills: 1 };
  const base = (over: Partial<PublicationRow>): PublicationRow => ({
    ...make(),
    listing_enabled: 1,
    publication_active: 1,
    state: 'published',
    ...over,
  });

  it('holds only when every condition does', () => {
    expect(publicationEligible(base({}), live)).toBe(true);
    expect(publicationEligible(base({ listing_enabled: 0 }), live)).toBe(false);
    expect(publicationEligible(base({ publication_active: 0 }), live)).toBe(false);
    expect(publicationEligible(base({ state: 'stood_down' }), live)).toBe(false);
    expect(publicationEligible(base({ state: 'deactivating' }), live)).toBe(false);
    expect(publicationEligible(base({}), { ...live, gatewayLive: false })).toBe(false);
    expect(publicationEligible(base({}), { ...live, projectableSkills: 0 })).toBe(false);
    for (const state of ['pending', 'published', 'failed', 'not_published'] as const) {
      expect(publicationEligible(base({ state }), live)).toBe(true);
    }
  });
});

describe('the guarded steps: an attempt lands only on the state it was built on', () => {
  const attemptFor = (r: PublicationRow, over: Partial<PublicationAttempt> = {}): PublicationAttempt => ({
    operation_kind: 'publish',
    card_projection_revision: r.card_projection_revision,
    freshness_epoch: r.freshness_epoch,
    publisher_epoch: r.publisher_epoch,
    publisher_instance: r.publisher_instance,
    fencing_generation: r.fencing_generation,
    desired_card_hash: 'a'.repeat(64),
    attempted_record_digest: 'b'.repeat(64),
    signing_key_id: KEY,
    ...over,
  });
  const claim = (a: PublicationAttempt) =>
    claimAttempt(iw.world.store, a, { priorCid: null, repoCommitCid: 'bafyhead' }, iw.world.clock);
  const KEY = 'ab'.repeat(32);
  const activate = () => {
    const r = make();
    setDirectoryListing(iw.world.store, true, iw.world.clock, newA2AId);
    expect(recordActivation(iw.world.store, { fencingGeneration: r.fencing_generation, epoch: 1, keyId: KEY, nowMs: iw.world.clock })).toBe(true);
    return row();
  };

  it('a claimed publish completes, and the record is the published one, under this epoch and key', () => {
    const a = attemptFor(activate());
    expect(claim(a)).toBe(true);
    expect(row()).toEqual(expect.objectContaining({ state: 'pending', card_maybe_present: 1 }));
    expect(completePublish(iw.world.store, a, { uri: 'at://d/c/self', cid: 'bafyrec' }, iw.world.clock)).toBe(true);
    expect(row()).toEqual(
      expect.objectContaining({
        state: 'published',
        last_published_cid: 'bafyrec',
        last_published_card_hash: 'a'.repeat(64),
        published_revision: a.card_projection_revision,
        published_publisher_epoch: 1,
        published_key_id: KEY,
        attempt_tuple_json: null,
      }),
    );
  });

  it('a publish claim needs the node active, switched on, and neither stood down nor deactivating; an unpublish only active', () => {
    const fresh = make();
    // Inactive: neither operation.
    expect(claim(attemptFor(fresh))).toBe(false);
    expect(claim(attemptFor(fresh, { operation_kind: 'unpublish' }))).toBe(false);
    activate();
    // Switched off: an unpublish, never a publish.
    setDirectoryListing(iw.world.store, false, iw.world.clock, newA2AId);
    expect(claim(attemptFor(row()))).toBe(false);
    expect(claim(attemptFor(row(), { operation_kind: 'unpublish' }))).toBe(true);
    setDirectoryListing(iw.world.store, true, iw.world.clock, newA2AId);
    // Deactivating keeps the one authority: the delete.
    expect(beginDeactivation(iw.world.store, iw.world.clock)).toBe(true);
    expect(claim(attemptFor(row()))).toBe(false);
    expect(claim(attemptFor(row(), { operation_kind: 'unpublish' }))).toBe(true);
    expect(row().state).toBe('deactivating');
    // Stood down: nothing at all.
    recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, row().fencing_generation);
    expect(claim(attemptFor(row()))).toBe(false);
    expect(claim(attemptFor(row(), { operation_kind: 'unpublish' }))).toBe(false);
  });

  it('a claim refuses a projection or a generation that moved', async () => {
    const r = activate();
    await save(listing({ name: 'Moved' }), 'moved');
    expect(claim(attemptFor(r))).toBe(false);
    expect(claim(attemptFor(row(), { fencing_generation: row().fencing_generation - 1 }))).toBe(false);
    expect(claim(attemptFor(row()))).toBe(true);
  });

  it.each([
    ['a stand-down', () => recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, row().fencing_generation)],
    ['a deactivation', () => beginDeactivation(iw.world.store, iw.world.clock)],
    ['a newer claim', () => claim(attemptFor(row(), { attempted_record_digest: 'c'.repeat(64) }))],
  ])('a late completion after %s writes nothing', (_name, between) => {
    const a = attemptFor(activate());
    expect(claim(a)).toBe(true);
    between();
    expect(completePublish(iw.world.store, a, { uri: 'at://d/c/self', cid: 'bafylate' }, iw.world.clock)).toBe(false);
    expect(failAttempt(iw.world.store, a, iw.world.clock + 1000, iw.world.clock)).toBe(false);
    expect(row().last_published_cid).not.toBe('bafylate');
  });

  it('a failed publish is released for a retry, counted, and the card stays maybe present: the write may have landed', () => {
    const a = attemptFor(activate());
    claim(a);
    expect(failAttempt(iw.world.store, a, iw.world.clock + 5000, iw.world.clock)).toBe(true);
    expect(row()).toEqual(
      expect.objectContaining({ state: 'failed', attempts: 1, next_retry_at: iw.world.clock + 5000, attempt_tuple_json: null, card_maybe_present: 1 }),
    );
  });

  it('an unpublish clears what was published, and only it clears the evidence bit', () => {
    const r = activate();
    const pub = attemptFor(r);
    claim(pub);
    completePublish(iw.world.store, pub, { uri: 'at://d/c/self', cid: 'bafyrec' }, iw.world.clock);
    setDirectoryListing(iw.world.store, false, iw.world.clock, newA2AId);
    const un = attemptFor(row(), { operation_kind: 'unpublish', desired_card_hash: null, attempted_record_digest: null });
    expect(claim(un)).toBe(true);
    expect(completeUnpublish(iw.world.store, un, iw.world.clock)).toBe(true);
    expect(row()).toEqual(
      expect.objectContaining({
        state: 'not_published',
        card_maybe_present: 0,
        last_published_cid: null,
        published_revision: null,
        published_key_id: null,
        published_publisher_epoch: null,
      }),
    );
    // A publish claimed after that marks the card maybe present again: its write may land unheard.
    setDirectoryListing(iw.world.store, true, iw.world.clock, newA2AId);
    expect(claim(attemptFor(row()))).toBe(true);
    expect(row().card_maybe_present).toBe(1);
  });

  it('an activation marks the card maybe present: a handoff leaves the previous holder’s card under the new fence', () => {
    expect(make().card_maybe_present).toBe(0);
    expect(activate().card_maybe_present).toBe(1);
  });

  it('a stand-down judged against a row an activation has since moved lands nothing', () => {
    const before = activate();
    expect(recordActivation(iw.world.store, { fencingGeneration: before.fencing_generation, epoch: 2, keyId: KEY, nowMs: iw.world.clock })).toBe(true);
    expect(recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, before.fencing_generation)).toBe(false);
    expect(row()).toEqual(expect.objectContaining({ publication_active: 1, publisher_epoch: 2, notice: null }));
    expect(recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, row().fencing_generation)).toBe(true);
    expect(row().state).toBe('stood_down');
  });

  it('the fence key is recorded at activation and after a re-sign, guarded on the generation', () => {
    const r = activate();
    expect(r.fence_key_id).toBe(KEY);
    expect(recordFenceKey(iw.world.store, { fencingGeneration: r.fencing_generation, keyId: 'cd'.repeat(32), nowMs: iw.world.clock })).toBe(true);
    expect(row().fence_key_id).toBe('cd'.repeat(32));
    recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, row().fencing_generation);
    expect(recordFenceKey(iw.world.store, { fencingGeneration: row().fencing_generation, keyId: KEY, nowMs: iw.world.clock })).toBe(false);
    expect(row().fence_key_id).toBe('cd'.repeat(32));
  });

  it('activation is guarded on the generation it began under, and clears a stand-down', () => {
    const r = make();
    recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, row().fencing_generation);
    expect(recordActivation(iw.world.store, { fencingGeneration: r.fencing_generation, epoch: 5, keyId: KEY, nowMs: iw.world.clock })).toBe(false);
    expect(recordActivation(iw.world.store, { fencingGeneration: row().fencing_generation, epoch: 5, keyId: KEY, nowMs: iw.world.clock })).toBe(true);
    expect(row()).toEqual(expect.objectContaining({ publication_active: 1, publisher_epoch: 5, state: 'not_published', notice: null }));
  });

  it('deactivation is two-phase: only from active, and completed only from deactivating', () => {
    make();
    expect(beginDeactivation(iw.world.store, iw.world.clock)).toBe(false);
    activate();
    expect(completeDeactivation(iw.world.store, iw.world.clock)).toBe(false);
    expect(beginDeactivation(iw.world.store, iw.world.clock)).toBe(true);
    expect(row().state).toBe('deactivating');
    expect(completeDeactivation(iw.world.store, iw.world.clock)).toBe(true);
    expect(row()).toEqual(expect.objectContaining({ state: 'not_published', publication_active: 0 }));
  });
});

describe('the owner routes', () => {
  const CAP = 'owner-capability-for-tests';
  const router = new CoreRouter();
  registerA2ARoutes(router, CAP);
  const owner = (method: 'GET' | 'POST', path: string, body: unknown = {}) =>
    router.handle({
      method,
      path,
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      ownerCapability: CAP,
    } as unknown as CoreRequest);

  const ROUTES = [
    ['GET', '/v1/owner/a2a/publisher'],
    ['POST', '/v1/owner/a2a/directory-listing'],
    ['POST', '/v1/owner/a2a/publisher/activate'],
    ['POST', '/v1/owner/a2a/publisher/deactivate'],
  ] as const;

  it.each(ROUTES)('%s %s is the owner’s alone: Brain cannot publish, in one process or two', async (method, path) => {
    // Two processes: Brain's signed service identity never passes the authz matrix.
    for (const caller of ['brain', 'connector', 'agent', 'plugin', 'device'] as const) {
      expect(isAuthorized(caller, method, path)).toBe(false);
    }
    // One process (the phone): the handler's guard refuses every caller but the owner.
    const brain = await router.handle({
      method,
      path,
      query: {},
      headers: {},
      body: { enabled: true },
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'brain',
      callerDID: 'did:key:brain',
    } as unknown as CoreRequest);
    expect(brain.status).toBe(403);
  });

  it('the switch: a boolean, or 400; the view after', async () => {
    expect((await owner('POST', '/v1/owner/a2a/directory-listing', { enabled: 'yes' })).status).toBe(400);
    const on = await owner('POST', '/v1/owner/a2a/directory-listing', { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toEqual(expect.objectContaining({ listing_enabled: true, active: false, eligible: false }));
    expect((await owner('GET', '/v1/owner/a2a/publisher')).body).toEqual(expect.objectContaining({ listing_enabled: true }));
  });

  it('activation and deactivation go to the host’s publisher, or 503 without one', async () => {
    expect((await owner('POST', '/v1/owner/a2a/publisher/activate')).status).toBe(503);
    const calls: string[] = [];
    const port: A2APublisherPort = {
      activate: async (o) => {
        calls.push(`activate:${String(o.refence)}`);
        return { ok: false, reason: 'fence_unverifiable' };
      },
      deactivate: async () => {
        calls.push('deactivate');
        return { ok: true };
      },
      nudge: () => calls.push('nudge'),
    };
    installA2APublisher(port);
    expect(await owner('POST', '/v1/owner/a2a/publisher/activate', { refence: 'no' })).toEqual(
      expect.objectContaining({ status: 400 }),
    );
    expect(await owner('POST', '/v1/owner/a2a/publisher/activate', { refence: true })).toEqual(
      expect.objectContaining({ status: 409, body: { error: 'fence_unverifiable' } }),
    );
    expect((await owner('POST', '/v1/owner/a2a/publisher/deactivate')).status).toBe(200);
    await owner('POST', '/v1/owner/a2a/directory-listing', { enabled: false });
    expect(calls).toEqual(['activate:true', 'deactivate', 'nudge']);
  });
});
