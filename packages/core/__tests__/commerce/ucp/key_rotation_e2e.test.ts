/**
 * Key rotation end to end (UCP plan §4.8, §3.5; U7): the node's publisher
 * against the REAL profile host, and a merchant that keeps the profile for
 * its full served max-age and never force-refreshes, verifying every request
 * the node's transport signs. A rotation never leaves a request it cannot
 * verify, survives a restart, a restore during the wait and during the
 * overlap, and never brings back a retired key.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  createUcpHost,
  memoryHostLog,
  memoryHostStore,
  profileUrlForLabel,
  PROFILE_MAX_AGE_SECONDS,
  requiredRequestComponents,
  UCP_PROFILE_HOST,
  verifyMessage,
  type HttpMessage,
  type MerchantProfile,
} from '@dina/ucp';

import { isAuthorized } from '../../../src/auth/authz';
import { inProcessOwnerDispatcher } from '../../../src/client/owner-dispatch';
import { OwnerUcpClient, OwnerUcpHttpError } from '../../../src/client/owner-ucp-client';
import {
  clearOwnerPresence,
  installOwnerPresenceVerifier,
  OWNER_IN_PROCESS_PRINCIPAL,
  proveOwnerPresence,
} from '../../../src/commerce/owner_presence';
import {
  deriveUcpIdentity,
  getUcpIdentity,
  installUcpIdentity,
  setUcpSigningGeneration,
  type UcpIdentity,
} from '../../../src/commerce/ucp/identity';
import { merchantKeyLookup } from '../../../src/commerce/ucp/merchant_client';
import { installUcpPublication } from '../../../src/commerce/ucp/publication_control';
import {
  KEY_OVERLAP_MS,
  KEY_SWITCH_WAIT_MS,
  startPublisherSchedule,
  UcpPublisher,
} from '../../../src/commerce/ucp/publisher';
import { UcpTransport } from '../../../src/commerce/ucp/transport';
import { deriveRootSigningKey } from '../../../src/crypto/slip0010';
import { kvDelete, kvSet } from '../../../src/kv/store';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter } from '../../../src/server/router';
import { registerUcpRoutes, UCP_OWNER_PUBLICATION } from '../../../src/server/routes/ucp';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const SEED = Uint8Array.from(
  Buffer.from('c1a1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f', 'hex'),
);
const DID = 'did:plc:7s5vldbcs2wwwxfzeigew6o5';
const ROOT_PUBLIC = ed25519.getPublicKey(deriveRootSigningKey(SEED, 0).privateKey);
const MAX_AGE_MS = PROFILE_MAX_AGE_SECONDS * 1000;
const T0 = 1_759_000_000_000;

let now = T0;
let uuid = 0;
let store = memoryHostStore();
const host = () =>
  createUcpHost({
    profileHost: UCP_PROFILE_HOST,
    store,
    log: memoryHostLog(),
    signingKeyFor: async (did) => (did === DID ? ROOT_PUBLIC : null),
    sha256,
    ed25519Verify: (pk, m, sig) => ed25519.verify(sig, m, pk),
  });
let profileHost = host();
/** The host's record of a label (retired keys included). */
const labelState = (label: string) => store.labels.get(label);

/** Runs before the host sees a request: may answer it (a fault) or hold it open. */
let intercept: ((r: PolicySocketRequest) => Promise<UcpFetchResult | null>) | null = null;
const socket = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
  if (intercept !== null) {
    const answered = await intercept(r);
    if (answered !== null) return answered;
  }
  const url = new URL(r.url);
  const answer = await profileHost.handle({
    method: r.method,
    hostname: url.hostname,
    path: url.pathname,
    headers: {},
    body: r.body ?? null,
  });
  return {
    ok: true,
    status: answer.status,
    bodyBytes: new TextEncoder().encode(answer.body),
    headers: answer.headers,
    connectedAddress: '203.0.114.7',
  };
};

const publisher = () =>
  new UcpPublisher({
    did: DID,
    fetch: socket,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
    now: () => now,
  });

/** Boot on this node: a fresh identity at generation 0, installed, then the publisher's record read. */
async function boot(): Promise<{ identity: UcpIdentity; p: UcpPublisher }> {
  const identity = deriveUcpIdentity(SEED);
  installUcpIdentity(identity);
  const p = publisher();
  await p.restoreKeys();
  return { identity, p };
}

/**
 * A merchant that honours the profile's max-age to the letter and no more:
 * it fetches the profile, keeps it for 300 seconds, never refreshes early on
 * an unknown key, and verifies each request against the keys it holds.
 */
class CachingMerchant {
  private cached: { profile: MerchantProfile; until: number } | null = null;
  fetches = 0;

