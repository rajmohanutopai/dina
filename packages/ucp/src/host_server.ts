/**
 * The profile host's HTTP contract (plan §3.5, S11), as one implementation the
 * host (AppView) runs and Core's publisher tests run against. Pure: storage,
 * the off-host log, DID-key lookup, SHA-256 and Ed25519 are the caller's.
 *
 *  - Each change's envelope is checked against the publisher's DID document as
 *    resolved now, and the document hash, before any rule runs; then
 *    `applyPublication` decides it inside the store's per-label transaction.
 *  - The change is appended to the off-host log before the row is written; a
 *    refusal or a replay is never logged.
 *  - A restored database is caught up from that log label by label: before a
 *    label's first change, or the first read of a stored label, in a process.
 *    The log is read OUTSIDE the transaction (a slow bucket must not hold a
 *    database connection), then applied inside it. A label whose log cannot be
 *    read, or reads as a damaged history, serves nothing and takes no change
 *    (503) until it can.
 *  - Host transactions are limited (`maxConcurrent`, a short queue beyond it,
 *    then 503), so the host cannot take every connection of a pool it shares.
 *  - The drop-box `webhook_url` (S9) answers 200 for a bound label, reads
 *    nothing, keeps nothing, and is limited per label.
 *  - The Dina app's claimed link (§3.17, U4): every label host serves the same
 *    `apple-app-site-association` and `assetlinks.json`, so the phone's OS
 *    hands `https://<label>.<host>/oauth/callback` to the app without the
 *    request reaching the host. A browser without the app reaches
 *    `/oauth/callback` itself: a static page that says so, reading nothing
 *    (not even the query) and keeping nothing.
 *
 * Nothing here logs.
 */

import { bytesToHex, isPlainObject, parseStrictJson, utf8Bytes } from '@dina/a2a';

import {
  applyPublication,
  catchUpFromLog,
  envelopeDigest,
  publicState,
  type HostLogRecord,
  type LabelState,
} from './host';
import { PROFILE_MAX_AGE_SECONDS, type ControlBody, type UploadBody } from './host_api';
import {
  LABEL_PATTERN,
  labelForHostname,
  validatePublication,
  verifyPublication,
  type PublicationEnvelope,
} from './publication';
import { UCP_VERSION } from './version';

import type { Sha256Fn } from './signatures';

/** Per-label transactions: the callback sees the current state and returns what to write. */
export interface UcpHostStore {
  transact<T>(
    label: string,
    fn: (current: LabelState | null) => Promise<{ write: LabelState | null; result: T }>,
  ): Promise<T>;
  get(label: string): Promise<LabelState | null>;
}

/** The off-host append-only log (a write-once store, apart from the database backups). */
export interface UcpHostLog {
  append(record: HostLogRecord): Promise<void>;
  /** The label's records with a revision above `revision`, in the order appended. Throws when unreadable. */
  after(label: string, revision: number): Promise<HostLogRecord[]>;
}

/** The Ed25519 `dina_signing` key a DID document names now; 'unavailable' when it cannot be had. */
export type SigningKeyFor = (did: string) => Promise<Uint8Array | null | 'unavailable'>;

export interface UcpHostOptions {
  /** This host's own name, e.g. `ucp.dinakernel.com`. */
  profileHost: string;
  store: UcpHostStore;
  log: UcpHostLog;
  signingKeyFor: SigningKeyFor;
  sha256: Sha256Fn;
  ed25519Verify: (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
  /** Drop-box deliveries accepted per label per minute (S9). */
  dropBoxPerMinute?: number;
  /** The Dina app as the OS knows it, for the claimed callback link; none: no app links served. */
  appLinks?: {
    appleAppIds: readonly string[];
    androidPackage: string;
    androidFingerprints: readonly string[];
  };
  /** Host transactions at once (default 4), and how many may wait (default 64). */
  maxConcurrent?: number;
  maxQueued?: number;
  now?: () => number;
}

export interface HostRequest {
  method: string;
  /** The request's host name, without a port. */
  hostname: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array | null;
}

export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The largest change body the host reads: an envelope plus one profile document. */
export const HOST_MAX_BODY_BYTES = 256 * 1024;

const json = (status: number, body: unknown, extra: Record<string, string> = {}): HostResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  body: JSON.stringify(body),
});
const notFound = (): HostResponse => json(404, {});

