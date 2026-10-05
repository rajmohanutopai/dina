/**
 * Linking an account at a merchant (UCP plan §3.17, U4.2) against the mock
 * merchant's authorization server, over the real policy socket: discovery,
 * the refusals before any redirect, the flow and its callback checks, one
 * refresh at a time, and unlink with revocation.
 */

import { randomBytes } from 'node:crypto';

import { sha256 } from '@noble/hashes/sha2.js';

import { mockProduct } from '../../../../test-harness/src/ucp_merchant/catalog';
import { orderFrom } from '../../../../test-harness/src/ucp_merchant/orders';
import {
  startMockMerchant,
  type MockMerchant,
} from '../../../../test-harness/src/ucp_merchant/server';
import { setUcpPolicySocket, ucpFetch } from '../../../src/commerce/ucp/fetch';
import { installUcpIdentity } from '../../../src/commerce/ucp/identity';
import { linkCardCorrelation, readLinkCard } from '../../../src/commerce/ucp/link_card';
import { UcpLinkStore } from '../../../src/commerce/ucp/link_store';
import {
  UcpLinkService,
  PENDING_LINK_TTL_MS,
  REFRESH_LEASE_MS,
  HELD_CALLBACK_LIFE_MS,
  dropHeldLinkCallbacks,
  heldLinkCallbacks,
  UCP_OAUTH_CALLBACK_WAIT_MS,
} from '../../../src/commerce/ucp/links';
import { installUcpLinkAuth, UcpMerchantClient } from '../../../src/commerce/ucp/merchant_client';
import { UcpOrderStore } from '../../../src/commerce/ucp/order_store';
import { UcpOrderService } from '../../../src/commerce/ucp/orders';
import {
  installUcpCheckoutRuntime,
  type UcpCheckoutRuntime,
} from '../../../src/commerce/ucp/runtime';
import { failedCallState } from '../../../src/commerce/ucp/search';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerUcpRoutes } from '../../../src/server/routes/ucp';
import { SQLiteWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService } from '../../../src/workflow/service';

import {
  CERT,
  IDENTITY,
  KEY,
  PROFILE_HOST,
  PROFILE_URL,
  fetchProfile,
  freshDatabase,
  testSocket,
} from './mock_harness';

import type { MockAuthOptions } from '../../../../test-harness/src/ucp_merchant/auth_server';

const ORDER_READ = 'dev.ucp.shopping.order:read';
const CHECKOUT_MANAGE = 'dev.ucp.shopping.checkout:manage';
const REDIRECT = 'https://node.example/ucp/oauth/callback';

let shop: MockMerchant;
let database: ReturnType<typeof freshDatabase>;
let clock: number;
let n = 0;
let auth: Omit<MockAuthOptions, 'now'>;

async function merchant(over: Partial<Omit<MockAuthOptions, 'now'>> = {}): Promise<void> {
  auth = { scopes: [ORDER_READ, 'dev.ucp.shopping.order:manage', CHECKOUT_MANAGE], ...over };
  shop = await startMockMerchant({
    host: 'agent.test',
    cert: CERT,
    key: KEY,
    products: () => [mockProduct({ id: 'p1', title: 'Tea', description: 'Green tea' })],
    fetchProfile,
    checkouts: true,
    orders: true,
    auth,
    now: () => clock,
  });
}

function service(
  holder = 'h1',
  fetch: typeof ucpFetch = ucpFetch,
  db: ReturnType<typeof freshDatabase>['db'] = database.db,
  more: Partial<ConstructorParameters<typeof UcpLinkService>[0]> = {},
): UcpLinkService {
  return new UcpLinkService({
    store: new UcpLinkStore(db),
    client: new UcpMerchantClient({
      identity: () => IDENTITY,
      profileHost: PROFILE_HOST,
      now: () => clock,
    }),
    fetch,
    clientId: () => PROFILE_URL,
    redirectUri: () => REDIRECT,
    nowMs: () => clock,
    randomBytes: (k) => new Uint8Array(randomBytes(k)),
    sha256: (b) => sha256(b),
    newId: () => `id-${++n}`,
    holder,
    sleep: async () => {
      await new Promise((r) => setImmediate(r));
    },
    ...more,
  });
}

/**
 * A fetch whose refresh answers arrive late: the merchant has issued the
 * tokens, and the answer is held until released. Notes what each answered.
 */
function heldRefreshes() {
  const answered: string[] = [];
  let release: () => void = () => undefined;
  let gate = new Promise<void>((r) => (release = r));
  let waiting = 0;
  const fetch: typeof ucpFetch = async (req) => {
    const body = req.body === undefined ? '' : new TextDecoder().decode(req.body as Uint8Array);
    if (!body.includes('grant_type=refresh_token')) return ucpFetch(req);
    const r = await ucpFetch(req);
    if (r.ok) {
      const t = JSON.parse(new TextDecoder().decode(r.bodyBytes)) as Record<string, string>;
      answered.push(t.access_token as string, t.refresh_token as string);
    }
    waiting += 1;
    await gate;
    return r;
  };
  return {
    fetch,
    answered,
    waiting: () => waiting,
    release() {
      release();
      gate = new Promise<void>((r) => (release = r));
    },
  };
}

/** A fetch whose authorization-code answers arrive late: the tokens are issued, the answer held until released. */
function heldCodes() {
  const answered: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let waiting = 0;
  const fetch: typeof ucpFetch = async (req) => {
    const body = req.body === undefined ? '' : new TextDecoder().decode(req.body as Uint8Array);
    if (!body.includes('grant_type=authorization_code')) return ucpFetch(req);
    const r = await ucpFetch(req);
    if (r.ok) {
      const t = JSON.parse(new TextDecoder().decode(r.bodyBytes)) as Record<string, string>;
      answered.push(t.access_token as string, t.refresh_token as string);
    }
    waiting += 1;
    await gate;
    return r;
  };
  return { fetch, answered, waiting: () => waiting, release: () => release() };
}

/** Let held work move until `done` holds (each turn one macrotask). */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((r) => setImmediate(r));
  if (!done()) throw new Error('never happened');
}

/** Link the shop: start, the owner's yes, the callback. */
async function linked(links = service()) {
  const started = await links.start(shop.origin);
  if (!started.ok) throw new Error(started.reason);
  const back = shop.auth?.consent(started.url) ?? {};
  const done = await links.complete(back);
  if (!done.ok) throw new Error(done.reason);
  return { links, started };
}

beforeEach(() => {
  database = freshDatabase('links');
  clock = Date.now();
  setUcpPolicySocket(testSocket());
  installUcpIdentity(IDENTITY);
});

afterEach(async () => {
  setUcpPolicySocket(null);
  installUcpIdentity(null);
  database.close();
  await shop?.close();
});