  private async profile(label: string): Promise<MerchantProfile> {
    if (this.cached !== null && now < this.cached.until) return this.cached.profile;
    const r = await socket({
      method: 'GET',
      url: profileUrlForLabel(label, UCP_PROFILE_HOST),
      headers: {},
      accept: 'json',
      maxResponseBytes: 65536,
      timeoutMs: 1000,
    } as PolicySocketRequest);
    if (!r.ok || r.status !== 200) throw new Error('profile not served');
    this.fetches++;
    const profile = JSON.parse(new TextDecoder().decode(r.bodyBytes)) as MerchantProfile;
    const maxAge = Number(/max-age=(\d+)/.exec(r.headers['cache-control'] ?? '')?.[1]);
    expect(maxAge).toBe(PROFILE_MAX_AGE_SECONDS);
    this.cached = { profile, until: now + maxAge * 1000 };
    return profile;
  }

  /** Verify one request the node sent. */
  async verify(label: string, r: PolicySocketRequest): Promise<boolean> {
    const msg: HttpMessage = {
      method: r.method,
      url: r.url,
      headers: r.headers,
      ...(r.body !== undefined ? { body: r.body } : {}),
    };
    const keyFor = merchantKeyLookup(await this.profile(label));
    return verifyMessage({ msg, required: requiredRequestComponents(msg), keyFor, sha256 }).ok;
  }
}

/** One request through the node's transport, signed as merchant_client signs it, then verified. */
async function shop(merchant: CachingMerchant): Promise<boolean> {
  const sent = await signed();
  const label = getUcpIdentity()?.label ?? '';
  for (const r of sent) if (!(await merchant.verify(label, r))) return false;
  return sent.length > 0;
}

/** The requests the node's transport sends for one call (none when it has no key). */
async function signed(): Promise<PolicySocketRequest[]> {
  const sent: PolicySocketRequest[] = [];
  const t = new UcpTransport({
    signer: () => {
      // As merchant_client signs: no key known, nothing sent.
      const key = getUcpIdentity()?.signingKey() ?? null;
      return key === null ? null : { keyid: key.jwk.kid, sign: key.sign };
    },
    fetch: async (r) => {
      sent.push(r);
      return { ok: false, error: 'connect_failed', sent: false };
    },
  });
  await t.call({
    transport: 'rest',
    endpoint: 'https://shop.example/ucp',
    profileUrl: 'https://x.example/.well-known/ucp',
    operation: 'create_cart',
    idempotencyKey: '7f1c0c1e-3a5e-4c0e-9d5f-1d1b2a3c4d5e',
    payload: { line_items: [] },
  });
  return sent;
}

const kids = (identity: UcpIdentity, ...gens: number[]) =>
  gens.map((g) => identity.keyAt(g).jwk.kid);
/** The keys the host serves in the profile, by kid. */
async function servedKids(label: string): Promise<string[]> {
  const r = await socket({
    method: 'GET',
    url: profileUrlForLabel(label, UCP_PROFILE_HOST),
  } as PolicySocketRequest);
  if (!r.ok || r.status !== 200) return [];
  const doc = JSON.parse(new TextDecoder().decode(r.bodyBytes)) as { keys?: { kid: string }[] };
  return (doc.keys ?? []).map((k) => k.kid).sort();
}

const DOWN: UcpFetchResult = { ok: false, error: 'connect_failed', sent: false };

beforeEach(async () => {
  intercept = null;
  now = T0;
  store = memoryHostStore();
  profileHost = host();
  setUcpSigningGeneration(null);
  installUcpIdentity(null);
  await kvDelete('publisher', 'ucp');
});
afterAll(() => {
  installUcpIdentity(null);
  setUcpSigningGeneration(null);
});

