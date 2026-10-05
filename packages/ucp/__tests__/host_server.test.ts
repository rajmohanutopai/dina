/**
 * The profile host's HTTP contract (plan §3.5), the one implementation AppView
 * serves and Core's publisher tests run against: the routes, envelope checks,
 * one change per label at a time, the off-host log, per-label catch-up, the
 * transaction limit and the drop-box.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  createUcpHost,
  isUcpHostRequest,
  memoryHostLog,
  memoryHostStore,
  type HostRequest,
  type UcpHostLog,
  type UcpHostStore,
} from '../src/host_server';
import { es256PublicJwk } from '../src/jwk';
import { buyerProfileBytes } from '../src/profile';
import {
  documentHash,
  labelFromBytes,
  signPublication,
  type PublicationFields,
  type PublishedKey,
} from '../src/publication';

import type { HostLogRecord, LabelState } from '../src/host';

const HOST = 'ucp.dinakernel.com';
const LABEL = labelFromBytes(new Uint8Array(16).fill(0x42));
const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const NODE_SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(9);
const NODE_KEY = ed25519.getPublicKey(NODE_SEED);
const OTHER_KEY = ed25519.getPublicKey(OTHER_SEED);
const verify = (pk: Uint8Array, m: Uint8Array, sig: Uint8Array) => ed25519.verify(sig, m, pk);

const ucpKey = (g: number) =>
  es256PublicJwk(p256.getPublicKey(new Uint8Array(32).fill(g + 1), false), sha256);
const profile = (gens: number[], webhook = `https://${LABEL}.${HOST}/webhooks/orders`) =>
  buyerProfileBytes({ keys: gens.map(ucpKey), webhookUrl: webhook });
const key = (g: number, phase: PublishedKey['phase'] = 'active'): PublishedKey => ({
  thumbprint: ucpKey(g).kid,
  generation: g,
  phase,
  ...(phase === 'retiring' ? { retire_after: 2_000_000_000_000 } : {}),
});

async function body(
  op: 'upload' | 'pause' | 'retire',
  revision: number,
  over: Partial<PublicationFields> & { bytes?: string; seed?: Uint8Array; did?: string } = {},
): Promise<Uint8Array> {
  const fields = {
    did: over.did ?? DID,
    label: LABEL,
    epoch: over.epoch ?? 1,
    instance: over.instance ?? '11111111-1111-4111-8111-111111111111',
    revision,
    issued_at: 1_759_000_000_000 + revision,
  };
  const signer = (m: Uint8Array) => ed25519.sign(m, over.seed ?? NODE_SEED);
  if (op === 'upload') {
    const bytes = over.bytes ?? profile([0]);
    const envelope = await signPublication(
      {
        ...fields,
        op,
        documents: { '2026-08-25': documentHash(bytes, sha256) },
        keys: over.keys ?? [key(0)],
      },
      signer,
      HOST,
    );
    return new TextEncoder().encode(
      JSON.stringify({ envelope, documents: { '2026-08-25': bytes } }),
    );
  }
  const envelope =
    op === 'retire'
      ? await signPublication({ ...fields, op, retire: over.retire ?? [] }, signer, HOST)
      : await signPublication({ ...fields, op }, signer, HOST);
  return new TextEncoder().encode(JSON.stringify({ envelope }));
}

/** A first upload for any label (revision 1, generation 0). */
async function uploadFor(label: string): Promise<Uint8Array> {
  const bytes = profile([0], `https://${label}.${HOST}/webhooks/orders`);
  const envelope = await signPublication(
    {
      did: DID,
      label,
      epoch: 1,
      instance: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      issued_at: 1,
      op: 'upload',
      documents: { '2026-08-25': documentHash(bytes, sha256) },
      keys: [key(0)],
    },
    (m) => ed25519.sign(m, NODE_SEED),
    HOST,
  );
  return new TextEncoder().encode(JSON.stringify({ envelope, documents: { '2026-08-25': bytes } }));
}

type Store = UcpHostStore & { labels: Map<string, LabelState> };
type Log = UcpHostLog & { records: HostLogRecord[] };

