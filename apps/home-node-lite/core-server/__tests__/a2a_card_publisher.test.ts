/**
 * The A2A card publisher (design §8.2, M5) against an in-memory PDS that
 * enforces `swapCommit` and `swapRecord` the way the real one does. The
 * describes follow §8.2's vector lists: the fencing ceremony, the predicate
 * and the restoring of each input, handoffs, a fence landing between the
 * reads and the write, the durable attempt CAS, keys, the projection, and
 * consent. Every test asserts what the repository holds, not only the row.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_CARD_COLLECTION,
  A2A_FENCE_COLLECTION,
  A2A_LIMITS,
  DINA_A2A_EXTENSION_URI,
  base64Decode,
  canonicalize,
  cardStringHash,
  readCardRecordFacts,
  readCardRecordText,
  signFence,
  verifyDirectoryEnvelope,
  verifyFence,
  type AgentCard,
  type JsonValue,
} from '@dina/a2a';
import {
  A2AStore,
  DIRECTORY_FRESHNESS_CADENCE_MS,
  IDENTITY_MIGRATIONS,
  SQLiteServiceConfigRepository,
  applyMigrations,
  getPublicKey,
  readPublication,
  recordStandDown,
  setDirectoryListing,
  sign,
  verify,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2ACardPublisher, PUBLISH_RETRY_DELAYS_MS, cardKeyCheck, type CardRepoClient } from '../src/appview/a2a_card_publisher';

const NODE = 'did:plc:nodeaaaaaaaaaaaaaaaaaaaa';

class LostSwap extends Error {}

/** One repository: records, a head that moves on every write, and the PDS's two preconditions. */
class FakeRepo implements CardRepoClient {
  records = new Map<string, { cid: string; value: Record<string, unknown> }>();
  head = 'c0';
  private seq = 0;
  reachable = true;
  sessionAs = NODE;
  writes: string[] = [];
  reads = 0;
  /** Runs once, before the next write is judged: another server, an unrelated write, or a held request. */
  beforeWrite: (() => void | Promise<void>) | null = null;
  /** Runs once, after the next write landed and before it answers: a lost answer, a crash, a held reply. */
  afterLand: (() => void | Promise<void>) | null = null;
  /** The next write never lands, and its answer is as ambiguous as a lost one. */
  dropNextWrite = false;

  private key = (col: string, rkey: string) => `${col}/${rkey}`;
  private move(): void {
    this.seq += 1;
    this.head = `c${this.seq}`;
  }
  private check(): void {
    if (!this.reachable) throw new Error('ECONNREFUSED');
  }
  private async before(): Promise<void> {
    const hook = this.beforeWrite;
    this.beforeWrite = null;
    await hook?.();
    this.check();
    if (this.dropNextWrite) {
      this.dropNextWrite = false;
      throw new Error('socket hang up');
    }
  }
  private async after(): Promise<void> {
    const hook = this.afterLand;
    this.afterLand = null;
    await hook?.();
  }
  /** Another writer: lands with no precondition, moving the head. */
  writeDirect(col: string, value: Record<string, unknown>): void {
    this.move();
    this.records.set(this.key(col, 'self'), { cid: `r${this.seq}`, value: { $type: col, ...value } });
  }
  async sessionDid(): Promise<string> {
    this.check();
    return this.sessionAs;
  }
  async getLatestCommit(): Promise<{ cid: string; rev: string }> {
    this.check();
    this.reads += 1;
    return { cid: this.head, rev: `rev${this.seq}` };
  }
  async getRecord(col: string, rkey: string) {
    this.check();
    this.reads += 1;
    const r = this.records.get(this.key(col, rkey));
    return r === undefined ? null : { uri: `at://${NODE}/${col}/${rkey}`, cid: r.cid, value: structuredClone(r.value) };
  }
  async putRecord(col: string, rkey: string, record: Record<string, unknown>, options: { swapCommit: string; swapRecord?: string | null }) {
    this.check();
    await this.before();
    if (options.swapCommit !== this.head) throw new LostSwap('head moved');
    const current = this.records.get(this.key(col, rkey))?.cid ?? null;
    if ('swapRecord' in options && options.swapRecord !== current) throw new LostSwap('record moved');
    this.move();
    const cid = `r${this.seq}`;
    this.records.set(this.key(col, rkey), { cid, value: structuredClone(record) });
    this.writes.push(`put ${col}`);
    await this.after();
    return { uri: `at://${NODE}/${col}/${rkey}`, cid };
  }
  async deleteRecord(col: string, rkey: string, options: { swapCommit: string }) {
    this.check();
    await this.before();
    if (options.swapCommit !== this.head) throw new LostSwap('head moved');
    this.move();
    this.records.delete(this.key(col, rkey));
    this.writes.push(`delete ${col}`);
    await this.after();
  }
  card() {
    return this.records.get(this.key(A2A_CARD_COLLECTION, 'self'))?.value ?? null;
  }
  fence() {
    return this.records.get(this.key(A2A_FENCE_COLLECTION, 'self'))?.value ?? null;
  }
  cardWrites() {
    return this.writes.filter((w) => w.endsWith(A2A_CARD_COLLECTION)).length;
  }
}