describe('a rotation (§4.8)', () => {
  it('a merchant that keeps the profile its full max-age and never force-refreshes verifies every request, through the switch and the overlap', async () => {
    const { identity, p } = await boot();
    const merchant = new CachingMerchant();
    expect(await p.publish()).toBe('served');
    // The worst case: the merchant fetched the old profile the instant before the new one was served.
    now += 1000;
    expect(await shop(merchant)).toBe(true);
    now += 1;

    expect(await p.rotateKey()).toBe('served');
    expect(identity.key.generation).toBe(0);
    expect(await servedKids(identity.label)).toEqual(kids(identity, 0, 1).sort());
    // A key listed but not yet signing: had the node switched now, this merchant would refuse it.
    identity.useGeneration(1);
    expect(await shop(merchant)).toBe(false);
    identity.useGeneration(0);

    // Not confirmed served: no switch, however long it waits.
    now += 2 * KEY_SWITCH_WAIT_MS;
    await p.publish();
    expect(identity.key.generation).toBe(0);
    expect(await p.verifyServed()).toBe('served');
    const confirmed = now;
    // Every request in the wait verifies, the cache expiring and refetched in between.
    for (let t = 0; t < KEY_SWITCH_WAIT_MS; t += 45_000) {
      now = confirmed + t;
      await p.publish();
      expect(identity.key.generation).toBe(0);
      expect(await shop(merchant)).toBe(true);
    }
    now = confirmed + KEY_SWITCH_WAIT_MS;
    expect(await p.publish()).toBe('served');
    expect(identity.key.generation).toBe(1);
    expect(getUcpIdentity()?.key.generation).toBe(1);
    // The old key stays listed as retiring for the overlap.
    expect(await servedKids(identity.label)).toEqual(kids(identity, 0, 1).sort());
    expect(await p.state()).toMatchObject({
      keys: { active: 1, retiring: [{ generation: 0, retireAfter: now + KEY_OVERLAP_MS }] },
    });
    for (let t = 0; t < 2 * MAX_AGE_MS; t += 30_000) {
      now += 30_000;
      expect(await shop(merchant)).toBe(true);
    }
    // Past the overlap the old key leaves the profile, and the host retires it for good.
    now += KEY_OVERLAP_MS;
    expect(await p.publish()).toBe('served');
    expect(await servedKids(identity.label)).toEqual(kids(identity, 1));
    expect(labelState(identity.label)?.retired).toContain(identity.keyAt(0).jwk.kid);
    now += MAX_AGE_MS;
    expect(await shop(merchant)).toBe(true);
    expect(merchant.fetches).toBeGreaterThan(3);
  });

  it('the schedule confirms a staged key at once and wakes for the switch and the removal', async () => {
    const { identity, p } = await boot();
    const timers: { fn: () => void; at: number }[] = [];
    const schedule = startPublisherSchedule(p, {
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
      now: () => now,
    });
    const settle = async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
    };
    /** Fire the next due publish timer (not the hourly check); returns when it fired. */
    const fireNext = async (): Promise<number> => {
      timers.sort((a, b) => a.at - b.at);
      const t = timers.find((x) => x.at - now !== 60 * 60 * 1000) ?? timers[0];
      if (t === undefined) throw new Error('nothing scheduled');
      timers.splice(timers.indexOf(t), 1);
      now = Math.max(now, t.at);
      t.fn();
      await settle();
      return t.at;
    };
    await fireNext();
    expect((await p.state()).status).toBe('served');
    await p.rotateKey();
    schedule.kick();
    await fireNext();
    // Confirmed in the same run: the switch is due the wait after.
    const staged = (await p.state()).keys?.staged;
    expect(staged?.confirmedAt).toBeDefined();
    const switchAt = await fireNext();
    expect(switchAt).toBe((staged?.confirmedAt ?? 0) + KEY_SWITCH_WAIT_MS);
    expect(identity.key.generation).toBe(1);
    // Next wake: no later than a day, then the removal at the end of the overlap.
    let at = switchAt;
    while ((await p.state()).keys?.retiring.length !== 0) at = await fireNext();
    expect(at).toBe(switchAt + KEY_OVERLAP_MS);
    schedule.stop();
  });
});

describe('restarts and restores (§3.5)', () => {
  it('a rotation survives a restart: the node signs with the key it switched to from its first call', async () => {
    const first = await boot();
    await first.p.publish();
    await first.p.rotateKey();
    await first.p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    await first.p.publish();
    expect(first.identity.key.generation).toBe(1);
    // Restart: the process forgets everything in memory; the record stays.
    setUcpSigningGeneration(null);
    installUcpIdentity(null);
    const again = await boot();
    expect(again.identity.key.generation).toBe(1);
    expect(await shop(new CachingMerchant())).toBe(true);
    // A seal and unlock (phone): an identity installed later signs with it too.
    installUcpIdentity(null);
    const unlocked = deriveUcpIdentity(SEED);
    installUcpIdentity(unlocked);
    expect(unlocked.key.generation).toBe(1);
  });

  it('a restart during the wait keeps the staged key waiting; it switches at its time', async () => {
    const first = await boot();
    await first.p.publish();
    await first.p.rotateKey();
    await first.p.verifyServed();
    const due = (await first.p.nextKeyStepAt()) ?? 0;
    setUcpSigningGeneration(null);
    const again = await boot();
    expect(again.identity.key.generation).toBe(0);
    now = due - 1;
    await again.p.publish();
    expect(again.identity.key.generation).toBe(0);
    now = due;
    await again.p.publish();
    expect(again.identity.key.generation).toBe(1);
  });

  it('a restore during the wait signs with the active key, and on activation waits a full wait again from its own upload', async () => {
    const first = await boot();
    await first.p.publish();
    await first.p.rotateKey();
    await first.p.verifyServed();
    // Restore on a new device: no record (archives leave it out), nothing in memory.
    await kvDelete('publisher', 'ucp');
    setUcpSigningGeneration(null);
    const restored = await boot();
    expect(await restored.p.publish()).toBe('stood_down');
    expect(restored.identity.key.generation).toBe(0);
    expect(await shop(new CachingMerchant())).toBe(true);
    now += KEY_SWITCH_WAIT_MS;
    expect(await restored.p.activate()).toBe('served');
    // The host's staged key, adopted without its times: published now, not yet confirmed.
    expect(restored.identity.key.generation).toBe(0);
    expect((await restored.p.state()).keys).toMatchObject({
      active: 0,
      staged: { generation: 1, publishedAt: now },
    });
    expect((await restored.p.state()).keys?.staged?.confirmedAt).toBeUndefined();
    await restored.p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    await restored.p.publish();
    expect(restored.identity.key.generation).toBe(1);
  });

  it('a restore during the overlap signs with the new key and keeps the old one listed until its time, never longer', async () => {
    const first = await boot();
    await first.p.publish();
    await first.p.rotateKey();
    await first.p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    await first.p.publish();
    const retireAfter = (await first.p.state()).keys?.retiring[0]?.retireAfter ?? 0;
    await kvDelete('publisher', 'ucp');
    setUcpSigningGeneration(null);
    now += 60_000;
    const restored = await boot();
    expect(await restored.p.publish()).toBe('stood_down');
    // Stood down, it still signs with the key the holding device made active.
    expect(restored.identity.key.generation).toBe(1);
    expect(await restored.p.activate()).toBe('served');
    expect((await restored.p.state()).keys).toEqual({
      active: 1,
      retiring: [{ generation: 0, retireAfter }],
    });
    now = retireAfter;
    await restored.p.publish();
    expect(await servedKids(restored.identity.label)).toEqual(kids(restored.identity, 1));
  });

  it('a restore never brings back a retired key: after the overlap it starts at the key in use', async () => {
    const first = await boot();
    await first.p.publish();
    await first.p.rotateKey();
    await first.p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    await first.p.publish();
    now += KEY_OVERLAP_MS;
    await first.p.publish();
    await kvDelete('publisher', 'ucp');
    setUcpSigningGeneration(null);
    const restored = await boot();
    await restored.p.publish();
    expect(await restored.p.activate()).toBe('served');
    expect((await restored.p.state()).keys).toEqual({ active: 1, retiring: [] });
    expect(await servedKids(restored.identity.label)).toEqual(kids(restored.identity, 1));
  });
});

