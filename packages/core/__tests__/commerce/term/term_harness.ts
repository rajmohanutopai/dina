/**
 * Two term engines — a store and a brand — on real SQLite, wired to each
 * other through BOTH sides' gates (outbound on the sender, inbound on the
 * receiver), with a clock the test moves. Sends queue; `pump()` delivers
 * until nothing is in flight, so a test reads like the conversation.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { firstPartyPack } from '../../../src/commerce/first_party_packs';
import {
  SLOT_BUYER_MANIFEST,
  SLOT_SELLER_MANIFEST,
} from '../../../src/commerce/slot_pack_manifests';
import { TermEngine, type TermPushKind } from '../../../src/commerce/term/term_engine';
import { TermStore } from '../../../src/commerce/term/term_store';
import { CommerceTransaction } from '../../../src/commerce/transaction';
import { tier0TxRunner } from '../../../src/run/tx';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

import type { TermCardSpec } from '../../../src/commerce/term/term_context';
import type { TermPolicy } from '../../../src/commerce/term/term_policy';
import type { TermListing } from '@dina/commerce-protocol';

export const STORE_DID = 'did:plc:cornerstore000000000000000';
export const BRAND_DID = 'did:plc:juicebrand0000000000000000';
export const BRAND2_DID = 'did:plc:secondjuice000000000000000';
export const T0 = Date.parse('2027-01-10T09:00:00Z');

export interface Delivery {
  from: string;
  to: string;
  kind: string;
  document: unknown;
  outcome: string;
}

export interface Node {
  did: string;
  engine: TermEngine;
  store: TermStore;
  cards: TermCardSpec[];
  closed: string[];
  close: () => void;
  /** Close and reopen on the same encrypted file: an app relaunch. */
  restart: () => void;
  /** The node's identity database as it is now (changes on restart). */
  db: () => NodeSQLiteAdapter;
  /** Toggle the pack half off (paused: still installed, see `packRemoved`). */
  packActive: { seller: boolean; buyer: boolean };
  /** The half is gone (revoked or uninstalled), not merely paused. */
  packRemoved: { seller: boolean; buyer: boolean };
  contacts: Set<string>;
  /** DIDs the owner blocked. */
  blocked: Set<string>;
  /** The node's public records, as a directory would hold them (uri → listing). */
  directory: Map<string, TermListing>;
  /**
   * Answers the inbox holds that the engine has not heard (a crash between the
   * workflow's commit and the engine's hook); the sweep reads and acts on them.
   */
  inboxAnswers: Map<string, 'approved' | 'declined'>;
  /** Inbox tasks the engine finished after acting on an owner's yes. */
  finished: { cardId: string; ok: boolean; refusal?: string }[];
  probing: { allow: boolean };
}

export class Fleet {
  nowMs = T0;
  readonly nodes = new Map<string, Node>();
  readonly inFlight: { from: string; to: string; kind: string; document: unknown }[] = [];
  readonly deliveries: Delivery[] = [];
  /** Drop every send to this DID (a phone asleep, a relay that lost it). */
  readonly unreachable = new Set<string>();
  /** This DID's own sends fail outright (its sender reports false). */
  readonly sendsFail = new Set<string>();

  add(did: string): Node {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dina-term-'));
    const passphraseHex = randomBytes(32).toString('hex');
    const cards: TermCardSpec[] = [];
    const closed: string[] = [];
    const packActive = { seller: true, buyer: true };
    const packRemoved = { seller: false, buyer: false };
    const contacts = new Set<string>();
    const blocked = new Set<string>();
    const inboxAnswers = new Map<string, 'approved' | 'declined'>();
    const finished: Node['finished'] = [];
    const probing = { allow: true };
    let adapter = this.openAdapter(dir, passphraseHex, true);
    const node: Node = {
      did,
      ...this.openEngine(did, adapter, {
        cards,
        closed,
        packActive,
        packRemoved,
        contacts,
        blocked,
        probing,
        inboxAnswers,
        finished,
      }),
      cards,
      closed,
      packActive,
      packRemoved,
      contacts,
      blocked,
      directory: new Map(),
      inboxAnswers,
      finished,
      probing,
      db: () => adapter,
      restart: () => {
        // An app relaunch: the process and everything in memory is gone; the
        // encrypted file stays. Raised cards live in the workflow store, which
        // is durable too, so the list carries over. The tests run the sweep
        // afterwards, as a booting node's sweeper does.
        adapter.close();
        adapter = this.openAdapter(dir, passphraseHex, false);
        Object.assign(
          node,
          this.openEngine(did, adapter, {
            cards,
            closed,
            packActive,
            packRemoved,
            contacts,
            blocked,
            probing,
            inboxAnswers,
            finished,
          }),
        );
      },
      close: () => {
        adapter.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
    this.nodes.set(did, node);
    return node;
  }

  private openAdapter(dir: string, passphraseHex: string, fresh: boolean): NodeSQLiteAdapter {
    const adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex,
      journalMode: 'WAL',
      synchronous: 'NORMAL',
    });
    if (fresh) applyMigrations(adapter, IDENTITY_MIGRATIONS);
    return adapter;
  }