const SKILL = (id: string) => ({ id, name: id, description: `${id}.`, tags: ['transit'] });
const CARD = (name = 'Bus 42', skills = ['eta_query']): AgentCard =>
  ({
    name,
    description: 'Arrival times.',
    supportedInterfaces: [{ url: 'https://dina.example/a2a/v1', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    version: '1.0.0',
    // A card the directory would take: the Dina extension names the node's own DID.
    capabilities: { streaming: true, extensions: [{ uri: DINA_A2A_EXTENSION_URI, params: { did: NODE } }] },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: skills.map(SKILL),
  }) as unknown as AgentCard;

let dir: string;
let clock: number;
let repo: FakeRepo;
let instances: number;

interface Node {
  db: NodeSQLiteAdapter;
  store: A2AStore;
  publisher: A2ACardPublisher;
  key: Uint8Array;
  card: AgentCard | null;
  gateway: boolean;
  keyReady: boolean;
  /** Runs once, while the card is being built (after the publisher read its row). */
  onBuild: (() => void) | null;
  logs: Record<string, unknown>[];
}
const nodes: Node[] = [];

const KEY_A = new Uint8Array(32).fill(7);
const keyIdOf = (key: Uint8Array) => Buffer.from(getPublicKey(key)).toString('hex');

function publisherFor(n: Node): A2ACardPublisher {
  return new A2ACardPublisher({
    store: n.store,
    repo,
    nodeDid: NODE,
    buildCard: async () => {
      const card = n.card;
      const hook = n.onBuild;
      n.onBuild = null;
      hook?.();
      return card === null ? { ok: false, reason: 'no_projectable_skills' } : { ok: true, card };
    },
    gatewayLive: () => n.gateway,
    sign: (m) => sign(n.key, m),
    verify: (m, s) => verify(getPublicKey(n.key), m, s),
    signingKeyId: () => keyIdOf(n.key),
    cardKeyReady: async () => n.keyReady,
    sha256: (b) => sha256(b),
    isLostSwap: (e) => e instanceof LostSwap,
    newInstance: () => {
      instances += 1;
      return `00000000-0000-4000-8000-${String(instances).padStart(12, '0')}`;
    },
    now: () => clock,
    log: (e) => n.logs.push(e),
    setTimeout: () => null,
    clearTimeout: () => undefined,
  });
}

/** One node over the shared repository: its own database, its own instance, the node's signing key. */
function node(key = KEY_A): Node {
  const db = new NodeSQLiteAdapter({
    path: path.join(dir, `identity-${nodes.length}.sqlite`),
    passphraseHex: '12'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  const n: Node = {
    db,
    store: new A2AStore(db),
    key,
    card: CARD(),
    gateway: true,
    keyReady: true,
    onBuild: null,
    logs: [],
    publisher: undefined as unknown as A2ACardPublisher,
  };
  // Started as boot starts it (its first step finds no row and does nothing).
  n.publisher = publisherFor(n);
  n.publisher.start();
  nodes.push(n);
  return n;
}

/** A process restart: a new publisher over the same database, started; its first step runs at once. */
const restart = (n: Node) => {
  n.publisher = publisherFor(n);
  n.publisher.start();
};

const rowOf = (n: Node) => {
  const r = readPublication(n.store);
  if (r === null) throw new Error('no publication');
  return r;
};
const step = async (n: Node) => {
  n.publisher.nudge();
  await n.publisher.flush();
};
const newId = () => `00000000-0000-4000-8000-${String(++instances).padStart(12, '0')}`;
const listOn = (n: Node) => setDirectoryListing(n.store, true, clock, newId);
const listOff = (n: Node) => setDirectoryListing(n.store, false, clock, newId);
/** A real listing write: the projection triggers bump the revision in its own transaction. */
const touchListing = async (n: Node, rkey = 'svc') => new SQLiteServiceConfigRepository(n.db).put(rkey, '{}', clock);
const nameInRepo = () => {
  const card = repo.card();
  return card === null ? null : (JSON.parse(card.card as string) as { name: string }).name;
};
const skillsInRepo = () => repo.card()?.skills as string[] | undefined;
const envelopeInRepo = () => repo.card()?.directory_envelope as Record<string, unknown> & { freshness_epoch: number; publisher_epoch: number; publisher_instance: string };
const envelopeVerifiesUnder = (key: Uint8Array) => {
  const record = repo.card();
  if (record === null) return false;
  return verifyDirectoryEnvelope(
    record.directory_envelope,
    { repoDid: NODE, collection: A2A_CARD_COLLECTION, rkey: 'self', cardText: record.card as string },
    (b) => sha256(b),
    (m, s) => verify(getPublicKey(key), m, s),
  ).ok;
};
const fenceVerifiesUnder = (key: Uint8Array) => {
  const { $type: _t, ...fence } = repo.fence() ?? {};
  return verifyFence(fence, NODE, (m, s) => verify(getPublicKey(key), m, s)).ok;
};
/** A promise and the function that settles it: a request held open. */
function held(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
/** Run until a held request is reached. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'a2a-publisher-'));
  clock = 1_800_000_000_000;
  repo = new FakeRepo();
  instances = 0;
});
afterEach(() => {
  for (const n of nodes.splice(0)) n.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A node switched on, activated, and published: the common start. */
async function activeNode(key = KEY_A): Promise<Node> {
  const n = node(key);
  listOn(n);
  expect((await n.publisher.activate({ refence: false })).ok).toBe(true);
  await n.publisher.flush();
  return n;
}

describe('activation: the fencing ceremony', () => {
  // Cold audit C4-6: with no gateway there is no card, so nothing to fence
  it('a node with no gateway: not_configured, with nothing read or written and nothing active', async () => {
    const n = node();
    n.gateway = false;
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: false, reason: 'not_configured' });
    expect([repo.reads, repo.writes]).toEqual([0, []]);
    expect(repo.fence()).toBeNull();
    expect(readPublication(n.store)?.publication_active ?? 0).toBe(0);
  });

  it('a fresh repository: epoch 1, a fence this node signed, publication active', async () => {
    const n = node();
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 1 });
    expect(repo.fence()).toEqual(expect.objectContaining({ did: NODE, publisher_epoch: 1, publisher_instance: rowOf(n).publisher_instance }));
    expect(fenceVerifiesUnder(n.key)).toBe(true);
    expect(rowOf(n)).toEqual(expect.objectContaining({ publication_active: 1, publisher_epoch: 1, fence_key_id: keyIdOf(n.key) }));
  });

  it('overlapping servers: the new one claims a greater epoch and publishes; the old one stands down when it next writes', async () => {
    const a = await activeNode();
    const b = node();
    listOn(b);
    expect(await b.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 2 });
    await b.publisher.flush();
    expect(envelopeInRepo()).toEqual(expect.objectContaining({ publisher_epoch: 2, publisher_instance: rowOf(b).publisher_instance }));
    a.card = CARD('Bus 99');
    await touchListing(a);
    await step(a);
    expect(rowOf(a)).toEqual(expect.objectContaining({ state: 'stood_down', publication_active: 0, notice: 'another_server_publishing' }));
    expect(nameInRepo()).toBe('Bus 42');
    expect(envelopeInRepo().publisher_instance).toBe(rowOf(b).publisher_instance);
  });

  it('a fence it cannot verify is replaced only on the owner’s word, above the epoch it claims', async () => {
    const stranger = new Uint8Array(32).fill(99);
    const fence = await signFence({ did: NODE, publisher_epoch: 9, publisher_instance: '00000000-0000-4000-8000-999999999999' }, (m) => sign(stranger, m));
    repo.writeDirect(A2A_FENCE_COLLECTION, fence as unknown as Record<string, unknown>);
    const n = node();
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: false, reason: 'fence_unverifiable' });
    expect(await n.publisher.activate({ refence: true })).toEqual({ ok: true, epoch: 10 });
  });

  it('another server’s fence landing during the ceremony loses this one the race; an unrelated write only restarts it', async () => {
    const n = node();
    repo.beforeWrite = () => repo.writeDirect('com.example.other', { x: 1 });
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 1 });
    const m = node();
    repo.beforeWrite = () => repo.writeDirect(A2A_FENCE_COLLECTION, { stolen: true });
    expect(await m.publisher.activate({ refence: false })).toEqual({ ok: false, reason: 'lost_race' });
    expect(rowOf(m).publication_active).toBe(0);
  });

  it('a restored node with an eligible card writes nothing until the owner activates it', async () => {
    await activeNode();
    const restored = node();
    listOn(restored);
    await step(restored);
    expect(rowOf(restored).publication_active).toBe(0);
    expect(repo.cardWrites()).toBe(1);
    // Stopped, it takes no further step, nudged or not.
    await restored.publisher.stop();
    restored.publisher.nudge();
    await restored.publisher.flush();
    expect(repo.cardWrites()).toBe(1);
  });

  it('two restores from one backup: the later activation holds; the earlier stands down at its next write', async () => {
    const a = await activeNode();
    const r1 = node();
    const r2 = node();
    listOn(r1);
    listOn(r2);
    expect(await r1.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 2 });
    await r1.publisher.flush();
    expect(await r2.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 3 });
    await r2.publisher.flush();
    expect(envelopeInRepo().publisher_instance).toBe(rowOf(r2).publisher_instance);
    for (const old of [a, r1]) {
      old.card = CARD('Bus 1');
      await touchListing(old);
      await step(old);
      expect(rowOf(old).state).toBe('stood_down');
    }
    expect(envelopeInRepo().publisher_instance).toBe(rowOf(r2).publisher_instance);
    expect(nameInRepo()).toBe('Bus 42');
  });

  it('boot before handoff: the new server runs, writes nothing until activated, then takes over', async () => {
    const a = await activeNode();
    const b = node();
    await step(b);
    listOn(b);
    await step(b);
    expect(repo.writes).toEqual([`put ${A2A_FENCE_COLLECTION}`, `put ${A2A_CARD_COLLECTION}`]);
    expect((await b.publisher.activate({ refence: false })).ok).toBe(true);
    await b.publisher.flush();
    expect(envelopeInRepo().publisher_instance).toBe(rowOf(b).publisher_instance);
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await step(a);
    expect(rowOf(a).state).toBe('stood_down');
  });
});

