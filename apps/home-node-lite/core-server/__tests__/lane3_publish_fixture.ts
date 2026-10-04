/**
 * A test world for the Lane 3 card publisher (design §8.2): one in-memory
 * repository that enforces `swapCommit` and `swapRecord` the way a PDS
 * does, and any number of nodes over it, each with its own identity
 * database, publisher instance and `dina_signing` key. Built on the same
 * shape as a2a_card_publisher.test.ts, with a few more hooks: every read
 * can be watched or made to fail, and every write's preconditions are
 * kept, so a test can say what went out and on what terms.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import {
  A2A_CARD_COLLECTION,
  A2A_FENCE_COLLECTION,
  DINA_A2A_EXTENSION_URI,
  signFence,
  verifyDirectoryEnvelope,
  verifyFence,
  type AgentCard,
} from '@dina/a2a';
import {
  A2AStore,
  IDENTITY_MIGRATIONS,
  SQLiteServiceConfigRepository,
  applyMigrations,
  getPublicKey,
  readPublication,
  setDirectoryListing,
  sign,
  verify,
  type PublicationRow,
} from '@dina/core';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2ACardPublisher, type A2ACardPublisherDeps, type CardRepoClient } from '../src/appview/a2a_card_publisher';

export const NODE = 'did:plc:nodeaaaaaaaaaaaaaaaaaaaa';
export const KEY_A = new Uint8Array(32).fill(7);
export const KEY_B = new Uint8Array(32).fill(8);
export const keyIdOf = (key: Uint8Array): string => Buffer.from(getPublicKey(key)).toString('hex');

export class LostSwap extends Error {}

export interface WriteSeen {
  op: 'put' | 'delete';
  collection: string;
  options: { swapCommit: string; swapRecord?: string | null };
}

/** One repository: records, a head that moves on every write, and the PDS's two preconditions. */
export class FakeRepo implements CardRepoClient {
  records = new Map<string, { cid: string; value: Record<string, unknown> }>();
  head = 'c0';
  private seq = 0;
  reachable = true;
  sessionAs = NODE;
  /** Every write that landed, in order: `put <collection>` or `delete <collection>`. */
  writes: string[] = [];
  /** Every write attempted, with the preconditions it carried, landed or not. */
  attempted: WriteSeen[] = [];
  reads = 0;
  headReads = 0;
  /** Runs once, before the next record read: something lands between the head reads. */
  beforeRecordRead: (() => void) | null = null;
  /** Runs before every record read while set. */
  onEveryRecordRead: (() => void) | null = null;
  /** A record read of this collection throws (an expired session, a refusing PDS). */
  failReadsOf: string | null = null;
  /** Runs once, before the next write is judged. */
  beforeWrite: (() => void | Promise<void>) | null = null;
  /** Runs once, after the next write landed and before it answers. */
  afterLand: (() => void | Promise<void>) | null = null;
  /** Watches every card put before it lands. */
  onCardPut: ((record: Record<string, unknown>) => void) | null = null;
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
  /** Another writer removes a record, moving the head. */
  deleteDirect(col: string): void {
    this.move();
    this.records.delete(this.key(col, 'self'));
  }
  async sessionDid(): Promise<string> {
    this.check();
    return this.sessionAs;
  }
  async getLatestCommit(): Promise<{ cid: string; rev: string }> {
    this.check();
    this.reads += 1;
    this.headReads += 1;
    return { cid: this.head, rev: `rev${this.seq}` };
  }
  async getRecord(col: string, rkey: string) {
    this.check();
    const once = this.beforeRecordRead;
    this.beforeRecordRead = null;
    once?.();
    this.onEveryRecordRead?.();
    if (this.failReadsOf === col) throw new Error('ExpiredToken');
    this.reads += 1;
    const r = this.records.get(this.key(col, rkey));
    return r === undefined ? null : { uri: `at://${NODE}/${col}/${rkey}`, cid: r.cid, value: structuredClone(r.value) };
  }
  async putRecord(col: string, rkey: string, record: Record<string, unknown>, options: { swapCommit: string; swapRecord?: string | null }) {
    this.check();
    this.attempted.push({ op: 'put', collection: col, options: { ...options } });
    await this.before();
    if (options.swapCommit !== this.head) throw new LostSwap('head moved');
    const current = this.records.get(this.key(col, rkey))?.cid ?? null;
    if ('swapRecord' in options && options.swapRecord !== current) throw new LostSwap('record moved');
    if (col === A2A_CARD_COLLECTION) this.onCardPut?.(record);
    this.move();
    const cid = `r${this.seq}`;
    this.records.set(this.key(col, rkey), { cid, value: structuredClone(record) });
    this.writes.push(`put ${col}`);
    await this.after();
    return { uri: `at://${NODE}/${col}/${rkey}`, cid };
  }
  async deleteRecord(col: string, rkey: string, options: { swapCommit: string }) {
    this.check();
    this.attempted.push({ op: 'delete', collection: col, options: { ...options } });
    await this.before();
    if (options.swapCommit !== this.head) throw new LostSwap('head moved');
    this.move();
    this.records.delete(this.key(col, rkey));
    this.writes.push(`delete ${col}`);
    await this.after();
  }
  card(): Record<string, unknown> | null {
    return this.records.get(this.key(A2A_CARD_COLLECTION, 'self'))?.value ?? null;
  }
  cardCid(): string | null {
    return this.records.get(this.key(A2A_CARD_COLLECTION, 'self'))?.cid ?? null;
  }
  fence(): Record<string, unknown> | null {
    return this.records.get(this.key(A2A_FENCE_COLLECTION, 'self'))?.value ?? null;
  }
  fenceCid(): string | null {
    return this.records.get(this.key(A2A_FENCE_COLLECTION, 'self'))?.cid ?? null;
  }
  cardWrites(): number {
    return this.writes.filter((w) => w.endsWith(A2A_CARD_COLLECTION)).length;
  }
}

