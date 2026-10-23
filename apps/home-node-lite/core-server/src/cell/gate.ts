/**
 * The gate of a hosted cell (HOSTED_DINA §4, §5).
 *
 * A hosted cell is one person's Dina on our machine: this gate plus one Core,
 * both running as the cell's own OS user. The gate serves the cell's owner
 * origin (behind the cell's own TLS) and does the three things Core cannot do
 * for itself while it is locked:
 *
 *   - sign-up: take the first passphrase (with the single-use ticket the
 *     front door handed the browser), start Core, show the 24 words once, set
 *     the café up as a buyer, and hand the browser a single-use code to pair
 *     its own owner key;
 *   - unlock: after a restart, check the owner's passphrase and start Core;
 *   - connect another browser, with the passphrase.
 *
 * Once Core runs, every other request is forwarded to Core's socket. The
 * passphrase reaches Core over an inherited pipe, never its environment, and
 * the gate keeps it only for the request it arrived in: when Core stops, the
 * cell is locked again until its owner unlocks it. The owner capability stays
 * in the cell's folder; the gate reads it to make owner calls on the owner's
 * behalf and strips any capability a browser sends, so outside the cell the
 * only owner credential is a browser key the owner paired.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { readWrappedSeed } from '@dina/core';

import { recoveryPhraseFromWrapped, WRAPPED_SEED_NAME } from '../identity/master_seed';
import { socketAnswers } from '../server/cell_lifecycle';

import { GATE_PAGE_HEADERS, renderGatePage } from './gate_pages';
import { createWorkerChecker, type KdfSlot, type PassphraseChecker } from './kdf_worker';

export type GateState = 'new' | 'starting' | 'unlocked' | 'locked' | 'failed';

/** What the gate tells the provisioner, one JSON line each. */
export type GateEvent =
  | { event: 'ticket'; ticket: string; expires_at: number }
  | { event: 'bootstrap'; code: string; expires_at: number }
  | { event: 'state'; state: GateState };