describe('the predicate: each input, and restoring it', () => {
  it('gateway disabled: the card goes; restored: it comes back', async () => {
    const n = await activeNode();
    n.gateway = false;
    await step(n);
    expect(repo.card()).toBeNull();
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', card_maybe_present: 0, last_published_cid: null }));
    n.gateway = true;
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
  });

  it('the final skill removed: the card goes; restored: it comes back', async () => {
    const n = await activeNode();
    n.card = null;
    await touchListing(n);
    await step(n);
    expect(repo.card()).toBeNull();
    n.card = CARD();
    await touchListing(n);
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
  });

  it('a runner binding revoked (no revision bump): the next tick publishes without the skill, then without the card; restored, back', async () => {
    const n = node();
    n.card = CARD('Bus 42', ['eta_query', 'route_status']);
    listOn(n);
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    expect(skillsInRepo()).toEqual(['eta_query', 'route_status']);
    // A device revocation drops a runner: the card changes though no revision moved.
    n.card = CARD('Bus 42', ['eta_query']);
    await step(n);
    expect(skillsInRepo()).toEqual(['eta_query']);
    n.card = null;
    await step(n);
    expect(repo.card()).toBeNull();
    n.card = CARD('Bus 42', ['eta_query', 'route_status']);
    await step(n);
    expect(skillsInRepo()).toEqual(['eta_query', 'route_status']);
  });

  it('the switch turned off: the card goes, and the intent survives a failure and a restart', async () => {
    const n = await activeNode();
    listOff(n);
    repo.reachable = false;
    await step(n);
    expect(rowOf(n).card_maybe_present).toBe(1);
    repo.reachable = true;
    restart(n);
    await step(n);
    expect(repo.card()).toBeNull();
    expect(rowOf(n).card_maybe_present).toBe(0);
  });

  it('the endpoint is the JSON-RPC interface’s wherever it is listed; a card with none is not publishable', async () => {
    const n = node();
    const rest = { url: 'https://dina.example/a2a/rest', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' };
    n.card = { ...CARD(), supportedInterfaces: [rest, ...CARD().supportedInterfaces] } as unknown as AgentCard;
    listOn(n);
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    expect(repo.card()?.endpoint).toBe('https://dina.example/a2a/v1');
    n.card = { ...CARD(), supportedInterfaces: [rest] } as unknown as AgentCard;
    await step(n);
    expect(repo.card()).toBeNull();
  });

  it('a card over the directory’s cap is not publishable: none goes out, and one already there is taken down', async () => {
    const n = await activeNode();
    expect(nameInRepo()).toBe('Bus 42');
    n.card = { ...CARD(), description: 'x'.repeat(A2A_LIMITS.maxCardBytes) } as unknown as AgentCard;
    await touchListing(n);
    await step(n);
    expect(repo.card()).toBeNull();
    expect(rowOf(n).state).toBe('not_published');
  });

  it('no card goes out before the DID document names the card key', async () => {
    const n = node();
    n.keyReady = false;
    listOn(n);
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    expect(repo.card()).toBeNull();
    n.keyReady = true;
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
  });

  it('a stand-down during in-flight I/O: the write lands, its completion does not, and nothing more is written', async () => {
    const n = await activeNode();
    n.card = CARD('Bus 61');
    await touchListing(n);
    repo.beforeWrite = () => {
      recordStandDown(n.store, 'another_server_publishing', clock, rowOf(n).fencing_generation);
    };
    const published = rowOf(n).last_published_card_hash;
    await step(n);
    expect(nameInRepo()).toBe('Bus 61');
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'stood_down', last_published_card_hash: published }));
    const writes = repo.writes.length;
    n.card = CARD('Bus 62');
    await touchListing(n);
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await step(n);
    expect(repo.writes.length).toBe(writes);
  });

  it('a late completion after deactivation began writes nothing; the deactivation then removes the card', async () => {
    const n = await activeNode();
    n.card = CARD('Bus 60');
    await touchListing(n);
    // The owner deactivates while the write is on its way.
    repo.beforeWrite = () => {
      void n.publisher.deactivate();
    };
    await step(n);
    await n.publisher.flush();
    expect(repo.card()).toBeNull();
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', publication_active: 0, card_maybe_present: 0 }));
    expect(repo.writes.slice(-2)).toEqual([`put ${A2A_CARD_COLLECTION}`, `delete ${A2A_CARD_COLLECTION}`]);
  });
});