describe('compromise (§4.8)', () => {
  it('"my key may be compromised" mid-rotation retires every listed key at once and starts above them', async () => {
    const { identity, p } = await boot();
    await p.publish();
    await p.rotateKey();
    expect(await p.retireKey()).toBe('served');
    const label = labelState(identity.label);
    expect(label?.retired).toEqual(expect.arrayContaining(kids(identity, 0, 1)));
    expect(identity.key.generation).toBe(2);
    expect(await servedKids(identity.label)).toEqual(kids(identity, 2));
    expect(await shop(new CachingMerchant())).toBe(true);
  });

  it('a device whose ring the owner retired from another device adopts the next generation on its next upload', async () => {
    const a = await boot();
    await a.p.publish();
    const stateA = await a.p.state();
    // Device B (same seed, same record shape) takes shopping and retires the key.
    await kvDelete('publisher', 'ucp');
    setUcpSigningGeneration(null);
    const b = await boot();
    await b.p.publish();
    await b.p.activate();
    await b.p.retireKey();
    expect(b.identity.key.generation).toBe(1);
    // Device A, its record back, is told to stand down and signs with B's key; never generation 0.
    await kvSet('publisher', JSON.stringify(stateA), 'ucp');
    setUcpSigningGeneration(null);
    const back = await boot();
    expect(back.identity.key.generation).toBe(0);
    expect(await back.p.publish()).toBe('stood_down');
    expect(back.identity.key.generation).toBe(1);
  });
});

describe('the owner’s rotate', () => {
  it('a second rotate while one is staged stages nothing more', async () => {
    const { p } = await boot();
    await p.publish();
    await p.rotateKey();
    const staged = (await p.state()).keys?.staged?.generation;
    await p.rotateKey();
    expect((await p.state()).keys?.staged?.generation).toBe(staged);
    expect(await servedKids((await boot()).identity.label)).toHaveLength(2);
  });

  it('does nothing while UCP is off or another device holds shopping', async () => {
    const { p } = await boot();
    await p.publish();
    await p.turnOff();
    await p.rotateKey();
    expect((await p.state()).keys?.staged).toBeUndefined();
    await kvDelete('publisher', 'ucp');
    const other = await boot();
    expect(await other.p.publish()).toBe('stood_down');
    await other.p.rotateKey();
    // It records the holder's ring (to sign with its key), and stages nothing.
    expect((await other.p.state()).keys).toEqual({ active: 0, retiring: [] });
    expect((await other.p.state()).rotate).toBeUndefined();
  });
});

