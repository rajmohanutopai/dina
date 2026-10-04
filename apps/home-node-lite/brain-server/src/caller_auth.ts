/**
 * Brain knows who is calling (docs/A2A_GATEWAY_ARCHITECTURE.md §4.1, plan
 * §3.18).
 *
 * Loopback is not an identity: any process on the host can reach Brain's
 * port, a compromised A2A gateway included. So every request except the
 * health probes carries Dina's canonical request signature (`X-DID`,
 * `X-Timestamp`, `X-Nonce`, `X-Signature` over the method, path, query,
 * time, nonce and the body's hash), checked by the function Core uses, and
 * Brain serves two signers only:
 *
 *   - Core, under its service key: forwarded asks, Tier 1 runs, A2A notices;
 *   - an owner device: the browser the owner paired, for the web app.
 *
 * Brain learns both from Core (`GET /v1/brain/callers`) over its own signed
 * link (see `CallerDirectory` for how often). A copy thirty seconds old is
 * never used, even when Core does not answer, and open event streams are
 * ended when their caller leaves the set, so a revoked owner device stops
 * working, streams included, within thirty seconds (and everyone does,
 * while Core is silent).
 *
 * A signer Brain does not know is refused before its signature or nonce is
 * looked at, so strangers cannot fill the replay cache. An unknown route
 * answers 401 like any other, so a stranger learns no route names.
 *
 * `DINA_BRAIN_CALLER_AUTH=off` turns this off for development (the `/dev`
 * page cannot sign). Config refuses it with release endpoints.
 */

import { NonceCache, checkRequestSignature } from '@dina/core';

import type { FastifyInstance, FastifyRequest } from 'fastify';

export type BrainCallerKind = 'core' | 'owner_device';

export interface BrainCaller {
  kind: BrainCallerKind;
  did: string;
}

export interface CallerSet {
  core: string | null;
  ownerDevices: readonly string[];
}

/** How long a copy of the caller set may be used at all. */
export const CALLER_SET_TTL_MS = 30_000;
/** A copy this old is refreshed in the background, so one failed ask refuses no one. */
export const CALLER_SET_REFRESH_MS = CALLER_SET_TTL_MS / 2;
/** The least time between two asks Core gets because an unknown DID signed. */
export const CALLER_SET_MISS_INTERVAL_MS = 5_000;
/** After a failed ask, wait this long before the next, doubling up to the cap. */
export const CALLER_SET_FAILURE_WAIT_MS = 1_000;
export const CALLER_SET_FAILURE_WAIT_MAX_MS = 15_000;

/** Paths any caller may reach unsigned: the liveness and readiness probes. */
const UNSIGNED_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

export interface CallerDirectoryOptions {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Brain's copy of who may call it.
 *
 * A copy is used for at most `CALLER_SET_TTL_MS` and refreshed in the
 * background from half that age, so one failed ask of Core refuses no one.
 * After a failed ask the next one waits (1 s, doubling to 15 s), whatever
 * prompted it, so a struggling Core is not asked once per request. One ask
 * runs at a time, and a request that finds one running waits for it.
 *
 * Open event streams register a watch: while any is open the directory
 * runs on its own timer, aimed at the next moment that matters (a refresh
 * due, the copy reaching thirty seconds, a back-off ending), and a watched
 * DID that leaves the set, or whose copy reaches thirty seconds, has its
 * stream ended then, not at the next round tick.
 */
export class CallerDirectory {
  private set: CallerSet | null = null;
  private fetchedAt = 0;
  private lastMissFetch = Number.NEGATIVE_INFINITY;
  private nextFetchAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private inFlight: Promise<void> | null = null;
  private readonly watchers = new Set<{ did: string; onLeave: () => void }>();
  private timer: unknown = null;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(
    private readonly fetchCallers: () => Promise<CallerSet | null>,
    options: CallerDirectoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setTimeoutFn =
      options.setTimeout ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      });
    this.clearTimeoutFn =
      options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** What `did` is to Brain, or null when it is neither Core nor an owner device. */
  async classify(did: string): Promise<BrainCallerKind | null> {
    const age = this.set === null ? Number.POSITIVE_INFINITY : this.now() - this.fetchedAt;
    if (age >= CALLER_SET_TTL_MS) await this.refresh();
    else if (age >= CALLER_SET_REFRESH_MS) void this.refresh();
    let kind = this.lookup(did);
    if (kind !== null) return kind;
    // A refresh another request started may be about to answer this one.
    if (this.inFlight !== null) {
      await this.inFlight;
      kind = this.lookup(did);
      if (kind !== null) return kind;
    }
    if (this.now() - this.lastMissFetch >= CALLER_SET_MISS_INTERVAL_MS) {
      this.lastMissFetch = this.now();
      await this.refresh();
      kind = this.lookup(did);
    }
    return kind;
  }

  /**
   * Call `onLeave` once if `did` stops being a caller Brain serves; returns
   * the way to stop watching. While anything is watched, the set is
   * refreshed and checked on the directory's own timer, with no requests
   * arriving.
   */
  watch(did: string, onLeave: () => void): () => void {
    const watcher = { did, onLeave };
    this.watchers.add(watcher);
    this.schedule();
    return () => {
      this.watchers.delete(watcher);
      this.schedule();
    };
  }