/** The Dina app's claimed callback path on every label host (§3.17): the redirect URI of a node without a public origin. */
export const UCP_APP_CALLBACK_PATH = '/oauth/callback';

/** What a browser without the Dina app sees at the claimed callback link: nothing is read or kept. */
const OPEN_IN_APP: HostResponse = {
  status: 200,
  headers: {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'referrer-policy': 'no-referrer',
  },
  body:
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
    '<title>Open in Dina</title><body style="font-family:system-ui;margin:2rem">' +
    '<h1>Open this link in the Dina app</h1>' +
    '<p>This link finishes linking your account, and only the Dina app can use it. ' +
    'The Dina app is not on this device, so nothing was linked. Start again from the Dina app.</p>',
};
const invalid = (status: number): HostResponse =>
  json(status, { status: 'refused', reason: 'invalid', state: null });
/** Try again later: the DID document, the log, or the host's capacity is not there now. */
const unavailable = (): HostResponse => json(503, {}, { 'retry-after': '60' });

class Busy extends Error {}
class LogUnreadable extends Error {}

/** Whether a request is for this host at all (its own name, or one of its labels). */
export function isUcpHostRequest(hostname: string, profileHost: string): boolean {
  const h = hostname.toLowerCase();
  return h === profileHost || h.endsWith(`.${profileHost}`);
}

export interface UcpHost {
  /** Answer a request for this host. The caller has read at most HOST_MAX_BODY_BYTES + 1. */
  handle(req: HostRequest): Promise<HostResponse>;
}