function setup(
  over: {
    keys?: Record<string, Uint8Array | 'unavailable'>;
    store?: Store;
    log?: Log;
    maxConcurrent?: number;
    maxQueued?: number;
    appLinks?: boolean;
  } = {},
) {
  const store = over.store ?? memoryHostStore();
  const log = over.log ?? memoryHostLog();
  const keys = over.keys ?? { [DID]: NODE_KEY };
  const host = createUcpHost({
    profileHost: HOST,
    store,
    log,
    signingKeyFor: async (did) => keys[did] ?? null,
    sha256,
    ed25519Verify: verify,
    now: () => 0,
    ...(over.maxConcurrent !== undefined ? { maxConcurrent: over.maxConcurrent } : {}),
    ...(over.maxQueued !== undefined ? { maxQueued: over.maxQueued } : {}),
    ...(over.appLinks === true
      ? {
          appLinks: {
            appleAppIds: ['TEAM123.org.dina.app'],
            androidPackage: 'org.dina.app',
            androidFingerprints: ['AA:BB'],
          },
        }
      : {}),
  });
  const req = (
    method: string,
    path: string,
    b: Uint8Array | null = null,
    hostname = HOST,
    headers: Record<string, string> = {},
  ) => host.handle({ method, hostname, path, headers, body: b } satisfies HostRequest);
  return { store, log, req, control: `/v1/profiles/${LABEL}`, labelHost: `${LABEL}.${HOST}` };
}

describe('the HTTP contract', () => {
  it('an upload is applied, its state is public, and the profile is served with cache headers', async () => {
    const { req, control, labelHost } = setup();
    const up = await req('PUT', control, await body('upload', 1));
    expect(up.status).toBe(200);
    expect(JSON.parse(up.body)).toMatchObject({
      status: 'applied',
      state: { revision: 1, serving: true },
    });
    const state = await req('GET', `${control}/state`);
    expect(JSON.parse(state.body)).toMatchObject({ revision: 1, epoch: 1 });
    expect(state.body).not.toContain('did:');
    const served = await req('GET', '/.well-known/ucp', null, labelHost);
    expect(served).toMatchObject({ status: 200, body: profile([0]) });
    expect(served.headers['cache-control']).toBe('public, max-age=300');
    const again = await req('GET', '/.well-known/ucp', null, labelHost, {
      'if-none-match': served.headers.etag as string,
    });
    expect(again.status).toBe(304);
  });

  it('an unbound label has no state and no profile', async () => {
    const { req, control, labelHost } = setup();
    expect((await req('GET', `${control}/state`)).status).toBe(404);
    expect((await req('GET', '/.well-known/ucp', null, labelHost)).status).toBe(404);
  });

  it('only exact names are served: a malformed label or hostname is a 404', async () => {
    const { req } = setup();
    expect((await req('GET', '/v1/profiles/NOT-A-LABEL/state')).status).toBe(404);
    expect((await req('GET', '/.well-known/ucp', null, `x.${LABEL}.${HOST}`)).status).toBe(404);
    expect((await req('GET', '/.well-known/ucp', null, `${LABEL}-v2.${HOST}`)).status).toBe(404);
    expect(isUcpHostRequest(`${LABEL}.${HOST}`, HOST)).toBe(true);
    expect(isUcpHostRequest(`${LABEL}.${HOST}.evil.example`, HOST)).toBe(false);
  });

  it('the drop-box answers a bound label 200 with the UCP version, reads nothing, and is limited per label', async () => {
    const { store, log, req, control, labelHost } = setup();
    await req('PUT', control, await body('upload', 1));
    const records = log.records.length;
    const first = await req(
      'POST',
      '/webhooks/orders',
      new TextEncoder().encode('{"id":"ord_1"}'),
      labelHost,
    );
    expect(first).toMatchObject({ status: 200, body: '{"ucp":{"version":"2026-08-25"}}' });
    for (let i = 0; i < 59; i++) await req('POST', '/webhooks/orders', null, labelHost);
    expect((await req('POST', '/webhooks/orders', null, labelHost)).status).toBe(429);
    expect(store.labels.size).toBe(1);
    expect(log.records.length).toBe(records);
  });

  it('the drop-box of an unbound label is a 404, and floods of unbound labels never touch a bound one’s count', async () => {
    const { req, control, labelHost } = setup();
    await req('PUT', control, await body('upload', 1));
    for (let i = 0; i < 59; i++) await req('POST', '/webhooks/orders', null, labelHost);
    for (let i = 0; i < 200; i++) {
      const stranger = labelFromBytes(new Uint8Array(16).fill(i));
      if (stranger === LABEL) continue;
      expect((await req('POST', '/webhooks/orders', null, `${stranger}.${HOST}`)).status).toBe(404);
    }
    expect((await req('POST', '/webhooks/orders', null, labelHost)).status).toBe(200);
    expect((await req('POST', '/webhooks/orders', null, labelHost)).status).toBe(429);
  });
});