describe('the owner’s controls (routes)', () => {
  const OWNER_CAP = 'test-owner-capability';
  const setup = async () => {
    const { identity, p } = await boot();
    const schedule = startPublisherSchedule(p, {
      // Hand-driven: nothing fires on its own here; the actions run through act().
      setTimer: () => ({}),
      clearTimer: () => undefined,
      now: () => now,
    });
    installUcpPublication({ publisher: p, schedule });
    setNodeDID(DID);
    const router = new CoreRouter();
    registerUcpRoutes(router, OWNER_CAP);
    const client = new OwnerUcpClient(inProcessOwnerDispatcher(router, OWNER_CAP));
    return { identity, p, schedule, client };
  };
  afterEach(() => {
    installUcpPublication(null);
    installOwnerPresenceVerifier(null);
    clearOwnerPresence();
  });

  it('shows the status and the ring; rotate, then the switch time once the host is seen serving it', async () => {
    const { p, schedule, client } = await setup();
    await p.publish();
    expect(await client.publication()).toEqual({
      status: 'served',
      role: 'active',
      enabled: true,
      compromise_pending: false,
      pending_control: null,
      detail: null,
      key: { generation: 0, next: null, retiring: [] },
      rotation_requested: false,
    });
    const view = await client.publicationAction('rotate');
    // act() confirmed the served copy in the same step, so the switch time is known.
    expect(view.key).toEqual({
      generation: 0,
      next: { generation: 1, signs_from: now + KEY_SWITCH_WAIT_MS },
      retiring: [],
    });
    schedule.stop();
  });

  it('"compromised" and "activate" need the owner present on a node that can ask; "turn off" never waits', async () => {
    const { identity, p, schedule, client } = await setup();
    await p.publish();
    installOwnerPresenceVerifier(async (pass) => pass === 'right');
    for (const action of ['compromised', 'activate'] as const) {
      const err = await client.publicationAction(action).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OwnerUcpHttpError);
      expect(err).toMatchObject({ status: 403, code: 'no_user_presence' });
    }
    expect(identity.key.generation).toBe(0);
    expect((await client.publicationAction('turn_off')).status).toBe('off');
    // The in-process owner app speaks for its own principal (no host entry point stamps one).
    expect(await proveOwnerPresence('right', Date.now(), OWNER_IN_PROCESS_PRINCIPAL)).toBe(true);
    expect((await client.publicationAction('activate')).status).toBe('served');
    const after = await client.publicationAction('compromised');
    expect(after).toMatchObject({
      status: 'served',
      compromise_pending: false,
      key: { generation: 1 },
    });
    schedule.stop();
  });

  it('an unknown action is a 400; no publisher is a 503; Brain and agents are refused', async () => {
    const { schedule } = await setup();
    const router = new CoreRouter();
    registerUcpRoutes(router, OWNER_CAP);
    const client = new OwnerUcpClient(inProcessOwnerDispatcher(router, OWNER_CAP));
    await expect(
      client.publicationAction('delete_everything' as unknown as 'rotate'),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_action' });
    installUcpPublication(null);
    expect(await client.publication()).toBeNull();
    for (const method of ['GET', 'POST'] as const) {
      for (const who of ['owner', 'admin', 'device'] as const)
        expect(isAuthorized(who, method, UCP_OWNER_PUBLICATION)).toBe(true);
      for (const who of ['brain', 'agent', 'plugin'] as const)
        expect(isAuthorized(who, method, UCP_OWNER_PUBLICATION)).toBe(false);
    }
    schedule.stop();
  });
});