const SKILL = (id: string) => ({ id, name: id, description: `${id}.`, tags: ['transit'] });
export const CARD = (name = 'Bus 42', skills = ['eta_query']): AgentCard =>
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

export interface PubNode {
  db: NodeSQLiteAdapter;
  store: A2AStore;
  publisher: A2ACardPublisher;
  key: Uint8Array;
  card: AgentCard | null;
  /** When set, the card build refuses with this reason. */
  refuse: string | null;
  /** When set, the card build throws. */
  buildThrows: boolean;
  gateway: boolean;
  keyReady: boolean;
  logs: Record<string, unknown>[];
  /** Replaces any dependency for the next publisher this node starts. */
  over: Partial<A2ACardPublisherDeps>;
}

/** A promise and the function that settles it: a request held open. */
export function held(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

/** Let pending callbacks run once. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class PublishWorld {
  readonly dir = mkdtempSync(path.join(tmpdir(), 'lane3-publish-'));
  clock = 1_800_000_000_000;
  readonly repo = new FakeRepo();
  private instances = 0;
  private readonly nodes: PubNode[] = [];

  close(): void {
    for (const n of this.nodes.splice(0)) n.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  newInstance = (): string => {
    this.instances += 1;
    return `00000000-0000-4000-8000-${String(this.instances).padStart(12, '0')}`;
  };

  publisherFor(n: PubNode): A2ACardPublisher {
    return new A2ACardPublisher({
      store: n.store,
      repo: this.repo,
      nodeDid: NODE,
      buildCard: async () => {
        if (n.buildThrows) throw new Error('card build failed');
        if (n.refuse !== null) return { ok: false, reason: n.refuse };
        const card = n.card;
        return card === null ? { ok: false, reason: 'no_projectable_skills' } : { ok: true, card };
      },
      gatewayLive: () => n.gateway,
      sign: (m) => sign(n.key, m),
      verify: (m, s) => verify(getPublicKey(n.key), m, s),
      signingKeyId: () => keyIdOf(n.key),
      cardKeyReady: async () => n.keyReady,
      sha256: (b) => sha256(b),
      isLostSwap: (e) => e instanceof LostSwap,
      newInstance: this.newInstance,
      now: () => this.clock,
      log: (e) => n.logs.push(e),
      setTimeout: () => null,
      clearTimeout: () => undefined,
      ...n.over,
    });
  }

  /** One node over the shared repository, started as boot starts it. */
  node(key = KEY_A, over: Partial<A2ACardPublisherDeps> = {}): PubNode {
    const db = new NodeSQLiteAdapter({
      path: path.join(this.dir, `identity-${this.nodes.length}.sqlite`),
      passphraseHex: '34'.repeat(32),
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    applyMigrations(db, IDENTITY_MIGRATIONS);
    const n: PubNode = {
      db,
      store: new A2AStore(db),
      key,
      card: CARD(),
      refuse: null,
      buildThrows: false,
      gateway: true,
      keyReady: true,
      logs: [],
      over,
      publisher: undefined as unknown as A2ACardPublisher,
    };
    n.publisher = this.publisherFor(n);
    n.publisher.start();
    this.nodes.push(n);
    return n;
  }

  /** A process restart: a new publisher over the same database, started; its first step runs at once. */
  restart(n: PubNode): void {
    n.publisher = this.publisherFor(n);
    n.publisher.start();
  }

  rowOf(n: PubNode): PublicationRow {
    const r = readPublication(n.store);
    if (r === null) throw new Error('no publication');
    return r;
  }

  async step(n: PubNode): Promise<void> {
    n.publisher.nudge();
    await n.publisher.flush();
  }

  listOn(n: PubNode): void {
    setDirectoryListing(n.store, true, this.clock, this.newInstance);
  }

  listOff(n: PubNode): void {
    setDirectoryListing(n.store, false, this.clock, this.newInstance);
  }

  /** A real listing write: the projection triggers bump the revision in its own transaction. */
  async touchListing(n: PubNode, rkey = 'svc'): Promise<void> {
    await new SQLiteServiceConfigRepository(n.db).put(rkey, '{}', this.clock);
  }

  /** A node switched on, activated, and published: the common start. */
  async activeNode(key = KEY_A): Promise<PubNode> {
    const n = this.node(key);
    this.listOn(n);
    const out = await n.publisher.activate({ refence: false });
    if (!out.ok) throw new Error(`activation refused: ${out.reason}`);
    await n.publisher.flush();
    return n;
  }

  nameInRepo(): string | null {
    const card = this.repo.card();
    return card === null ? null : (JSON.parse(card.card as string) as { name: string }).name;
  }

  envelopeInRepo(): { freshness_epoch: number; publisher_epoch: number; publisher_instance: string } {
    return this.repo.card()?.directory_envelope as { freshness_epoch: number; publisher_epoch: number; publisher_instance: string };
  }

  envelopeVerifiesUnder(key: Uint8Array): boolean {
    const record = this.repo.card();
    if (record === null) return false;
    return verifyDirectoryEnvelope(
      record.directory_envelope,
      { repoDid: NODE, collection: A2A_CARD_COLLECTION, rkey: 'self', cardText: record.card as string },
      (b) => sha256(b),
      (m, s) => verify(getPublicKey(key), m, s),
    ).ok;
  }

  fenceVerifiesUnder(key: Uint8Array): boolean {
    const { $type: _t, ...fence } = this.repo.fence() ?? {};
    return verifyFence(fence, NODE, (m, s) => verify(getPublicKey(key), m, s)).ok;
  }

  /** A fence another writer puts in the repository, signed with `key`. */
  async writeFence(key: Uint8Array, epoch: number, instance: string): Promise<void> {
    const fence = await signFence({ did: NODE, publisher_epoch: epoch, publisher_instance: instance }, (m) => sign(key, m));
    this.repo.writeDirect(A2A_FENCE_COLLECTION, fence as unknown as Record<string, unknown>);
  }
}

export interface WireCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  /** A GET's query: which repository a read named. */
  query: Record<string, string>;
}

/**
 * A PDS behind fetch: the node's repository, a head that moves on every
 * write, the two swap preconditions. A read names its repository; any other
 * account's is empty, as the PDS would answer it. The session signs in as
 * `sessionAs`, and a write lands in the session's repository.
 */
export class WirePds {
  readonly calls: WireCall[] = [];
  readonly records = new Map<string, { cid: string; value: Record<string, unknown> }>();
  head = 'bafyhead0';
  sessionAs = NODE;
  /** Writes that landed in another account's repository. */
  readonly foreignWrites: WireCall[] = [];
  private seq = 0;
  /** Answer the next call to this XRPC method this way instead (`no_cid`: a 200 head with no cid). */
  readonly failNext = new Map<string, { status: number; error: string }>();

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }
  private move(): string {
    this.seq += 1;
    this.head = `bafyhead${this.seq}`;
    return `bafyrec${this.seq}`;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const xrpc = url.pathname.replace('/xrpc/', '');
    this.calls.push({ method, path: xrpc, body, query: Object.fromEntries(url.searchParams) });
    const forced = this.failNext.get(xrpc);
    if (forced !== undefined) {
      this.failNext.delete(xrpc);
      if (forced.error === 'no_cid') return this.json(forced.status, { rev: 'r' });
      return this.json(forced.status, { error: forced.error, message: 'refused' });
    }
    switch (xrpc) {
      case 'com.atproto.server.createSession':
        return this.json(200, { accessJwt: 'jwt', did: this.sessionAs });
      case 'com.atproto.sync.getLatestCommit':
        if (url.searchParams.get('did') !== NODE) return this.json(200, { cid: 'bafyotherhead', rev: 'rother' });
        return this.json(200, { cid: this.head, rev: `rev${this.seq}` });
      case 'com.atproto.repo.getRecord': {
        const key = `${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`;
        const r = url.searchParams.get('repo') === NODE ? this.records.get(key) : undefined;
        if (r === undefined) return this.json(400, { error: 'RecordNotFound' });
        return this.json(200, { uri: `at://${NODE}/${key}`, cid: r.cid, value: r.value });
      }
      case 'com.atproto.repo.putRecord': {
        const b = body ?? {};
        if (b.repo !== NODE) {
          this.foreignWrites.push({ method, path: xrpc, body, query: {} });
          return this.json(200, { uri: `at://${String(b.repo)}/x`, cid: 'bafyforeign' });
        }
        const key = `${String(b.collection)}/${String(b.rkey)}`;
        if (b.swapCommit !== undefined && b.swapCommit !== this.head) return this.json(400, { error: 'InvalidSwap' });
        const current = this.records.get(key)?.cid ?? null;
        if ('swapRecord' in b && b.swapRecord !== current) return this.json(400, { error: 'InvalidSwap' });
        const cid = this.move();
        this.records.set(key, { cid, value: b.record as Record<string, unknown> });
        return this.json(200, { uri: `at://${NODE}/${key}`, cid });
      }
      case 'com.atproto.repo.deleteRecord': {
        const b = body ?? {};
        if (b.repo !== NODE) {
          this.foreignWrites.push({ method, path: xrpc, body, query: {} });
          return this.json(200, {});
        }
        if (b.swapCommit !== undefined && b.swapCommit !== this.head) return this.json(400, { error: 'InvalidSwap' });
        this.move();
        this.records.delete(`${String(b.collection)}/${String(b.rkey)}`);
        return this.json(200, {});
      }
      default:
        return this.json(404, { error: 'MethodNotImplemented' });
    }
  }) as typeof fetch;

  writesTo(collection: string): WireCall[] {
    return this.calls.filter((c) => c.method === 'POST' && c.body?.collection === collection);
  }
  card(): Record<string, unknown> | null {
    return this.records.get(`${A2A_CARD_COLLECTION}/self`)?.value ?? null;
  }
}
