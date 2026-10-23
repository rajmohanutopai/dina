/**
 * HOSTED_DINA §4–§5 — a hosted cell's gate: sign-up with the ticket, the 24
 * words once, the café set up as a buyer, the owner's browser code, the dot's
 * bootstrap code to the provisioner, forwarding to Core, locking when Core
 * stops, and unlocking with the passphrase.
 *
 * Core here is a fake Fastify app on a real Unix socket that writes a real
 * wrapped seed, so the gate's own checks (ticket, passphrase, recovery words)
 * run against real files.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { generateMnemonic, mnemonicToEntropy, serializeWrappedSeed, wrapSeed } from '@dina/core';

import {
  clientKey,
  createGate,
  type CoreHandle,
  type Gate,
  type GateEvent,
} from '../src/cell/gate';
import { WRAPPED_SEED_NAME } from '../src/identity/master_seed';

const PASS = 'a long cell passphrase';
const CAP = 'cell-owner-capability-0123456789abcdef';

interface FakeCore {
  calls: { method: string; url: string; cap: string | undefined; body: unknown }[];
  mnemonic: string;
}

let dir: string;
let vaultDir: string;
let socket: string;
let events: GateEvent[];
let fake: FakeCore;
let servers: FastifyInstance[];
let gate: Gate;
let spawned: string[];
let handles: CoreHandle[];

let lastGateKey = '';

function fakeCore(): (passphrase: string, gateKey: string) => CoreHandle {
  return (passphrase, gateKey) => {
    lastGateKey = gateKey;
    spawned.push(passphrase);
    let exit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => (exit = resolve));
    const app = Fastify();
    servers.push(app);
    app.addHook('onRequest', async (req) => {
      fake.calls.push({
        method: req.method,
        url: req.url,
        cap: req.headers['x-dina-owner-capability'] as string | undefined,
        body: undefined,
      });
    });
    const ownerOnly = (cap: unknown): boolean => cap === CAP;
    app.get('/readyz', async () => ({ ok: true }));
    app.post('/v1/commerce/catalog/drafts/presence', async (req, reply) => {
      const body = req.body as { passphrase?: string };
      if (body.passphrase !== passphrase) return reply.code(401).send({ error: 'not_proven' });
      return { ok: true };
    });
    app.get('/v1/owner/setup/status', async (req, reply) =>
      ownerOnly(req.headers['x-dina-owner-capability'])
        ? { home_did: 'did:plc:cafecell' }
        : reply.code(403).send({ error: 'owner' }),
    );
    app.post('/v1/owner/setup/owner-device', async () => ({ code: 'OWNERCODE' }));
    app.put('/v1/commerce/settings/buyer', async (req) => {
      const last = fake.calls[fake.calls.length - 1];
      if (last !== undefined) last.body = req.body;
      return { ok: true };
    });
    app.post('/v1/commerce/install/begin', async () => ({
      install_id: 'ins-1',
      status: 'pending',
    }));
    app.post('/v1/commerce/install/bind_reference_runner', async () => ({
      device_did: 'did:key:zRunner',
    }));
    app.post('/v1/commerce/install/confirm', async () => ({ ok: true }));
    app.post('/v1/pair/complete', async () => ({ device_id: 'dev-browser' }));
    app.get('/owner', async (req) => ({
      page: 'owner',
      saw_capability: req.headers['x-dina-owner-capability'] ?? null,
      client: req.headers['x-dina-client'] ?? null,
      gate_key: req.headers['x-dina-gate-key'] ?? null,
    }));
    const ready = (async () => {
      // Core's first boot: the seed, wrapped under the passphrase it was given.
      const wrapped = path.join(vaultDir, WRAPPED_SEED_NAME);
      if (!fs.existsSync(wrapped)) {
        fake.mnemonic = generateMnemonic();
        const w = await wrapSeed(passphrase, mnemonicToEntropy(fake.mnemonic));
        fs.writeFileSync(wrapped, serializeWrappedSeed(w), { mode: 0o600 });
        fs.writeFileSync(path.join(vaultDir, 'owner_capability'), CAP, { mode: 0o600 });
      }
      fs.rmSync(socket, { force: true });
      await app.listen({ path: socket });
    })();
    const handle: CoreHandle = {
      bootstrap: ready.then(() => ({ code: 'DOTCODE', expiresAt: 123 })),
      exited,
      async stop() {
        await app.close();
        exit(0);
      },
    };
    handles.push(handle);
    return handle;
  };
}

function start(): Gate {
  gate = createGate({
    vaultDir,
    coreSocket: socket,
    spawnCore: fakeCore(),
    emit: (e) => events.push(e),
    frontDoorOrigin: 'https://chatgpt.dinakernel.test',
  });
  return gate;
}

const ticketOf = (): string => {
  const t = events.find((e) => e.event === 'ticket');
  return t !== undefined && t.event === 'ticket' ? t.ticket : '';
};

async function post(url: string, body: unknown, from = '') {
  const res = await gate.app.inject({
    method: 'POST',
    url,
    payload: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      ...(from === '' ? {} : { 'x-forwarded-for': from }),
    },
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-gate-'));
  vaultDir = path.join(dir, 'vault');
  fs.mkdirSync(vaultDir);
  socket = path.join(dir, 'core.sock');
  events = [];
  fake = { calls: [], mnemonic: '' };
  servers = [];
  spawned = [];
  handles = [];
});

afterEach(async () => {
  await gate?.close();
  for (const s of servers) await s.close().catch(() => undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sign-up', () => {
  it('needs the ticket, then shows the 24 words once, sets up the buyer and hands over both codes', async () => {
    start();
    expect(gate.state()).toBe('new');
    expect(ticketOf()).not.toBe('');

    expect((await post('/cell/setup', { ticket: 'nope', passphrase: PASS })).body).toEqual({
      error: 'bad_ticket',
    });
    expect(spawned).toEqual([]);

    const res = await post('/cell/setup', {
      ticket: ticketOf(),
      passphrase: PASS,
      currency: 'inr',
      postal_area: '682001',
    });
    expect(res.status).toBe(200);
    expect((res.body.words as string[]).join(' ')).toBe(fake.mnemonic);
    expect(res.body.owner_device_code).toBe('OWNERCODE');
    expect(gate.state()).toBe('unlocked');
    expect(spawned).toEqual([PASS]);

    const settings = fake.calls.find((c) => c.url === '/v1/commerce/settings/buyer');
    expect(settings?.body).toEqual(
      expect.objectContaining({
        actingIdentityDid: 'did:plc:cafecell',
        currency: 'INR',
        locations: [{ scheme: 'postal_area', value: '682001' }],
      }),
    );
    expect(fake.calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        '/v1/commerce/install/begin',
        '/v1/commerce/install/bind_reference_runner',
        '/v1/commerce/install/confirm',
      ]),
    );
    // Every owner call the gate made carried the cell's capability.
    for (const c of fake.calls.filter((c) => c.url.startsWith('/v1/'))) expect(c.cap).toBe(CAP);
    expect(events).toContainEqual({ event: 'bootstrap', code: 'DOTCODE', expires_at: 123 });
    // The cell is marked as someone's before the words leave the gate.
    expect(fs.existsSync(path.join(vaultDir, 'setup_complete'))).toBe(true);

    // The ticket is spent.
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(409);
  }, 30_000);

  it('refuses a short passphrase and an expired ticket', async () => {
    let t = 1_000;
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      now: () => t,
      ticketTtlMs: 500,
    });
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: 'short' })).body).toEqual({
      error: 'passphrase_too_short',
    });
    t = 2_000;
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).body).toEqual({
      error: 'bad_ticket',
    });
    expect(spawned).toEqual([]);
  });
});

describe('running, locking and unlocking', () => {
  async function signedUp(): Promise<void> {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
  }

  it('forwards to Core once unlocked, and never passes on a capability a browser sends', async () => {
    await signedUp();
    const res = await gate.app.inject({
      method: 'GET',
      url: '/owner',
      headers: { 'x-dina-owner-capability': 'stolen', 'x-dina-client': 'forged' },
    });
    // No capability passes, and the client name is the gate's, not the browser's.
    expect(res.json()).toEqual({
      page: 'owner',
      saw_capability: null,
      client: '127.0.0.1',
      gate_key: lastGateKey,
    });
    expect(lastGateKey).toHaveLength(48);
  }, 30_000);

  it('locks when Core stops, and opens again only with the passphrase', async () => {
    await signedUp();
    // Core stops on its own (a crash, an upgrade): the cell locks at once.
    await handles[0]?.stop();
    await new Promise((r) => setImmediate(r));
    expect(gate.state()).toBe('locked');
    expect(events).toContainEqual({ event: 'state', state: 'locked' });
    expect(spawned).toEqual([PASS]);
    const html = await gate.app.inject({
      method: 'GET',
      url: '/owner',
      headers: { accept: 'text/html' },
    });
    expect(html.statusCode).toBe(303);
    expect((await gate.app.inject({ method: 'GET', url: '/v1/anything' })).statusCode).toBe(503);

    expect((await post('/cell/unlock', { passphrase: 'wrong passphrase!' })).body).toEqual({
      error: 'wrong_passphrase',
    });
    const res = await post('/cell/unlock', { passphrase: PASS, connect_browser: true });
    expect(res.body).toEqual({ ok: true, owner_device_code: 'OWNERCODE' });
    expect(gate.state()).toBe('unlocked');
  }, 60_000);

  it('starts locked after a restart, and stops guessing after five wrong passphrases', async () => {
    await signedUp();
    await gate.close();
    // A new gate process over the same folder: locked, and no sign-up ticket.
    events = [];
    start();
    expect(gate.state()).toBe('locked');
    expect(events.some((e) => e.event === 'ticket')).toBe(false);
    for (let i = 0; i < 5; i++) {
      expect((await post('/cell/unlock', { passphrase: `wrong ${i} passphrase` })).status).toBe(
        401,
      );
    }
    expect((await post('/cell/unlock', { passphrase: PASS })).body).toEqual({
      error: 'too_many_attempts',
    });
  }, 120_000);

  it('serves a page with strict headers and no framing', async () => {
    start();
    const res = await gate.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('"new"');
    expect(res.body).toContain('"https://chatgpt.dinakernel.test"');
  });
});

describe('a sign-up that never finished (cold audit)', () => {
  it('comes back failed after a restart, reports it, and cannot be unlocked', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    await gate.close();
    // As if the gate died after Core wrote the seed but before the mark.
    fs.rmSync(path.join(vaultDir, 'setup_complete'));
    events = [];
    start();
    expect(gate.state()).toBe('failed');
    expect(events).toEqual([{ event: 'state', state: 'failed' }]);
    const r = await post('/cell/unlock', { passphrase: PASS });
    expect(r.status).toBe(409);
  });

  it('reports a set-up cell as locked when it restarts', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    await gate.close();
    events = [];
    start();
    expect(events).toEqual([{ event: 'state', state: 'locked' }]);
  });
});

describe('guarding the owner origin (code review round 1)', () => {
  async function signedUp(trustForwardedFor = false): Promise<void> {
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      trustForwardedFor,
    });
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
  }

  it('limits passphrase guesses on connect-browser too, and mints no code for a wrong one', async () => {
    await signedUp();
    const minted = () => fake.calls.filter((c) => c.url === '/v1/owner/setup/owner-device').length;
    const before = minted();
    for (let i = 0; i < 5; i++) {
      expect(
        (await post('/cell/connect-browser', { passphrase: `wrong ${i} passphrase` })).status,
      ).toBe(401);
    }
    expect((await post('/cell/connect-browser', { passphrase: PASS })).body).toEqual({
      error: 'too_many_attempts',
    });
    expect(minted()).toBe(before);
  }, 120_000);

  it('counts wrong passphrases per client, so a stranger cannot lock the owner out', async () => {
    await signedUp(true);
    for (let i = 0; i < 5; i++) {
      await post('/cell/connect-browser', { passphrase: `wrong ${i} passphrase` }, '203.0.113.9');
    }
    expect((await post('/cell/connect-browser', { passphrase: PASS }, '203.0.113.9')).status).toBe(
      429,
    );
    expect(
      (await post('/cell/connect-browser', { passphrase: PASS }, '198.51.100.7')).body,
    ).toEqual({
      owner_device_code: 'OWNERCODE',
    });
  }, 120_000);

  it('passes only signed requests and the browser-pairing calls to Core', async () => {
    await signedUp();
    const blocked = await gate.app.inject({
      method: 'POST',
      url: '/v1/commerce/trade/suppliers',
      payload: '{}',
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json()).toEqual({ error: 'sign_in_first' });
    expect((await gate.app.inject({ method: 'GET', url: '/owner' })).statusCode).toBe(200);
    const signed = await gate.app.inject({
      method: 'GET',
      url: '/owner?x=1',
      headers: { 'x-did': 'did:key:zBrowser', 'x-signature': 'ab' },
    });
    expect(signed.statusCode).toBe(200);
  }, 30_000);

  it('refuses to start a second Core while an old one still answers on the socket', async () => {
    await signedUp();
    await gate.close();
    // An old Core outlived its gate and still holds the socket.
    const squatter = Fastify();
    servers.push(squatter);
    squatter.get('/readyz', async () => ({ ok: true }));
    await squatter.listen({ path: socket });
    start();
    expect((await post('/cell/unlock', { passphrase: PASS })).body).toEqual({
      error: 'core_still_running',
    });
    expect(gate.state()).toBe('locked');
  }, 60_000);

  it('gives up on a Core that accepts calls and never answers, and frees the gate', async () => {
    let hang: http.Server | null = null;
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      emit: (e) => events.push(e),
      coreCallTimeoutMs: 200,
      coreReadyTimeoutMs: 1_000,
      spawnCore: () => {
        // A Core that takes every connection and never replies.
        hang = http.createServer(() => undefined);
        hang.listen(socket);
        return {
          bootstrap: Promise.resolve(null),
          exited: new Promise<number | null>(() => undefined),
          stop: async () => {
            hang?.closeAllConnections();
            hang?.close();
          },
        };
      },
    });
    const t0 = Date.now();
    const res = await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.body).toEqual({ error: 'core_not_ready' });
    // The gate is free again (not stuck answering `busy`).
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).body).toEqual({
      error: 'already_set_up',
    });
  }, 30_000);
});

describe('guessing from many addresses (code review round 3)', () => {
  it('counts an IPv6 address by its /64 and an IPv4-mapped address as IPv4', () => {
    expect(clientKey('2001:db8:aa:bb:1:2:3:4')).toBe('2001:db8:aa:bb::/64');
    expect(clientKey('2001:db8:aa:bb::9')).toBe('2001:db8:aa:bb::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
  });

  it('slows checks once wrong passphrases pile up from anywhere, yet the owner still gets in', async () => {
    await (async () => {
      start();
      expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(
        200,
      );
      await gate.close();
    })();
    events = [];
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      trustForwardedFor: true,
      verifyPassphrase: async (p) => p === PASS,
    });
    // 24 wrong guesses, each from its own address.
    for (let i = 0; i < 24; i++) {
      await post('/cell/unlock', { passphrase: 'wrong wrong wrong' }, `198.51.100.${i}`);
    }
    // Over the quiet level now: the next check waits before it runs.
    const t0 = Date.now();
    expect(
      (await post('/cell/unlock', { passphrase: 'still wrong!!' }, '203.0.113.200')).status,
    ).toBe(401);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // The owner, from a fresh address, still unlocks.
    expect((await post('/cell/unlock', { passphrase: PASS }, '192.0.2.10')).body).toEqual({
      ok: true,
    });
  }, 60_000);

  it('serves a client with no failures ahead of guessers, and never answers the owner busy', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    await gate.close();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      trustForwardedFor: true,
      verifyPassphrase: async (p) => {
        order.push(p);
        if (p === 'first slow guess') await firstHeld;
        return p === PASS;
      },
    });
    // Two guessers who have each failed before.
    await post('/cell/unlock', { passphrase: 'earlier wrong one' }, '198.51.100.1');
    await post('/cell/unlock', { passphrase: 'earlier wrong two' }, '198.51.100.2');
    // One runs a slow check; the other queues behind it; then the owner arrives.
    const slow = post('/cell/unlock', { passphrase: 'first slow guess' }, '198.51.100.1');
    await new Promise((r) => setTimeout(r, 30));
    const repeatGuess = post('/cell/unlock', { passphrase: 'queued repeat guess' }, '198.51.100.2');
    await new Promise((r) => setTimeout(r, 30));
    const owner = post('/cell/unlock', { passphrase: PASS }, '192.0.2.10');
    await new Promise((r) => setTimeout(r, 30));
    releaseFirst();
    expect((await owner).body).toEqual({ ok: true });
    await slow;
    await repeatGuess;
    // The owner's check ran before the repeat guesser's, though it came later.
    expect(order.indexOf(PASS)).toBeLessThan(order.indexOf('queued repeat guess'));
  }, 60_000);

  it('gives a burst from one client no more checks than its five tries, and keeps the owner first', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    await gate.close();
    const checked: string[] = [];
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      trustForwardedFor: true,
      verifyPassphrase: async (p) => {
        checked.push(p);
        await new Promise((r) => setTimeout(r, 20));
        return p === PASS;
      },
    });
    const burst = Array.from({ length: 70 }, (_, i) =>
      post('/cell/unlock', { passphrase: `burst guess ${i}` }, '198.51.100.7'),
    );
    await new Promise((r) => setTimeout(r, 10));
    const owner = post('/cell/unlock', { passphrase: PASS }, '192.0.2.10');
    const out = await Promise.all(burst);
    expect(out.filter((r) => r.status === 401)).toHaveLength(5);
    expect(out.filter((r) => r.status === 429)).toHaveLength(65);
    expect((await owner).body).toEqual({ ok: true });
    // The owner waited behind at most the one check already running.
    expect(checked.indexOf(PASS)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('charges nobody for a turn the machine could not give, even an owner after a typo', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    await gate.close();
    let busy = false;
    const asked: boolean[] = [];
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      trustForwardedFor: true,
      verifyPassphrase: async (p) => p === PASS,
      kdfSlot: async (fresh) => {
        asked.push(fresh);
        if (busy) throw new Error('no slot in time');
        return () => undefined;
      },
    });
    // The owner mistypes once, so now asks as a repeat client.
    expect((await post('/cell/unlock', { passphrase: 'a typo here' }, '192.0.2.10')).status).toBe(
      401,
    );
    busy = true;
    for (let i = 0; i < 8; i++) {
      expect((await post('/cell/unlock', { passphrase: PASS }, '192.0.2.10')).status).toBe(503);
    }
    // Busy answers spent none of the five tries.
    busy = false;
    expect((await post('/cell/unlock', { passphrase: PASS }, '192.0.2.10')).body).toEqual({
      ok: true,
    });
    expect(asked[0]).toBe(true); // before the typo: fresh
    expect(asked.slice(1).every((f) => !f)).toBe(true); // after it: repeat
  }, 60_000);

  it('answers busy and spends no try when a check cannot run', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    await gate.close();
    let faulty = true;
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      trustForwardedFor: true,
      verifyPassphrase: async (p) => (faulty ? null : p === PASS),
    });
    // The owner's right passphrase, over and over, while checks fault.
    for (let i = 0; i < 7; i++) {
      const r = await post('/cell/unlock', { passphrase: PASS }, '192.0.2.10');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: 'busy' });
    }
    faulty = false;
    expect((await post('/cell/unlock', { passphrase: PASS }, '192.0.2.10')).body).toEqual({
      ok: true,
    });
  }, 60_000);

  it('takes a turn among all cells for every check, and counts no miss when none comes', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    await gate.close();
    let slotFree = false;
    let held = 0;
    let given = 0;
    gate = createGate({
      vaultDir,
      coreSocket: socket,
      spawnCore: fakeCore(),
      emit: (e) => events.push(e),
      trustForwardedFor: true,
      verifyPassphrase: async (p) => {
        expect(held).toBe(1); // every check runs inside a turn
        return p === PASS;
      },
      kdfSlot: async () => {
        if (!slotFree) throw new Error('no slot in time');
        held += 1;
        return () => {
          held -= 1;
          given += 1;
        };
      },
    });
    // No turn: busy, and not counted as a wrong passphrase.
    for (let i = 0; i < 6; i++) {
      const r = await post('/cell/unlock', { passphrase: 'a wrong passphrase' }, '192.0.2.10');
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ error: 'busy' });
    }
    slotFree = true;
    expect(
      (await post('/cell/unlock', { passphrase: 'a wrong passphrase' }, '192.0.2.10')).status,
    ).toBe(401);
    expect((await post('/cell/unlock', { passphrase: PASS }, '192.0.2.10')).body).toEqual({
      ok: true,
    });
    // Each turn went back, right or wrong.
    expect(held).toBe(0);
    expect(given).toBe(2);
  }, 60_000);
});

describe('posts from other sites (security audit)', () => {
  it('refuses a cross-site or non-JSON post before checking any passphrase', async () => {
    start();
    expect((await post('/cell/setup', { ticket: ticketOf(), passphrase: PASS })).status).toBe(200);
    const tries = async (headers: Record<string, string>) =>
      gate.app.inject({
        method: 'POST',
        url: '/cell/connect-browser',
        payload: JSON.stringify({ passphrase: 'a wrong passphrase' }),
        headers,
      });
    const plain = await tries({ 'content-type': 'text/plain' });
    expect(plain.statusCode).toBe(403);
    expect(plain.json()).toEqual({ error: 'cross_site' });
    const foreign = await tries({
      'content-type': 'application/json',
      origin: 'https://evil.example',
      host: 'abc.dina-owner.test',
    });
    expect(foreign.statusCode).toBe(403);
    const crossFetch = await tries({
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    });
    expect(crossFetch.statusCode).toBe(403);
    // None of those counted: the owner still has all five tries.
    for (let i = 0; i < 4; i++) {
      expect(
        (await post('/cell/connect-browser', { passphrase: `wrong ${i} passphrase` })).status,
      ).toBe(401);
    }
    expect((await post('/cell/connect-browser', { passphrase: PASS })).body).toEqual({
      owner_device_code: 'OWNERCODE',
    });
  }, 60_000);
});