describe('the Dina app’s claimed callback link (UCP plan §3.17, U4)', () => {
  it('every label host serves the same app-site files, bound or not; nothing else is added', async () => {
    const { req, labelHost } = setup({ appLinks: true });
    const other = `${'b'.repeat(26)}.${HOST}`;
    const aasa = await req('GET', '/.well-known/apple-app-site-association', null, labelHost);
    expect(JSON.parse(aasa.body)).toEqual({
      applinks: {
        details: [{ appIDs: ['TEAM123.org.dina.app'], components: [{ '/': '/oauth/callback' }] }],
      },
    });
    expect((await req('GET', '/.well-known/apple-app-site-association', null, other)).body).toBe(
      aasa.body,
    );
    const android = await req('GET', '/.well-known/assetlinks.json', null, labelHost);
    expect(JSON.parse(android.body)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'org.dina.app',
          sha256_cert_fingerprints: ['AA:BB'],
        },
      },
    ]);
    // On the host's own name too: a wildcard claim is verified at the base domain.
    expect((await req('GET', '/.well-known/assetlinks.json', null, HOST)).body).toBe(android.body);
    expect((await req('GET', '/.well-known/apple-app-site-association', null, HOST)).body).toBe(
      aasa.body,
    );
    // Not without the app configured.
    const { req: plain } = setup();
    expect((await plain('GET', '/.well-known/assetlinks.json', null, labelHost)).status).toBe(404);
  });

  it('a browser without the app reaches a static page that reads nothing and keeps nothing', async () => {
    const { req, labelHost, log } = setup({ appLinks: true });
    const page = await req('GET', '/oauth/callback', null, labelHost);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('Open this link in the Dina app');
    expect(log.records).toEqual([]);
    expect((await req('POST', '/oauth/callback', null, labelHost)).status).toBe(404);
  });
});

describe('envelope checks', () => {
  it('refuses a forged upload that copies the key but changes the document', async () => {
    const { req, control } = setup();
    const genuine = JSON.parse(new TextDecoder().decode(await body('upload', 1)));
    genuine.documents['2026-08-25'] = profile([0], 'https://evil.example/hook');
    expect(
      (await req('PUT', control, new TextEncoder().encode(JSON.stringify(genuine)))).status,
    ).toBe(401);
  });

  it('refuses a signature from a key the DID document does not name, and a DID with no key', async () => {
    const { req, control } = setup();
    expect((await req('PUT', control, await body('upload', 1, { seed: OTHER_SEED }))).status).toBe(
      401,
    );
    expect(
      (await req('PUT', control, await body('upload', 1, { did: OTHER, seed: OTHER_SEED }))).status,
    ).toBe(401);
  });

  it('answers 503 with no refusal body when the DID document cannot be had (the node retries)', async () => {
    const { req, control } = setup({ keys: { [DID]: 'unavailable' } });
    const r = await req('PUT', control, await body('upload', 1));
    expect(r.status).toBe(503);
    expect(r.headers['retry-after']).toBe('60');
    expect(JSON.parse(r.body)).toEqual({});
  });

  it('refuses an operation that does not match its route, extra body members, and a body that is not one', async () => {
    const { req, control } = setup();
    expect((await req('PUT', control, await body('pause', 1))).status).toBe(400);
    const extra = JSON.parse(new TextDecoder().decode(await body('pause', 1)));
    extra.more = 1;
    expect(
      (await req('DELETE', control, new TextEncoder().encode(JSON.stringify(extra)))).status,
    ).toBe(400);
    expect((await req('PUT', control, new TextEncoder().encode('{"envelope":1}'))).status).toBe(
      400,
    );
    expect((await req('PUT', control, null)).status).toBe(400);
  });

  it('refuses another DID for a bound label (409, with the state)', async () => {
    const { req, control } = setup({ keys: { [DID]: NODE_KEY, [OTHER]: OTHER_KEY } });
    await req('PUT', control, await body('upload', 1));
    const r = await req('PUT', control, await body('upload', 2, { did: OTHER, seed: OTHER_SEED }));
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toMatchObject({
      status: 'refused',
      reason: 'label_owned',
      state: { revision: 1 },
    });
  });
});