describe('linking', () => {
  it('discovers the server, asks only for the scopes Dina uses, and stores a link the owner said yes to', async () => {
    await merchant();
    const links = service();
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    // Never order:manage (Dina does not return or cancel orders).
    expect(started.scopes).toEqual([CHECKOUT_MANAGE, ORDER_READ]);
    expect(started.issuer).toBe(`${shop.origin}/auth`);
    const url = new URL(started.url);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: PROFILE_URL,
      redirect_uri: REDIRECT,
      code_challenge_method: 'S256',
      scope: `${CHECKOUT_MANAGE} ${ORDER_READ}`,
    });
    const done = await links.complete(shop.auth?.consent(started.url) ?? {});
    expect(done).toEqual({
      ok: true,
      merchantOrigin: shop.origin,
      scopes: [CHECKOUT_MANAGE, ORDER_READ],
    });
    const view = links.view(shop.origin);
    expect(view).toMatchObject({
      state: 'active',
      issuer: `${shop.origin}/auth`,
      client_id: PROFILE_URL,
    });
    // The view never carries a token.
    expect(JSON.stringify(view)).not.toMatch(/at-|rt-/);
    expect(await links.bearer(shop.origin)).toMatch(/^at-/);
  });

  it('a merchant with no protected-resource metadata is its own issuer; OIDC discovery is used only on 404', async () => {
    await merchant({ protectedResource: false, rfc8414: false });
    const started = await service().start(shop.origin);
    expect(started).toMatchObject({ ok: true, issuer: shop.origin });
  });

  it.each<[string, Partial<Omit<MockAuthOptions, 'now'>>, string]>([
    ['no S256', { s256: false }, 'no_s256'],
    ['no iss response parameter', { issParameter: false }, 'no_iss_parameter'],
    ['no public-client authentication', { publicClient: false }, 'no_public_client'],
    ['no scope Dina uses', { scopes: ['dev.ucp.shopping.order:manage'] }, 'nothing_to_link'],
  ])('refuses before any redirect: %s', async (_n, over, reason) => {
    await merchant(over);
    expect(await service().start(shop.origin)).toEqual({ ok: false, reason });
    expect(database.db.query('SELECT 1 FROM ucp_link_pending')).toEqual([]);
  });

  it('a merchant that does not offer identity linking: nothing to start', async () => {
    shop = await startMockMerchant({
      host: 'agent.test',
      cert: CERT,
      key: KEY,
      products: () => [],
      fetchProfile,
      now: () => clock,
    });
    expect(await service().start(shop.origin)).toEqual({ ok: false, reason: 'not_offered' });
  });
});

