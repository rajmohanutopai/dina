/**
 * Lane 3's state in Core (design §8.2, §9; plan §3.8; notes "M5 steps
 * 1–2"): the rules the first test set left open. The projection revision
 * under the plugin-update rebind and under a rolled-back write; the guarded
 * steps against an epoch, an instance, a moved row; the owner routes
 * against every other caller; the owner's view of a stand-down; and the
 * card itself: byte-stable for one key, new bytes and a new key set
 * together for another, and what another Dina's Lane 1 pin makes of each.
 */

import { p256 } from '@noble/curves/nist.js';

import { canonicalize, verifyAgentCardSignatures, type JsonValue } from '@dina/a2a';

import {
  A2A_JWKS_PATH,
  beginDeactivation,
  buildInboundCard,
  claimAttempt,
  completeDeactivation,
  completePublish,
  completeUnpublish,
  ensurePublication,
  failAttempt,
  installA2ACardConfig,
  markPublishedCurrent,
  parsePublicJwk,
  readPublication,
  recordActivation,
  recordStandDown,
  registerRemoteAgent,
  reverifyRemoteAgent,
  setDirectoryListing,
  verifyWithJwk,
  type A2ACardConfig,
  type PublicationAttempt,
  type PublicationRow,
} from '../../src/a2a';
import { newA2AId } from '../../src/a2a/ids';
import { isAuthorized, type CallerType } from '../../src/auth/authz';
import { deriveP256SigningKey } from '../../src/crypto';
import { clearPairingState, setNodeDID } from '../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerA2ARoutes } from '../../src/server/routes/a2a';
import { registerA2AIngressRoutes } from '../../src/server/routes/a2a_ingress';
import { rebindListingsForUpdate } from '../../src/service/listing_rebind';

import { InboundWorld, listing, save } from './inbound_fixture';

let iw: InboundWorld;
beforeEach(async () => {
  iw = await InboundWorld.create();
});
afterEach(() => {
  installA2ACardConfig(null);
  clearPairingState();
  iw.close();
});

const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);
const row = (): PublicationRow => {
  const r = readPublication(iw.world.store);
  if (r === null) throw new Error('no publication');
  return r;
};
const revision = () => row().card_projection_revision;
const make = () => ensurePublication(iw.world.store, iw.world.clock, newA2AId);

/** A listing bound to a plugin install, written as an older row or a direct write would be. */
function pluginListing(rkey: string, cid: string): void {
  const config = {
    ...listing({ name: 'Plugin bus' }),
    capabilities: {
      eta_query: { pluginInstallId: 'pi-1', pluginManifestCid: cid, pluginCapabilityId: 'eta', responsePolicy: 'auto', category: 'transit' },
    },
  };
  iw.world.store.db.execute(
    `INSERT INTO service_configs (rkey, config_json, created_at, updated_at, revision) VALUES (?, ?, ?, ?, 1)`,
    [rkey, JSON.stringify(config), iw.world.clock, iw.world.clock],
  );
}
const configRevision = (rkey: string): number =>
  (iw.world.store.db.query('SELECT revision FROM service_configs WHERE rkey = ?', [rkey])[0] as { revision: number }).revision;