describe('one change at a time, logged first', () => {
  it('logs every applied change in order, never a refusal or a replay', async () => {
    const { req, log, control } = setup();
    const one = await body('upload', 1);
    await req('PUT', control, one);
    await req('PUT', control, one); // replay
    await req('PUT', control, await body('upload', 5)); // stale
    await req('DELETE', control, await body('pause', 2));
    expect(log.records.map((r) => [r.revision, r.op])).toEqual([
      [1, 'upload'],
      [2, 'pause'],
    ]);
  });

  it('of two uploads claiming the same revision at once, exactly one applies', async () => {
    const { req, control } = setup();
    await req('PUT', control, await body('upload', 1));
    const [a, b] = await Promise.all([
      req(
        'PUT',
        control,
        await body('upload', 2, { bytes: profile([0], `https://${LABEL}.${HOST}/webhooks/a`) }),
      ),
      req(
        'PUT',
        control,
        await body('upload', 2, { bytes: profile([0], `https://${LABEL}.${HOST}/webhooks/b`) }),
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('a change whose log append fails is not written', async () => {
    const store = memoryHostStore();
    const failing: Log = {
      records: [],
      append: async () => {
        throw new Error('log down');
      },
      after: async () => [],
    };
    const { req, control } = setup({ store, log: failing });
    await expect(req('PUT', control, await body('upload', 1))).rejects.toThrow('log down');
    expect(store.labels.size).toBe(0);
  });

  it('a change whose write fails after its append catches the label up again before the next use', async () => {
    const inner = memoryHostStore();
    let failNextWrite = false;
    const store: Store = {
      labels: inner.labels,
      get: inner.get,
      transact: (label, fn) =>
        inner.transact(label, async (current) => {
          const out = await fn(current);
          if (failNextWrite && out.write !== null) {
            failNextWrite = false;
            throw new Error('commit failed');
          }
          return out;
        }),
    };
    const { req, control, log } = setup({ store });
    await req('PUT', control, await body('upload', 1));
    failNextWrite = true;
    await expect(req('DELETE', control, await body('pause', 2))).rejects.toThrow('commit failed');
    // The log holds revision 2; the database does not.
    expect(log.records.map((r) => r.revision)).toEqual([1, 2]);
    expect(store.labels.get(LABEL)?.revision).toBe(1);
    // The next read catches up, so the pause the node was told failed is not lost either way.
    const state = JSON.parse((await req('GET', `${control}/state`)).body);
    expect(state).toMatchObject({ revision: 2, serving: false });
  });
});

describe('a restored database', () => {
  it('is caught up from the log label by label: a retired key is never served again and no counter goes back', async () => {
    const first = setup();
    await first.req(
      'PUT',
      first.control,
      await body('upload', 1, { bytes: profile([0, 1]), keys: [key(1), key(0, 'retiring')] }),
    );
    const backup = structuredClone(first.store.labels.get(LABEL) as LabelState);
    await first.req(
      'POST',
      `${first.control}/retire`,
      await body('retire', 2, { retire: [key(0).thumbprint] }),
    );
    // Restored from the backup with the node offline; the host restarts.
    first.store.labels.set(LABEL, backup);
    const { store, req, control, labelHost } = setup({ store: first.store, log: first.log });
    expect((await req('GET', '/.well-known/ucp', null, labelHost)).status).toBe(404);
    const s = store.labels.get(LABEL) as LabelState;
    expect(s).toMatchObject({ revision: 2, serving: false });
    expect(s.retired).toContain(key(0).thumbprint);
    expect(JSON.parse((await req('GET', `${control}/state`)).body)).toMatchObject({
      revision: 2,
      serving: false,
    });
    expect(
      (
        await req(
          'PUT',
          control,
          await body('upload', 3, { bytes: profile([0, 1]), keys: [key(1), key(0, 'retiring')] }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await req('PUT', control, await body('upload', 3, { bytes: profile([1]), keys: [key(1)] })))
        .status,
    ).toBe(200);
  });

  it('a label missing from the restored database is still bound: another DID cannot take it', async () => {
    const keys = { [DID]: NODE_KEY, [OTHER]: OTHER_KEY };
    const first = setup({ keys });
    await first.req('PUT', first.control, await body('upload', 1));
    first.store.labels.clear();
    const { req, control } = setup({ keys, store: first.store, log: first.log });
    const r = await req('PUT', control, await body('upload', 1, { did: OTHER, seed: OTHER_SEED }));
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toMatchObject({ reason: 'label_owned' });
  });

  it('a label whose log cannot be read, or reads as a damaged history, serves nothing and takes no change', async () => {
    const first = setup();
    await first.req('PUT', first.control, await body('upload', 1));
    await first.req('DELETE', first.control, await body('pause', 2));
    first.store.labels.set(LABEL, {
      ...(first.store.labels.get(LABEL) as LabelState),
      revision: 1,
      serving: true,
    });
    let mode: 'down' | 'tampered' | 'ok' = 'down';
    const log: Log = {
      records: first.log.records,
      append: first.log.append,
      after: async (label, revision) => {
        if (mode === 'down') throw new Error('bucket unreachable');
        const records = await first.log.after(label, revision);
        return mode === 'tampered' ? records.map((r) => ({ ...r, did: OTHER })) : records;
      },
    };
    const { req, control, labelHost } = setup({ store: first.store, log });
    for (const m of ['down', 'tampered'] as const) {
      mode = m;
      const r = await req('GET', '/.well-known/ucp', null, labelHost);
      expect(r.status).toBe(503);
      expect(r.headers['retry-after']).toBe('60');
      expect((await req('GET', `${control}/state`)).status).toBe(503);
      expect((await req('PUT', control, await body('upload', 3))).status).toBe(503);
    }
    mode = 'ok';
    expect((await req('GET', '/.well-known/ucp', null, labelHost)).status).toBe(404); // paused, as the log says
    expect((await req('PUT', control, await body('upload', 3))).status).toBe(200);
  });

  it('asks the log once per label per process, never for a label it has no row for, and outside any transaction', async () => {
    const first = setup();
    await first.req('PUT', first.control, await body('upload', 1));
    let asked = 0;
    let open = 0;
    let askedInside = false;
    const store: Store = {
      labels: first.store.labels,
      get: first.store.get,
      transact: async (label, fn) => {
        open += 1;
        try {
          return await first.store.transact(label, fn);
        } finally {
          open -= 1;
        }
      },
    };
    const log: Log = {
      records: first.log.records,
      append: first.log.append,
      after: async (label, revision) => {
        asked += 1;
        if (open > 0) askedInside = true;
        return first.log.after(label, revision);
      },
    };
    const { req, labelHost, control } = setup({ store, log });
    await Promise.all([1, 2, 3].map(() => req('GET', '/.well-known/ucp', null, labelHost)));
    await req('GET', '/.well-known/ucp', null, labelHost);
    await req('PUT', control, await body('upload', 2));
    expect(asked).toBe(1);
    expect(askedInside).toBe(false);
    const stranger = labelFromBytes(new Uint8Array(16).fill(0x07));
    expect((await req('GET', '/.well-known/ucp', null, `${stranger}.${HOST}`)).status).toBe(404);
    expect(asked).toBe(1);
  });
});

describe('the transaction limit', () => {
  it('runs at most maxConcurrent transactions, queues a few, and answers 503 beyond the queue', async () => {
    const inner = memoryHostStore();
    let open = 0;
    let peak = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const store: Store = {
      labels: inner.labels,
      get: inner.get,
      transact: async (label, fn) => {
        open += 1;
        peak = Math.max(peak, open);
        await gate;
        try {
          return await inner.transact(label, fn);
        } finally {
          open -= 1;
        }
      },
    };
    const { req } = setup({ store, maxConcurrent: 2, maxQueued: 1 });
    const labels = [1, 2, 3, 4].map((i) => labelFromBytes(new Uint8Array(16).fill(0x50 + i)));
    const bodies = await Promise.all(labels.map(async (l) => ({ l, b: await uploadFor(l) })));
    const answers = bodies.map(({ l, b }) => req('PUT', `/v1/profiles/${l}`, b));
    // Let the first ones reach the gate.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const statuses = (await Promise.all(answers)).map((a) => a.status).sort();
    expect(peak).toBeLessThanOrEqual(2);
    expect(statuses).toEqual([200, 200, 200, 503]);
  });
});