/** A running Core, as the gate sees it. */
export interface CoreHandle {
  /** The single-use dot pairing code Core hands over on its first boot, or null. */
  bootstrap: Promise<{ code: string; expiresAt: number } | null>;
  /** Resolves with the exit code when Core stops. */
  exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface GateOptions {
  /** Core's vault folder (holds `wrapped_seed.bin` and `owner_capability`). */
  vaultDir: string;
  /** The Unix socket Core listens on. */
  coreSocket: string;
  /**
   * Start Core with this passphrase on its unlock pipe and this gate key in
   * its environment (`DINA_GATE_KEY`): Core trusts `x-dina-client` only beside
   * it, so the front door, which shares Core's socket, cannot name a client.
   */
  spawnCore(passphrase: string, gateKey: string): CoreHandle;
  /** Report to the provisioner. */
  emit(event: GateEvent): void;
  now?: () => number;
  ticketTtlMs?: number;
  /** How long Core may take to answer /readyz (first boot creates its identity). */
  coreReadyTimeoutMs?: number;
  minPassphraseLength?: number;
  /** Shorter Argon2 for tests; production uses Core's defaults. */
  /** Null when the check could not run (counted as no try). */
  verifyPassphrase?(passphrase: string): Promise<boolean | null>;
  /** The front door's origin: the only place a finished sign-up may return to. */
  frontDoorOrigin?: string;
  /**
   * Take the client's address from `x-forwarded-for`. Only for a gate on a
   * socket that only the cell's own TLS front (its Caddy) can open, which
   * sets the header; anything else could forge it.
   */
  trustForwardedFor?: boolean;
  /** Longest wait for one call to Core (default 15 s). */
  coreCallTimeoutMs?: number;
  /**
   * A turn among all the machine's cells before each passphrase check (the
   * provisioner's limit on Argon2 memory), asked as fresh or repeat so the
   * machine serves clients with no recent failure first. Without it, checks
   * are limited per gate only.
   */
  kdfSlot?: KdfSlot;
}

const TICKET_TTL_MS = 10 * 60 * 1000;
const MIN_PASSPHRASE = 12;
const MAX_PASSPHRASE = 512;
/** Wrong passphrases per window before the gate waits it out. */
const UNLOCK_ATTEMPTS = 5;
const UNLOCK_WINDOW_MS = 10 * 60 * 1000;
/** Clients whose failures are remembered; the oldest go first past this. */
const MAX_TRACKED_CLIENTS = 10_000;
/** Checks that may wait, per queue: clients with no recent failure, and the rest. */
const MAX_WAITING_FRESH = 64;
const MAX_WAITING_REPEAT = 16;
/** Wrong passphrases from anywhere in a window before checks slow down. */
const GLOBAL_QUIET_FAILURES = 20;
const GLOBAL_DELAY_STEP_MS = 250;
const MAX_GLOBAL_DELAY_MS = 5_000;
const OWNER_DEVICE_NAME = 'Browser';
/** Written before the recovery words are shown; the provisioner reads it (`hosting.py`). */
export const SETUP_COMPLETE = 'setup_complete';
/** Unsigned requests the gate passes to Core: the console page and browser pairing. */
const UNSIGNED_FORWARDS: readonly { method: string; path: string }[] = [
  { method: 'GET', path: '/owner' },
  { method: 'POST', path: '/v1/pair/complete' },
];
const DEFAULT_CURRENCY = 'INR';

export interface Gate {
  app: FastifyInstance;
  state(): GateState;
  /** Stop Core (the cell locks) and the gate's own server. */
  close(): Promise<void>;
}

class GateError extends Error {
  constructor(
    readonly status: number,
    readonly key: string,
  ) {
    super(key);
  }
}

export function createGate(opts: GateOptions): Gate {
  const now = opts.now ?? Date.now;
  const minLength = opts.minPassphraseLength ?? MIN_PASSPHRASE;
  const wrappedPath = path.join(opts.vaultDir, WRAPPED_SEED_NAME);
  // Someone's Dina: set up, its words shown. A seed without the mark is a
  // sign-up that never finished (nobody holds its words): it stays failed,
  // never unlockable, and the provisioner removes it.
  const isSetUp = (): boolean =>
    fs.existsSync(wrappedPath) && fs.existsSync(path.join(opts.vaultDir, SETUP_COMPLETE));
  let state: GateState = isSetUp() ? 'locked' : fs.existsSync(wrappedPath) ? 'failed' : 'new';
  let core: CoreHandle | null = null;
  let ticket: { value: Buffer; expiresAt: number } | null = null;
  let busy = false;
  const gateKey = randomBytes(24).toString('hex');
  // Wrong passphrases, for unlock and connect-browser alike. Per client, so
  // one stranger's guesses cannot lock the owner out; and across all clients,
  // so guessing from many addresses slows down for everyone who keeps
  // guessing. A check runs before the gate's busy flag is taken, so guesses
  // never hold the gate.
  const failures = new Map<string, number[]>();
  const allFailures: number[] = [];
  // One check runs at a time (on the worker, off the event loop). Clients
  // with no recent failure are served first, so the owner is not stuck
  // behind someone who keeps guessing; each queue is capped.
  const fresh: (() => void)[] = [];
  const repeat: (() => void)[] = [];
  let running = false;
  const pump = (): void => {
    if (running) return;
    const next = fresh.shift() ?? repeat.shift();
    if (next === undefined) return;
    running = true;
    next();
  };
  const inTurn = async <T>(isFresh: boolean, run: () => Promise<T>): Promise<T> => {
    const queue = isFresh ? fresh : repeat;
    if (queue.length >= (isFresh ? MAX_WAITING_FRESH : MAX_WAITING_REPEAT)) {
      throw new GateError(429, 'too_many_attempts');
    }
    await new Promise<void>((resolve) => {
      queue.push(resolve);
      pump();
    });
    try {
      return await run();
    } finally {
      running = false;
      pump();
    }
  };

  const recentFailures = (client: string, t: number): number[] => {
    const list = (failures.get(client) ?? []).filter((at) => at >= t - UNLOCK_WINDOW_MS);
    if (list.length === 0) failures.delete(client);
    else failures.set(client, list);
    return list;
  };
  const noteFailure = (client: string, t: number): void => {
    const list = [...recentFailures(client, t), t];
    // Re-insert so the Map's order stays oldest-first by latest failure.
    failures.delete(client);
    failures.set(client, list);
    // Oldest first in a Map: drop from the front past the cap.
    while (failures.size > MAX_TRACKED_CLIENTS) {
      const oldest = failures.keys().next().value;
      if (oldest === undefined) break;
      failures.delete(oldest);
    }
    allFailures.push(t);
  };
  // Checks a client has waiting or running: they count against its tries, so
  // a burst of requests at once gets no more checks than one after another.
  const inFlight = new Map<string, number>();
  /** Check a passphrase against the wrapped seed, counting a miss against this client. */
  const checkPassphrase = async (client: string, raw: unknown): Promise<string> => {
    const t = now();
    const past = recentFailures(client, t).length;
    const pending = inFlight.get(client) ?? 0;
    if (past + pending >= UNLOCK_ATTEMPTS) throw new GateError(429, 'too_many_attempts');
    const passphrase = typeof raw === 'string' ? raw : '';
    if (passphrase === '' || passphrase.length > MAX_PASSPHRASE) {
      noteFailure(client, t);
      throw new GateError(401, 'wrong_passphrase');
    }
    while ((allFailures[0] ?? Infinity) < t - UNLOCK_WINDOW_MS) allFailures.shift();
    inFlight.set(client, pending + 1);
    let opened: boolean | null;
    try {
      // Past a quiet level, each check waits longer the more wrong
      // passphrases there have been lately, from anywhere. The wait comes
      // before the queue, so it never holds the one check that runs.
      const over = allFailures.length - GLOBAL_QUIET_FAILURES;
      if (over > 0) await sleep(Math.min(MAX_GLOBAL_DELAY_MS, over * GLOBAL_DELAY_STEP_MS));
      const isFresh = past === 0 && pending === 0;
      opened = await inTurn(isFresh, async () => {
        let release: (() => void) | null = null;
        if (opts.kdfSlot !== undefined) {
          try {
            release = await opts.kdfSlot(isFresh);
          } catch {
            // No turn came. That says nothing about the passphrase and used
            // no check, so it costs nobody a try: an owner with one typo
            // must not be locked out by a busy machine. Guessers gain
            // nothing by asking again, since fresh asks go first.
            throw new GateError(503, 'busy');
          }
        }
        try {
          return await verify(passphrase);
        } finally {
          release?.();
        }
      });
    } finally {
      const left = (inFlight.get(client) ?? 1) - 1;
      if (left > 0) inFlight.set(client, left);
      else inFlight.delete(client);
    }
    // A check that could not run says nothing about the passphrase.
    if (opened === null) throw new GateError(503, 'busy');
    if (!opened) {
      noteFailure(client, now());
      throw new GateError(401, 'wrong_passphrase');
    }
    failures.delete(client);
    return passphrase;
  };

  const setState = (next: GateState): void => {
    state = next;
    opts.emit({ event: 'state', state: next });
  };

  if (state === 'new') {
    const value = randomBytes(24);
    ticket = { value, expiresAt: now() + (opts.ticketTtlMs ?? TICKET_TTL_MS) };
    opts.emit({
      event: 'ticket',
      ticket: value.toString('base64url'),
      expires_at: ticket.expiresAt,
    });
  } else {
    // Tell the provisioner where a restarted cell stands (locked, or a
    // sign-up that never finished).
    opts.emit({ event: 'state', state });
  }

  const checker = opts.verifyPassphrase === undefined ? createWorkerChecker() : null;
  // True or false for the passphrase; null when the check could not run.
  const verify = async (passphrase: string): Promise<boolean | null> => {
    if (opts.verifyPassphrase !== undefined) return opts.verifyPassphrase(passphrase);
    try {
      const result = await (checker as PassphraseChecker).check(
        passphrase,
        readWrappedSeed(wrappedPath),
      );
      return result === 'fault' ? null : result === 'opened';
    } catch {
      return null;
    }
  };

  // ── Core ──────────────────────────────────────────────────────────────

  async function startCore(passphrase: string): Promise<CoreHandle> {
    // A Core still answering (an old one outlived its gate) must go first;
    // Core itself refuses to start on a live socket.
    if (await socketAnswers(opts.coreSocket)) throw new GateError(409, 'core_still_running');
    const handle = opts.spawnCore(passphrase, gateKey);
    core = handle;
    void handle.exited.then(() => {
      if (core === handle) {
        core = null;
        // A Core that stops takes its keys with it: the cell is locked until
        // the owner unlocks it, whatever state it was in.
        setState(isSetUp() ? 'locked' : 'failed');
      }
    });
    const deadline = now() + (opts.coreReadyTimeoutMs ?? 120_000);
    for (;;) {
      if (core !== handle) throw new GateError(503, 'core_stopped');
      const ready = await coreCall('GET', '/readyz', undefined, false, 2_000).catch(() => null);
      if (ready !== null && ready.status === 200) return handle;
      if (now() > deadline) {
        await handle.stop();
        throw new GateError(503, 'core_not_ready');
      }
      await sleep(250);
    }
  }

  function coreCall(
    method: string,
    p: string,
    body?: unknown,
    owner = false,
    timeoutMs = opts.coreCallTimeoutMs ?? 15_000,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    // The gate's own calls: its key, and no client, so Core counts them on a
    // bucket of the gate's own.
    const headers: Record<string, string> = { 'x-dina-gate-key': gateKey };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (owner) headers['x-dina-owner-capability'] = ownerCapability();
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: opts.coreSocket, path: p, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let parsed: unknown = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          } catch {
            parsed = {};
          }
          resolve({
            status: res.statusCode ?? 0,
            body:
              parsed !== null && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : {},
          });
        });
        res.on('aborted', () => reject(new GateError(502, 'core_call_aborted')));
        res.on('error', reject);
      });
      // A Core that accepts and never answers must not hold the gate forever.
      req.setTimeout(timeoutMs, () => req.destroy(new GateError(504, 'core_call_timeout')));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  function ownerCapability(): string {
    return fs.readFileSync(path.join(opts.vaultDir, 'owner_capability'), 'utf8').trim();
  }

  async function ownerOk(
    method: string,
    p: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const res = await coreCall(method, p, body, true);
    if (res.status < 200 || res.status >= 300) {
      const key = typeof res.body.error === 'string' ? res.body.error : `core_${res.status}`;
      throw new GateError(res.status === 401 ? 401 : 502, key);
    }
    return res.body;
  }

  /** Prove the owner is present, then mint the code a browser pairs its key with. */
  async function ownerDeviceCode(passphrase: string): Promise<string> {
    const proved = await coreCall(
      'POST',
      '/v1/commerce/catalog/drafts/presence',
      { passphrase },
      true,
    );
    if (proved.status === 401) throw new GateError(401, 'wrong_passphrase');
    if (proved.status !== 200) throw new GateError(502, 'presence_failed');
    const minted = await ownerOk('POST', '/v1/owner/setup/owner-device', {
      device_name: OWNER_DEVICE_NAME,
    });
    if (typeof minted.code !== 'string' || minted.code === '') {
      throw new GateError(502, 'pairing_code_missing');
    }
    return minted.code;
  }

  /** The café as a buyer: its settings and the buyer pack (presence already proved). */
  async function setUpBuyer(currency: string, postalArea: string): Promise<void> {
    const status = await ownerOk('GET', '/v1/owner/setup/status', undefined);
    const nodeDid = typeof status.home_did === 'string' ? status.home_did : '';
    await ownerOk('PUT', '/v1/commerce/settings/buyer', {
      actingIdentityDid: nodeDid,
      locations: postalArea === '' ? [] : [{ scheme: 'postal_area', value: postalArea }],
      preferredSuppliers: [],
      blockedSuppliers: [],
      allowedCategoryIds: [],
      quoteFanoutCeiling: 5,
      approvalPolicySummary: '',
      currency,
      preferredUnitCodes: [],
      publishReviews: false,
    });
    const begun = await ownerOk('POST', '/v1/commerce/install/begin', { role: 'buyer' });
    if (begun.status === 'active') return;
    const installId = String(begun.install_id ?? '');
    const bound = await ownerOk('POST', '/v1/commerce/install/bind_reference_runner', {
      install_id: installId,
    });
    await ownerOk('POST', '/v1/commerce/install/confirm', {
      install_id: installId,
      device_did: String(bound.device_did ?? ''),
    });
  }

  // ── Steps ─────────────────────────────────────────────────────────────

  async function setup(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (state !== 'new' || ticket === null) throw new GateError(409, 'already_set_up');
    const offered = Buffer.from(typeof body.ticket === 'string' ? body.ticket : '', 'base64url');
    if (
      offered.length !== ticket.value.length ||
      !timingSafeEqual(offered, ticket.value) ||
      now() > ticket.expiresAt
    ) {
      throw new GateError(403, 'bad_ticket');
    }
    const passphrase = passphraseOf(body.passphrase, minLength);
    const currency = currencyOf(body.currency);
    const postalArea = postalAreaOf(body.postal_area);
    // The ticket is spent on the first passphrase set with it, success or not.
    ticket = null;
    setState('starting');
    try {
      const handle = await startCore(passphrase);
      const words = (await recoveryPhraseFromWrapped(opts.vaultDir, passphrase)).split(' ');
      const code = await ownerDeviceCode(passphrase);
      await setUpBuyer(currency, postalArea);
      const boot = await handle.bootstrap;
      if (boot !== null)
        opts.emit({ event: 'bootstrap', code: boot.code, expires_at: boot.expiresAt });
      // Mark the cell as someone's before the words leave: from here on the
      // provisioner never removes it as an unfinished sign-up.
      // Flushed to disk, file and folder: a crash that kept the seed but lost
      // the mark would leave the cell failed, and it would be removed.
      writeDurably(opts.vaultDir, SETUP_COMPLETE, String(now()));
      setState('unlocked');
      return { words, owner_device_code: code };
    } catch (err) {
      const handle = core;
      core = null;
      await handle?.stop();
      setState('failed');
      throw err instanceof GateError ? err : new GateError(500, 'setup_failed');
    }
  }

  async function unlock(
    body: Record<string, unknown>,
    passphrase: string,
  ): Promise<Record<string, unknown>> {
    if (state === 'unlocked') return { ok: true, already: true };
    if (state !== 'locked') throw new GateError(409, `cannot_unlock_${state}`);
    setState('starting');
    try {
      await startCore(passphrase);
    } catch (err) {
      setState('locked');
      throw err;
    }
    setState('unlocked');
    if (body.connect_browser === true) {
      return { ok: true, owner_device_code: await ownerDeviceCode(passphrase) };
    }
    return { ok: true };
  }

  async function connectBrowser(
    _body: Record<string, unknown>,
    passphrase: string,
  ): Promise<Record<string, unknown>> {
    if (state !== 'unlocked') throw new GateError(409, 'locked');
    return { owner_device_code: await ownerDeviceCode(passphrase) };
  }

  /** Who is asking: the address the cell's Caddy forwards, else the socket peer. */
  function clientOf(req: FastifyRequest): string {
    if (opts.trustForwardedFor === true) {
      const header = req.headers['x-forwarded-for'];
      // The entry the cell's Caddy appended is the last; any before it came
      // from the client and could be anything.
      const parts = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',');
      const last = parts[parts.length - 1]?.trim();
      if (last !== undefined && last !== '') return clientKey(last);
    }
    return clientKey(req.ip ?? 'unknown');
  }

  // ── Server ────────────────────────────────────────────────────────────

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  // Bodies pass through to Core untouched; the gate's own routes parse JSON.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const gateStep =
    (
      step: (body: Record<string, unknown>, passphrase: string) => Promise<Record<string, unknown>>,
      needsPassphrase = false,
    ) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      reply.headers(GATE_PAGE_HEADERS);
      // Only the cell's own page may post here: JSON (a cross-site form or
      // no-cors fetch cannot send it without a preflight, which the gate never
      // grants), and no foreign Origin or fetch site. Refused before any
      // passphrase is checked, so another site cannot spend the owner's tries.
      if (!sameOriginJson(req)) {
        await reply.code(403).send({ error: 'cross_site' });
        return;
      }
      const body = jsonBody(req.body);
      // The passphrase is checked first, outside the busy flag, so guessers
      // (refused or wrong) never hold the gate against the owner.
      let passphrase = '';
      if (needsPassphrase) {
        try {
          passphrase = await checkPassphrase(clientOf(req), body.passphrase);
        } catch (err) {
          const e = err instanceof GateError ? err : new GateError(500, 'gate_error');
          await reply.code(e.status).send({ error: e.key });
          return;
        }
      }
      if (busy) {
        await reply.code(409).send({ error: 'busy' });
        return;
      }
      busy = true;
      try {
        const answer = await step(body, passphrase);
        await reply.code(200).send(answer);
      } catch (err) {
        const e = err instanceof GateError ? err : new GateError(500, 'gate_error');
        await reply.code(e.status).send({ error: e.key });
      } finally {
        busy = false;
      }
    };

  app.post(
    '/cell/setup',
    gateStep((body) => setup(body)),
  );
  app.post('/cell/unlock', gateStep(unlock, true));
  app.post('/cell/connect-browser', gateStep(connectBrowser, true));
  app.get('/cell/state', async (_req, reply) => {
    await reply.headers(GATE_PAGE_HEADERS).send({ state });
  });
  // Every state has a page; an unlocked cell's page sends a browser that
  // holds the owner key on to /owner and offers any other browser to connect.
  app.get('/', async (_req, reply) => {
    await reply
      .headers(GATE_PAGE_HEADERS)
      .type('text/html; charset=utf-8')
      .send(renderGatePage(state, opts.frontDoorOrigin ?? ''));
  });
  app.get('/cell', async (_req, reply) => {
    await reply
      .headers(GATE_PAGE_HEADERS)
      .type('text/html; charset=utf-8')
      .send(renderGatePage(state, opts.frontDoorOrigin ?? ''));
  });

  app.all('/*', async (req, reply) => {
    if (state !== 'unlocked') {
      if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
        await reply.redirect('/', 303);
        return;
      }
      await reply.code(503).headers(GATE_PAGE_HEADERS).send({ error: 'locked' });
      return;
    }
    // Only signed requests (the owner's browser key) and the two unsigned
    // ones a browser needs reach Core; anything else stops here, so a
    // stranger cannot spend Core's budgets through the owner origin.
    const bare = req.url.split('?')[0] ?? '';
    const signed =
      typeof req.headers['x-did'] === 'string' && typeof req.headers['x-signature'] === 'string';
    if (!signed && !UNSIGNED_FORWARDS.some((r) => r.method === req.method && r.path === bare)) {
      await reply.code(401).headers(GATE_PAGE_HEADERS).send({ error: 'sign_in_first' });
      return;
    }
    await forward(req, reply, opts.coreSocket, clientOf(req), gateKey);
  });

  return {
    app,
    state: () => state,
    async close() {
      const handle = core;
      core = null;
      await handle?.stop();
      await checker?.close();
      await app.close();
    },
  };
}