describe('handoffs', () => {
  it('predicate false on the new server: it deletes the card the old one left, and the old one stands down', async () => {
    const a = await activeNode();
    const b = node(); // switched off
    expect(await b.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 2 });
    await b.publisher.flush();
    expect(repo.card()).toBeNull();
    expect(rowOf(b)).toEqual(expect.objectContaining({ state: 'not_published', card_maybe_present: 0 }));
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await step(a);
    expect(rowOf(a).state).toBe('stood_down');
    expect(repo.card()).toBeNull();
  });

  it('an absent card (fence present, card unpublished): the new server reads, finds none, and writes only its fence', async () => {
    const a = await activeNode();
    expect(await a.publisher.deactivate()).toEqual({ ok: true });
    expect(repo.card()).toBeNull();
    const writes = repo.writes.length;
    const b = node();
    await b.publisher.activate({ refence: false });
    await b.publisher.flush();
    expect(repo.writes.slice(writes)).toEqual([`put ${A2A_FENCE_COLLECTION}`]);
    expect(rowOf(b).card_maybe_present).toBe(0);
    listOn(b);
    await step(b);
    expect(envelopeInRepo().publisher_instance).toBe(rowOf(b).publisher_instance);
  });

  it('the old node’s unpublish after a handoff stands it down and leaves the new holder’s card', async () => {
    const a = await activeNode();
    const b = node();
    b.card = CARD('Bus B');
    listOn(b);
    await b.publisher.activate({ refence: false });
    await b.publisher.flush();
    listOff(a);
    await step(a);
    expect(rowOf(a).state).toBe('stood_down');
    expect(nameInRepo()).toBe('Bus B');
  });

  it('a delayed old-node retry stands down; the new holder’s card stays', async () => {
    const a = node();
    listOn(a);
    a.keyReady = false; // holds the card back until the fence is in
    expect(await a.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 1 });
    await a.publisher.flush();
    a.keyReady = true;
    repo.dropNextWrite = true;
    await step(a);
    expect(rowOf(a).state).toBe('failed');
    const b = node();
    b.card = CARD('Bus B');
    listOn(b);
    await b.publisher.activate({ refence: false });
    await b.publisher.flush();
    clock += PUBLISH_RETRY_DELAYS_MS[1];
    await step(a);
    expect(rowOf(a).state).toBe('stood_down');
    expect(nameInRepo()).toBe('Bus B');
  });

  it('A → B → A: a stood-down server comes back only by activating again, standing the other down', async () => {
    const a = await activeNode();
    const b = node();
    b.card = CARD('Bus B');
    listOn(b);
    expect((await b.publisher.activate({ refence: false })).ok).toBe(true);
    await b.publisher.flush();
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await step(a);
    expect(rowOf(a).state).toBe('stood_down');
    expect(await a.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 3 });
    await a.publisher.flush();
    expect(nameInRepo()).toBe('Bus 42');
    expect(envelopeInRepo()).toEqual(expect.objectContaining({ publisher_epoch: 3, publisher_instance: rowOf(a).publisher_instance }));
    b.card = CARD('Bus B2');
    await touchListing(b);
    await step(b);
    expect(rowOf(b).state).toBe('stood_down');
    expect(nameInRepo()).toBe('Bus 42');
  });

  it('an ambiguous timeout over our own older record: not taken for success; the retry publishes', async () => {
    const n = await activeNode();
    n.card = CARD('Bus 50');
    await touchListing(n);
    repo.dropNextWrite = true;
    await step(n);
    expect(rowOf(n).state).toBe('failed');
    expect(nameInRepo()).toBe('Bus 42');
    clock += PUBLISH_RETRY_DELAYS_MS[0];
    await step(n);
    expect(nameInRepo()).toBe('Bus 50');
    expect(rowOf(n).state).toBe('published');
  });

  it('a newer cadence record of ours during recovery: some other write, so the current desired state runs again', async () => {
    const n = await activeNode();
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    // Between the reads and the write, the same card lands with another freshness epoch.
    repo.beforeWrite = () => {
      const record = structuredClone(repo.card() ?? {});
      (record.directory_envelope as { freshness_epoch: number }).freshness_epoch = 7;
      repo.writeDirect(A2A_CARD_COLLECTION, record);
    };
    await step(n);
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', freshness_epoch: 0 }));
    clock += PUBLISH_RETRY_DELAYS_MS[0];
    await step(n);
    expect(envelopeInRepo().freshness_epoch).toBe(1);
    expect(envelopeVerifiesUnder(n.key)).toBe(true);
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'published', freshness_epoch: 1 }));
  });

  it('an ambiguous delete: gone means done; still there means retry', async () => {
    const n = await activeNode();
    listOff(n);
    repo.dropNextWrite = true;
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', card_maybe_present: 1 }));
    repo.afterLand = () => {
      throw new Error('socket hang up');
    };
    clock += PUBLISH_RETRY_DELAYS_MS[1];
    await step(n);
    expect(repo.card()).toBeNull();
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', card_maybe_present: 0 }));
  });
});

