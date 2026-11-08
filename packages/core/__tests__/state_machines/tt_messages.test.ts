/**
 * docs/STATE_MACHINES.md issues 4, 6, 10: inbound messages lost after an ack,
 * outbox sweeps, retries past their time. TT-01, 03, 06, 07, 08, 11, 12, 13, 14.
 * The socket is fake; SQLite and the pipeline are the real ones.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '../../../storage-node/src/index';
import { queryAudit } from '../../src/audit/service';
import { SQLiteContactRepository, setContactRepository } from '../../src/contacts/repository';
import { deleteContact } from '../../src/contacts/directory';
import { getPublicKey } from '../../src/crypto/ed25519';
import { sealDecryptWithScheme, sealEncrypt } from '../../src/crypto/nacl';
import { sealMessage } from '../../src/d2d/envelope';
import {
  SQLiteQuarantineRepository,
  hydrateQuarantineFromRepository,
  listBySender,
  listQuarantined,
  quarantineMessage,
  resetQuarantineState,
  setQuarantineRepository,
  unquarantineSender,
} from '../../src/d2d/quarantine';
import { receiveD2D } from '../../src/d2d/receive_pipeline';
import { sendD2D } from '../../src/d2d/send';
import { getDeviceByDID, resetDeviceRegistry, revokeDevice } from '../../src/devices/registry';
import { setDeviceRepository } from '../../src/devices/repository';
import { deriveDIDKey, publicKeyToMultibase } from '../../src/identity/did';
import { clearPairingState, generatePairingCode, setNodeDID } from '../../src/pairing/ceremony';
import { SQLitePeopleRepository, setPeopleRepository } from '../../src/people/repository';
import { bootstrapMsgBox } from '../../src/relay/msgbox_boot';
import { resetHandlerState, type ResolvedSender } from '../../src/relay/msgbox_handlers';
import { resetConnectionState, wakeRelay } from '../../src/relay/msgbox_ws';
import { CoreRouter } from '../../src/server/router';
import { registerD2DQuarantineRoutes } from '../../src/server/routes/d2d_quarantine';
import { registerPairRoutes } from '../../src/server/routes/pair';
import {
  requesterWindow,
  resetServiceWindows,
  setProviderWindow,
} from '../../src/service/windows';
import { SQLiteStagingRepository, setStagingRepository } from '../../src/staging/repository';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { clearReplayCache, isReplayedMessage } from '../../src/transport/adversarial';
import { resetDeliveryDeps, setDeliveryFetchFn, setWSDeliverFn } from '../../src/transport/delivery';
import {
  claimDue,
  enqueueD2D,
  getOutboxRow,
  outboxCount,
  sweepTerminal,
} from '../../src/transport/outbox';
import { SQLiteD2DOutboxRepository, setD2DOutboxRepository } from '../../src/transport/outbox_repository';
import {
  drainOutbox,
  recoverOutboxOnBoot,
  resetRetryState,
  setOutboxRedeliverFn,
} from '../../src/transport/retry';

import type { DatabaseAdapter } from '../../src/storage/db_adapter';

const NODE_DID = 'did:plc:nodeprobe';
const SENDER_DID = 'did:plc:senderprobe';

function openDb(): DatabaseAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-messages-'));
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: randomBytes(32).toString('hex'),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  } as never) as unknown as DatabaseAdapter;
  applyMigrations(db as never, IDENTITY_MIGRATIONS);
  return db;
}

class FakeWS {
  sent: { type?: string; id?: string; ciphertext?: string }[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  send(d: string | Uint8Array) {
    this.sent.push(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)));
  }
  close() {
    this.readyState = 3;
  }
  acks() {
    return this.sent.filter((f) => f.type === 'ack');
  }
  rpc() {
    return this.sent.filter((f) => f.type === 'rpc');
  }
}

const sockets: FakeWS[] = [];
function authed(): FakeWS {
  const s = sockets[sockets.length - 1];
  s.readyState = 1;
  s.onopen!();
  s.onmessage!({ data: JSON.stringify({ type: 'auth_challenge', nonce: 'n', ts: 1 }) });
  s.onmessage!({ data: JSON.stringify({ type: 'auth_success', features: ['ack'] }) });
  return s;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const nodeKey = new Uint8Array(randomBytes(32));
const senderKey = new Uint8Array(randomBytes(32));
const nodePub = getPublicKey(nodeKey);
const senderPub = getPublicKey(senderKey);

function envelope(id: string, signingKey = senderKey, type = 'social.update', body = '{"text":"hello"}') {
  const payload = sealMessage(
    { id, type, from: SENDER_DID, to: NODE_DID, created_time: Date.now(), body },
    signingKey,
    nodePub,
  );
  return { type: 'd2d', id, from_did: SENDER_DID, to_did: NODE_DID, ciphertext: JSON.stringify(payload) };
}

async function boot(
  resolveSender: (did: string) => Promise<ResolvedSender>,
  router = new CoreRouter(),
  extra: { onBypassedD2D?: () => Promise<void> } = {},
): Promise<FakeWS> {
  const p = bootstrapMsgBox({
    did: NODE_DID,
    privateKey: nodeKey,
    msgboxURL: 'wss://relay.example/ws',
    wsFactory: () => {
      const s = new FakeWS();
      sockets.push(s);
      return s as never;
    },
    coreRouter: router,
    resolveSender,
    readyTimeoutMs: 2000,
    ...extra,
  });
  const s = authed();
  await p;
  return s;
}

function send(s: FakeWS, env: unknown) {
  s.onmessage!({ data: JSON.stringify(env) });
}

let db: DatabaseAdapter;

beforeEach(() => {
  db = openDb();
  sockets.length = 0;
  clearReplayCache();
  resetServiceWindows();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  resetConnectionState();
  resetHandlerState();
  setStagingRepository(null);
  setQuarantineRepository(null);
  resetQuarantineState();
  setD2DOutboxRepository(null);
  setPeopleRepository(null);
  setContactRepository(null);
  resetDeliveryDeps();
  resetRetryState();
  setWSDeliverFn(null);
});

describe('TT-01: a sender we cannot check yet', () => {
  it('a directory outage is not a bad signature: no ack, no replay key, and the next copy lands', async () => {
    setStagingRepository(new SQLiteStagingRepository(db));
    let up = false;
    const s = await boot(async () =>
      up ? { keys: [senderPub], trust: 'verified' } : { keys: [], trust: 'verified', unresolved: true },
    );
    const env = envelope('d2d-1');
    send(s, env);
    await sleep(30);
    expect(s.acks()).toHaveLength(0);
    expect(isReplayedMessage(`${SENDER_DID}|d2d-1`)).toBe(false);

    up = true;
    send(s, env);
    await sleep(30);
    expect(s.acks()).toHaveLength(1);
    expect(db.query('SELECT 1 FROM staging_inbox WHERE source_id = ?', ['d2d-1'])).toHaveLength(1);
  });

  it('a resolver that throws is the same', async () => {
    const s = await boot(async () => {
      throw new Error('PLC 503');
    });
    send(s, envelope('d2d-2'));
    await sleep(30);
    expect(s.acks()).toHaveLength(0);
  });

  it('an unverifiable message is never accepted, however long the outage', async () => {
    setStagingRepository(new SQLiteStagingRepository(db));
    const s = await boot(async () => ({ keys: [], trust: 'verified', unresolved: true }));
    send(s, envelope('d2d-3'));
    await sleep(30);
    expect(db.query('SELECT 1 FROM staging_inbox')).toHaveLength(0);
    expect(listQuarantined()).toHaveLength(0);
  });

  it('a node that stays connected tries again by itself', async () => {
    setStagingRepository(new SQLiteStagingRepository(db));
    let up = false;
    const s = await boot(async () =>
      up ? { keys: [senderPub], trust: 'verified' } : { keys: [], trust: 'verified', unresolved: true },
    );
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    send(s, envelope('d2d-4'));
    await jest.advanceTimersByTimeAsync(10);
    expect(s.acks()).toHaveLength(0);
    up = true;
    await jest.advanceTimersByTimeAsync(31_000);
    expect(s.acks()).toHaveLength(1);
    expect(db.query('SELECT 1 FROM staging_inbox WHERE source_id = ?', ['d2d-4'])).toHaveLength(1);
  });

  it('a rotated key is checked against the fresh document', async () => {
    setStagingRepository(new SQLiteStagingRepository(db));
    const oldKey = getPublicKey(new Uint8Array(randomBytes(32)));
    const refresh = jest.fn(async () => ({ keys: [senderPub], trust: 'verified' }));
    const s = await boot(async () => ({ keys: [oldKey], trust: 'verified', refresh }));
    send(s, envelope('d2d-5'));
    await sleep(30);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(s.acks()).toHaveLength(1);
    expect(db.query('SELECT 1 FROM staging_inbox WHERE source_id = ?', ['d2d-5'])).toHaveLength(1);
  });

  it('a stale key with the directory down stays for later', async () => {
    const oldKey = getPublicKey(new Uint8Array(randomBytes(32)));
    const s = await boot(async () => ({
      keys: [oldKey],
      trust: 'verified',
      refresh: async () => ({ keys: [], trust: 'verified', unresolved: true }),
    }));
    send(s, envelope('d2d-6'));
    await sleep(30);
    expect(s.acks()).toHaveLength(0);
  });

  it('a forged signature is dropped and acked once the directory has answered', async () => {
    setStagingRepository(new SQLiteStagingRepository(db));
    const forger = new Uint8Array(randomBytes(32));
    const refresh = jest.fn(async () => ({ keys: [senderPub], trust: 'verified' }));
    const s = await boot(async () => ({ keys: [senderPub], trust: 'verified', refresh }));
    send(s, envelope('d2d-7', forger));
    await sleep(30);
    expect(s.acks()).toHaveLength(1);
    expect(db.query('SELECT 1 FROM staging_inbox')).toHaveLength(0);
    expect(isReplayedMessage(`${SENDER_DID}|d2d-7`)).toBe(false);
  });

  it('a frame that can never parse is refused and acked', async () => {
    const s = await boot(async () => ({ keys: [senderPub], trust: 'verified' }));
    send(s, { type: 'd2d', id: 'bad', from_did: SENDER_DID, to_did: NODE_DID, ciphertext: 'not json' });
    await sleep(30);
    expect(s.acks()).toHaveLength(1);
  });
});

describe('TT-03: a replay key only after the message has a home', () => {
  it('a staging write that fails holds no key and sends no ack; the next copy stages', async () => {
    const real = new SQLiteStagingRepository(db);
    let fail = true;
    setStagingRepository(
      new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'ingest' && fail) {
            return () => {
              fail = false;
              throw new Error('SQLITE_BUSY');
            };
          }
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      }),
    );
    const s = await boot(async () => ({ keys: [senderPub], trust: 'verified' }));
    const env = envelope('d2d-10');
    send(s, env);
    await sleep(30);
    expect(s.acks()).toHaveLength(0);
    expect(isReplayedMessage(`${SENDER_DID}|d2d-10`)).toBe(false);

    send(s, env);
    await sleep(30);
    expect(s.acks()).toHaveLength(1);
    expect(isReplayedMessage(`${SENDER_DID}|d2d-10`)).toBe(true);
    expect(db.query('SELECT 1 FROM staging_inbox WHERE source_id = ?', ['d2d-10'])).toHaveLength(1);
  });

  it('a quarantine write that fails is the same, and holds nothing in memory', async () => {
    const real = new SQLiteQuarantineRepository(db);
    let fail = true;
    setQuarantineRepository({
      add: (m) => {
        if (fail) {
          fail = false;
          throw new Error('SQLITE_BUSY');
        }
        real.add(m);
      },
      deleteById: (i) => real.deleteById(i),
      deleteBySender: (d) => real.deleteBySender(d),
      deleteExpired: (n) => real.deleteExpired(n),
      listAll: () => real.listAll(),
      clear: () => real.clear(),
    });
    const s = await boot(async () => ({ keys: [senderPub], trust: 'unknown' }));
    const env = envelope('d2d-11');
    send(s, env);
    await sleep(30);
    expect(s.acks()).toHaveLength(0);
    expect(listQuarantined()).toHaveLength(0);

    send(s, env);
    await sleep(30);
    expect(s.acks()).toHaveLength(1);
    expect(real.listAll()).toHaveLength(1);
  });

  it('a crash after the store and before the key: the resend lands on the same row', () => {
    setQuarantineRepository(new SQLiteQuarantineRepository(db));
    const payload = () =>
      sealMessage(
        { id: 'd2d-12', type: 'social.update', from: SENDER_DID, to: NODE_DID, created_time: Date.now(), body: '{"text":"x"}' },
        senderKey,
        nodePub,
      );
    receiveD2D(payload(), nodePub, nodeKey, [senderPub], 'unknown');
    clearReplayCache(); // the key that never got written
    receiveD2D(payload(), nodePub, nodeKey, [senderPub], 'unknown');
    expect(listQuarantined()).toHaveLength(1);
  });

  it('service traffic: the key waits for the dispatcher, and a second copy cannot run alongside', async () => {
    const body = JSON.stringify({
      query_id: 'q-1',
      capability: 'eta_query',
      params: { location: { lat: 1, lng: 2 } },
      ttl_seconds: 60,
    });
    const payload = () =>
      sealMessage(
        { id: 'd2d-13', type: 'service.query', from: SENDER_DID, to: NODE_DID, created_time: Date.now(), body },
        senderKey,
        nodePub,
      );
    const options = { isCapabilityConfigured: () => true, holdBypassReplayKey: true };
    const first = receiveD2D(payload(), nodePub, nodeKey, [senderPub], 'unknown', options);
    expect(first.action).toBe('bypassed');
    expect(isReplayedMessage(`${SENDER_DID}|d2d-13`)).toBe(false);
    const second = receiveD2D(payload(), nodePub, nodeKey, [senderPub], 'unknown', options);
    expect(second.action).toBe('dropped');
    first.commitReplay!();
    expect(isReplayedMessage(`${SENDER_DID}|d2d-13`)).toBe(true);
    expect(receiveD2D(payload(), nodePub, nodeKey, [senderPub], 'unknown', options).action).toBe('dropped');
  });
});

describe('TT-13: quarantine ids', () => {
  it('do not repeat after a restart, so a later accepted message is staged', async () => {
    setQuarantineRepository(new SQLiteQuarantineRepository(db));
    setStagingRepository(new SQLiteStagingRepository(db));
    setPeopleRepository(new SQLitePeopleRepository(db));
    setContactRepository(new SQLiteContactRepository(db));
    const router = new CoreRouter();
    registerD2DQuarantineRoutes(router);
    const accept = () =>
      router.handle({
        method: 'POST',
        path: '/v1/d2d/quarantine/accept',
        query: {},
        headers: {},
        body: { sender_did: SENDER_DID, sender_label: 'P' },
        rawBody: new Uint8Array(0),
        params: {},
        trustedInProcess: true,
      } as never);
    const q1 = quarantineMessage(SENDER_DID, 'social.update', JSON.stringify({ text: 'first' }));
    await accept();
    deleteContact(SENDER_DID);
    resetQuarantineState();
    hydrateQuarantineFromRepository();
    const q2 = quarantineMessage(SENDER_DID, 'social.update', JSON.stringify({ text: 'second' }));
    await accept();
    expect(q2.id).not.toBe(q1.id);
    const rows = db.query<{ data: string }>('SELECT data FROM staging_inbox WHERE producer_id = ?', [SENDER_DID]);
    expect(rows.some((r) => r.data.includes('second'))).toBe(true);
  });

  it('the same message id from the same sender stays one row; another sender is apart', () => {
    const a = quarantineMessage(SENDER_DID, 'social.update', '{}', undefined, 'm1');
    const b = quarantineMessage(SENDER_DID, 'social.update', '{}', undefined, 'm1');
    const c = quarantineMessage('did:plc:other', 'social.update', '{}', undefined, 'm1');
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
  });
});

describe('TT-14: quarantine expiry', () => {
  it('the boot sweep removes a row past its 30 days', () => {
    const repo = new SQLiteQuarantineRepository(db);
    setQuarantineRepository(repo);
    quarantineMessage(SENDER_DID, 'social.update', '{}', Date.now() - 40 * 86400_000);
    quarantineMessage(SENDER_DID, 'social.update', '{}');
    resetQuarantineState();
    expect(hydrateQuarantineFromRepository()).toBe(1);
    expect(listQuarantined()).toHaveLength(1);
    expect(repo.listAll()).toHaveLength(1);
  });

  it('the drainer sweeps on its slow clock, even with nothing to send', async () => {
    const { startOutboxDrainer } = await import('../../src/transport/retry');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    quarantineMessage(SENDER_DID, 'social.update', '{}', Date.now() - 40 * 86400_000);
    const drainer = startOutboxDrainer({ intervalMs: 1000, sweepEveryTicks: 1 });
    await jest.advanceTimersByTimeAsync(10);
    drainer.stop();
    expect(listQuarantined()).toHaveLength(0);
  });

  it('a row past its time cannot be released before a sweep', () => {
    quarantineMessage(SENDER_DID, 'social.update', '{}', Date.now() - 40 * 86400_000);
    expect(unquarantineSender(SENDER_DID)).toHaveLength(0);
    expect(listQuarantined()).toHaveLength(0);
  });

  it('one sender cannot hold more than the cap, and loses its own oldest', () => {
    for (let i = 0; i < 205; i++) quarantineMessage(SENDER_DID, 'social.update', String(i), Date.now() + i);
    quarantineMessage('did:plc:other', 'social.update', 'kept');
    const held = listBySender(SENDER_DID);
    expect(held).toHaveLength(200);
    expect(held.some((m) => m.body === '0')).toBe(false);
    expect(held.some((m) => m.body === '204')).toBe(true);
    expect(listBySender('did:plc:other')).toHaveLength(1);
  });
});

describe('outbox', () => {
  const T0 = Date.now();
  beforeEach(() => setD2DOutboxRepository(new SQLiteD2DOutboxRepository(db)));

  it('TT-06: a crash then a restart inside the lease: the next drain after the lease sends', async () => {
    enqueueD2D({ id: 'a', targetDID: 'did:plc:x', messageType: 'social.update', bodyJson: '{}', now: T0 });
    expect(claimDue(T0, 60_000, 25)).toHaveLength(1);
    expect(recoverOutboxOnBoot(T0 + 10_000)).toBe(0);
    const sent: string[] = [];
    setOutboxRedeliverFn(async (r) => {
      sent.push(r.id);
      return { delivered: true };
    }, 'did:plc:me');
    await drainOutbox(T0 + 20_000); // lease still live: nothing yet
    expect(sent).toEqual([]);
    await drainOutbox(T0 + 70_000);
    expect(sent).toEqual(['a']);
    expect(getOutboxRow('a')?.state).toBe('sent');
  });

  it('TT-07: an expired row dies, is audited, is swept, and frees its key', async () => {
    const body = JSON.stringify({ query_id: 'q1' });
    const r = enqueueD2D({ id: 'b', targetDID: 'did:plc:x', messageType: 'service.query', bodyJson: body, now: T0 });
    const later = T0 + 25 * 3_600_000;
    const res = await drainOutbox(later); // no redeliver wired: still dies
    expect(res.dead).toBe(1);
    expect(getOutboxRow('b')?.state).toBe('dead');
    expect(queryAudit({ action: 'd2d_outbox_dead' }).some((e) => e.detail.includes('id=b'))).toBe(true);
    expect(sweepTerminal(later + 2 * 86_400_000)).toBe(1);

    const again = enqueueD2D({ id: 'c', targetDID: 'did:plc:x', messageType: 'service.query', bodyJson: body, now: later });
    expect(again.id).not.toBe(r.id);
    expect(again.state).toBe('pending');
  });

  it('TT-07: an enqueue with no drain in between does not get the expired row back', () => {
    const body = JSON.stringify({ query_id: 'q2' });
    enqueueD2D({ id: 'd', targetDID: 'did:plc:x', messageType: 'service.query', bodyJson: body, now: T0 });
    const later = T0 + 25 * 3_600_000;
    const again = enqueueD2D({ id: 'e', targetDID: 'did:plc:x', messageType: 'service.query', bodyJson: body, now: later });
    expect(again.id).toBe('e');
    expect(getOutboxRow('d')?.state).toBe('dead');
    expect(outboxCount('pending')).toBe(1);
  });
});

describe('service traffic and its TTL', () => {
  const me = new Uint8Array(randomBytes(32));
  const PEER = 'did:plc:peerprobe';
  const ME = 'did:plc:meprobe';
  const ENDPOINT = 'wss://mailbox.example.com/ws';
  const peerPub = getPublicKey(new Uint8Array(randomBytes(32)));
  const resolver = { isDiscoverableService: async () => true };
  let posts = 0;
  let online = false;

  function redeliver(): void {
    setOutboxRedeliverFn(async (row) => {
      const result = await sendD2D({
        recipientDID: row.targetDID,
        messageType: row.messageType,
        body: row.bodyJson,
        senderDID: ME,
        senderPrivateKey: me,
        recipientPublicKey: peerPub,
        endpoint: ENDPOINT,
        suppressEnqueue: true,
        messageId: row.id,
        createdTime: row.createdAt,
        providerServiceResolver: resolver as never,
      });
      return result.delivered || result.buffered
        ? { delivered: true }
        : { delivered: false, error: result.error ?? result.deniedAt ?? 'failed' };
    }, ME);
  }

  beforeEach(() => {
    posts = 0;
    online = false;
    setD2DOutboxRepository(new SQLiteD2DOutboxRepository(db));
    setDeliveryFetchFn((async () => {
      posts++;
      return online
        ? new Response(JSON.stringify({ status: 'delivered' }), { status: 200 })
        : new Response('down', { status: 503 });
    }) as typeof fetch);
    redeliver();
  });

  const queryBody = (ttl: number) =>
    JSON.stringify({ query_id: 'q2', capability: 'book_table', params: { party: 2 }, ttl_seconds: ttl });

  function firstSend(body: string) {
    return sendD2D({
      recipientDID: PEER,
      messageType: 'service.query',
      body,
      senderDID: ME,
      senderPrivateKey: me,
      recipientPublicKey: peerPub,
      endpoint: ENDPOINT,
      providerServiceResolver: resolver as never,
    });
  }

  it('TT-08: a query past its TTL dies in the outbox and never goes out', async () => {
    const r = await firstSend(queryBody(60));
    expect(r.queued).toBe(true);
    const row = getOutboxRow(r.messageId)!;
    expect(row.expiresAt! - row.createdAt).toBeLessThanOrEqual(60_000);
    requesterWindow().checkAndConsume(PEER, 'q2', 'book_table');
    online = true;
    posts = 0;
    const o = await drainOutbox(Date.now() + 3 * 3_600_000);
    expect(o.delivered).toBe(0);
    expect(posts).toBe(0);
    expect(getOutboxRow(r.messageId)?.state).toBe('dead');
    expect(requesterWindow().peek(PEER, 'q2', 'book_table')).toBe(false);
  });

  it('TT-08: a row queued before this fix, with a 24 h expiry, still cannot leave past its TTL', async () => {
    const created = Date.now() - 3 * 3_600_000;
    enqueueD2D({
      id: 'd2d-oldrow',
      targetDID: PEER,
      messageType: 'service.query',
      bodyJson: queryBody(60),
      now: created,
    });
    online = true;
    posts = 0;
    await drainOutbox();
    expect(posts).toBe(0);
    expect(requesterWindow().peek(PEER, 'q2', 'book_table')).toBe(false);
  });

  it('TT-08: a retry inside the TTL keeps the first created_time, and opens only what is left', async () => {
    let seen: { created_time?: number } = {};
    setWSDeliverFn((_d, _p, m) => {
      seen = m as { created_time?: number };
      return true;
    });
    const created = Date.now() - 200_000;
    enqueueD2D({
      id: 'd2d-inttl',
      targetDID: PEER,
      messageType: 'service.query',
      bodyJson: queryBody(300),
      now: created,
    });
    const open = jest.spyOn(requesterWindow(), 'open');
    await drainOutbox();
    expect(seen.created_time).toBe(created);
    const ttlMs = open.mock.calls[0]![3];
    expect(ttlMs).toBeGreaterThan(90_000); // 300 - 200 = 100 s were left
    expect(ttlMs).toBeLessThanOrEqual(101_000);
  });

  it('TT-08: a first send stamps the time it leaves', async () => {
    let seen: { created_time?: number } = {};
    setWSDeliverFn((_d, _p, m) => {
      seen = m as { created_time?: number };
      return true;
    });
    const before = Date.now();
    await sendD2D({
      recipientDID: PEER,
      messageType: 'service.response',
      body: JSON.stringify({ query_id: 'none', capability: 'c', status: 'success', ttl_seconds: 60, result: {} }),
      senderDID: ME,
      senderPrivateKey: me,
      recipientPublicKey: peerPub,
      endpoint: ENDPOINT,
      suppressEnqueue: true,
    });
    expect(seen.created_time).toBeGreaterThanOrEqual(before);
  });

  it('TT-08: the provider refuses a query older than its own TTL, and takes one inside it', () => {
    const query = (id: string, age: number) =>
      sealMessage(
        {
          id,
          type: 'service.query',
          from: SENDER_DID,
          to: NODE_DID,
          created_time: Date.now() - age,
          body: JSON.stringify({ query_id: id, capability: 'eta_query', params: { location: { lat: 1, lng: 2 } }, ttl_seconds: 60 }),
        },
        senderKey,
        nodePub,
      );
    const options = { isCapabilityConfigured: () => true };
    const old = receiveD2D(query('old', 3 * 3_600_000), nodePub, nodeKey, [senderPub], 'unknown', options);
    expect(old.action).toBe('dropped');
    expect(old.reason).toMatch(/ttl/);
    const fresh = receiveD2D(query('fresh', 30_000), nodePub, nodeKey, [senderPub], 'unknown', options);
    expect(fresh.action).toBe('bypassed');
  });

  it('TT-08: the commerce lane keeps its longer life at both ends', async () => {
    const capability = 'com.dinakernel.commerce.request_quote';
    const body = JSON.stringify({ query_id: 'po-1', capability, params: {}, ttl_seconds: 60 });
    const r = await firstSend(body);
    expect(r.queued).toBe(true);
    const row = getOutboxRow(r.messageId)!;
    expect(row.expiresAt! - row.createdAt).toBe(24 * 3_600_000);
    const sealed = sealMessage(
      { id: 'late', type: 'service.query', from: SENDER_DID, to: NODE_DID, created_time: Date.now() - 3 * 3_600_000, body },
      senderKey,
      nodePub,
    );
    const late = receiveD2D(sealed, nodePub, nodeKey, [senderPub], 'unknown', {
      isCapabilityConfigured: () => true,
    });
    expect(late.action).toBe('bypassed');
  });

  it('TT-12: a queued response still leaves after a restart lost its window, while its TTL lasts', async () => {
    setProviderWindow(PEER, 'q1', 'eta', 300);
    const r = await sendD2D({
      recipientDID: PEER,
      messageType: 'service.response',
      body: JSON.stringify({ query_id: 'q1', capability: 'eta', status: 'success', ttl_seconds: 300, result: { eta: 5 } }),
      senderDID: ME,
      senderPrivateKey: me,
      recipientPublicKey: peerPub,
      endpoint: ENDPOINT,
    });
    expect(r.queued).toBe(true);
    resetServiceWindows(); // restart
    online = true;
    posts = 0;
    expect((await drainOutbox()).delivered).toBe(1);
    expect(posts).toBe(1);
    expect(getOutboxRow(r.messageId)?.state).toBe('sent');
  });

  it('TT-12: a first send with no window is still refused', async () => {
    const r = await sendD2D({
      recipientDID: PEER,
      messageType: 'service.response',
      body: JSON.stringify({ query_id: 'nope', capability: 'eta', status: 'success', ttl_seconds: 300, result: {} }),
      senderDID: ME,
      senderPrivateKey: me,
      recipientPublicKey: peerPub,
      endpoint: ENDPOINT,
    });
    expect(r.sent).toBe(false);
    expect(r.deniedAt).toBe('service_bypass');
    expect(outboxCount()).toBe(0);
  });
});

describe('TT-11: a pairing answer lost with the socket', () => {
  afterEach(() => {
    clearPairingState();
    resetDeviceRegistry();
    setDeviceRepository(null);
  });

  function setup() {
    setNodeDID(NODE_DID);
    setDeviceRepository({
      register: async () => undefined,
      revoke: async () => true,
      list: async () => [],
    } as never);
    const router = new CoreRouter();
    registerPairRoutes(router);
    const agentKey = new Uint8Array(randomBytes(32));
    const agentPub = getPublicKey(agentKey);
    const agentDid = deriveDIDKey(agentPub);
    const multibase = publicKeyToMultibase(agentPub);
    const { code } = generatePairingCode({ deviceName: 'agent', role: 'agent', scope: 'runner' });
    const env = (id: string, c = code, mb = multibase, from = agentDid) => {
      const inner = {
        method: 'POST',
        path: '/v1/pair/complete',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c, public_key_multibase: mb }),
      };
      const ct = sealEncrypt(new TextEncoder().encode(JSON.stringify(inner)), nodePub);
      return {
        type: 'rpc',
        direction: 'request',
        id,
        from_did: from,
        to_did: NODE_DID,
        ciphertext: btoa(String.fromCharCode(...ct)),
      };
    };
    const decode = (s: FakeWS) => {
      const frames = s.rpc();
      const last = frames[frames.length - 1];
      const dec = sealDecryptWithScheme(
        Uint8Array.from(atob(last.ciphertext!), (c) => c.charCodeAt(0)),
        agentPub,
        agentKey,
      );
      return JSON.parse(new TextDecoder().decode(dec.plaintext)) as { status: number; body: string };
    };
    return { router, env, decode, agentDid, code };
  }

  it('the same key retrying with the same code gets the original 201', async () => {
    const { router, env, decode, agentDid } = setup();
    const s = await boot(async () => ({ keys: [], trust: 'unknown' }), router);
    send(s, env('rpc-1'));
    s.readyState = 3;
    await sleep(2500); // past the send budget; the answer is gone
    expect(getDeviceByDID(agentDid)?.revoked).toBe(false);
    expect(s.rpc()).toHaveLength(0);

    wakeRelay();
    const s2 = authed();
    send(s2, env('rpc-2'));
    await sleep(100);
    const answer = decode(s2);
    expect(answer.status).toBe(201);
    expect(JSON.parse(answer.body).device_id).toBe(getDeviceByDID(agentDid)?.deviceId);
  });

  it('another key is still refused, and a revoked device gets no answer', async () => {
    const { router, env, decode, agentDid } = setup();
    const s = await boot(async () => ({ keys: [], trust: 'unknown' }), router);
    send(s, env('rpc-1'));
    await sleep(100);
    expect(decode(s).status).toBe(201);

    revokeDevice(getDeviceByDID(agentDid)!.deviceId);
    send(s, env('rpc-3'));
    await sleep(100);
    expect(decode(s).status).toBe(400);
  });
});