describe('review round 1 (U7)', () => {
  it('"compromised" on a stood-down device retires the keys the holder rotated to, not only its own stale ones', async () => {
    const a = await boot();
    await a.p.publish();
    const stateA = await a.p.state();
    // Device B takes shopping and rotates to generation 1.
    await kvDelete('publisher', 'ucp');
    setUcpSigningGeneration(null);
    const b = await boot();
    await b.p.publish();
    await b.p.activate();
    await b.p.rotateKey();
    await b.p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    await b.p.publish();
    expect(b.identity.key.generation).toBe(1);
    // Device A, its old record back (it knows only generation 0), stands down, then the owner
    // presses "compromised" there.
    await kvSet('publisher', JSON.stringify(stateA), 'ucp');
    setUcpSigningGeneration(null);
    const back = await boot();
    expect(await back.p.publish()).toBe('stood_down');
    expect(await back.p.retireKey()).toBe('served');
    const retired = labelState(back.identity.label)?.retired ?? [];
    expect(retired).toEqual(expect.arrayContaining(kids(back.identity, 0, 1)));
    expect(back.identity.key.generation).toBe(2);
    expect(await servedKids(back.identity.label)).toEqual(kids(back.identity, 2));
    expect(await shop(new CachingMerchant())).toBe(true);
  });

  it('a restored node signs nothing until it has read the host; then only with the key the host lists as active', async () => {
    const first = await boot();
    await first.p.publish();
    await first.p.rotateKey();
    await first.p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    await first.p.publish();
    now += KEY_OVERLAP_MS;
    await first.p.publish();
    // Generation 0 is retired at the host. A restore, the host out of reach at boot:
    await kvDelete('publisher', 'ucp');
    setUcpSigningGeneration(null);
    intercept = async () => DOWN;
    const restored = await boot();
    expect(await restored.p.publish()).toBe('unreachable');
    expect(restored.identity.signingKey()).toBeNull();
    // No request is signed at all (the transport sends nothing without a key).
    expect(await shop(new CachingMerchant())).toBe(false);
    intercept = null;
    expect(await restored.p.publish()).toBe('stood_down');
    expect(restored.identity.key.generation).toBe(1);
    expect(await shop(new CachingMerchant())).toBe(true);
  });

  it('after "compromised", nothing signs with the retired key while the new one is not yet accepted', async () => {
    const { identity, p } = await boot();
    await p.publish();
    // The retirement lands; the upload of the next generation does not.
    intercept = async (r) => (r.method === 'PUT' ? DOWN : null);
    expect(await p.retireKey()).toBe('unreachable');
    expect(labelState(identity.label)?.retired).toEqual(kids(identity, 0));
    expect(identity.signingKey()).toBeNull();
    // Nothing leaves at all: not a request the merchant refuses, no request.
    expect(await signed()).toEqual([]);
    intercept = null;
    expect(await p.publish()).toBe('served');
    expect(identity.key.generation).toBe(1);
  });

  it('a served check held open while a run switches keys never puts the old ring back', async () => {
    const { identity, p } = await boot();
    await p.publish();
    await p.rotateKey();
    await p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    let release: () => void = () => undefined;
    let held = false;
    intercept = async (r) => {
      if (r.method === 'GET' && !r.url.endsWith('/state') && !held) {
        held = true;
        await new Promise<void>((res) => (release = res));
      }
      return null;
    };
    const check = p.verifyServed();
    for (let i = 0; i < 10 && !held; i++) await new Promise((res) => setImmediate(res));
    expect(held).toBe(true);
    expect(await p.publish()).toBe('served');
    expect((await p.state()).keys?.active).toBe(1);
    release();
    await check;
    expect((await p.state()).keys).toMatchObject({ active: 1, retiring: [{ generation: 0 }] });
    expect((await p.state()).keys?.staged).toBeUndefined();
    expect(identity.key.generation).toBe(1);
  });

  it('the schedule runs the hourly check one at a time with runs', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const fake = {
      publish: async () => {
        order.push('publish');
        return 'served' as const;
      },
      verifyServed: async () => {
        order.push('verify:start');
        await new Promise<void>((res) => (release = res));
        order.push('verify:end');
        return 'served' as const;
      },
      awaitingConfirmation: async () => false,
      nextKeyStepAt: async () => null,
    };
    const timers: { fn: () => void; ms: number }[] = [];
    const s = startPublisherSchedule(fake, {
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: () => undefined,
      now: () => now,
    });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
    };
    timers.find((t) => t.ms === 0)?.fn();
    await settle();
    timers.find((t) => t.ms === 60 * 60 * 1000)?.fn();
    await settle();
    // An owner action while the check is held waits for it.
    const acted = s.act(async () => {
      order.push('act');
      return 'served';
    });
    await settle();
    expect(order).toEqual(['publish', 'verify:start']);
    release();
    await acted;
    expect(order).toEqual(['publish', 'verify:start', 'verify:end', 'act']);
    s.stop();
  });
});

describe('gap sweep (U7)', () => {
  it('a restart while "compromised" is still pending signs nothing, and never the compromised key', async () => {
    const first = await boot();
    await first.p.publish();
    intercept = async () => DOWN;
    expect(await first.p.retireKey()).toBe('stopping');
    // The process restarts with the host still out of reach.
    setUcpSigningGeneration(null);
    installUcpIdentity(null);
    const again = await boot();
    expect(again.identity.signingKey()).toBeNull();
    expect(await again.p.publish()).toBe('stopping');
    expect(again.identity.signingKey()).toBeNull();
    intercept = null;
    expect(await again.p.publish()).toBe('served');
    expect(again.identity.key.generation).toBe(1);
    expect(labelState(again.identity.label)?.retired).toEqual(kids(again.identity, 0));
  });

  it('"compromised" pressed while a run is in flight: that run finishing does not bring the key back', async () => {
    const { identity, p } = await boot();
    await p.publish();
    let release: () => void = () => undefined;
    let held = false;
    intercept = async (r) => {
      if (r.method === 'PUT' && !held) {
        held = true;
        await new Promise<void>((res) => (release = res));
      }
      return null;
    };
    const run = p.publish();
    for (let i = 0; i < 20 && !held; i++) await new Promise((res) => setImmediate(res));
    expect(held).toBe(true);
    // The owner's press: signing stops before the action waits its turn.
    p.stopSigningNow();
    release();
    await run;
    expect(identity.signingKey()).toBeNull();
    expect(await p.retireKey()).toBe('served');
    expect(identity.key.generation).toBe(1);
  });

  it('a stood-down device follows the holder: its rotation, then its compromise', async () => {
    const a = await boot();
    await a.p.publish();
    const stateA = await a.p.state();
    await kvDelete('publisher', 'ucp');
    setUcpSigningGeneration(null);
    const b = await boot();
    await b.p.publish();
    await b.p.activate();
    // A, its record back, stands down signing with B's key (0).
    const stateB = await b.p.state();
    await kvSet('publisher', JSON.stringify(stateA), 'ucp');
    setUcpSigningGeneration(null);
    const back = await boot();
    expect(await back.p.publish()).toBe('stood_down');
    expect(back.identity.key.generation).toBe(0);
    // One KV store stands for both devices here: each acts with its own record swapped in.
    const swap = async (st: unknown) => kvSet('publisher', JSON.stringify(st), 'ucp');
    // B rotates.
    await swap(stateB);
    await b.p.rotateKey();
    await b.p.verifyServed();
    now += KEY_SWITCH_WAIT_MS;
    await b.p.publish();
    const stateB2 = await b.p.state();
    await swap(stateA);
    // A's next (hourly) run reads the host again: it signs with B's new key.
    expect(await back.p.publish()).toBe('stood_down');
    expect(back.identity.key.generation).toBe(1);
    // B retires everything: A, reading again, finds no key of its own to sign with until B republishes.
    await swap(stateB2);
    intercept = async (r) => (r.method === 'PUT' ? DOWN : null);
    await b.p.retireKey();
    intercept = null;
    await swap(stateA);
    expect(await back.p.publish()).toBe('stood_down');
    expect(back.identity.signingKey()).toBeNull();
  });
});