describe('a fence landing between the reads and the write', () => {
  it('a publish with no card yet: nothing is written, and the node stands down', async () => {
    const n = node();
    listOn(n);
    await n.publisher.activate({ refence: false });
    repo.beforeWrite = () => repo.writeDirect(A2A_FENCE_COLLECTION, { epoch: 'theirs' });
    await n.publisher.flush();
    expect(repo.card()).toBeNull();
    clock += PUBLISH_RETRY_DELAYS_MS[0];
    await step(n);
    expect(rowOf(n).state).toBe('stood_down');
    expect(repo.card()).toBeNull();
  });

  it('a delete: it fails, the card is the new holder’s to answer for, and the node stands down', async () => {
    const n = await activeNode();
    listOff(n);
    repo.beforeWrite = () => repo.writeDirect(A2A_FENCE_COLLECTION, { epoch: 'theirs' });
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
    clock += PUBLISH_RETRY_DELAYS_MS[0];
    await step(n);
    expect(rowOf(n).state).toBe('stood_down');
    expect(nameInRepo()).toBe('Bus 42');
  });

  it('an unrelated write: the swap is lost, retried soon, then lands', async () => {
    const n = node();
    listOn(n);
    await n.publisher.activate({ refence: false });
    repo.beforeWrite = () => repo.writeDirect('com.example.other', { y: 1 });
    await n.publisher.flush();
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', attempts: 1, next_retry_at: clock + PUBLISH_RETRY_DELAYS_MS[0] }));
    clock += PUBLISH_RETRY_DELAYS_MS[0];
    await step(n);
    expect(rowOf(n).state).toBe('published');
    expect(nameInRepo()).toBe('Bus 42');
  });

  it('a lost swap over an older card is not taken for success: only the record attempted counts', async () => {
    const n = await activeNode();
    const older = rowOf(n).last_published_card_hash;
    n.card = CARD('Bus 70');
    await touchListing(n);
    repo.beforeWrite = () => repo.writeDirect('com.example.other', { z: 1 });
    await step(n);
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', last_published_card_hash: older }));
    expect(nameInRepo()).toBe('Bus 42');
    clock += PUBLISH_RETRY_DELAYS_MS[0];
    await step(n);
    expect(nameInRepo()).toBe('Bus 70');
    expect(rowOf(n).state).toBe('published');
  });
});