/** Forward one request to Core's socket, minus any owner capability it carries. */
async function forward(
  req: FastifyRequest,
  reply: FastifyReply,
  socketPath: string,
  client: string,
  gateKey: string,
): Promise<void> {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers['x-dina-owner-capability'];
  // Core keys its budget for forwarded calls on this; only the gate sets it,
  // and proves it with its key (any copy a browser sent is overwritten).
  headers['x-dina-client'] = client;
  headers['x-dina-gate-key'] = gateKey;
  delete headers.host;
  delete headers.connection;
  const body = Buffer.isBuffer(req.body) ? req.body : undefined;
  if (body !== undefined) headers['content-length'] = String(body.length);
  await new Promise<void>((resolve) => {
    const upstream = http.request(
      { socketPath, path: req.url, method: req.method, headers },
      (res) => {
        reply.code(res.statusCode ?? 502);
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined && k !== 'connection' && k !== 'transfer-encoding')
            reply.header(k, v);
        }
        void reply.send(res);
        res.on('end', () => resolve());
        res.on('error', () => resolve());
      },
    );
    upstream.on('error', () => {
      void reply.code(502).send({ error: 'core_unreachable' });
      resolve();
    });
    if (body !== undefined) upstream.write(body);
    upstream.end();
  });
}