describe('the wait and the overlap at their edges (U7, §4.8)', () => {
  it('a merchant that fetched the old profile just before the new one was served verifies the first request the new key signs, at the exact switch time; switching a minute early would fail it', async () => {
    const { identity, p } = await boot();
    await p.publish();
    const merchant = new CachingMerchant();
    // The rotation's upload goes out at P; this merchant read the profile 1 ms before.
    now += 60_000;
    expect(await shop(merchant)).toBe(true);
    now += 1;
    await p.rotateKey();
    // The schedule checks the served copy in the same run.
    await p.verifyServed();
    const switchAt = (await p.nextKeyStepAt()) ?? 0;
    expect(switchAt).toBe(now + KEY_SWITCH_WAIT_MS);
    // Control: the new key signing 61 s before the switch (inside the merchant's max-age) is refused.
    now = switchAt - 61_000;
    identity.useGeneration(1);
    expect(await shop(merchant)).toBe(false);
    identity.useGeneration(0);
    now = switchAt - 1;
    await p.publish();
    expect(identity.key.generation).toBe(0);
    now = switchAt;
    await p.publish();
    expect(identity.key.generation).toBe(1);
    expect(await shop(merchant)).toBe(true);
  });

  it('a request the old key signed just before the switch still verifies at a merchant that fetches the profile after it; without the overlap it would not', async () => {
    const { identity, p } = await boot();
    await p.publish();
    await p.rotateKey();
    await p.verifyServed();
    now = ((await p.nextKeyStepAt()) ?? 0) - 1;
    const inFlight = await signed();
    expect(inFlight.length).toBeGreaterThan(0);
    now += 1;
    await p.publish();
    expect(identity.key.generation).toBe(1);
    // A merchant that reads the profile now, after the switch: the old key is listed as retiring.
    const late = new CachingMerchant();
    for (const r of inFlight) expect(await late.verify(identity.label, r)).toBe(true);
    // Past the overlap the old key is gone: the same request no longer verifies.
    now += KEY_OVERLAP_MS;
    await p.publish();
    const after = new CachingMerchant();
    for (const r of inFlight) expect(await after.verify(identity.label, r)).toBe(false);
  });
});

describe('review round 3 (U7)', () => {
  it('"compromised" before the label was ever published: the next generation publishes and signs, with no restart; generation 0 never does', async () => {
    const { identity, p } = await boot();
    // Boot read the record; a publisher whose first upload never landed has no ring yet.
    intercept = async (r) => (r.method === 'PUT' ? DOWN : null);
    expect(await p.publish()).toBe('unreachable');
    intercept = null;
    // The host knows nothing of this label (404): nothing to retire there.
    expect(await p.retireKey()).toBe('served');
    expect(await p.state()).toMatchObject({ keyRetired: false, pendingControl: null });
    expect(identity.key.generation).toBeGreaterThanOrEqual(0);
    expect(await shop(new CachingMerchant())).toBe(true);
  });

  it('"compromised" after a ring was known but before the host bound the label: starts above it', async () => {
    const { identity, p } = await boot();
    // A record that names generation 0 (it was about to publish) and an unbound host.
    await kvSet(
      'publisher',
      JSON.stringify({ ...(await p.state()), keys: { active: 0, retiring: [] } }),
      'ucp',
    );
    expect(await p.retireKey()).toBe('served');
    expect(identity.key.generation).toBe(1);
    expect(await servedKids(identity.label)).toEqual(kids(identity, 1));
  });

  it('a "not_bound" answer to the retirement ends it the same way: published again, signing, no restart', async () => {
    const { identity, p } = await boot();
    await p.publish();
    intercept = async (r) =>
      r.method === 'POST' && r.url.endsWith('/retire')
        ? {
            ok: true,
            status: 409,
            bodyBytes: new TextEncoder().encode(
              JSON.stringify({ status: 'refused', reason: 'not_bound', state: null }),
            ),
            headers: { 'content-type': 'application/json' },
            connectedAddress: '203.0.114.7',
          }
        : null;
    const out = await p.retireKey();
    intercept = null;
    // Published again at once (the next upload leaves generation 0 out, so the host retires it).
    expect(out).toBe('served');
    expect((await p.state()).keyRetired).toBe(false);
    expect(identity.key.generation).toBe(1);
    expect(labelState(identity.label)?.retired).toContain(identity.keyAt(0).jwk.kid);
    expect(await shop(new CachingMerchant())).toBe(true);
  });

  it('a pause on a label the host never knew is simply off', async () => {
    const { p } = await boot();
    expect(await p.turnOff()).toBe('off');
    expect((await p.state()).keyRetired).toBe(false);
  });
});

