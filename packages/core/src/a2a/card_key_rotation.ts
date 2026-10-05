/**
 * Rotating the A2A card key (UCP plan §4.8, U7; A2A plan D4): the same key
 * ring as the UCP request key (`crypto/key_rotation.ts`), for the ES256 key at
 * `m/9999'/5'/{generation}'` that signs the Agent Card.
 *
 * Who checks the key, and what each caches:
 *  - A remote agent verifies the card against the JWK Set its `jku` names,
 *    which the gateway serves with `max-age` 30 from a copy it fetched from
 *    Core. A staged key counts as served once Core hands the gateway a JWK
 *    Set naming it (the gateway replaces its copy then); the switch waits the
 *    set's `max-age` plus a minute after that, so every client that honours
 *    the header has fetched a set naming the new key. The old key stays in
 *    the set for 7 days after the switch.
 *  - The directory (AppView) verifies the published card against the DID
 *    document's one `#a2a_card` key. The switch itself puts the new key there
 *    first (`recordKey`), whether or not the card is listed, and does not
 *    happen until that succeeds; the card publisher's key check
 *    (`cardKeyCheck`) then finds it present.
 *
 * The DID document is therefore the record of the key in use. The ring lives
 * under KV `a2a:card_key_ring`, which archives leave out: a node without one
 * (new, or restored) adopts the generation the document names (searching
 * upward from 0), and every boot checks once that the document names no
 * newer generation than its ring, so a restore never signs with, or puts
 * back, a key a later rotation replaced. Until it knows, no card is served or
 * published. A node without a did:plc has no document: it signs with
 * generation 0 and cannot rotate (a restore could not know of a rotation).
 * A restore during an overlap lists only the key in use: a client holding a
 * card signed by the old key fetches it again within the gateway's 30 s.
 */

import { p256 } from '@noble/curves/nist.js';

import {
  advance,
  freshRing,
  listedGenerations,
  nextStepAt,
  promoteAt,
  readKeyRing,
  stage,
  stagedConfirmed,
  stagedPublished,
  type KeyRing,
} from '../crypto/key_rotation';
import { kvGet, kvSet } from '../kv/store';

import { cardPublicJwk, installA2ACardConfig, type A2ACardKey } from './inbound_card';

/** What the gateway's JWK Set is served with (`cache-control: public, max-age=30`). */
export const A2A_JWKS_MAX_AGE_SECONDS = 30;
/** A staged card key signs this long after the gateway first served a set naming it. */
export const CARD_KEY_SWITCH_WAIT_MS = (A2A_JWKS_MAX_AGE_SECONDS + 60) * 1000;
/** The replaced card key stays in the set this long after the switch. */
export const CARD_KEY_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;
/** How far up a node without a ring looks for the generation its DID document names. */
const MAX_ADOPTED_GENERATION = 256;

const KV_NAMESPACE = 'a2a';
const KV_KEY = 'card_key_ring';

export interface A2ACardKeyRotationOptions {
  /** The card key at a generation, derived from the master seed. */
  keyAt(generation: number): A2ACardKey;
  publicOrigin: string;
  /**
   * The node's DID document, or null when it has none (no did:plc): reads
   * the compressed P-256 key it names as `#a2a_card` (null when none; throws
   * when it cannot be read now), and records a new one (throws on failure).
   */
  document: {
    readKey(): Promise<Uint8Array | null>;
    recordKey(compressed: Uint8Array): Promise<unknown>;
  } | null;
  now?: () => number;
}

export type CardKeyRotateOutcome = 'staged' | 'busy' | 'unknown' | 'no_did_document';

export interface A2ACardKeyView {
  /** Null until the node knows its ring (a restored node reading its DID document). */
  generation: number | null;
  next: { generation: number; signs_from: number | null } | null;
  retiring: { generation: number; until: number }[];
}

export class A2ACardKeyRotation {
  private ring: KeyRing | null = null;
  private readonly now: () => number;
  /** Told after every change of the ring (the schedule wakes for the next step). */
  private changed: (() => void) | null = null;
  /** This boot has compared the ring with the DID document. */
  private reconciled = false;