function jsonBody(raw: unknown): Record<string, unknown> {
  if (!Buffer.isBuffer(raw)) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function passphraseOf(raw: unknown, minLength: number): string {
  const value = typeof raw === 'string' ? raw : '';
  if (value.length < minLength) throw new GateError(400, 'passphrase_too_short');
  if (value.length > MAX_PASSPHRASE) throw new GateError(400, 'passphrase_too_long');
  return value;
}

function currencyOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (value === '') return DEFAULT_CURRENCY;
  if (!/^[A-Z]{3}$/.test(value)) throw new GateError(400, 'bad_currency');
  return value;
}

function postalAreaOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value.length > 32 || !/^[A-Za-z0-9 -]*$/.test(value))
    throw new GateError(400, 'bad_postal_area');
  return value;
}

/** Write a file and flush it and its folder to disk before returning. */
function writeDurably(dir: string, name: string, data: string): void {
  const fd = fs.openSync(path.join(dir, name), 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An address as the limiter counts it: IPv6 by its /64, the block one user holds. */
export function clientKey(address: string): string {
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (!bare.includes(':')) return bare;
  const [head = '', tail = ''] = bare.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = bare.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** A JSON request from the cell's own origin (or a client that names none). */
function sameOriginJson(req: FastifyRequest): boolean {
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (type !== 'application/json') return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