  private checkWatchers(): void {
    for (const watcher of [...this.watchers]) {
      if (this.lookup(watcher.did) !== null) continue;
      this.watchers.delete(watcher);
      watcher.onLeave();
    }
    this.schedule();
  }

  /**
   * Aim the one timer at the next moment a watched stream could change:
   * the copy due for refresh, the copy reaching the TTL (its streams end
   * then), or a back-off ending. No watchers, no timer.
   */
  private schedule(): void {
    if (this.timer !== null) this.clearTimeoutFn(this.timer);
    this.timer = null;
    if (this.watchers.size === 0) return;
    const now = this.now();
    const moments = [
      this.fetchedAt + CALLER_SET_REFRESH_MS,
      this.fetchedAt + CALLER_SET_TTL_MS,
      this.nextFetchAt,
    ];
    const next = Math.min(...moments.filter((at) => at > now), now + CALLER_SET_REFRESH_MS);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.refresh().then(() => this.checkWatchers());
    }, next - now);
  }

  private lookup(did: string): BrainCallerKind | null {
    const set = this.set;
    if (set === null || this.now() - this.fetchedAt >= CALLER_SET_TTL_MS) return null;
    if (set.core !== null && did === set.core) return 'core';
    return set.ownerDevices.includes(did) ? 'owner_device' : null;
  }

  private refresh(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (this.now() < this.nextFetchAt) return Promise.resolve();
    this.inFlight = this.fetchCallers()
      .catch(() => null)
      .then((set) => {
        if (set !== null) {
          this.set = set;
          this.fetchedAt = this.now();
          this.failures = 0;
          this.nextFetchAt = Number.NEGATIVE_INFINITY;
          return;
        }
        this.failures += 1;
        this.nextFetchAt =
          this.now() +
          Math.min(
            CALLER_SET_FAILURE_WAIT_MS * 2 ** (this.failures - 1),
            CALLER_SET_FAILURE_WAIT_MAX_MS,
          );
      })
      .finally(() => {
        this.inFlight = null;
        this.checkWatchers();
      });
    return this.inFlight;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified caller; null when caller auth is off. */
    dinaCaller: BrainCaller | null;
    /** The request body exactly as sent, for the signature's body hash. */
    rawBody?: Uint8Array;
  }
  interface FastifyInstance {
    /** Who may call Brain; absent when caller auth is off. */
    dinaCallerDirectory?: CallerDirectory;
  }
}

/** The verified caller of `req`, or null when caller auth is off. */
export function callerOf(req: FastifyRequest): BrainCaller | null {
  return (req.dinaCaller as BrainCaller | null | undefined) ?? null;
}

/**
 * Call `onLeave` once when the verified caller of `req` leaves Brain's
 * caller set; returns the way to stop watching. A no-op with the check off.
 * Event streams use it to end themselves.
 */
export function watchCaller(req: FastifyRequest, onLeave: () => void): () => void {
  const directory = req.server.dinaCallerDirectory;
  const caller = callerOf(req);
  if (directory === undefined || caller === null) return () => undefined;
  return directory.watch(caller.did, onLeave);
}

/**
 * Keep each JSON body's raw bytes (the signature covers them), then parse it
 * with Fastify's own JSON parser, which refuses `__proto__` and
 * `constructor` keys and an empty body, as Brain always has.
 */
export function installRawJsonParser(app: FastifyInstance): void {
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body: Buffer, done) => {
    req.rawBody = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    parseJson(req, body.toString('utf8'), done);
  });
}

/**
 * Refuse every unsigned or unknown caller before any handler (or schema)
 * sees the request. Must be registered before the routes.
 */
export function registerCallerAuth(
  app: FastifyInstance,
  options: { directory: CallerDirectory; nonces?: NonceCache },
): void {
  const nonces = options.nonces ?? new NonceCache();
  app.decorate('dinaCallerDirectory', options.directory);
  app.decorateRequest('dinaCaller', null);
  installRawJsonParser(app);
  app.addHook('preValidation', async (req, reply) => {
    const url = req.raw.url ?? '/';
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    if (req.method === 'GET' && UNSIGNED_PATHS.has(path)) return;
    const header = (name: string): string | undefined => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : undefined;
    };
    const did = header('x-did');
    const timestamp = header('x-timestamp');
    const nonce = header('x-nonce');
    const signature = header('x-signature');
    // Who first: a stranger never reaches the signature check or the nonce cache.
    const kind = did === undefined ? null : await options.directory.classify(did);
    if (kind === null) return reply.code(401).send({ error: 'unauthenticated' });
    const check = checkRequestSignature(
      {
        method: req.method,
        path,
        query: q === -1 ? '' : url.slice(q + 1),
        body: req.rawBody ?? new Uint8Array(),
        ...(did === undefined ? {} : { did }),
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(nonce === undefined ? {} : { nonce }),
        ...(signature === undefined ? {} : { signature }),
      },
      { nonces },
    );
    if (!check.ok) return reply.code(401).send({ error: 'unauthenticated' });
    req.dinaCaller = { kind, did: check.did };
  });
}