describe('the durable attempt', () => {
  it('cadence against a config change: the refresh lands, then the new card follows', async () => {
    const n = await activeNode();
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    repo.beforeWrite = async () => {
      n.card = CARD('Bus 80');
      await touchListing(n);
    };
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
    await step(n);
    expect(nameInRepo()).toBe('Bus 80');
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'published', published_revision: rowOf(n).card_projection_revision }));
  });

  it('cadence against the switch turned off: the refresh lands, then the card goes', async () => {
    const n = await activeNode();
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    repo.beforeWrite = () => {
      listOff(n);
    };
    await step(n);
    await step(n);
    expect(repo.card()).toBeNull();
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'not_published', card_maybe_present: 0 }));
  });

  it('a late success (a restart while an answer was held) writes nothing over the newer publish', async () => {
    const n = await activeNode();
    const old = n.publisher;
    n.card = CARD('Bus 81');
    await touchListing(n);
    const answer = held();
    repo.afterLand = () => answer.wait;
    old.nudge();
    await tick();
    expect(nameInRepo()).toBe('Bus 81');
    // The process restarts; the new one publishes a newer card.
    restart(n);
    n.card = CARD('Bus 82');
    await touchListing(n);
    await step(n);
    expect(nameInRepo()).toBe('Bus 82');
    answer.release();
    await old.flush();
    expect(nameInRepo()).toBe('Bus 82');
    expect(rowOf(n)).toEqual(
      expect.objectContaining({
        state: 'published',
        published_revision: rowOf(n).card_projection_revision,
        last_published_card_hash: cardStringHash(canonicalize(CARD('Bus 82') as unknown as JsonValue), (b) => sha256(b)),
      }),
    );
  });

  it('a late failure (a request held while a newer publish lands) changes nothing', async () => {
    const n = await activeNode();
    const old = n.publisher;
    n.card = CARD('Bus 83');
    await touchListing(n);
    const request = held();
    repo.beforeWrite = () => request.wait;
    old.nudge();
    await tick();
    // The process restarts; the new one publishes a newer card while the old request hangs.
    restart(n);
    n.card = CARD('Bus 84');
    await touchListing(n);
    await step(n);
    expect(nameInRepo()).toBe('Bus 84');
    // The old request fails at last (its swap is lost, the record there is not its own): nothing changes.
    request.release();
    await old.flush();
    expect(old).not.toBe(n.publisher);
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'published', attempts: 0, next_retry_at: null }));
    expect(nameInRepo()).toBe('Bus 84');
  });

  it('a crash between the PDS’s success and the local record, the read-back failing too: switching off still deletes it', async () => {
    const n = node();
    listOn(n);
    await n.publisher.activate({ refence: false });
    repo.afterLand = () => {
      repo.reachable = false;
      throw new Error('socket hang up');
    };
    await n.publisher.flush();
    expect(nameInRepo()).toBe('Bus 42');
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', last_published_cid: null, card_maybe_present: 1 }));
    repo.reachable = true;
    restart(n);
    listOff(n);
    await step(n);
    expect(repo.card()).toBeNull();
    expect(rowOf(n).card_maybe_present).toBe(0);
  });

  it('after an unpublish, a publish whose answer and read-back are both lost is still deleted when the switch goes off', async () => {
    const n = await activeNode();
    n.gateway = false;
    await step(n);
    expect(rowOf(n).card_maybe_present).toBe(0);
    n.gateway = true;
    repo.afterLand = () => {
      repo.reachable = false;
      throw new Error('socket hang up');
    };
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'failed', last_published_cid: null, card_maybe_present: 1 }));
    repo.reachable = true;
    listOff(n);
    await step(n);
    expect(repo.card()).toBeNull();
  });

  it('restart convergence: a claim left by a process that died is taken over, and the row ends as the repository is', async () => {
    const n = node();
    listOn(n);
    n.keyReady = false;
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    // The first process claims, then dies before its write goes out.
    n.keyReady = true;
    repo.beforeWrite = () => new Promise<void>(() => undefined);
    n.publisher.nudge();
    await tick();
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'pending', card_maybe_present: 1 }));
    expect(rowOf(n).attempt_tuple_json).not.toBeNull();
    restart(n);
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
    expect(rowOf(n)).toEqual(expect.objectContaining({ state: 'published', attempt_tuple_json: null }));
    expect(rowOf(n).last_published_cid).toBe(repo.records.get(`${A2A_CARD_COLLECTION}/self`)?.cid);
  });
});