describe('the projection revision', () => {
  // Plan E9 (the rebind half)
  it('on an install with no publication row, a plugin-update rebind succeeds, bumps only the listing, and makes no row', () => {
    pluginListing('plug', 'bafyold');
    const before = configRevision('plug');
    const out = rebindListingsForUpdate(iw.world.store.db, { installId: 'pi-1', fromCid: 'bafyold', toCid: 'bafynew' });
    expect(out.rebound).toEqual(['plug']);
    expect(configRevision('plug')).toBe(before + 1);
    expect(readPublication(iw.world.store)).toBeNull();
  });

  // Plan E15
  it('a plugin-update rebind moves the projection: a publish built before it cannot claim, and one built after it can', () => {
    pluginListing('plug', 'bafyold');
    make();
    setDirectoryListing(iw.world.store, true, iw.world.clock, newA2AId);
    expect(recordActivation(iw.world.store, { fencingGeneration: row().fencing_generation, epoch: 1, keyId: KEY, nowMs: iw.world.clock })).toBe(true);
    const publishAt = (r: PublicationRow): PublicationAttempt => ({
      operation_kind: 'publish',
      card_projection_revision: r.card_projection_revision,
      freshness_epoch: r.freshness_epoch,
      publisher_epoch: r.publisher_epoch,
      publisher_instance: r.publisher_instance,
      fencing_generation: r.fencing_generation,
      desired_card_hash: 'a'.repeat(64),
      attempted_record_digest: 'b'.repeat(64),
      signing_key_id: KEY,
    });
    const claim = (a: PublicationAttempt) => claimAttempt(iw.world.store, a, { priorCid: null, repoCommitCid: 'bafyhead' }, iw.world.clock);
    const stale = publishAt(row());
    // A rebind of another install binds nothing and moves nothing.
    expect(rebindListingsForUpdate(iw.world.store.db, { installId: 'pi-other', fromCid: 'bafyold', toCid: 'bafynew' }).rebound).toEqual([]);
    expect(revision()).toBe(stale.card_projection_revision);
    expect(rebindListingsForUpdate(iw.world.store.db, { installId: 'pi-1', fromCid: 'bafyold', toCid: 'bafynew' }).rebound).toEqual(['plug']);
    expect(revision()).toBeGreaterThan(stale.card_projection_revision);
    expect(claim(stale)).toBe(false);
    expect(row().attempt_tuple_json).toBeNull();
    // The publisher builds again on the new projection, and that claim stands.
    const fresh = publishAt(row());
    expect(claim(fresh)).toBe(true);
    expect(row().attempt_tuple_json).toBe(JSON.stringify(fresh));
  });

  // Plan E17
  it('the bump is inside the writer’s transaction: a write rolled back leaves the revision where it was', () => {
    pluginListing('plug', 'bafyold');
    make();
    const before = revision();
    expect(() =>
      iw.world.store.transaction(() => {
        rebindListingsForUpdate(iw.world.store.db, { installId: 'pi-1', fromCid: 'bafyold', toCid: 'bafynew' });
        iw.world.store.db.execute(`DELETE FROM service_configs WHERE rkey = 'bus'`);
        iw.world.store.db.execute(
          `INSERT INTO plugin_installs (install_id, publisher_did, plugin_id, status, execution_mode, current_cid,
             current_version, manifest_json, install_scope_hash, capability_hashes_json, behavior_hash,
             presentation_hash, trust_anchor_json, created_at, updated_at)
           VALUES ('pi-2', 'did:plc:pub', 'p', 'active', 'runner', 'bafy', '1.0.0', '{}', 'h', '{}', 'h', 'h', '{}', 1, 1)`,
        );
        expect(revision()).toBeGreaterThan(before);
        throw new Error('the writer fails after its writes');
      }),
    ).toThrow('the writer fails');
    expect(revision()).toBe(before);
  });
});