describe('the callback', () => {
  beforeEach(() => merchant());

  it('the owner said no: nothing is stored', async () => {
    const links = service();
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    expect(await links.complete(shop.auth?.consent(started.url, 'no') ?? {})).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(links.view(shop.origin)).toBeNull();
  });

  it('a replayed callback, a wrong state, a wrong iss and an expired link are all refused; a link is consumed once', async () => {
    const links = service();
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    const back = shop.auth?.consent(started.url) ?? {};
    expect(await links.complete({ ...back, state: 'not-ours' })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
    // A wrong iss (a mix-up) consumes the pending link: it is not tried again.
    expect(await links.complete({ ...back, iss: 'https://evil.example' })).toEqual({
      ok: false,
      reason: 'discarded',
    });
    expect(await links.complete(back)).toEqual({ ok: false, reason: 'unknown_state' });
    // A fresh start, left past its 10 minutes.
    const late = await links.start(shop.origin);
    if (!late.ok) throw new Error(late.reason);
    const lateBack = shop.auth?.consent(late.url) ?? {};
    clock += PENDING_LINK_TTL_MS + 1;
    expect(await links.complete(lateBack)).toEqual({ ok: false, reason: 'unknown_state' });
    expect(links.view(shop.origin)).toBeNull();
  });

  it('a crash after the callback was taken but before the code was exchanged: the repeat finishes it, never losing it (dual review R1-7)', async () => {
    await merchant();
    const links = service();
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    const back = shop.auth?.consent(started.url) ?? {};
    // The process took the attempt, then stopped before the token request.
    expect(
      new UcpLinkStore(database.db).consumePending(
        String(back.state),
        clock,
        true,
        UCP_OAUTH_CALLBACK_WAIT_MS,
      ),
    ).not.toBeNull();
    const restarted = service();
    // Within the time an exchange may take, another run may still be finishing it.
    expect(await restarted.complete(back, { relayed: true })).toEqual({
      ok: false,
      reason: 'busy',
    });
    clock += UCP_OAUTH_CALLBACK_WAIT_MS;
    expect(await restarted.complete(back, { relayed: true })).toMatchObject({ ok: true });
    expect(restarted.view(shop.origin)?.state).toBe('active');
    // Ended now: a further repeat is refused.
    expect(await restarted.complete(back, { relayed: true })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
  });

  it('a crash right after the link was written: the repeat never spends the code again, and what follows the link is done then (dual review R2-3)', async () => {
    await merchant();
    let exchanges = 0;
    const counting: typeof ucpFetch = async (req) => {
      const body = req.body === undefined ? '' : new TextDecoder().decode(req.body as Uint8Array);
      if (body.includes('grant_type=authorization_code')) exchanges += 1;
      return ucpFetch(req);
    };
    // The process stops right after the link's commit: here, in the first step that follows it.
    const crashing = service('h1', counting, database.db, {
      onLinked: () => {
        throw new Error('process stopped');
      },
    });
    const started = await crashing.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    const back = shop.auth?.consent(started.url) ?? {};
    await expect(crashing.complete(back, { relayed: true })).rejects.toThrow('process stopped');
    expect(exchanges).toBe(1);
    expect(crashing.view(shop.origin)?.state).toBe('active');
    // Restarted, past the claim window, the phone hands the callback over again.
    const resumed: string[] = [];
    const restarted = service('h1', counting, database.db, {
      onLinked: (origin) => resumed.push(origin),
    });
    clock += UCP_OAUTH_CALLBACK_WAIT_MS;
    expect(await restarted.complete(back, { relayed: true })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
    expect(exchanges).toBe(1);
    expect(resumed).toEqual([shop.origin]);
    expect(restarted.view(shop.origin)?.state).toBe('active');
  });

  it('survives a restart between start and callback (a new service on the same database)', async () => {
    const started = await service('a').start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    const done = await service('b').complete(shop.auth?.consent(started.url) ?? {});
    expect(done.ok).toBe(true);
  });
});

describe('refresh', () => {
  beforeEach(() => merchant());

  it('an expiring token is refreshed before use; the rotated refresh token is kept', async () => {
    const { links } = await linked();
    const first = await links.bearer(shop.origin);
    clock += 3600_000;
    const second = await links.bearer(shop.origin);
    expect(second).toMatch(/^at-/);
    expect(second).not.toBe(first);
    expect(shop.auth?.tokenRequests).toEqual(['authorization_code', 'refresh_token']);
    // The next refresh uses the rotated token: the merchant does not see a reused one.
    clock += 3600_000;
    expect(await links.bearer(shop.origin)).toMatch(/^at-/);
    expect(shop.auth?.revoked).toEqual([]);
  });

  it('two callers at once: one refresh, both get the new token', async () => {
    const { links } = await linked();
    clock += 3600_000;
    const other = service('h2');
    const [a, b] = await Promise.all([links.bearer(shop.origin), other.bearer(shop.origin)]);
    expect(shop.auth?.tokenRequests.filter((t) => t === 'refresh_token')).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('a refresh whose answer is lost is retried once with the same token; a merchant that treats that as reuse ends the link for re-linking', async () => {
    const { links } = await linked();
    clock += 3600_000;
    if (shop.auth !== null) shop.auth.loseNextTokenAnswer = true;
    // The merchant rotated the token while the answer was lost; the retry presents the old one.
    expect(await links.bearer(shop.origin)).toBeNull();
    expect(shop.auth?.tokenRequests.filter((t) => t === 'refresh_token')).toHaveLength(2);
    expect(links.view(shop.origin)?.state).toBe('needs_relink');
  });

  it('invalid_grant: the link needs the owner to link again, and is not used', async () => {
    const { links } = await linked();
    // The merchant ends the grant.
    const rt = links['deps'].store.useTokens(shop.origin, (t) => t.refreshToken);
    shop.auth?.handle('POST', '/auth/revoke', `token=${rt ?? ''}`);
    clock += 3600_000;
    expect(await links.bearer(shop.origin)).toBeNull();
    expect(links.view(shop.origin)?.state).toBe('needs_relink');
  });
});

describe('unlink', () => {
  beforeEach(() => merchant());

  it('stops use at once, revokes every token, then the link goes', async () => {
    const { links } = await linked();
    const rt = links['deps'].store.useTokens(shop.origin, (t) => t.refreshToken);
    const at = await links.bearer(shop.origin);
    expect(links.unlink(shop.origin)).toBe(true);
    expect(await links.bearer(shop.origin)).toBeNull();
    expect(links.view(shop.origin)?.state).toBe('revoking');
    await links.sweep();
    expect([...(shop.auth?.revoked ?? [])].sort()).toEqual([at, rt].sort());
    expect(links.view(shop.origin)).toBeNull();
  });

  it('offline: revocation retries with backoff; the link stays revoking until it succeeds', async () => {
    const { links } = await linked();
    links.unlink(shop.origin);
    setUcpPolicySocket(null);
    await links.sweep();
    expect(links.view(shop.origin)?.state).toBe('revoking');
    setUcpPolicySocket(testSocket());
    clock += 60_000;
    await links.sweep();
    expect(links.view(shop.origin)).toBeNull();
  });

  it('a refresh still running at unlink: the link stays until it answers, then its rotated tokens are revoked too', async () => {
    const held = heldRefreshes();
    const { links } = await linked(service('h1', held.fetch));
    const refreshing = links.refresh(shop.origin);
    await until(() => held.waiting() === 1);
    expect(links.unlink(shop.origin)).toBe(true);
    // The old tokens go, but the link waits for the refresh it may still hear from.
    await links.sweep();
    expect(links.view(shop.origin)).toMatchObject({ state: 'revoking' });
    held.release();
    expect(await refreshing).toBe(false);
    await links.sweep();
    expect(shop.auth?.revoked).toEqual(expect.arrayContaining(held.answered));
    expect(held.answered).toHaveLength(2);
    expect(links.view(shop.origin)).toBeNull();
  });

  it('a refresh that answers after its lease lapsed and the link went: its tokens are still revoked where they were issued', async () => {
    const held = heldRefreshes();
    const { links } = await linked(service('h1', held.fetch));
    const refreshing = links.refresh(shop.origin);
    await until(() => held.waiting() === 1);
    links.unlink(shop.origin);
    // The process stalled past the lease: the unlink finishes without it.
    clock += REFRESH_LEASE_MS + 1;
    await links.sweep();
    expect(links.view(shop.origin)).toBeNull();
    held.release();
    expect(await refreshing).toBe(false);
    await links.sweep();
    expect(shop.auth?.revoked).toEqual(expect.arrayContaining(held.answered));
    expect(new UcpLinkStore(database.db).pendingRevocations(shop.origin)).toBe(0);
  });

  it('a restart part-way through revoking: the queue survives, and the next sweep finishes the unlink', async () => {
    const { links } = await linked();
    links.unlink(shop.origin);
    // The first revocation lands, then the process dies (the second never answers).
    let posts = 0;
    const dying = service('h1', async (req) => {
      posts += 1;
      if (posts > 1) return { ok: false, error: 'unavailable', sent: false };
      return ucpFetch(req);
    });
    await dying.sweep();
    expect(shop.auth?.revoked).toHaveLength(1);
    expect(dying.view(shop.origin)).toMatchObject({ state: 'revoking' });
    // Restarted: a new service on the same store.
    clock += 2 * 60_000;
    const restarted = service('h2');
    await restarted.sweep();
    expect(shop.auth?.revoked).toHaveLength(2);
    expect(restarted.view(shop.origin)).toBeNull();
  });
});

describe('one refresh at a time (§3.17)', () => {
  beforeEach(() => merchant({ accessTtlSeconds: 600 }));

  it('a slow refresh keeps its lease past two timeouts; a second caller waits and uses its token, never sending the old refresh token again', async () => {
    const held = heldRefreshes();
    const { links } = await linked(service('h1', held.fetch));
    const first = links.refresh(shop.origin);
    await until(() => held.waiting() === 1);
    // The first post lost its answer and the retry takes its full time: 30 s on, still leased.
    clock += 31_000;
    const second = service('h1', held.fetch).refresh(shop.origin);
    held.release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(shop.auth?.tokenRequests.filter((t) => t === 'refresh_token')).toHaveLength(1);
    expect(shop.auth?.revoked).toEqual([]);
  });

  it('a lease is released only by the refresh that holds it', () => {
    const store = new UcpLinkStore(database.db);
    store.putLink(
      {
        merchant_origin: 'https://m.example',
        issuer: 'https://m.example',
        token_endpoint: 'https://m.example/token',
        revocation_endpoint: null,
        client_id: PROFILE_URL,
        scopes: [ORDER_READ],
        access_expires_at: null,
      },
      { accessToken: 'a', refreshToken: 'r' },
      clock,
      () => `id-${++n}`,
    );
    expect(store.takeRefresh('https://m.example', 'h1#1', clock, 1000)).not.toBeNull();
    // Lapsed and taken over; the first one finishing late frees nothing.
    expect(store.takeRefresh('https://m.example', 'h1#2', clock + 1001, 1000)).not.toBeNull();
    store.releaseRefresh('https://m.example', 'h1#1');
    expect(store.takeRefresh('https://m.example', 'h1#3', clock + 1002, 1000)).toBeNull();
    store.releaseRefresh('https://m.example', 'h1#2');
    expect(store.takeRefresh('https://m.example', 'h1#3', clock + 1002, 1000)).not.toBeNull();
  });
});

describe('a missing scope is asked for alone (identity-linking §insufficient_scope)', () => {
  /** A scope the merchant lists that Dina asks for only when a challenge names it. */
  const HIGH = 'dev.ucp.shopping.checkout:complete_high_value';
  beforeEach(() =>
    merchant({ scopes: [ORDER_READ, CHECKOUT_MANAGE, HIGH, 'dev.ucp.shopping.order:manage'] }),
  );

  it('with a live link, only the missing scopes are asked; the answer extends the link and nothing granted is revoked', async () => {
    const { links } = await linked();
    expect(links.view(shop.origin)?.scopes).toEqual([CHECKOUT_MANAGE, ORDER_READ]);
    const generation = links.view(shop.origin)?.generation ?? 0;
    // The merchant's challenge names the full set the operation needs.
    const started = await links.start(shop.origin, [CHECKOUT_MANAGE, HIGH]);
    if (!started.ok) throw new Error(started.reason);
    expect(started.scopes).toEqual([HIGH]);
    expect(new URL(started.url).searchParams.get('scope')).toBe(HIGH);
    const done = await links.complete(shop.auth?.consent(started.url) ?? {});
    expect(done).toMatchObject({ ok: true, scopes: [HIGH, CHECKOUT_MANAGE, ORDER_READ] });
    expect(links.view(shop.origin)).toMatchObject({
      state: 'active',
      generation: generation + 1,
      scopes: [HIGH, CHECKOUT_MANAGE, ORDER_READ],
    });
    expect(shop.auth?.revoked).toEqual([]);
    expect(new UcpLinkStore(database.db).pendingRevocations(shop.origin)).toBe(0);
    const bearer = await links.bearer(shop.origin);
    expect(shop.auth?.authorized(`Bearer ${bearer}`, ORDER_READ)).toBe('ok');
    expect(shop.auth?.authorized(`Bearer ${bearer}`, HIGH)).toBe('ok');
  });

  it('a step-up answer that arrives after the owner unlinked never brings the link back: its tokens are revoked (dual review R1-4)', async () => {
    await linked();
    // The step-up's answer is held: a second service on the same store, as a restart would be.
    const held = heldCodes();
    const links = service('h1', held.fetch);
    const started = await links.start(shop.origin, [CHECKOUT_MANAGE, HIGH]);
    if (!started.ok) throw new Error(started.reason);
    const finishing = links.complete(shop.auth?.consent(started.url) ?? {});
    await until(() => held.waiting() === 1);
    expect(links.unlink(shop.origin)).toBe(true);
    held.release();
    expect(await finishing).toEqual({ ok: false, reason: 'cancelled' });
    expect(links.view(shop.origin)?.state).not.toBe('active');
    await links.sweep();
    expect(shop.auth?.revoked).toEqual(expect.arrayContaining(held.answered));
    expect(links.view(shop.origin)).toBeNull();
    expect(await links.bearer(shop.origin)).toBeNull();
  });

  it('a first link whose answer arrives after an unlink of that shop: nothing is linked, its tokens revoked', async () => {
    const held = heldCodes();
    const links = service('h1', held.fetch);
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    const finishing = links.complete(shop.auth?.consent(started.url) ?? {});
    await until(() => held.waiting() === 1);
    links.unlink(shop.origin);
    held.release();
    expect(await finishing).toEqual({ ok: false, reason: 'cancelled' });
    expect(links.view(shop.origin)).toBeNull();
    await links.sweep();
    expect(shop.auth?.revoked).toEqual(expect.arrayContaining(held.answered));
  });

  it('a step-up raises the authorization revision a checkout approval binds; a refresh does not (plan §3.7)', async () => {
    const { links } = await linked();
    expect(links.view(shop.origin)?.auth_revision).toBe(1);
    await links.refresh(shop.origin);
    expect(links.view(shop.origin)?.auth_revision).toBe(1);
    const started = await links.start(shop.origin, [CHECKOUT_MANAGE, HIGH]);
    if (!started.ok) throw new Error(started.reason);
    await links.complete(shop.auth?.consent(started.url) ?? {});
    expect(links.view(shop.origin)?.auth_revision).toBe(2);
  });

  it('a challenge for scopes the link holds (a policy one): asked again, the grant kept', async () => {
    const { links } = await linked();
    const again = await links.start(shop.origin, [ORDER_READ]);
    if (!again.ok) throw new Error(again.reason);
    expect(again.scopes).toEqual([ORDER_READ]);
    expect(await links.complete(shop.auth?.consent(again.url) ?? {})).toMatchObject({ ok: true });
    expect(links.view(shop.origin)?.scopes).toEqual([CHECKOUT_MANAGE, ORDER_READ]);
    expect(shop.auth?.revoked).toEqual([]);
  });

  it('a challenge naming a scope the merchant does not list asks only for those it lists', async () => {
    const { links } = await linked();
    const started = await links.start(shop.origin, [
      HIGH,
      'dev.ucp.shopping.payments:manage',
      'com.other:read',
    ]);
    if (!started.ok) throw new Error(started.reason);
    expect(started.scopes).toEqual([HIGH]);
    // Nothing listed among them: nothing to ask.
    expect(await links.start(shop.origin, ['com.other:read'])).toEqual({
      ok: false,
      reason: 'nothing_to_link',
    });
  });

  it('a challenge that needs order:manage is never answered, though the merchant lists it: Dina never cancels or returns', async () => {
    const { links } = await linked();
    expect(await links.start(shop.origin, [ORDER_READ, 'dev.ucp.shopping.order:manage'])).toEqual({
      ok: false,
      reason: 'scope_refused',
    });
    expect(await links.canLink(shop.origin, ['dev.ucp.shopping.order:manage'])).toBe('never');
    // A first link never asks for it either.
    links.unlink(shop.origin);
    const fresh = await links.start(shop.origin);
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(fresh.scopes).not.toContain('dev.ucp.shopping.order:manage');
  });

  it('no live link: a fresh link with the scopes Dina uses and those the challenge named', async () => {
    const { links } = await linked();
    links.unlink(shop.origin);
    const fresh = await links.start(shop.origin, [ORDER_READ, HIGH]);
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(fresh.scopes).toEqual([HIGH, CHECKOUT_MANAGE, ORDER_READ]);
  });
});

describe('a callback the Dina app caught (U4.4, §3.17)', () => {
  beforeEach(() => merchant());

  it('the phone’s own link finishes on the phone', async () => {
    const phone = service();
    const started = await phone.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    const out = await phone.receive(shop.auth?.consent(started.url) ?? {});
    expect(out).toMatchObject({ ok: true, merchantOrigin: shop.origin });
    expect(phone.view(shop.origin)?.state).toBe('active');
  });

  it('a NAT’d server’s link: the phone keeps the callback, the server pulls it by its state, finishes, and the phone drops it', async () => {
    const phoneDb = freshDatabase('links-phone');
    try {
      const server = service();
      const phone = service('p1', ucpFetch, phoneDb.db, { serverPaired: () => true });
      const started = await server.start(shop.origin);
      if (!started.ok) throw new Error(started.reason);
      const back = shop.auth?.consent(started.url) ?? {};
      expect(await phone.receive(back)).toEqual({ ok: false, reason: 'held' });
      // The phone never exchanged the code: no link there, none here yet.
      expect(phone.view(shop.origin)).toBeNull();
      expect(shop.auth?.tokenRequests).toEqual([]);
      const states = server.waitingStates();
      expect(states).toEqual([back.state]);
      // Another state (another server's, or a guess) reads nothing.
      expect(heldLinkCallbacks(new UcpLinkStore(phoneDb.db), ['A'.repeat(43)], clock)).toEqual([]);
      const held = heldLinkCallbacks(new UcpLinkStore(phoneDb.db), states, clock);
      expect(held).toEqual([{ state: back.state, params: back }]);
      expect(await server.complete(held[0]?.params ?? {})).toMatchObject({ ok: true });
      expect(server.view(shop.origin)?.state).toBe('active');
      // Pulled again before the acknowledgement: the pending link was consumed once.
      expect(await server.complete(held[0]?.params ?? {})).toEqual({
        ok: false,
        reason: 'unknown_state',
      });
      expect(server.waitingStates()).toEqual([]);
      expect(dropHeldLinkCallbacks(new UcpLinkStore(phoneDb.db), states)).toBe(1);
      expect(heldLinkCallbacks(new UcpLinkStore(phoneDb.db), states, clock)).toEqual([]);
    } finally {
      phoneDb.close();
    }
  });

  it('a phone no server is paired with keeps nothing: a stray callback is one for nothing', async () => {
    const phone = service('p1', ucpFetch, database.db, { serverPaired: () => false });
    const state = 's'.repeat(43);
    expect(await phone.receive({ code: 'c', state })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
    expect(heldLinkCallbacks(new UcpLinkStore(database.db), [state], clock)).toEqual([]);
  });

  it('a held callback lasts 10 minutes; at most 20 are kept; a bad state is never kept', async () => {
    const phone = service('p1', ucpFetch, database.db, { serverPaired: () => true });
    const state = (i: number) => `s${String(i).padStart(42, '0')}`;
    expect(await phone.receive({ code: 'c', state: 'short' })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
    expect(await phone.receive({ code: 'c', state: 'x'.repeat(129) })).toMatchObject({
      reason: 'unknown_state',
    });
    for (let i = 0; i < 20; i++)
      expect(await phone.receive({ code: 'c', state: state(i) })).toMatchObject({ reason: 'held' });
    expect(await phone.receive({ code: 'c', state: state(20) })).toMatchObject({
      reason: 'not_held',
    });
    // The same state again keeps the first.
    expect(heldLinkCallbacks(new UcpLinkStore(database.db), [state(0)], clock)).toEqual([
      { state: state(0), params: { code: 'c', state: state(0) } },
    ]);
    clock += HELD_CALLBACK_LIFE_MS;
    expect(heldLinkCallbacks(new UcpLinkStore(database.db), [state(0)], clock)).toEqual([]);
    expect(await phone.receive({ code: 'c', state: state(20) })).toMatchObject({ reason: 'held' });
  });
});

describe('a public server: the gateway hands the callback to Core (U4.6, §3.17)', () => {
  beforeEach(() => merchant());
  afterEach(() => installUcpCheckoutRuntime(null));

  it('the owner starts on the console, signs in at the shop, and the callback through Core’s door stores the link', async () => {
    setNodeDID('did:plc:owner');
    const links = service('h1', ucpFetch, database.db, { opensHere: () => true });
    installUcpCheckoutRuntime({ links, stop: () => undefined } as unknown as UcpCheckoutRuntime);
    const router = new CoreRouter();
    registerUcpRoutes(router, 'cap');
    const call = (p: string, body: unknown, who: Partial<CoreRequest>) =>
      router.handle({
        method: 'POST',
        path: p,
        query: {},
        headers: {},
        body,
        rawBody: new Uint8Array(),
        params: {},
        trustedInProcess: true,
        ...who,
      } as CoreRequest);
    const started = await call(
      '/v1/owner/ucp/links/start',
      { merchant_origin: shop.origin },
      { callerType: 'owner', ownerCapability: 'cap' },
    );
    const body = started.body as { started: boolean; opens: string; url: string };
    expect(body).toMatchObject({ started: true, opens: 'here' });
    expect(new URL(body.url).searchParams.get('redirect_uri')).toBe(REDIRECT);
    const back = shop.auth?.consent(body.url) ?? {};
    const done = await call('/v1/ucp/ingress/oauth-callback', back, { callerType: 'gateway' });
    expect(done.body).toEqual({ linked: true, merchant_host: new URL(shop.origin).host });
    expect(links.view(shop.origin)?.state).toBe('active');
    // The same answer again (a reload of the page): refused, and the link stands.
    expect(
      (await call('/v1/ucp/ingress/oauth-callback', back, { callerType: 'gateway' })).body,
    ).toEqual({
      linked: false,
      reason: 'unknown_state',
    });
    const listed = await call(
      '/v1/owner/ucp/links',
      {},
      { callerType: 'owner', ownerCapability: 'cap', method: 'GET' },
    );
    expect(JSON.stringify(listed.body)).not.toMatch(/at-|rt-|token/);
  });
});

describe('where the sign-in page opens (U4.5, §3.17)', () => {
  let workflow: WorkflowService;
  beforeEach(async () => {
    await merchant();
    workflow = new WorkflowService({
      repository: new SQLiteWorkflowRepository(database.db),
      nowMsFn: () => clock,
    });
  });
  const natServer = () =>
    service('h1', ucpFetch, database.db, { opensHere: () => false, workflow: () => workflow });
  const cardsFor = (status?: string) =>
    workflow
      .store()
      .getByCorrelationId(linkCardCorrelation(shop.origin))
      .filter((t) => status === undefined || t.status === status);

  it('a node that takes the answer itself gets the page to open; no card', async () => {
    const here = service('h1', ucpFetch, database.db, {
      opensHere: () => true,
      workflow: () => workflow,
    });
    const out = await here.startForOwner(shop.origin);
    expect(out).toMatchObject({ ok: true, opens: 'here', scopes: [CHECKOUT_MANAGE, ORDER_READ] });
    expect(cardsFor()).toEqual([]);
  });

  it('a server behind NAT sends the page to the phone on a presence-gated card, in Core’s words', async () => {
    const out = await natServer().startForOwner(shop.origin);
    if (!out.ok || out.opens !== 'phone') throw new Error('no card');
    const [card] = cardsFor();
    expect(card).toMatchObject({ id: out.cardId, status: 'pending_approval', origin: 'system' });
    expect(card?.expires_at).toBe(Math.floor(out.expiresAt / 1000));
    const read = readLinkCard(card?.payload ?? '');
    expect(read).toMatchObject({ merchant: shop.origin, scopes: [CHECKOUT_MANAGE, ORDER_READ] });
    expect(new URL(read?.url ?? '').searchParams.get('state')).toBe(natServer().waitingStates()[0]);
    expect(card?.description).toBe(
      [
        `Link your account at ${new URL(shop.origin).host}?`,
        'Dina may prepare checkouts, read your orders.',
        `You sign in at ${new URL(shop.origin).host}.`,
        'Dina never cancels, returns or pays through this link.',
        `Open until ${new Date(out.expiresAt).toISOString()}.`,
      ].join('\n'),
    );
  });

  it('a second start replaces the first card; the yes (from the phone) settles it; the link completing ends any still waiting', async () => {
    const nat = natServer();
    const first = await nat.startForOwner(shop.origin);
    const second = await nat.startForOwner(shop.origin);
    if (!first.ok || first.opens !== 'phone' || !second.ok || second.opens !== 'phone')
      throw new Error('no card');
    expect(workflow.store().getById(first.cardId)?.status).toBe('cancelled');
    expect(workflow.store().getById(second.cardId)?.status).toBe('pending_approval');
    workflow.approve(second.cardId);
    const task = workflow.store().getById(second.cardId);
    if (task === null) throw new Error('no task');
    expect(nat.decide(task, 'approved')).toBe('opened');
    expect(workflow.store().getById(second.cardId)?.status).toBe('completed');
    // Once more: nothing changes.
    expect(nat.decide(task, 'approved')).toBe('ignored');
    // A third card, then the owner links (the phone caught it): the card waiting ends.
    const third = await nat.startForOwner(shop.origin);
    if (!third.ok || third.opens !== 'phone') throw new Error('no card');
    const url = readLinkCard(workflow.store().getById(third.cardId)?.payload ?? '')?.url ?? '';
    expect(await nat.complete(shop.auth?.consent(url) ?? {})).toMatchObject({ ok: true });
    expect(workflow.store().getById(third.cardId)?.status).toBe('cancelled');
  });

  it('with no workflow service, a NAT’d server cannot link and says so before asking the merchant', async () => {
    const nat = service('h1', ucpFetch, database.db, {
      opensHere: () => false,
      workflow: () => null,
    });
    expect(await nat.startForOwner(shop.origin)).toEqual({ ok: false, reason: 'no_workflow' });
    expect(nat.waitingStates()).toEqual([]);
  });

  it('with no phone paired as the node’s own, it refuses before anything leaves; asked later, it may be', async () => {
    let paired = false;
    const nat = service('h1', ucpFetch, database.db, {
      opensHere: () => false,
      phoneReady: () => paired,
      workflow: () => workflow,
    });
    expect(await nat.startForOwner(shop.origin)).toEqual({ ok: false, reason: 'no_phone' });
    expect(await nat.canLink(shop.origin)).toBe('later');
    expect(cardsFor()).toEqual([]);
    expect(nat.waitingStates()).toEqual([]);
    paired = true;
    expect(await nat.canLink(shop.origin)).toBe('yes');
  });

  it('can a link be made: later while the sign-in is out of reach, never where the merchant rules it out', async () => {
    let failing = true;
    const flaky = service('h1', async (req) =>
      failing && req.url.includes('/.well-known/oauth-protected-resource')
        ? { ok: false, error: 'unavailable', sent: true }
        : ucpFetch(req),
    );
    expect(await flaky.canLink(shop.origin)).toBe('later');
    failing = false;
    expect(await flaky.canLink(shop.origin)).toBe('yes');
    await shop.close();
    await merchant({ s256: false });
    expect(await service().canLink(shop.origin)).toBe('never');
  });

  it('a refusal is the start’s, and raises no card', async () => {
    await shop.close();
    await merchant({ publicClient: false });
    expect(await natServer().startForOwner(shop.origin)).toEqual({
      ok: false,
      reason: 'no_public_client',
    });
    expect(cardsFor()).toEqual([]);
  });
});

describe('merchant calls with a linked account (U4.3)', () => {
  beforeEach(() => merchant({ accessTtlSeconds: 600 }));
  afterEach(() => installUcpLinkAuth(null));

  /** An order at the shop that only shares with a linked account, its reconciler, and the link service as the runtime wires them. */
  function followed(fetch: typeof ucpFetch = ucpFetch) {
    const store = new UcpOrderStore(database.db);
    const links = service('h1', fetch, database.db, {
      onLinked: (origin, at) => store.resumeAfterLink(origin, at),
    });
    installUcpLinkAuth(links);
    shop.logic.orders.set('ord_1', orderFrom('ord_1', 'co_1', 'EUR', []));
    const orders = new UcpOrderService({
      store,
      client: new UcpMerchantClient({
        identity: () => IDENTITY,
        profileHost: PROFILE_HOST,
        now: () => clock,
      }),
      nowMs: () => clock,
      holder: 'o',
      takesWebhooks: () => false,
      random: () => 0.5,
      canLink: (origin, scopes) => links.canLink(origin, scopes),
      linkView: (origin) => links.view(origin),
    });
    orders.track(
      {
        session_id: 's1',
        merchant_origin: shop.origin,
        merchant_checkout_id: 'co_1',
        leaf_profile_url: `${shop.origin}/.well-known/ucp`,
        version: '2026-08-25',
        transport: 'mcp',
        order_id: 'ord_1',
        order_permalink_url: `${shop.origin}/orders/ord_1`,
      } as never,
      clock,
    );
    return { store, links, orders, key: { merchant_origin: shop.origin, order_id: 'ord_1' } };
  }

  it('Get Order: refused without a link (polling waits), then read with the bearer once linked; an expired token is refreshed once and the call sent again', async () => {
    const { store, links, orders, key } = followed();
    await orders.reconcile(key);
    // Paused for the owner: woken only to close by age (180 days).
    expect(store.get(key)).toMatchObject({ state: 'open', next_poll_at: clock + 180 * 86_400_000 });
    // `identity_required` names no scope (spec §"identity_required"): a link with the scopes Dina uses.
    expect(store.get(key)?.link_scopes).toBe('[]');
    // The merchant asked: the owner is offered a link there.
    expect(links.wanted().map((w) => w.merchant_origin)).toEqual([shop.origin]);
    // The owner links; the order waiting for it is due at once, through the service's own hook.
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    await links.complete(shop.auth?.consent(started.url) ?? {});
    expect(store.get(key)).toMatchObject({ link_scopes: null, next_poll_at: clock });
    expect(links.wanted()).toEqual([]);
    await orders.sweep();
    expect(store.get(key)).toMatchObject({ link_scopes: null, polls: 2 });
    expect(store.get(key)?.summary_json).toContain('EUR');
    // The token lapses at the merchant before Dina expected (its clock ran ahead): the
    // merchant says invalid_token; Dina refreshes once and asks again.
    const before = shop.auth?.tokenRequests.filter((t) => t === 'refresh_token').length ?? 0;
    clock += 601_000;
    database.db.run(`UPDATE ucp_merchant_links SET access_expires_at = ?`, [clock + 3600_000]);
    database.db.run(`UPDATE ucp_orders SET next_poll_at = ?`, [clock]);
    await orders.sweep();
    expect(shop.auth?.tokenRequests.filter((t) => t === 'refresh_token').length).toBe(before + 1);
    expect(store.get(key)).toMatchObject({ polls: 3, link_scopes: null, state: 'open' });
  });

  it('a linked account whose refresh fails for a moment: no call goes without its token, and the order keeps its schedule', async () => {
    let tokenDown = false;
    const { store, links, orders, key } = followed(async (req) => {
      const body = req.body === undefined ? '' : new TextDecoder().decode(req.body as Uint8Array);
      if (tokenDown && body.includes('grant_type=refresh_token'))
        return { ok: false, error: 'unavailable', sent: false };
      return ucpFetch(req);
    });
    // Get Order calls the merchant received (MCP tools/call).
    const getOrders = () =>
      shop.mcpLog.filter((m) => m.method === 'tools/call' && m.rawBody.includes('get_order'))
        .length;
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    await links.complete(shop.auth?.consent(started.url) ?? {});
    // The token is near its end and the merchant's token endpoint is down.
    clock += 600_000;
    tokenDown = true;
    const calls = getOrders();
    await orders.reconcile(key);
    expect(getOrders()).toBe(calls);
    expect(store.get(key)).toMatchObject({ state: 'open', link_scopes: null });
    expect(store.get(key)?.next_poll_at).toBeLessThan(clock + 86_400_000);
    expect(links.view(shop.origin)?.state).toBe('active');
    // Back up: the next poll reads it.
    tokenDown = false;
    await orders.reconcile(key);
    expect(store.get(key)?.summary_json).toContain('EUR');
    // The count above is of real merchant calls: this read made one.
    expect(getOrders()).toBe(calls + 1);
  });

  it('a stale token refused twice brings one refresh: the second refusal finds a newer token and sends nothing', async () => {
    const { links } = followed();
    const started = await links.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    await links.complete(shop.auth?.consent(started.url) ?? {});
    const stale = (await links.bearer(shop.origin)) ?? '';
    const count = () => shop.auth?.tokenRequests.filter((t) => t === 'refresh_token').length ?? 0;
    expect(await links.refresh(shop.origin, stale)).toBe(true);
    expect(count()).toBe(1);
    expect(await links.refresh(shop.origin, stale)).toBe(true);
    expect(count()).toBe(1);
  });
});

describe('revocation that does not land (U4 sweep)', () => {
  it('a server with no revocation endpoint is never linked: Dina could not take the access back', async () => {
    await merchant({ revocation: false });
    expect(await service().start(shop.origin)).toEqual({ ok: false, reason: 'no_revocation' });
    expect(await service().canLink(shop.origin)).toBe('never');
  });

  it('only a 200 revokes; a refused answer is tried again for a week, then the owner is told to remove it there', async () => {
    let answer = { status: 401, body: { error: 'invalid_client' } };
    await merchant({ revokeAnswer: () => answer });
    const { links } = await linked();
    links.unlink(shop.origin);
    await links.sweep();
    // Not revoked: still queued, the link still going.
    expect(new UcpLinkStore(database.db).pendingRevocations(shop.origin)).toBe(2);
    expect(links.view(shop.origin)?.state).toBe('revoking');
    answer = { status: 400, body: { error: 'invalid_request' } };
    clock += 2 * 60_000;
    await links.sweep();
    expect(new UcpLinkStore(database.db).pendingRevocations(shop.origin)).toBe(2);
    clock += 7 * 24 * 3600_000;
    await links.sweep();
    expect(links.unrevoked()).toEqual([{ merchant_origin: shop.origin, since: clock }]);
    expect(links.view(shop.origin)).toBeNull();
    expect(links.dismissUnrevoked(shop.origin)).toBe(true);
    expect(links.unrevoked()).toEqual([]);
  });

  it('a server that does not revoke a token type: an access token lapses on its own; a refresh token is access the owner removes', async () => {
    await merchant({
      revokeAnswer: () => ({ status: 400, body: { error: 'unsupported_token_type' } }),
    });
    const { links } = await linked();
    links.unlink(shop.origin);
    await links.sweep();
    expect(new UcpLinkStore(database.db).pendingRevocations(shop.origin)).toBe(0);
    expect(links.unrevoked().map((u) => u.merchant_origin)).toEqual([shop.origin]);
  });

  it('a step-up that started a separate grant: the refresh token it replaced is revoked with the link', async () => {
    const HIGH = 'dev.ucp.shopping.checkout:complete_high_value';
    await merchant({ scopes: [ORDER_READ, CHECKOUT_MANAGE, HIGH], separateGrants: true });
    const { links } = await linked();
    const firstRefresh = new UcpLinkStore(database.db).useTokens(
      shop.origin,
      (t) => t.refreshToken,
    );
    const up = await links.start(shop.origin, [HIGH]);
    if (!up.ok) throw new Error(up.reason);
    await links.complete(shop.auth?.consent(up.url) ?? {});
    const secondRefresh = new UcpLinkStore(database.db).useTokens(
      shop.origin,
      (t) => t.refreshToken,
    );
    expect(secondRefresh).not.toBe(firstRefresh);
    links.unlink(shop.origin);
    await links.sweep();
    expect(shop.auth?.revoked).toEqual(expect.arrayContaining([firstRefresh, secondRefresh]));
  });
});

describe('races and restarts (U4 sweep)', () => {
  beforeEach(() => merchant({ accessTtlSeconds: 600 }));

  it('a step-up that finishes while a refresh is out waits for it, then merges: the rotated tokens are kept, nothing of the grant revoked', async () => {
    const HIGH = 'dev.ucp.shopping.checkout:complete_high_value';
    await shop.close();
    await merchant({ scopes: [ORDER_READ, CHECKOUT_MANAGE, HIGH], accessTtlSeconds: 600 });
    const held = heldRefreshes();
    const { links } = await linked(service('h1', held.fetch));
    const up = await links.start(shop.origin, [HIGH]);
    if (!up.ok) throw new Error(up.reason);
    const refreshing = links.refresh(shop.origin);
    await until(() => held.waiting() === 1);
    const stepping = links.complete(shop.auth?.consent(up.url) ?? {});
    // Let the step-up find the lease held, then let the refresh land.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    held.release();
    expect(await refreshing).toBe(true);
    expect(await stepping).toMatchObject({ ok: true });
    expect(shop.auth?.revoked).toEqual([]);
    expect(links.view(shop.origin)?.scopes).toEqual([HIGH, CHECKOUT_MANAGE, ORDER_READ]);
    const bearer = await links.bearer(shop.origin);
    expect(shop.auth?.authorized(`Bearer ${bearer}`, HIGH)).toBe('ok');
  });

  it('a refresh that outlived its link and the link made again: its answer never lands on the new one', async () => {
    const held = heldRefreshes();
    const { links } = await linked(service('h1', held.fetch));
    const refreshing = links.refresh(shop.origin);
    await until(() => held.waiting() === 1);
    links.unlink(shop.origin);
    clock += REFRESH_LEASE_MS + 1;
    await links.sweep();
    expect(links.view(shop.origin)).toBeNull();
    // Linked again: a new link, generation 1 again.
    await linked(links);
    const fresh = await links.bearer(shop.origin);
    held.release();
    expect(await refreshing).toBe(false);
    expect(await links.bearer(shop.origin)).toBe(fresh);
    await links.sweep();
    expect(shop.auth?.revoked).toEqual(expect.arrayContaining(held.answered));
  });

  it('a process that died mid-refresh: once its lease lapses another refreshes, with one request', async () => {
    const hang = service('h1', async (req) => {
      const body = req.body === undefined ? '' : new TextDecoder().decode(req.body as Uint8Array);
      if (body.includes('grant_type=refresh_token')) return new Promise(() => undefined);
      return ucpFetch(req);
    });
    await linked(hang);
    clock += 600_000;
    void hang.refresh(shop.origin);
    await new Promise((r) => setImmediate(r));
    clock += REFRESH_LEASE_MS + 1;
    const other = service('h2');
    expect(await other.bearer(shop.origin)).not.toBeNull();
    expect(shop.auth?.tokenRequests.filter((t) => t === 'refresh_token')).toHaveLength(1);
  });
});

describe('a NAT’d server’s pull, crashes and outcomes (U4 sweep)', () => {
  beforeEach(() => merchant());

  it('a crash between finishing a pulled callback and its acknowledgement: pulled again, refused, then acknowledged', async () => {
    const server = service();
    const started = await server.start(shop.origin);
    if (!started.ok) throw new Error(started.reason);
    const back = shop.auth?.consent(started.url) ?? {};
    expect(await server.complete(back, { relayed: true })).toMatchObject({ ok: true });
    // The process died before the acknowledgement: the state is still asked for.
    expect(server.waitingStates()).toEqual([back.state]);
    expect(await server.complete(back, { relayed: true })).toEqual({
      ok: false,
      reason: 'unknown_state',
    });
    server.markRelayed([back.state ?? '']);
    expect(server.waitingStates()).toEqual([]);
  });

  it('a callback that does not finish is kept for the owner, until a later link there works', async () => {
    let tokenDown = true;
    const server = service('h1', async (req) => {
      const body = req.body === undefined ? '' : new TextDecoder().decode(req.body as Uint8Array);
      if (tokenDown && body.includes('grant_type=authorization_code'))
        return { ok: false, error: 'unavailable', sent: false };
      return ucpFetch(req);
    });
    const first = await server.start(shop.origin);
    if (!first.ok) throw new Error(first.reason);
    expect(await server.complete(shop.auth?.consent(first.url) ?? {}, { relayed: true })).toEqual({
      ok: false,
      reason: 'token_unreachable',
    });
    expect(server.failedAttempts()).toEqual([
      { merchant_origin: shop.origin, outcome: 'token_unreachable', at: clock },
    ]);
    tokenDown = false;
    clock += 1000;
    await linked(server);
    expect(server.failedAttempts()).toEqual([]);
  });
});

describe('discovery and scope checks before any redirect (U4 sweep)', () => {
  it('a server error at protected-resource metadata, or at RFC 8414, aborts; OIDC is asked only on a 404', async () => {
    await merchant({ discoveryStatus: { protectedResource: 500 } });
    expect(await service().start(shop.origin)).toEqual({ ok: false, reason: 'discovery_failed' });
    await shop.close();
    await merchant({ discoveryStatus: { rfc8414: 500 } });
    expect(await service().start(shop.origin)).toEqual({ ok: false, reason: 'discovery_failed' });
    expect(shop.auth?.discoveryRequests.some((p) => p.includes('openid-configuration'))).toBe(
      false,
    );
  });

  it('a server whose scopes_supported lacks what Dina would ask is refused', async () => {
    await merchant({ scopesSupported: [ORDER_READ] });
    expect(await service().start(shop.origin)).toEqual({ ok: false, reason: 'scope_mismatch' });
  });
});

describe('a merchant that asks for a linked account on search (U4 sweep)', () => {
  afterEach(() => installUcpLinkAuth(null));

  it('the search says link_required, and the owner is offered the link', async () => {
    await merchant({ scopes: [ORDER_READ, 'dev.ucp.shopping.catalog.search:read'] });
    const links = service();
    installUcpLinkAuth(links);
    const client = new UcpMerchantClient({
      identity: () => IDENTITY,
      profileHost: PROFILE_HOST,
      now: () => clock,
    });
    const opened = await client.open(shop.origin);
    if (!opened.ok) throw new Error('not opened');
    const out = await opened.connection.call('search_catalog', { payload: { query: 'tea' } });
    if (out.ok) throw new Error('answered');
    expect(failedCallState(out)).toBe('link_required');
    expect(links.wanted()).toEqual([{ merchant_origin: shop.origin, scopes: [], at: clock }]);
  });
});