describe('keys', () => {
  it('a rotation before any refresh: the fence is re-signed, keeping epoch and instance, and the envelope at once', async () => {
    const n = await activeNode();
    const before = repo.fence();
    const freshness = envelopeInRepo().freshness_epoch;
    n.key = new Uint8Array(32).fill(8);
    await step(n);
    const after = repo.fence();
    expect(after).toEqual(expect.objectContaining({ publisher_epoch: before?.publisher_epoch, publisher_instance: before?.publisher_instance }));
    expect(fenceVerifiesUnder(n.key)).toBe(true);
    expect(envelopeVerifiesUnder(n.key)).toBe(true);
    expect(envelopeInRepo().freshness_epoch).toBe(freshness);
    expect(rowOf(n)).toEqual(expect.objectContaining({ fence_key_id: keyIdOf(n.key), published_key_id: keyIdOf(n.key), state: 'published' }));
  });

  it('a rotation on an active node with nothing published still re-signs its fence at once, and writes no card', async () => {
    const n = node(); // switched off: nothing to publish
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    n.key = new Uint8Array(32).fill(8);
    await step(n);
    expect(fenceVerifiesUnder(n.key)).toBe(true);
    expect(repo.card()).toBeNull();
    expect(rowOf(n).fence_key_id).toBe(keyIdOf(n.key));
    // Recorded: the next step reads nothing.
    const reads = repo.reads;
    await step(n);
    expect(repo.reads).toBe(reads);
  });

  it('a re-activation republishes the envelope under the new epoch', async () => {
    const n = await activeNode();
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 2 });
    await n.publisher.flush();
    expect(envelopeInRepo().publisher_epoch).toBe(2);
  });

  it('activation after a rotation whose refresh never ran: refused without the owner’s re-fence; the old key’s node then stands down', async () => {
    const a = await activeNode();
    const rotated = new Uint8Array(32).fill(8);
    const b = node(rotated);
    listOn(b);
    expect(await b.publisher.activate({ refence: false })).toEqual({ ok: false, reason: 'fence_unverifiable' });
    expect(await b.publisher.activate({ refence: true })).toEqual({ ok: true, epoch: 2 });
    await b.publisher.flush();
    a.key = rotated;
    await step(a);
    expect(rowOf(a).state).toBe('stood_down');
    expect(envelopeInRepo().publisher_instance).toBe(rowOf(b).publisher_instance);
  });

  it('a rollback attempt: an older fence of ours written back stops the node, and activation claims above both', async () => {
    const n = await activeNode();
    const old = repo.fence();
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 2 });
    await n.publisher.flush();
    repo.writeDirect(A2A_FENCE_COLLECTION, old ?? {});
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await step(n);
    expect(rowOf(n).state).toBe('stood_down');
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: true, epoch: 3 });
  });

  it('the owner re-activating during a step’s reads: the activation waits for the step, then stands', async () => {
    const n = await activeNode();
    n.card = CARD('Bus 78');
    await touchListing(n);
    // The step's reads are held; the owner re-activates meanwhile (its own fence at epoch 2).
    const reads = held();
    let first = true;
    const realHead = repo.getLatestCommit.bind(repo);
    repo.getLatestCommit = async () => {
      if (first) {
        first = false;
        await reads.wait;
      }
      return realHead();
    };
    n.publisher.nudge();
    await tick();
    const fences = () => repo.writes.filter((w) => w === `put ${A2A_FENCE_COLLECTION}`).length;
    const fencesBefore = fences();
    const activation = n.publisher.activate({ refence: false });
    let settled = false;
    void activation.then(() => (settled = true));
    await tick();
    // It waits its turn: no fence is written while the step is in flight.
    expect(settled).toBe(false);
    expect(fences()).toBe(fencesBefore);
    reads.release();
    expect(await activation).toEqual({ ok: true, epoch: 2 });
    await n.publisher.flush();
    expect(rowOf(n)).toEqual(expect.objectContaining({ publication_active: 1, publisher_epoch: 2, notice: null }));
    expect(rowOf(n).state).not.toBe('stood_down');
    expect(envelopeInRepo()).toEqual(expect.objectContaining({ publisher_epoch: 2 }));
    expect(nameInRepo()).toBe('Bus 78');
  });

  // Cold audit C5-7: no step reads between the fence write and its local record
  it('a step asked for after the PDS commits the activation’s fence, before the activation records it: the node is not stood down', async () => {
    const n = await activeNode();
    // The fence write commits, then its answer is held: the activation is between the two.
    const answer = held();
    const realPut = repo.putRecord.bind(repo);
    let fenceCommitted = false;
    repo.putRecord = async (col, rkey, record, options) => {
      const out = await realPut(col, rkey, record, options);
      if (col === A2A_FENCE_COLLECTION && !fenceCommitted) {
        fenceCommitted = true;
        await answer.wait;
      }
      return out;
    };
    const activation = n.publisher.activate({ refence: false });
    while (!fenceCommitted) await tick();
    // The new fence (epoch 2) is in the repository; the local row still says epoch 1.
    expect(rowOf(n).publisher_epoch).toBe(1);
    const readsBefore = repo.reads;
    n.publisher.nudge();
    await tick();
    // The step waits behind the activation: it has read nothing.
    expect(repo.reads).toBe(readsBefore);
    answer.release();
    expect(await activation).toEqual({ ok: true, epoch: 2 });
    await n.publisher.flush();
    expect(rowOf(n)).toEqual(expect.objectContaining({ publication_active: 1, publisher_epoch: 2, notice: null }));
    expect(rowOf(n).state).not.toBe('stood_down');
    expect(envelopeInRepo()).toEqual(expect.objectContaining({ publisher_epoch: 2 }));
  });

  it('writes nothing when the PDS session is not the node’s DID', async () => {
    const n = node();
    listOn(n);
    repo.sessionAs = 'did:plc:someoneelse0000000000000';
    expect(await n.publisher.activate({ refence: false })).toEqual({ ok: false, reason: 'repo_unreachable' });
    expect(repo.writes).toEqual([]);
  });
});