describe('the guarded steps', () => {
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
  const claim = (a: PublicationAttempt, expected = { priorCid: null as string | null, repoCommitCid: 'bafyhead' }) =>
    claimAttempt(iw.world.store, a, expected, iw.world.clock);
  const activate = (epoch = 1) => {
    make();
    setDirectoryListing(iw.world.store, true, iw.world.clock, newA2AId);
    expect(recordActivation(iw.world.store, { fencingGeneration: row().fencing_generation, epoch, keyId: KEY, nowMs: iw.world.clock })).toBe(true);
    return row();
  };
  /** Active and published under (hash a…, KEY, epoch 1). */
  const published = () => {
    const a = attemptFor(activate());
    expect(claim(a)).toBe(true);
    expect(completePublish(iw.world.store, a, { uri: 'at://d/c/self', cid: 'bafyrec' }, iw.world.clock)).toBe(true);
    return row();
  };
  const unpublishFor = (r: PublicationRow) => attemptFor(r, { operation_kind: 'unpublish', desired_card_hash: null, attempted_record_digest: null });

  // Plan E48
  it('a claim names the epoch and instance it was built under: another of either is refused', () => {
    const r = activate();
    expect(claim(attemptFor(r, { publisher_epoch: r.publisher_epoch + 1 }))).toBe(false);
    expect(claim(attemptFor(r, { publisher_epoch: r.publisher_epoch - 1 }))).toBe(false);
    expect(claim(attemptFor(r, { publisher_instance: '00000000-0000-4000-8000-000000000999' }))).toBe(false);
    expect(row().attempt_tuple_json).toBeNull();
    expect(claim(attemptFor(r))).toBe(true);
  });

  // Plan E50
  it('a claim stores the head it read and the record it expects to replace; a completion clears both', () => {
    const a = attemptFor(activate());
    expect(claim(a, { priorCid: 'bafyprior', repoCommitCid: 'bafyhead7' })).toBe(true);
    expect(row()).toEqual(
      expect.objectContaining({ attempt_expected_cid: 'bafyprior', attempt_expected_repo_commit_cid: 'bafyhead7', attempt_tuple_json: JSON.stringify(a) }),
    );
    completePublish(iw.world.store, a, { uri: 'at://d/c/self', cid: 'bafyrec' }, iw.world.clock);
    expect(row()).toEqual(expect.objectContaining({ attempt_expected_cid: null, attempt_expected_repo_commit_cid: null, attempt_tuple_json: null }));
  });

  // Plan E52
  it.each([
    ['a stand-down', () => recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, row().fencing_generation)],
    ['a newer claim', () => claimAttempt(iw.world.store, { ...unpublishFor(row()), signing_key_id: OTHER_KEY }, { priorCid: null, repoCommitCid: 'h2' }, iw.world.clock)],
    ['a re-activation', () => recordActivation(iw.world.store, { fencingGeneration: row().fencing_generation, epoch: 2, keyId: KEY, nowMs: iw.world.clock })],
  ])('an unpublish lands only on its own claim: after %s it records nothing, and the card stays maybe present', (_name, between) => {
    published();
    setDirectoryListing(iw.world.store, false, iw.world.clock, newA2AId);
    const un = unpublishFor(row());
    expect(claim(un)).toBe(true);
    between();
    expect(completeUnpublish(iw.world.store, un, iw.world.clock)).toBe(false);
    expect(row().card_maybe_present).toBe(1);
  });

  // Plan E54
  it.each<[string, (r: PublicationRow) => Parameters<typeof markPublishedCurrent>[1] | null]>([
    ['another card', (r) => ({ revision: r.card_projection_revision, cardHash: 'f'.repeat(64), keyId: KEY, nowMs: 0 })],
    ['another key', (r) => ({ revision: r.card_projection_revision, cardHash: 'a'.repeat(64), keyId: OTHER_KEY, nowMs: 0 })],
    ['a revision that is not the current one', (r) => ({ revision: r.card_projection_revision - 1, cardHash: 'a'.repeat(64), keyId: KEY, nowMs: 0 })],
    [
      'a moved epoch',
      () => {
        recordActivation(iw.world.store, { fencingGeneration: row().fencing_generation, epoch: 2, keyId: KEY, nowMs: iw.world.clock });
        return null;
      },
    ],
    [
      'an attempt in flight',
      () => {
        claim(attemptFor(row(), { attempted_record_digest: 'e'.repeat(64) }));
        return null;
      },
    ],
  ])('the record there answers for a new revision only if it is this card, under this epoch and key: refused for %s', async (_name, change) => {
    published();
    await save(listing({ name: 'Bus 42' }), 'other'); // a projection change the card may not show
    const args = change(row()) ?? { revision: row().card_projection_revision, cardHash: 'a'.repeat(64), keyId: KEY, nowMs: 0 };
    const before = row().published_revision;
    expect(markPublishedCurrent(iw.world.store, args)).toBe(false);
    expect(row().published_revision).toBe(before);
  });

  it('…and with nothing moved but the projection, it does answer for the new revision', async () => {
    published();
    await save(listing({ name: 'Bus 42' }), 'other');
    expect(markPublishedCurrent(iw.world.store, { revision: revision(), cardHash: 'a'.repeat(64), keyId: KEY, nowMs: 0 })).toBe(true);
    expect(row().published_revision).toBe(revision());
  });

  // Plan E58
  it('an activation during a deactivation moves the generation: the pending delete lands nothing, and the deactivation cannot complete over it', () => {
    published();
    expect(beginDeactivation(iw.world.store, iw.world.clock)).toBe(true);
    const un = unpublishFor(row());
    expect(claim(un)).toBe(true);
    expect(recordActivation(iw.world.store, { fencingGeneration: row().fencing_generation, epoch: 2, keyId: KEY, nowMs: iw.world.clock })).toBe(true);
    expect(completeUnpublish(iw.world.store, un, iw.world.clock)).toBe(false);
    expect(failAttempt(iw.world.store, un, iw.world.clock + 5000, iw.world.clock)).toBe(false);
    expect(completeDeactivation(iw.world.store, iw.world.clock)).toBe(false);
    expect(row()).toEqual(expect.objectContaining({ publication_active: 1, publisher_epoch: 2, card_maybe_present: 1 }));
    expect(row().state).not.toBe('deactivating');
  });
});