export function createUcpHost(options: UcpHostOptions): UcpHost {
  const { sha256 } = options;
  const now = options.now ?? Date.now;
  const dropBoxPerMinute = options.dropBoxPerMinute ?? 60;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const maxQueued = options.maxQueued ?? 64;

  // ---- the limit on host transactions
  let running = 0;
  const waiting: (() => void)[] = [];
  async function limited<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= maxConcurrent) {
      if (waiting.length >= maxQueued) throw new Busy();
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next !== undefined) next();
      else running -= 1;
    }
  }
  const transact: UcpHostStore['transact'] = (label, fn) =>
    limited(() => options.store.transact(label, fn));

  // ---- catching up from the log
  /** Labels this process has caught up (and the catch-ups running). */
  const caughtUp = new Set<string>();
  const catchingUp = new Map<string, Promise<void>>();

  async function catchUpOnce(label: string): Promise<void> {
    const stored = await options.store.get(label);
    // Read the log outside the transaction; the transaction applies only what is newer than its row.
    const records = await options.log.after(label, stored?.revision ?? 0);
    if (records.length > 0) {
      await transact(label, async (current) => {
        const out = catchUpFromLog(current, records);
        if (!out.ok) throw new LogUnreadable(out.reason);
        return { write: out.state, result: undefined };
      });
    }
    caughtUp.add(label);
  }

  function catchUp(label: string): Promise<void> {
    if (caughtUp.has(label)) return Promise.resolve();
    let pending = catchingUp.get(label);
    if (pending === undefined) {
      pending = catchUpOnce(label).finally(() => catchingUp.delete(label));
      catchingUp.set(label, pending);
    }
    return pending;
  }

  /** The label's state once caught up; 'unavailable' when its log or the host is not there now. */
  async function currentState(label: string): Promise<LabelState | null | 'unavailable'> {
    const stored = await options.store.get(label);
    // A label with no row serves nothing whatever its log says; only a change must ask the log.
    if (stored === null) return null;
    try {
      await catchUp(label);
    } catch {
      // A log that cannot be read (unreachable, or a damaged history), or a host
      // at capacity: serve nothing now.
      return 'unavailable';
    }
    return options.store.get(label);
  }

  // ---- changes
  function readBody(
    op: PublicationEnvelope['op'],
    body: Uint8Array | null,
  ): UploadBody | ControlBody | null {
    if (body === null || body.length > HOST_MAX_BODY_BYTES) return null;
    const parsed = parseStrictJson(new TextDecoder().decode(body));
    if (!parsed.ok || !isPlainObject(parsed.value)) return null;
    const value = parsed.value;
    const members = Object.keys(value);
    const expected = op === 'upload' ? ['envelope', 'documents'] : ['envelope'];
    if (members.length !== expected.length || !expected.every((m) => members.includes(m)))
      return null;
    // The shape first, so the DID it names is well formed before it is looked up.
    if (validatePublication(value.envelope, options.profileHost) !== null) return null;
    const envelope = value.envelope as unknown as PublicationEnvelope;
    if (envelope.op !== op) return null;
    if (op !== 'upload') return { envelope };
    const documents = value.documents;
    if (!isPlainObject(documents)) return null;
    const versions = Object.keys(documents);
    if (versions.length !== 1 || typeof documents[UCP_VERSION] !== 'string') return null;
    return { envelope, documents: { [UCP_VERSION]: documents[UCP_VERSION] as string } };
  }

  async function change(
    label: string,
    op: PublicationEnvelope['op'],
    raw: Uint8Array | null,
  ): Promise<HostResponse> {
    const body = readBody(op, raw);
    if (body === null) return invalid(400);
    const profileBytes = 'documents' in body ? body.documents[UCP_VERSION] : undefined;
    const key = await options.signingKeyFor(body.envelope.did);
    // A DID document that cannot be had now is not a refusal: the node tries again.
    if (key === 'unavailable') return unavailable();
    const check = verifyPublication(
      body.envelope,
      {
        label,
        profileHost: options.profileHost,
        ...(profileBytes !== undefined ? { profileBytes } : {}),
      },
      sha256,
      (message, signature) => key !== null && options.ed25519Verify(key, message, signature),
    );
    if (!check.ok) return invalid(401);

    const digest = envelopeDigest(check.envelope, sha256);
    try {
      await catchUp(label);
    } catch {
      // The log cannot be read (or reads as a damaged history), or the host is at capacity.
      return unavailable();
    }
    try {
      return await transact(label, async (current) => {
        const outcome = applyPublication(current, check.envelope, digest, profileBytes, sha256);
        if (outcome.kind === 'refused') {
          return {
            write: null,
            result: json(409, {
              status: 'refused',
              reason: outcome.reason,
              state: outcome.state === null ? null : publicState(outcome.state),
            }),
          };
        }
        if (outcome.kind === 'replay') {
          return {
            write: null,
            result: json(200, { status: 'replay', state: publicState(outcome.state) }),
          };
        }
        // The security state reaches the off-host log before the database.
        await options.log.append(outcome.log);
        return {
          write: outcome.state,
          result: json(200, { status: 'applied', state: publicState(outcome.state) }),
        };
      });
    } catch (err) {
      // The log may now hold a change the database lacks (an append that landed,
      // then a write that failed): catch the label up again before its next use.
      caughtUp.delete(label);
      if (err instanceof Busy) return unavailable();
      throw err;
    }
  }

  // ---- reads
  async function served(label: string, req: HostRequest): Promise<HostResponse> {
    const state = await currentState(label);
    if (state === 'unavailable') return unavailable();
    const bytes = state?.serving === true ? state.documents[UCP_VERSION] : undefined;
    if (bytes === undefined) return notFound();
    const etag = `"${bytesToHex(sha256(utf8Bytes(bytes))).slice(0, 32)}"`;
    const headers = {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${PROFILE_MAX_AGE_SECONDS}`,
      etag,
    };
    if (req.headers['if-none-match'] === etag) return { status: 304, headers, body: '' };
    return { status: 200, headers, body: bytes };
  }

  // ---- the drop-box: counters for bound labels only, dropped once their minute has passed
  const dropBox = new Map<string, { minute: number; count: number }>();
  let dropBoxMinute = -1;
  async function dropBoxDelivery(label: string): Promise<HostResponse> {
    if ((await options.store.get(label)) === null) return notFound();
    const minute = Math.floor(now() / 60_000);
    if (minute !== dropBoxMinute) {
      dropBox.clear();
      dropBoxMinute = minute;
    }
    const count = (dropBox.get(label)?.count ?? 0) + 1;
    dropBox.set(label, { minute, count });
    if (count > dropBoxPerMinute) return json(429, {}, { 'retry-after': '60' });
    // Reads nothing and keeps nothing (S9); the answer UCP expects (order/index.md:801-802).
    return json(200, { ucp: { version: UCP_VERSION } });
  }

  /** The app-site files for the Dina app's claimed callback link; null when it is not one. */
  function appLinkFile(req: HostRequest): HostResponse | null {
    const links = options.appLinks;
    if (links === undefined || req.method !== 'GET') return null;
    if (req.path === '/.well-known/apple-app-site-association')
      return json(200, {
        applinks: {
          details: [
            { appIDs: [...links.appleAppIds], components: [{ '/': UCP_APP_CALLBACK_PATH }] },
          ],
        },
      });
    if (req.path === '/.well-known/assetlinks.json')
      return json(200, [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: links.androidPackage,
            sha256_cert_fingerprints: [...links.androidFingerprints],
          },
        },
      ]);
    return null;
  }

  return {
    async handle(req) {
      const hostname = req.hostname.toLowerCase();
      // A wildcard claim (`*.<host>`) is verified at the base domain (Apple and Android alike).
      if (hostname === options.profileHost) {
        const appFile = appLinkFile(req);
        if (appFile !== null) return appFile;
      }
      if (hostname === options.profileHost) {
        const m = /^\/v1\/profiles\/([^/]+)(\/state|\/retire)?$/.exec(req.path);
        if (m === null || !LABEL_PATTERN.test(m[1] as string)) return notFound();
        const label = m[1] as string;
        if (m[2] === '/state') {
          if (req.method !== 'GET') return json(405, {});
          const state = await currentState(label);
          if (state === 'unavailable') return unavailable();
          return state === null ? notFound() : json(200, publicState(state));
        }
        if (m[2] === '/retire')
          return req.method === 'POST' ? change(label, 'retire', req.body) : json(405, {});
        if (req.method === 'PUT') return change(label, 'upload', req.body);
        if (req.method === 'DELETE') return change(label, 'pause', req.body);
        return json(405, {});
      }
      const label = labelForHostname(hostname, options.profileHost);
      if (label === null) return notFound();
      if (req.path === '/.well-known/ucp' && req.method === 'GET') return served(label, req);
      if (req.path === '/webhooks/orders' && req.method === 'POST') return dropBoxDelivery(label);
      if (
        req.method === 'GET' &&
        req.path === UCP_APP_CALLBACK_PATH &&
        options.appLinks !== undefined
      )
        return OPEN_IN_APP;
      const appFile = appLinkFile(req);
      if (appFile !== null) return appFile;
      return notFound();
    },
  };
}

/** An in-memory store (tests, and Core's publisher tests): one change per label at a time. */
export function memoryHostStore(): UcpHostStore & { labels: Map<string, LabelState> } {
  const labels = new Map<string, LabelState>();
  const locks = new Map<string, Promise<unknown>>();
  return {
    labels,
    async transact(label, fn) {
      const prior = locks.get(label) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const mine = new Promise<void>((r) => (release = r));
      locks.set(
        label,
        prior.then(() => mine),
      );
      await prior;
      try {
        const { write, result } = await fn(labels.get(label) ?? null);
        if (write !== null) labels.set(label, write);
        return result;
      } finally {
        release();
      }
    },
    async get(label) {
      return labels.get(label) ?? null;
    },
  };
}

/** An in-memory log (tests, and a development host with no bucket). */
export function memoryHostLog(): UcpHostLog & { records: HostLogRecord[] } {
  const records: HostLogRecord[] = [];
  return {
    records,
    async append(record) {
      records.push(record);
    },
    async after(label, revision) {
      return records.filter((r) => r.label === label && r.revision > revision);
    },
  };
}