describe('the projection', () => {
  it('nothing changed: no write, and no read of the repository either', async () => {
    const n = await activeNode();
    const { reads, writes } = { reads: repo.reads, writes: repo.writes.length };
    await step(n);
    await step(n);
    expect(repo.reads).toBe(reads);
    expect(repo.writes.length).toBe(writes);
  });

  it('a change the card does not show is recorded without a write', async () => {
    const n = await activeNode();
    const writes = repo.writes.length;
    await touchListing(n);
    await step(n);
    expect(repo.writes.length).toBe(writes);
    expect(rowOf(n).published_revision).toBe(rowOf(n).card_projection_revision);
  });

  it('a concurrent edit while the card is built: that claim is refused, and the next step publishes the newer card', async () => {
    const n = await activeNode();
    n.card = CARD('Bus 90');
    await touchListing(n);
    n.onBuild = () => {
      n.card = CARD('Bus 91');
      void touchListing(n);
    };
    const writes = repo.cardWrites();
    await step(n);
    expect(repo.cardWrites()).toBe(writes);
    await step(n);
    expect(nameInRepo()).toBe('Bus 91');
  });

  it('a listing deleted: the projection moves and the card goes', async () => {
    const n = await activeNode();
    await touchListing(n, 'only');
    await step(n);
    await new SQLiteServiceConfigRepository(n.db).remove('only');
    n.card = null;
    await step(n);
    expect(repo.card()).toBeNull();
  });
});

describe('consent', () => {
  it('activated with listings but the switch off: nothing is published until the owner switches it on', async () => {
    const n = node();
    await touchListing(n);
    await n.publisher.activate({ refence: false });
    await n.publisher.flush();
    expect(repo.card()).toBeNull();
    listOn(n);
    await step(n);
    expect(nameInRepo()).toBe('Bus 42');
    // The envelope's signature decodes to 64 bytes: a real Ed25519 signature.
    expect(base64Decode((envelopeInRepo() as unknown as { sig: string }).sig)?.length).toBe(64);
    expect(repo.card()?.card).toBe(canonicalize(CARD() as unknown as JsonValue));
    expect(repo.card()).toEqual(
      expect.objectContaining({ $type: A2A_CARD_COLLECTION, endpoint: 'https://dina.example/a2a/v1', protocol_version: '1.0', skills: ['eta_query'] }),
    );
    expect(envelopeVerifiesUnder(n.key)).toBe(true);
    // Cold audit C4-9: the record is one the directory takes, by the rules it holds (shared in @dina/a2a).
    const text = readCardRecordText(repo.card());
    if (!text.ok) throw new Error(`record refused: ${text.reason}`);
    expect(readCardRecordFacts(text.card, text.record, NODE)).toEqual(expect.objectContaining({ ok: true }));
  });
});

describe('cadence', () => {
  it('refreshes every 14 days with a new freshness epoch, the card bytes unchanged', async () => {
    const n = await activeNode();
    const before = repo.card();
    clock += DIRECTORY_FRESHNESS_CADENCE_MS;
    await step(n);
    const after = repo.card();
    expect(after?.card).toBe(before?.card);
    expect(envelopeInRepo().freshness_epoch).toBe(1);
    expect(rowOf(n).freshness_epoch).toBe(1);
  });
});

describe('cardKeyCheck', () => {
  it('true once the key is there, remembered; after a failure, not asked again before the retry delay', async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const key = new Uint8Array(33).fill(2);
    const ready = cardKeyCheck(
      async () => {
        calls += 1;
        if (fail) throw new Error('PLC unreachable');
      },
      () => key,
      () => now,
    );
    expect(await ready()).toBe(false);
    expect(await ready()).toBe(false);
    expect(calls).toBe(1);
    now += PUBLISH_RETRY_DELAYS_MS[0];
    fail = false;
    expect(await ready()).toBe(true);
    expect(await ready()).toBe(true);
    expect(calls).toBe(2);
  });

  it('remembers the key it confirmed, not "ready": a key that changes is put in the document before any card it signs', async () => {
    let now = 0;
    const asked: number[] = [];
    let failFor: number | null = null;
    let current: Uint8Array | null = new Uint8Array(33).fill(2);
    const ready = cardKeyCheck(
      async (key) => {
        asked.push(key[1] ?? -1);
        if (key[1] === failFor) throw new Error('PLC unreachable');
      },
      () => current,
      () => now,
    );
    expect(await ready()).toBe(true);
    expect(asked).toEqual([2]);
    // A new card key: the document is asked for it, and no card goes out until it names it.
    current = new Uint8Array(33).fill(3);
    failFor = 3;
    expect(await ready()).toBe(false);
    expect(asked).toEqual([2, 3]);
    // The new key keeps its own retry delay; the old key's success does not stand in for it.
    expect(await ready()).toBe(false);
    expect(asked).toEqual([2, 3]);
    now += PUBLISH_RETRY_DELAYS_MS[0];
    failFor = null;
    expect(await ready()).toBe(true);
    expect(asked).toEqual([2, 3, 3]);
    // No card can be built: nothing to confirm.
    current = null;
    expect(await ready()).toBe(false);
  });

  it('a new key is asked at once, even while an earlier key waits out its retry delay', async () => {
    const asked: number[] = [];
    let current = new Uint8Array(33).fill(2);
    const ready = cardKeyCheck(
      async (key) => {
        asked.push(key[1] ?? -1);
        if (key[1] === 2) throw new Error('PLC unreachable');
      },
      () => current,
      () => 0,
    );
    expect(await ready()).toBe(false);
    expect(await ready()).toBe(false);
    expect(asked).toEqual([2]);
    current = new Uint8Array(33).fill(3);
    expect(await ready()).toBe(true);
    expect(asked).toEqual([2, 3]);
  });
});