describe('the owner routes', () => {
  const CAP = 'owner-capability-for-tests';
  const router = new CoreRouter();
  registerA2ARoutes(router, CAP);
  const ROUTES = [
    ['GET', '/v1/owner/a2a/publisher'],
    ['POST', '/v1/owner/a2a/directory-listing'],
    ['POST', '/v1/owner/a2a/publisher/activate'],
    ['POST', '/v1/owner/a2a/publisher/deactivate'],
  ] as const;
  const call = (method: string, path: string, over: Record<string, unknown>) =>
    router.handle({
      method,
      path,
      query: {},
      headers: {},
      body: { enabled: true, refence: true },
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      ...over,
    } as unknown as CoreRequest);

  // Plan E38
  it.each(ROUTES)('%s %s refuses an owner caller with the wrong capability, or none, and makes no row', async (method, path) => {
    for (const ownerCapability of ['owner-capability-for-test', '', undefined]) {
      const res = await call(method, path, { callerType: 'owner', ownerCapability });
      expect(res.status).toBe(403);
    }
    expect(readPublication(iw.world.store)).toBeNull();
    // Control: the same request with the right capability gets past the gate.
    // The view and the switch answer; activation and deactivation reach the host's port, and none is installed.
    const ok = await call(method, path, { callerType: 'owner', ownerCapability: CAP });
    if (path.startsWith('/v1/owner/a2a/publisher/')) expect(ok).toEqual(expect.objectContaining({ status: 503, body: { error: 'publisher_unavailable' } }));
    else expect(ok.status).toBe(200);
  });

  // Plan E39
  it.each(ROUTES)('%s %s refuses every caller but the owner, in one process and in two, capability or not', async (method, path) => {
    const others: CallerType[] = ['agent', 'device', 'plugin', 'gateway', 'admin', 'connector', 'staff', 'owner_device'];
    for (const callerType of others) {
      expect(isAuthorized(callerType, method, path)).toBe(false);
      // Holding the owner's capability, or not, opens nothing to any other caller.
      for (const ownerCapability of [CAP, undefined]) {
        const res = await call(method, path, {
          callerType,
          callerDID: 'did:key:z6MkSomeone',
          ...(ownerCapability === undefined ? {} : { ownerCapability }),
        });
        expect([callerType, ownerCapability ?? 'none', res.status]).toEqual([callerType, ownerCapability ?? 'none', 403]);
      }
    }
    expect(readPublication(iw.world.store)).toBeNull();
  });

  // Plan E42
  it('the owner’s view shows a stand-down and why', async () => {
    make();
    recordActivation(iw.world.store, { fencingGeneration: row().fencing_generation, epoch: 1, keyId: KEY, nowMs: iw.world.clock });
    recordStandDown(iw.world.store, 'another_server_publishing', iw.world.clock, row().fencing_generation);
    const view = await call('GET', '/v1/owner/a2a/publisher', { callerType: 'owner', ownerCapability: CAP });
    expect(view.status).toBe(200);
    expect(view.body).toEqual(expect.objectContaining({ state: 'stood_down', notice: 'another_server_publishing', active: false, eligible: false }));
  });
});