  private openEngine(
    did: string,
    adapter: NodeSQLiteAdapter,
    state: Pick<
      Node,
      | 'cards'
      | 'closed'
      | 'packActive'
      | 'packRemoved'
      | 'contacts'
      | 'blocked'
      | 'probing'
      | 'inboxAnswers'
      | 'finished'
    >,
  ): { engine: TermEngine; store: TermStore } {
    const store = new TermStore(adapter);
    const sellerEntry = firstPartyPack(SLOT_SELLER_MANIFEST.plugin_id);
    const buyerEntry = firstPartyPack(SLOT_BUYER_MANIFEST.plugin_id);
    const engine = new TermEngine({
      store,
      transaction: new CommerceTransaction(tier0TxRunner(adapter)),
      selfDid: () => did,
      now: () => this.nowMs,
      activePack: (role) => {
        if (role === 'term_seller')
          return state.packActive.seller && sellerEntry !== null
            ? { entry: sellerEntry, installId: `inst-s-${did}` }
            : null;
        return state.packActive.buyer && buyerEntry !== null
          ? { entry: buyerEntry, installId: `inst-b-${did}` }
          : null;
      },
      packHeld: (role) => !state.packRemoved[role === 'term_seller' ? 'seller' : 'buyer'],
      isContact: (peer) => state.contacts.has(peer),
      isBlocked: (peer) => state.blocked.has(peer),
      send: (toDid, kind, document) => {
        // A send that fails outright (no sender yet, relay down): nothing leaves.
        if (this.sendsFail.has(did)) return Promise.resolve(false);
        this.inFlight.push({
          from: did,
          to: toDid,
          kind,
          document: JSON.parse(JSON.stringify(document)),
        });
        return Promise.resolve(true);
      },
      cards: {
        raise: (card) => {
          if (state.cards.some((c) => c.cardId === card.cardId)) return false;
          state.cards.push(card);
          return true;
        },
        close: (cardId) => {
          state.closed.push(cardId);
        },
        answer: (cardId) => {
          const answered = state.inboxAnswers.get(cardId) ?? null;
          state.inboxAnswers.delete(cardId);
          return answered;
        },
        finish: (cardId, outcome) => {
          state.finished.push({
            cardId,
            ok: outcome.ok,
            ...(outcome.ok ? {} : { refusal: outcome.refusal }),
          });
        },
      },
      spendProbing: () => state.probing.allow,
    });
    return { engine, store };
  }

  /** Deliver everything in flight (and what it causes) through both gates. */
  pump(max = 500): void {
    for (let i = 0; i < max && this.inFlight.length > 0; i += 1) {
      const msg = this.inFlight.shift();
      if (msg === undefined) break;
      const sender = this.nodes.get(msg.from);
      const receiver = this.nodes.get(msg.to);
      if (sender === undefined || receiver === undefined || this.unreachable.has(msg.to)) {
        this.deliveries.push({ ...msg, outcome: 'lost' });
        continue;
      }
      const outboundOk =
        sender.contacts.has(msg.to) ||
        sender.engine.gateAllows({
          peerDid: msg.to,
          kind: msg.kind,
          document: msg.document,
          direction: 'outbound',
        });
      if (!outboundOk) {
        this.deliveries.push({ ...msg, outcome: 'egress_denied' });
        continue;
      }
      const inboundOk =
        receiver.contacts.has(msg.from) ||
        receiver.engine.gateAllows({
          peerDid: msg.from,
          kind: msg.kind,
          document: msg.document,
          direction: 'inbound',
        });
      if (!inboundOk) {
        this.deliveries.push({ ...msg, outcome: 'ingress_denied' });
        continue;
      }
      const result = receiver.engine.ingest({
        senderDid: msg.from,
        kind: msg.kind as TermPushKind,
        document: msg.document,
        evidenceJson: '{}',
      });
      this.deliveries.push({ ...msg, outcome: result.outcome });
    }
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  closeAll(): void {
    for (const node of this.nodes.values()) node.close();
  }

  outcomes(kind: string): string[] {
    return this.deliveries.filter((d) => d.kind === kind).map((d) => d.outcome);
  }
}

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;

/** The juice store's policy: one shelf slot, rent ₹1,500 floor, 15% premium per juice brand, at most 4. */
export function juicePolicy(overrides: Partial<TermPolicy> = {}): TermPolicy {
  return {
    enabled: true,
    access: 'anyone',
    maxRounds: 3,
    windowSeconds: 7 * 24 * 60 * 60,
    maxCountersPerBuyerPerDay: 20,
    resources: [
      {
        resource_ref: 'slot-3',
        currency: 'INR',
        asking: { fee: '250000', share_bps: '1000' },
        floors: { fee: { hard: '150000', auto: '180000' }, share_bps: { hard: '500' } },
        available: { from: '2027-01-01T00:00:00Z', to: '2028-12-31T00:00:00Z' },
        conditions: {
          period: 'monthly',
          cash_handler: 'vendor',
          exit_notice_days: 30,
          trial: { days: 14, fee_minor: '50000' },
        },
      },
      {
        resource_ref: 'slot-4',
        currency: 'INR',
        asking: { fee: '200000', share_bps: '0' },
        floors: { fee: { hard: '150000' }, share_bps: { hard: '0' } },
        available: { from: '2027-01-01T00:00:00Z', to: '2028-12-31T00:00:00Z' },
        conditions: { period: 'monthly', cash_handler: 'vendor', exit_notice_days: 30 },
      },
    ],
    holding_rules: [{ tag: 'beverages.juice', premium_bps_per_count: 1500, max_count: 4 }],
    manual_holdings: [],
    ...overrides,
  };
}

/** A value a test depends on, or a failure that names what was missing. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`test: no ${what}`);
  return value;
}

/**
 * Publish a listing as the owner route does: compose it (closed vocabulary,
 * no money), write the public record first — here to the fleet's stand-in
 * directory — then record it as published on the node.
 */
export function publishListing(
  node: Node,
  input: Parameters<TermEngine['composeListing']>[0],
): { ok: true; listing: TermListing; uri: string } | { ok: false; refusal: string } {
  const composed = node.engine.composeListing(input);
  if (!composed.ok) return composed;
  node.directory.set(composed.uri, composed.listing);
  node.engine.storeListing(composed.listing);
  return composed;
}