describe('simulator run (Android, 2026-10-05)', () => {
  it('"use this device" pressed while the host is out of reach is kept, never lost: the turn-off is cancelled and UCP comes back on once the host answers', async () => {
    const { p } = await boot();
    await p.publish();
    intercept = async () => DOWN;
    expect(await p.turnOff()).toBe('stopping');
    await p.activate();
    // On at once, the turn-off cancelled; the claim waits for the host.
    expect(await p.state()).toMatchObject({ enabled: true, pendingControl: 'activate' });
    intercept = null;
    expect(await p.publish()).toBe('served');
    expect(await p.state()).toMatchObject({ enabled: true, pendingControl: null });
    expect(labelState(getUcpIdentity()?.label ?? '')?.serving).toBe(true);
  });

  it('a stood-down device whose "use this device" could not reach the host claims shopping on the next run', async () => {
    const a = await boot();
    await a.p.publish();
    await kvDelete('publisher', 'ucp');
    const b = await boot();
    expect(await b.p.publish()).toBe('stood_down');
    intercept = async () => DOWN;
    await b.p.activate();
    intercept = null;
    expect(await b.p.publish()).toBe('served');
    expect(await b.p.state()).toMatchObject({ role: 'active', enabled: true });
  });
});

describe('a pending owner action and a newer choice on another device (dual review R1-1)', () => {
  /** Two devices of one owner: one KV store here, so each acts with its own record swapped in. */
  async function twoDevices() {
    const a = await boot();
    await a.p.publish();
    const recordA = await a.p.state();
    await kvDelete('publisher', 'ucp');
    const b = await boot();
    expect(await b.p.publish()).toBe('stood_down');
    const recordB = await b.p.state();
    const as = async (rec: unknown) => kvSet('publisher', JSON.stringify(rec), 'ucp');
    return { a, b, recordA, recordB, as };
  }

  it('"use this device" pressed offline on B, then the owner chose A: B’s retry is not applied, and B says why', async () => {
    const { a, b, recordA, as } = await twoDevices();
    intercept = async () => DOWN;
    expect(await b.p.activate()).toBe('unreachable');
    const pendingB = await b.p.state();
    intercept = null;
    // Later, on A, the owner activates A.
    await as(recordA);
    expect(await a.p.activate()).toBe('served');
    const epochA = labelState(a.identity.label)?.epoch;
    // B comes back and its schedule retries the old press.
    await as(pendingB);
    expect(await b.p.publish()).toBe('stood_down');
    expect(await b.p.state()).toMatchObject({ pendingControl: null, detail: 'superseded' });
    expect(labelState(a.identity.label)?.epoch).toBe(epochA);
    // Set aside, it stood down as any device does: signing with the holder's key at once.
    expect(b.identity.signingKey()?.generation).toBe(a.identity.key.generation);
    expect((await b.p.state()).keys?.active).toBe(a.identity.key.generation);
  });

  it('a turn-off pressed offline, then another device chosen: the retry does not switch shopping off', async () => {
    const { a, b, recordA, as } = await twoDevices();
    // B takes shopping, then (offline) the owner presses "turn off" there.
    await as(await b.p.state());
    expect(await b.p.activate()).toBe('served');
    intercept = async () => DOWN;
    expect(await b.p.turnOff()).toBe('stopping');
    const pendingB = await b.p.state();
    intercept = null;
    // Later the owner chooses A.
    await as(recordA);
    expect(await a.p.activate()).toBe('served');
    await as(pendingB);
    expect(await b.p.publish()).toBe('stood_down');
    expect(await b.p.state()).toMatchObject({ pendingControl: null, detail: 'superseded' });
    expect(labelState(a.identity.label)?.serving).toBe(true);
  });

  it('a press made now always applies, even when this device had not seen the other’s earlier claim', async () => {
    const { a, b, recordA, as } = await twoDevices();
    // A last knew epoch 1; B claimed epoch 2 since. The owner now turns shopping off on A.
    await as(await b.p.state());
    expect(await b.p.activate()).toBe('served');
    await as(recordA);
    expect(await a.p.turnOff()).toBe('off');
    expect(labelState(a.identity.label)?.serving).toBe(false);
  });

  it('a pending press with no newer choice anywhere is carried out when the host answers', async () => {
    const { b } = await twoDevices();
    intercept = async () => DOWN;
    expect(await b.p.activate()).toBe('unreachable');
    intercept = null;
    expect(await b.p.publish()).toBe('served');
    expect(await b.p.state()).toMatchObject({ role: 'active', pendingControl: null });
  });
});