describe('the card under one key and under the next', () => {
  const ORIGIN = 'https://dina.example.org';
  const REMOTE = 'did:plc:remotecardaaaaaaaaaaaaaa';
  const SEED = new Uint8Array(32).map((_, i) => 200 - i);
  const config = (generation: number): A2ACardConfig => ({
    key: { privateKey: deriveP256SigningKey(SEED, generation).privateKey, generation },
    publicOrigin: ORIGIN,
  });
  const build = async (generation: number) => {
    const built = await buildInboundCard(iw.world.store, { nodeDid: REMOTE, config: config(generation) });
    if (!built.ok) throw new Error(built.reason);
    return built;
  };
  const verifiesUnder = async (card: unknown, jwk: unknown) => {
    const parsed = parsePublicJwk(jwk);
    if (parsed === null) return false;
    const report = await verifyAgentCardSignatures(card as Record<string, unknown>, ({ header, signingInputs, signature }) =>
      signingInputs.some((input) => verifyWithJwk(parsed, header.alg, input, signature)),
    );
    return report.state === 'verified';
  };

  // Plan E131
  it('the card’s bytes are deterministic: built twice under one key, the same canonical bytes', async () => {
    const one = canonicalize((await build(0)).card as unknown as JsonValue);
    const two = canonicalize((await build(0)).card as unknown as JsonValue);
    expect(two).toBe(one);
  });

  // Plan E111 (the card's side) and X-1 (the gateway's side)
  it('a new card key gives new card bytes, and Core hands the gateway the card and the key set that verifies it in one answer', async () => {
    const before = await build(0);
    const after = await build(1);
    expect(canonicalize(after.card as unknown as JsonValue)).not.toBe(canonicalize(before.card as unknown as JsonValue));
    setNodeDID(REMOTE);
    const ingress = new CoreRouter();
    registerA2AIngressRoutes(ingress);
    const fetchCard = async () => {
      const res = await ingress.handle({
        method: 'GET',
        path: '/v1/a2a/card',
        query: {},
        headers: {},
        body: undefined,
        rawBody: new Uint8Array(),
        params: {},
        trustedInProcess: true,
        callerType: 'gateway',
        callerDID: 'did:key:gateway',
      } as CoreRequest);
      expect(res.status).toBe(200);
      return res.body as { card: Record<string, unknown>; jwks: { keys: unknown[] } };
    };
    installA2ACardConfig(config(0));
    const old = await fetchCard();
    installA2ACardConfig(config(1));
    const now = await fetchCard();
    expect(await verifiesUnder(now.card, now.jwks.keys[0])).toBe(true);
    expect(await verifiesUnder(now.card, old.jwks.keys[0])).toBe(false);
    expect(now.jwks.keys[0]).not.toEqual(old.jwks.keys[0]);
    // The key the set names is the generation-1 card key.
    const parsed = parsePublicJwk(now.jwks.keys[0]);
    expect(parsed).not.toBeNull();
    const probe = new Uint8Array([1, 2, 3]);
    expect(verifyWithJwk(parsed as NonNullable<typeof parsed>, 'ES256', probe, p256.sign(probe, deriveP256SigningKey(SEED, 1).privateKey))).toBe(true);
  });

  // Plan X-1 (another Dina's Lane 1 pin) and E107
  it('another Dina’s Lane 1 pin of this card: a rebuild with nothing changed keeps it, a new card key changes it', async () => {
    const CARD_URL = `${ORIGIN}/.well-known/agent-card.json`;
    const serve = (built: Awaited<ReturnType<typeof build>>) => {
      iw.world.cards.set(CARD_URL, built.card as unknown as never);
      iw.world.cards.set(`${ORIGIN}${A2A_JWKS_PATH}`, built.jwks as unknown as never);
    };
    serve(await build(0));
    const deps = { store: iw.world.store, nowMs: () => iw.world.clock };
    const reg = await registerRemoteAgent(deps, CARD_URL);
    if (!reg.ok) throw new Error(reg.reason);
    expect(reg.agent.signature_state).toBe('verified');
    // The 14-day refresh touches only the directory; the live card is rebuilt byte for byte.
    serve(await build(0));
    const same = await reverifyRemoteAgent(deps, reg.agent.agent_id);
    expect(same.ok && same.changed).toBe(false);
    // The card key moves: the same content under a new signer re-gates the registration.
    serve(await build(1));
    const moved = await reverifyRemoteAgent(deps, reg.agent.agent_id);
    expect(moved.ok && moved.changed).toBe(true);
    expect(moved.ok && moved.agent.status).toBe('changed');
    expect(moved.ok && moved.agent.signature_state).toBe('verified');
  });
});