  constructor(private readonly opts: A2ACardKeyRotationOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Load the ring on disk, if any, and install the card config; no network. */
  async load(): Promise<boolean> {
    if (this.ring !== null) return true;
    const raw = await kvGet(KV_KEY, KV_NAMESPACE);
    if (raw === null) return false;
    let stored: KeyRing | null;
    try {
      stored = readKeyRing(JSON.parse(raw) as unknown);
    } catch {
      stored = null;
    }
    if (stored === null) return false;
    this.ring = stored;
    this.install();
    return true;
  }

  /**
   * Know the ring, then advance it. A node without one adopts the DID
   * document's generation; once per boot the ring is checked against the
   * document, and a newer generation there is adopted. `false` while the
   * document cannot be read and no ring is known (no card until it can; call
   * again later). Throws when a due switch could not record its key.
   */
  async start(): Promise<boolean> {
    await this.load();
    const doc = this.opts.document;
    if (this.ring === null || (!this.reconciled && doc !== null)) {
      let named: Uint8Array | null = null;
      let read = doc === null;
      try {
        if (doc !== null) {
          named = await doc.readKey();
          read = true;
        }
      } catch {
        // Unreadable now: a node with a ring keeps it and checks on a later run.
        if (this.ring === null) return false;
      }
      const g = named === null ? null : this.generationOf(named);
      if (this.ring === null) await this.save(freshRing(g ?? 0));
      else if (g !== null && g > this.ring.active) await this.save(freshRing(g));
      if (read) this.reconciled = true;
    }
    await this.step();
    return true;
  }

  /** Whether the ring is known (the card can be built and published). */
  ready(): boolean {
    return this.ring !== null;
  }

  /** The generation a document key belongs to; above every one tried when none matches. */
  private generationOf(key: Uint8Array): number {
    const hex = Buffer.from(key).toString('hex');
    for (let g = 0; g <= MAX_ADOPTED_GENERATION; g++) {
      if (
        Buffer.from(p256.getPublicKey(this.opts.keyAt(g).privateKey, true)).toString('hex') === hex
      )
        return g;
    }
    // Not this seed's key (a document edited by hand): start above the range searched, so
    // no key this node signed with before is used again.
    return MAX_ADOPTED_GENERATION + 1;
  }

  private async save(ring: KeyRing): Promise<void> {
    await kvSet(KV_KEY, JSON.stringify(ring), KV_NAMESPACE);
    this.ring = ring;
    this.install();
    this.changed?.();
  }

  /** One listener: the schedule. */
  onChange(listener: (() => void) | null): void {
    this.changed = listener;
  }

  /** The card signs with the active key; the JWK Set lists every key the ring lists. */
  private install(): void {
    const ring = this.ring;
    if (ring === null) return;
    installA2ACardConfig({
      key: this.opts.keyAt(ring.active),
      also: listedGenerations(ring)
        .filter((g) => g !== ring.active)
        .map((g) => this.opts.keyAt(g)),
      publicOrigin: this.opts.publicOrigin,
    });
  }

  /**
   * Advance to now (a switch, a removal) and save when anything changed. A
   * switch first records the new key in the DID document; it throws, and
   * nothing changes, when that fails.
   */
  async step(): Promise<void> {
    if (this.ring === null) return;
    const next = advance(this.ring, this.now(), CARD_KEY_SWITCH_WAIT_MS, CARD_KEY_OVERLAP_MS);
    if (next === this.ring) return;
    if (next.active !== this.ring.active && this.opts.document !== null)
      await this.opts.document.recordKey(
        p256.getPublicKey(this.opts.keyAt(next.active).privateKey, true),
      );
    await this.save(next);
  }

  /** The owner's "Rotate the card key": the next generation is listed; it signs later. */
  async rotate(): Promise<CardKeyRotateOutcome> {
    if (this.opts.document === null) return 'no_did_document';
    if (this.ring === null) return 'unknown';
    if (this.ring.staged !== undefined) return 'busy';
    await this.save(stagedPublished(stage(this.ring, 0), this.now()));
    return 'staged';
  }

  /**
   * Core handed the gateway a JWK Set naming these keys: a staged key among
   * them now counts as served from this moment (the first time only).
   */
  async served(kids: readonly string[]): Promise<void> {
    const ring = this.ring;
    if (ring?.staged === undefined) return;
    const kid = cardPublicJwk(this.opts.keyAt(ring.staged.generation)).kid;
    if (!kids.includes(kid as string)) return;
    const next = stagedConfirmed(ring, this.now());
    if (next !== ring) await this.save(next);
  }

  /** When the ring next changes on its own; null when nothing waits. */
  nextStepAt(): number | null {
    return this.ring === null ? null : nextStepAt(this.ring, CARD_KEY_SWITCH_WAIT_MS);
  }

  view(): A2ACardKeyView {
    const ring = this.ring;
    if (ring === null) return { generation: null, next: null, retiring: [] };
    return {
      generation: ring.active,
      next:
        ring.staged === undefined
          ? null
          : {
              generation: ring.staged.generation,
              signs_from: promoteAt(ring, CARD_KEY_SWITCH_WAIT_MS),
            },
      retiring: ring.retiring.map((r) => ({ generation: r.generation, until: r.retireAfter })),
    };
  }
}

/**
 * What boot awaits: a ring on disk installs the card at once and nothing waits
 * on the network (the document check and any due switch are the schedule's
 * first run); a node with none reads its DID document first, as bounded as
 * the caller's fetch. False when no card is known yet.
 */
export async function bootA2ACardKeys(rotation: A2ACardKeyRotation): Promise<boolean> {
  if (await rotation.load()) return true;
  return rotation.start().catch(() => false);
}

let installed: A2ACardKeyRotation | null = null;

/** A host serving Lane 2 installs its rotation; the card route and the owner's routes reach it here. */
export function installA2ACardKeyRotation(rotation: A2ACardKeyRotation | null): void {
  installed = rotation;
}

export function getA2ACardKeyRotation(): A2ACardKeyRotation | null {
  return installed;
}

/**
 * Keep the ring moving: try `start` until it succeeds (a restored node whose
 * DID document could not be read yet), then wake at each next step, and at
 * least hourly. Returns a stop.
 */
export function startA2ACardKeySchedule(
  rotation: A2ACardKeyRotation,
  options: {
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    now?: () => number;
  } = {},
): { stop(): void; kick(): void } {
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      (t as { unref?: () => void }).unref?.();
      return t;
    });
  const clearTimer =
    options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = options.now ?? Date.now;
  const HOUR = 60 * 60 * 1000;
  let timer: unknown = null;
  let stopped = false;
  let retry = 60_000;
  const schedule = (ms: number): void => {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => void run(), ms);
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    const ok = await rotation.start().catch(() => false);
    if (!ok) {
      schedule(retry);
      retry = Math.min(retry * 2, HOUR);
      return;
    }
    retry = 60_000;
    const at = rotation.nextStepAt();
    schedule(at === null ? HOUR : Math.min(HOUR, Math.max(0, at - now())));
  };
  // A change made elsewhere (the owner's rotation, the gateway serving a staged key): wake for
  // the step it brings.
  rotation.onChange(() => schedule(0));
  schedule(0);
  return {
    stop: () => {
      stopped = true;
      rotation.onChange(null);
      if (timer !== null) clearTimer(timer);
    },
    kick: () => schedule(0),
  };
}
