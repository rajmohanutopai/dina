/**
 * The node's half of profile publication (UCP plan §3.5): Core builds the
 * exact profile bytes and a signed envelope over them, and sends both straight
 * to the Dina-run host. Nothing goes to the PDS.
 *
 *  - Revision: always the host's current revision + 1, read from the host
 *    before each change; a refused stale revision is re-read and retried, a
 *    few times, re-checking the fence before each rebuild.
 *  - Publisher epoch: each installation draws an `instance` id once. A node
 *    whose label is already served by another installation, or by a newer
 *    epoch, stands down: it stops uploading and tells the owner which device
 *    holds shopping. Only the owner's own actions on this device claim a
 *    greater epoch ("Use this device for shopping", and "Turn UCP off" or "My
 *    key may be compromised", which must take effect whichever device last
 *    published); a retry or the daily re-upload never does.
 *  - The fence: each owner action moves a fencing generation. A job that began
 *    under an older one stops without sending, and a result that comes back
 *    after the fence moved is not saved.
 *  - Pause ("Turn UCP off") stops serving and retires nothing. Retire ("My key
 *    may be compromised") retires every key the profile lists for good, then
 *    publishes again under the next generation (U7: compromise recovery).
 *    Either is kept as a pending control (status `stopping`) and retried until
 *    the host confirms it, so the owner never reads "off" while the host still
 *    serves the profile.
 *  - Key rotation (U7, §4.8; `crypto/key_rotation.ts`): "Rotate my shopping
 *    key" stages the next generation above any the host has seen; the profile
 *    lists it beside the active key. Once the host is seen serving that
 *    profile, and the served `max-age` plus a minute has passed, the next
 *    upload makes it active, and requests are signed with it only after the
 *    host has accepted that upload; the old key stays listed as retiring for 7
 *    days, then the upload that leaves it out retires it at the host. The ring
 *    is this record's; a node without one (new, or restored) adopts the
 *    host's, which records every listed key's phase and times.
 *  - The host's HTTP status comes first: 503, 429 and other 5xx are temporary
 *    (`unreachable`, retried); only a 409 carries a refusal of the change; 400
 *    and 401 are permanent refusals of what this node sent.
 *  - The identity is taken once per run, and the run stops before any send if
 *    the vault was sealed (or the identity replaced) in between.
 *
 * The order `webhook_url`: a public server's own while the owner keeps order
 * webhooks on (S8, §3.13), else the drop-box (S9), and polling covers orders.
 * A change of either changes the document, so the next run uploads it; a
 * host kicks the schedule when the owner saves UCP settings.
 *
 * The record lives under KV `ucp:publisher`, which archives leave out
 * (`export/archive.ts`): a node restored from an archive is a new
 * installation, and stands down until the owner activates it.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  buyerProfileBytes,
  documentHash,
  dropBoxWebhookUrl,
  hostEndpoints,
  isNonNegInt,
  parseHostAnswer,
  parsePublicState,
  PROFILE_MAX_AGE_SECONDS,
  profileUrlForLabel,
  signPublication,
  UCP_PROFILE_HOST,
  UCP_VERSION,
  UUID_RE,
  type ControlBody,
  type HostAnswer,
  type PublicState,
  type PublishedKey,
  type PublicationFields,
  type UploadBody,
} from '@dina/ucp';

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
} from '../../crypto/key_rotation';
import { kvGet, kvSet } from '../../kv/store';

import { ucpFetch, type UcpFetchResult } from './fetch';
import { getUcpIdentity, setUcpSigningGeneration, type UcpIdentity } from './identity';
import { newUcpId } from './ids';
import { jsonOrUndefined } from './json_bytes';
import { setUcpWebhooksStoodDown, ucpOrderWebhookUrl } from './webhooks';

import type { PolicySocketRequest } from '@dina/net-policy';

export type PublicationStatus =
  /** The host serves exactly the bytes this node built. */
  | 'served'
  /** The host serves other bytes (or none) than this node built. */
  | 'stale'
  | 'unreachable'
  /** The host refused the change (the label is another DID's, a key is retired, …). */
  | 'refused'
  /** Another installation, or a newer epoch, holds shopping for this identity. */
  | 'stood_down'
  /** The owner turned UCP off (or retired the key), and the host stopped serving. */
  | 'off'
  /** The owner turned UCP off (or retired the key); the host has not confirmed yet. Retried. */
  | 'stopping';

/**
 * An owner action the host has not confirmed yet, retried until it has:
 * `pause` ("Turn UCP off"), `retire` ("My key may be compromised"),
 * `activate` ("Use this device for shopping" pressed while the host could not
 * be reached: the epoch is claimed once it can).
 */
export type PendingControl = 'pause' | 'retire' | 'activate';

/**
 * How long a key listed in a newly served profile waits before it signs:
 * the profile's served `max-age` plus a minute, so every merchant that
 * honours the header has fetched a profile naming it (§4.8).
 */
export const KEY_SWITCH_WAIT_MS = (PROFILE_MAX_AGE_SECONDS + 60) * 1000;
/** How long a replaced key stays listed (retiring) after the switch. */
export const KEY_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

/** What the publisher keeps (Core's KV store, namespace `ucp`). */
export interface PublisherState {
  instance: string;
  epoch: number;
  role: 'active' | 'stood_down';
  /** Moved by every owner action; a job or result from an older value is dropped. */
  fence: number;
  enabled: boolean;
  /** Set while the owner's "My key may be compromised" is carried out; cleared once republished. */
  keyRetired: boolean;
  /**
   * The key ring (U7): which generation signs, which is staged, which retire
   * when. Absent until known: a new or restored node adopts the host's.
   */
  keys?: KeyRing;
  /** The owner asked for a rotation that the next upload has not staged yet. */
  rotate?: boolean;
  /** The highest publisher epoch this node has read from the host (how current its view is). */
  hostEpoch?: number;
  /**
   * For an owner action left pending (the host out of reach at the press):
   * the highest epoch this node knew of then. A retry that finds a newer one
   * is not applied (another device chose after the press); the owner is told.
   */
  controlEpoch?: number;
  /**
   * The lowest generation a new ring may start at: one above every key a
   * compromise retired, even where the host never registered them (a label
   * never published), so no such key signs again.
   */
  generationFloor?: number;
  /** An owner control the host has not confirmed yet. */
  pendingControl: PendingControl | null;
  status: PublicationStatus;
  /** The host's refusal or fault, for the owner's UCP settings (no request content). */
  detail?: string;
}

export interface UcpPublisherOptions {
  did: string;
  /** Default: production. A test deployment passes its own. */
  profileHost?: string;
  identity?: () => UcpIdentity | null;
  fetch?: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  /** This node's own order `webhook_url`, or null for the drop-box. Default: `ucpOrderWebhookUrl`. */
  webhookUrl?: () => string | null;
  /** Per-installation id, drawn once. Default: `newUcpId` (Hermes has no crypto.randomUUID). */
  randomUUID?: () => string;
  now?: () => number;
}

const KV_NAMESPACE = 'ucp';
const KV_KEY = 'publisher';
/** Rebuilds after a stale revision (or a lost epoch race) before trying again later. */
const MAX_ATTEMPTS = 4;
const HOST_LIMITS = { maxResponseBytes: 64 * 1024, timeoutMs: 10_000 };

/** A change's answer, read by HTTP status first. */
type SendResult = HostAnswer | 'unreachable';

export class UcpPublisher {
  private readonly did: string;
  private readonly profileHost: string;
  private readonly webhookUrl: () => string | null;
  private readonly identity: () => UcpIdentity | null;
  private readonly fetch: (request: PolicySocketRequest) => Promise<UcpFetchResult>;
  private readonly randomUUID: () => string;
  private readonly now: () => number;
  /** "My key may be compromised" pressed and not yet carried out: nothing signs (in memory; the record's `keyRetired` survives a restart). */
  private halted = false;

  constructor(options: UcpPublisherOptions) {
    this.did = options.did;
    this.profileHost = options.profileHost ?? UCP_PROFILE_HOST;
    this.webhookUrl = options.webhookUrl ?? ucpOrderWebhookUrl;
    this.identity = options.identity ?? getUcpIdentity;
    this.fetch = options.fetch ?? ucpFetch;
    this.randomUUID = options.randomUUID ?? newUcpId;
    this.now = options.now ?? Date.now;
  }

  // ---------------------------------------------------------------- state

  async state(): Promise<PublisherState> {
    const raw = await kvGet(KV_KEY, KV_NAMESPACE);
    // Core's own record, shape-checked on read; anything unreadable starts
    // again as a fresh installation (which stands down if the label is held).
    const stored =
      raw === null ? null : readPublisherState(parseJson(new TextEncoder().encode(raw)));
    if (stored !== null) {
      setUcpWebhooksStoodDown(stored.role === 'stood_down');
      return stored;
    }
    const fresh: PublisherState = {
      instance: this.randomUUID(),
      // Epoch 0: nothing claimed yet. The first publish of an unbound label
      // claims 1; a label already served elsewhere leaves this node stood down.
      epoch: 0,
      role: 'active',
      fence: 0,
      enabled: true,
      keyRetired: false,
      pendingControl: null,
      status: 'stale',
    };
    await this.save(fresh);
    return fresh;
  }

  private async save(state: PublisherState): Promise<void> {
    await kvSet(KV_KEY, JSON.stringify(state), KV_NAMESPACE);
    // A node that stands down stops taking webhooks too (§3.5).
    setUcpWebhooksStoodDown(state.role === 'stood_down');
  }

  private async update(change: Partial<PublisherState>): Promise<PublisherState> {
    const next = { ...(await this.state()), ...change };
    // A field set to undefined is removed, not stored as undefined.
    if ('detail' in change && change.detail === undefined) delete next.detail;
    if ('keys' in change && change.keys === undefined) delete next.keys;
    if ('rotate' in change && change.rotate === undefined) delete next.rotate;
    // Set with a pending action, ended with it.
    if (
      ('controlEpoch' in change && change.controlEpoch === undefined) ||
      ('pendingControl' in change && change.pendingControl === null)
    )
      delete next.controlEpoch;
    await this.save(next);
    return next;
  }

  /**
   * Requests are signed with `generation` from now (null: with nothing, until
   * one is named): this publisher's identity, and any installed.
   */
  private signWith(generation: number | null): void {
    // Halted by a compromise: a run that finishes now names no key.
    if (this.halted && generation !== null) return;
    const identity = this.identity();
    if (generation === null) identity?.forgetGeneration();
    else identity?.useGeneration(generation);
    setUcpSigningGeneration(generation);
  }

  /**
   * Sign with the generation the stored ring names: boot awaits this before
   * any merchant call, so a restart keeps a rotated key (for this identity
   * and any installed later, as a phone unlocked after a seal).
   */
  async restoreKeys(): Promise<void> {
    const state = await this.state();
    // A compromise still being carried out: the key it names never signs again.
    if (state.keyRetired || state.pendingControl === 'retire') {
      this.stopSigningNow();
      return;
    }
    if (state.keys !== undefined) this.signWith(state.keys.active);
  }

  /**
   * The owner said the key may be in other hands: nothing signs from this
   * moment, whatever run is in flight, until the next generation's upload is
   * accepted (`control('retire')` lifts it). Called before the owner's action
   * waits its turn in the schedule.
   */
  stopSigningNow(): void {
    this.halted = true;
    this.signWith(null);
  }

  /** When the ring next changes on its own (a promotion, a retirement); null when nothing waits. */
  async nextKeyStepAt(): Promise<number | null> {
    const keys = (await this.state()).keys;
    return keys === undefined ? null : nextStepAt(keys, KEY_SWITCH_WAIT_MS);
  }

  /** Whether a staged key's profile is published but not yet seen served. */
  async awaitingConfirmation(): Promise<boolean> {
    const s = (await this.state()).keys?.staged;
    return s?.publishedAt !== undefined && s.confirmedAt === undefined;
  }

  /**
   * Save a job's result only if no owner action moved the fence while it ran;
   * otherwise the newer action's state stands and this result is dropped.
   */
  private async settle(fence: number, change: Partial<PublisherState>): Promise<PublicationStatus> {
    const current = await this.state();
    if (current.fence !== fence) return current.status;
    return (await this.update(change)).status;
  }

  // ---------------------------------------------------------------- host

  private request(
    method: PolicySocketRequest['method'],
    url: string,
    body?: UploadBody | ControlBody,
  ): PolicySocketRequest {
    return {
      method,
      url,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: new TextEncoder().encode(JSON.stringify(body)) } : {}),
      accept: 'json',
      minTls: 'TLSv1.3',
      readAuthErrorBodies: false,
      ...HOST_LIMITS,
    };
  }

  /** The host's public state: null when the label is unbound, 'unreachable' on any fault. */
  private async readHost(label: string): Promise<PublicState | null | 'unreachable'> {
    const r = await this.fetch(this.request('GET', hostEndpoints(label, this.profileHost).state));
    if (!r.ok) return 'unreachable';
    if (r.status === 404) return null;
    if (r.status !== 200) return 'unreachable';
    const parsed = parseJson(r.bodyBytes);
    const state = parsed === undefined ? null : parsePublicState(parsed);
    if (state === null) return 'unreachable';
    const known = (await this.state()).hostEpoch ?? 0;
    if (state.epoch > known) await this.update({ hostEpoch: state.epoch });
    return state;
  }

  /** The newest epoch this node knows of now: its own claim, or the host's last read. */
  private async knownEpoch(): Promise<number> {
    const s = await this.state();
    return Math.max(s.epoch, s.hostEpoch ?? 0);
  }

  /**
   * A pending action carried by a later run (not the press itself) when the
   * host now shows an epoch newer than any this node knew at the press:
   * another device claimed shopping after it. Not applied; the owner sees
   * why and may press again.
   */
  private superseded(state: PublisherState, host: PublicState, fresh: boolean): boolean {
    return !fresh && state.controlEpoch !== undefined && host.epoch > state.controlEpoch;
  }

  /**
   * Send a change. 200 is applied or replayed; 409 a refusal with the state;
   * 400 and 401 a refusal of what was sent (never retried as it is); 429, 503
   * and every other status, or no answer, is temporary.
   */
  private async send(
    method: PolicySocketRequest['method'],
    url: string,
    body: UploadBody | ControlBody,
  ): Promise<SendResult> {
    const r = await this.fetch(this.request(method, url, body));
    if (!r.ok) return 'unreachable';
    if (r.status === 400 || r.status === 401)
      return { status: 'refused', reason: 'invalid', state: null };
    if (r.status !== 200 && r.status !== 409) return 'unreachable';
    const parsed = parseJson(r.bodyBytes);
    const answer = parsed === undefined ? null : parseHostAnswer(parsed);
    if (answer === null) return 'unreachable';
    // A 200 must be a success and a 409 a refusal; anything else is not the host's contract.
    if ((r.status === 200) !== (answer.status !== 'refused')) return 'unreachable';
    return answer;
  }

  private envelopeFields(
    epoch: number,
    instance: string,
    label: string,
    revision: number,
  ): Omit<PublicationFields, 'op'> {
    return { did: this.did, label, epoch, instance, revision, issued_at: this.now() };
  }

  /** Whether the run may still send: the identity it started with is still installed. */
  private stillHeld(identity: UcpIdentity): boolean {
    return this.identity() === identity;
  }

  /** The exact profile bytes this node serves, listing every key the ring lists. */
  profileBytes(identity: UcpIdentity, keys: KeyRing): string {
    return buyerProfileBytes({
      // Dina links accounts (U4, §3.17): merchants offering identity linking negotiate it.
      identityLinking: true,
      keys: listedGenerations(keys).map((g) => identity.keyAt(g).jwk),
      webhookUrl: this.webhookUrl() ?? dropBoxWebhookUrl(identity.label, this.profileHost),
    });
  }

  /** The envelope's `keys`: each listed key with its phase and times. */
  private publishedKeys(identity: UcpIdentity, keys: KeyRing): PublishedKey[] {
    const at = (g: number) => identity.keyAt(g).jwk.kid;
    const staged = keys.staged;
    return [
      { thumbprint: at(keys.active), generation: keys.active, phase: 'active' },
      ...(staged !== undefined
        ? [
            {
              thumbprint: at(staged.generation),
              generation: staged.generation,
              phase: 'staged' as const,
              // No earlier than the profile naming it has been out a full max-age and a minute.
              not_before:
                promoteAt(keys, KEY_SWITCH_WAIT_MS) ??
                (staged.publishedAt ?? this.now()) + KEY_SWITCH_WAIT_MS,
            },
          ]
        : []),
      ...keys.retiring.map((r) => ({
        thumbprint: at(r.generation),
        generation: r.generation,
        phase: 'retiring' as const,
        retire_after: r.retireAfter,
      })),
    ];
  }

  /**
   * The ring a node without one adopts from the host: the keys it lists, in
   * their phases, when each is this seed's own; null when none is active (all
   * retired, or not this seed's), and the node starts at the next generation.
   * A staged key comes without its publication time: it waits a full wait
   * again from this node's own upload, so it never signs early. A key below
   * `floor` (one a compromise on this node retired, whatever the host still
   * lists) is never taken.
   */
  private ringFromHost(identity: UcpIdentity, host: PublicState, floor = 0): KeyRing | null {
    const ours = host.keys.filter(
      (k) => k.generation >= floor && identity.keyAt(k.generation).jwk.kid === k.thumbprint,
    );
    const active = ours.find((k) => k.phase === 'active');
    if (active === undefined) return null;
    const staged = ours.find((k) => k.phase === 'staged');
    return {
      active: active.generation,
      ...(staged !== undefined ? { staged: { generation: staged.generation } } : {}),
      retiring: ours
        .filter((k) => k.phase === 'retiring' && k.retire_after !== undefined)
        .map((k) => ({ generation: k.generation, retireAfter: k.retire_after as number })),
    };
  }

  // ---------------------------------------------------------------- operations

  /**
   * The scheduled run: a pending owner control first, else the upload (boot, a
   * changed document, the daily re-upload). An upload never claims a newer
   * epoch: a label held elsewhere leaves the node stood down.
   */
  async publish(): Promise<PublicationStatus> {
    const start = await this.state();
    if (start.pendingControl === 'activate') return this.activate(false);
    if (start.pendingControl !== null) return this.control(start.pendingControl, false);
    if (!start.enabled || start.keyRetired) return start.status;
    const identity = this.identity();
    if (identity === null) return start.status;
    if (start.role === 'stood_down') return this.followHolder(identity, start.fence);
    const fence = start.fence;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const host = await this.readHost(identity.label);
      if (host === 'unreachable')
        return this.settle(fence, { status: 'unreachable', detail: 'host' });
      let state = await this.state();
      // The owner acted while this job ran: stop without sending.
      if (state.fence !== fence || !state.enabled) return state.status;
      if (host !== null) {
        const ours = host.instance === state.instance;
        if (
          host.epoch > state.epoch ||
          (host.epoch === state.epoch && !ours) ||
          (state.epoch === 0 && !ours)
        ) {
          return this.standDown(identity, fence, host);
        }
      } else if (state.epoch === 0) {
        // The first publish of an unbound label claims epoch 1.
        state = await this.update({ epoch: 1 });
      }
      // The ring this upload lists: this node's own, else the host's (or a new generation
      // above every one the host has seen); advanced to now; staged when the owner asked.
      const now = this.now();
      let keys =
        state.keys ??
        (host !== null ? this.ringFromHost(identity, host, state.generationFloor) : null) ??
        freshRing(
          Math.max(host === null ? 0 : host.highest_generation + 1, state.generationFloor ?? 0),
        );
      keys = advance(keys, now, KEY_SWITCH_WAIT_MS, KEY_OVERLAP_MS);
      if (state.rotate === true) keys = stage(keys, host?.highest_generation ?? 0);
      keys = stagedPublished(keys, now);
      const bytes = this.profileBytes(identity, keys);
      const envelope = await signPublication(
        {
          ...this.envelopeFields(
            state.epoch,
            state.instance,
            identity.label,
            (host?.revision ?? 0) + 1,
          ),
          op: 'upload',
          documents: { [UCP_VERSION]: documentHash(bytes, sha256) },
          keys: this.publishedKeys(identity, keys),
        },
        identity.signEnvelope,
        this.profileHost,
      );
      if (!this.stillHeld(identity)) return (await this.state()).status;
      const answer = await this.send(
        'PUT',
        hostEndpoints(identity.label, this.profileHost).profile,
        {
          envelope,
          documents: { [UCP_VERSION]: bytes },
        },
      );
      if (answer === 'unreachable')
        return this.settle(fence, { status: 'unreachable', detail: 'host' });
      if (answer.status !== 'refused') {
        const settled = await this.settle(fence, {
          status: 'served',
          detail: undefined,
          keys,
          rotate: undefined,
        });
        // The host lists this ring now: requests are signed with its active key from here.
        if ((await this.state()).fence === fence) this.signWith(keys.active);
        return settled;
      }
      if (answer.reason === 'stale_revision') continue;
      // A key this ring lists was retired at the host (the owner's compromise recovery on
      // another device): adopt the host's ring, or start a new generation, and try again.
      if (answer.reason === 'retired_key' && state.keys !== undefined) {
        await this.update({ keys: undefined });
        continue;
      }
      if (answer.reason === 'stale_epoch' || answer.reason === 'other_instance')
        return this.standDown(identity, fence, answer.state);
      return this.settle(fence, { status: 'refused', detail: answer.reason });
    }
    return this.settle(fence, { status: 'stale', detail: 'stale_revision' });
  }

  /**
   * Another device holds shopping: this one records the holder's ring and
   * signs with the key the holder made active (one seed, one key per
   * generation), so its requests verify; with none known (the host's state
   * unread, or no active key of this seed), it signs nothing.
   */
  private async standDown(
    identity: UcpIdentity,
    fence: number,
    host: PublicState | null,
  ): Promise<PublicationStatus> {
    const floor = (await this.state()).generationFloor;
    const held = host === null ? null : this.ringFromHost(identity, host, floor);
    const settled = await this.settle(fence, {
      role: 'stood_down',
      status: 'stood_down',
      detail: undefined,
      keys: held ?? undefined,
      rotate: undefined,
    });
    if ((await this.state()).fence === fence) this.signWith(held?.active ?? null);
    return settled;
  }

  /**
   * A pending press another device's later choice overtook: not applied. This
   * device stands down as any other does (taking the holder's keys at once),
   * and the owner is told why (`superseded`).
   */
  private async setAside(
    identity: UcpIdentity,
    fence: number,
    host: PublicState,
  ): Promise<PublicationStatus> {
    await this.standDown(identity, fence, host);
    return this.settle(fence, { pendingControl: null, detail: 'superseded' });
  }

  /**
   * A stood-down device's run: no upload, only the host's state read again,
   * so it follows the holder's rotations and retirements (the schedule runs
   * it hourly). Unreachable leaves everything as it was.
   */
  private async followHolder(identity: UcpIdentity, fence: number): Promise<PublicationStatus> {
    const host = await this.readHost(identity.label);
    if (host === 'unreachable') return (await this.state()).status;
    return this.standDown(identity, fence, host);
  }

  /**
   * The owner's "Use this device for shopping": claim the next epoch, then
   * publish. The ring is the host's (another device may have rotated): the
   * upload adopts it.
   */
  async activate(fresh = true): Promise<PublicationStatus> {
    const before = await this.state();
    const identity = this.identity();
    if (identity === null) return before.status;
    // The newest epoch known at the press, kept with a pending press (read before the host is).
    const atPress = fresh ? await this.knownEpoch() : before.controlEpoch;
    const host = await this.readHost(identity.label);
    if (host !== 'unreachable' && host !== null && this.superseded(before, host, fresh))
      return this.setAside(identity, before.fence, host);
    if (host === 'unreachable') {
      // The owner's word stands now: UCP on, a pending turn-off cancelled. Claiming the epoch
      // waits for the host (the schedule retries); a compromise still pending goes first.
      return (
        await this.update({
          enabled: true,
          pendingControl: before.keyRetired ? 'retire' : 'activate',
          // One fence move per press, not per retry.
          ...(before.pendingControl !== 'activate' ? { fence: before.fence + 1 } : {}),
          ...(atPress !== undefined ? { controlEpoch: atPress } : {}),
          status: 'unreachable',
          detail: 'host',
        })
      ).status;
    }
    const state = await this.state();
    await this.update({
      epoch: Math.max(state.epoch, host?.epoch ?? 0) + 1,
      role: 'active',
      enabled: true,
      // A compromise still being carried out stays pending: it completes before anything else.
      pendingControl: before.keyRetired ? 'retire' : null,
      controlEpoch: undefined,
      fence: state.fence + 1,
      // The device that last published may have rotated: adopt the host's ring.
      ...(before.role === 'stood_down' ? { keys: undefined } : {}),
    });
    return this.publish();
  }

  /**
   * The owner's "Rotate my shopping key" (U7): the next upload stages a new
   * generation; it signs once the host is seen serving it and the wait has
   * passed. Nothing happens while UCP is off or another device holds it.
   */
  async rotateKey(): Promise<PublicationStatus> {
    const state = await this.state();
    if (!state.enabled || state.role !== 'active' || state.keys?.staged !== undefined)
      return state.status;
    await this.update({ rotate: true, fence: state.fence + 1 });
    return this.publish();
  }

  /** The owner's "Turn UCP off": stop serving; nothing is retired. Kept until the host confirms. */
  async turnOff(): Promise<PublicationStatus> {
    const state = await this.state();
    // A retirement already pending covers a pause.
    const op = state.pendingControl === 'retire' ? 'retire' : 'pause';
    await this.update({
      enabled: false,
      pendingControl: op,
      controlEpoch: await this.knownEpoch(),
      fence: state.fence + 1,
      status: 'stopping',
      detail: undefined,
    });
    return this.control(op, true);
  }

  /**
   * The owner's "My key may be compromised": every key the profile lists is
   * retired for good at once (the host stops serving), then the profile is
   * published again under a new generation (U7: compromise recovery).
   */
  async retireKey(): Promise<PublicationStatus> {
    const state = await this.state();
    // The owner says the key may be in other hands: it stops signing now, before the host
    // confirms; merchant calls wait for the next generation. The ring goes from the record
    // too, so a restart before the host confirms cannot bring it back (the retirement names
    // every key the host lists, read just before it is sent).
    this.stopSigningNow();
    const listed = state.keys === undefined ? [] : listedGenerations(state.keys);
    await this.update({
      generationFloor: Math.max(state.generationFloor ?? 0, ...listed.map((g) => g + 1)),
      keyRetired: true,
      keys: undefined,
      rotate: undefined,
      pendingControl: 'retire',
      fence: state.fence + 1,
      status: 'stopping',
      detail: undefined,
    });
    return this.publish();
  }

  /**
   * Carry a pending owner control to the host. The owner acted on this device,
   * so it takes effect whichever installation last published: when the host
   * holds another installation's or a newer epoch, the control claims the next
   * epoch. Unreachable, or racing another claim, leaves it pending (`stopping`).
   */
  private async control(
    op: Exclude<PendingControl, 'activate'>,
    fresh: boolean,
  ): Promise<PublicationStatus> {
    const start = await this.state();
    const fence = start.fence;
    const identity = this.identity();
    // No identity (a sealed vault): stays pending until the next run with one.
    if (identity === null) return start.status;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const host = await this.readHost(identity.label);
      if (host === 'unreachable') return this.settle(fence, { status: 'stopping', detail: 'host' });
      // Never published: nothing to stop, and no key of this label registered to retire.
      if (host === null)
        return op === 'retire'
          ? this.retired(fence)
          : this.settle(fence, { pendingControl: null, status: 'off', detail: undefined });
      const state = await this.state();
      if (state.fence !== fence) return state.status;
      // A turn-off the owner pressed before another device chose shopping is not applied over that
      // choice (a compromise always is: retiring keys only makes things safer).
      if (op === 'pause' && this.superseded(state, host, fresh))
        return this.setAside(identity, fence, host);
      const ours =
        host.instance === state.instance && host.epoch === state.epoch && state.epoch > 0;
      const epoch = ours ? state.epoch : Math.max(state.epoch, host.epoch) + 1;
      const fields = this.envelopeFields(epoch, state.instance, identity.label, host.revision + 1);
      const envelope =
        op === 'pause'
          ? await signPublication({ ...fields, op }, identity.signEnvelope, this.profileHost)
          : await signPublication(
              {
                ...fields,
                op,
                // Every key the host lists for this label, read just now (another device may
                // have rotated since this one last looked), with this node's own ring and the key
                // it signs with: none of them may sign again.
                retire: [
                  ...new Set([
                    ...host.keys.map((k) => k.thumbprint),
                    ...(state.keys !== undefined
                      ? listedGenerations(state.keys).map((g) => identity.keyAt(g).jwk.kid)
                      : []),
                    ...(identity.signingKey() !== null ? [identity.key.jwk.kid] : []),
                  ]),
                ],
              },
              identity.signEnvelope,
              this.profileHost,
            );
      if (!this.stillHeld(identity)) return (await this.state()).status;
      const ends = hostEndpoints(identity.label, this.profileHost);
      const answer =
        op === 'pause'
          ? await this.send('DELETE', ends.profile, { envelope })
          : await this.send('POST', ends.retire, { envelope });
      if (answer === 'unreachable')
        return this.settle(fence, { status: 'stopping', detail: 'host' });
      if (answer.status !== 'refused') {
        if (op === 'retire') return this.retired(fence, epoch);
        return this.settle(fence, {
          epoch,
          role: 'active',
          pendingControl: null,
          status: 'off',
          detail: undefined,
        });
      }
      // Another change, or another installation's claim, landed first: read again.
      if (
        answer.reason === 'stale_revision' ||
        answer.reason === 'stale_epoch' ||
        answer.reason === 'other_instance'
      )
        continue;
      if (answer.reason === 'not_bound')
        return op === 'retire'
          ? this.retired(fence)
          : this.settle(fence, { pendingControl: null, status: 'off', detail: undefined });
      // Anything else will not change on a retry; the owner sees why it is not off.
      return this.settle(fence, { status: 'refused', detail: answer.reason });
    }
    return this.settle(fence, { status: 'stopping', detail: 'contended' });
  }

  /**
   * A compromise carried out (the host retired the keys, or never knew the
   * label): nothing has signed since the owner asked; the next generation,
   * at or above the floor, signs once its upload is accepted. Published at
   * once when UCP is on.
   */
  private async retired(fence: number, epoch?: number): Promise<PublicationStatus> {
    this.halted = false;
    const enabled = (await this.state()).enabled;
    const settled = await this.settle(fence, {
      ...(epoch !== undefined ? { epoch, role: 'active' as const } : {}),
      pendingControl: null,
      keyRetired: false,
      keys: undefined,
      rotate: undefined,
      status: enabled ? 'stale' : 'off',
      detail: undefined,
    });
    return enabled && settled === 'stale' ? this.publish() : settled;
  }

  /**
   * The hourly check: fetch the served profile and compare it byte for byte
   * with what this node built. Runs while the node publishes (served, stale,
   * or unreachable after a failed check), so one failure does not end it.
   */
  async verifyServed(): Promise<PublicationStatus> {
    const state = await this.state();
    const identity = this.identity();
    const checks =
      state.status === 'served' || state.status === 'stale' || state.status === 'unreachable';
    if (identity === null || !checks || !state.enabled || state.role !== 'active')
      return state.status;
    if (state.keys === undefined) return state.status;
    const fence = state.fence;
    const keys = state.keys;
    const r = await this.fetch(
      this.request('GET', profileUrlForLabel(identity.label, this.profileHost)),
    );
    if (!r.ok) return this.settle(fence, { status: 'unreachable', detail: 'profile' });
    const same =
      r.status === 200 &&
      new TextDecoder().decode(r.bodyBytes) === this.profileBytes(identity, keys);
    // Served as built: a staged key's wait counts from here (§4.8). Only for the ring read:
    // a run that changed it meanwhile (a switch, a new rotation) is never undone here.
    const current = await this.state();
    if (current.fence !== fence) return current.status;
    if (JSON.stringify(current.keys) !== JSON.stringify(keys)) return current.status;
    return this.settle(fence, {
      status: same ? 'served' : 'stale',
      detail: undefined,
      ...(same ? { keys: stagedConfirmed(keys, this.now()) } : {}),
    });
  }
}

const parseJson = jsonOrUndefined;

// ---------------------------------------------------------------- schedule

export interface PublisherSchedule {
  stop(): void;
  /** Run now (a changed document, an owner action); resets the backoff. */
  kick(): void;
  /**
   * Carry out an owner action (U7: rotate, turn off, …) one at a time with
   * the scheduled runs, then schedule from its result as after a run.
   */
  act(action: () => Promise<PublicationStatus>): Promise<PublicationStatus>;
}

export interface PublisherScheduleOptions {
  /** Timers, injectable for tests; production uses setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIRST_RETRY_MS = 60 * 1000;

/**
 * The upload lifecycle (§3.5): run at boot, every 24 hours, and after a
 * failure (or while an owner control is pending) with backoff from one minute,
 * doubling to an hour; compare the served copy every hour. One run at a time;
 * a kick during a run runs again as soon as it ends.
 *
 * Key rotation (U7, §4.8): an upload that lists a newly staged key is checked
 * against the served copy at once (the switch waits from that check), and the
 * next run is due no later than the ring's next step (the switch, a retiring
 * key's removal).
 */
/** What the schedule drives. */
export type ScheduledPublisher = Pick<
  UcpPublisher,
  'publish' | 'verifyServed' | 'awaitingConfirmation' | 'nextKeyStepAt'
>;

export function startPublisherSchedule(
  publisher: ScheduledPublisher,
  options: PublisherScheduleOptions = {},
): PublisherSchedule {
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
  let stopped = false;
  let running = false;
  let again = false;
  let backoff = FIRST_RETRY_MS;
  let next: unknown = null;
  let verifyTimer: unknown = null;

  const schedule = (ms: number): void => {
    if (stopped) return;
    if (next !== null) clearTimer(next);
    next = setTimer(() => void run(), ms);
  };
  const retry = (): void => {
    schedule(backoff);
    backoff = Math.min(backoff * 2, HOUR_MS);
  };
  /** Owner actions waiting for the run in progress. */
  let queue: Promise<unknown> = Promise.resolve();
  const after = async (status: PublicationStatus): Promise<void> => {
    if (status === 'served') {
      backoff = FIRST_RETRY_MS;
      // A newly staged key: confirm the host serves it now, not at the next hourly check.
      const confirmed = (await publisher.awaitingConfirmation().catch(() => false))
        ? await publisher.verifyServed().catch((): PublicationStatus => 'unreachable')
        : 'served';
      if (confirmed !== 'served') retry();
      else {
        const step = await publisher.nextKeyStepAt().catch(() => null);
        schedule(step === null ? DAY_MS : Math.min(DAY_MS, Math.max(0, step - now())));
      }
    } else if (status === 'unreachable' || status === 'stale' || status === 'stopping') {
      retry();
    } else if (status === 'stood_down') {
      // Another device holds shopping: read the host hourly to follow its keys (no upload).
      schedule(HOUR_MS);
    } else if (next !== null) {
      // off, refused: nothing scheduled until the owner acts (kick).
      clearTimer(next);
      next = null;
    }
  };
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const ran = queue.then(fn);
    queue = ran.catch(() => undefined);
    return ran;
  };
  const run = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await exclusive(async () => {
        const status = await publisher.publish().catch((): PublicationStatus => 'unreachable');
        await after(status);
      });
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        schedule(0);
      }
    }
  };
  const verify = (): void => {
    if (stopped) return;
    verifyTimer = setTimer(() => {
      // One at a time with runs and owner actions: a check never races a switch.
      void exclusive(() => publisher.verifyServed())
        .then((status) => {
          if (status === 'stale') {
            backoff = FIRST_RETRY_MS;
            schedule(0);
          }
        })
        .catch(() => undefined)
        .finally(verify);
    }, HOUR_MS);
  };

  schedule(0);
  verify();
  return {
    stop: () => {
      stopped = true;
      if (next !== null) clearTimer(next);
      if (verifyTimer !== null) clearTimer(verifyTimer);
    },
    kick: () => {
      backoff = FIRST_RETRY_MS;
      if (running) again = true;
      else schedule(0);
    },
    act: (action) =>
      exclusive(async () => {
        backoff = FIRST_RETRY_MS;
        // As a run: a failure is a fault to retry, never a lost schedule.
        const status = await action().catch((): PublicationStatus => 'unreachable');
        if (!stopped) await after(status);
        return status;
      }),
  };
}

const STATUSES: ReadonlySet<string> = new Set([
  'served',
  'stale',
  'unreachable',
  'refused',
  'stood_down',
  'off',
  'stopping',
]);

/** The stored publisher record, checked field by field; null when any field is wrong. */
export function readPublisherState(value: unknown): PublisherState | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.instance !== 'string' || !UUID_RE.test(v.instance)) return null;
  if (!isNonNegInt(v.epoch) || !isNonNegInt(v.fence)) return null;
  if (v.role !== 'active' && v.role !== 'stood_down') return null;
  if (typeof v.enabled !== 'boolean' || typeof v.keyRetired !== 'boolean') return null;
  const pending = v.pendingControl;
  if (pending !== null && pending !== 'pause' && pending !== 'retire' && pending !== 'activate')
    return null;
  if (typeof v.status !== 'string' || !STATUSES.has(v.status)) return null;
  if (v.detail !== undefined && typeof v.detail !== 'string') return null;
  const keys = v.keys === undefined ? undefined : readKeyRing(v.keys);
  if (keys === null) return null;
  if (v.rotate !== undefined && typeof v.rotate !== 'boolean') return null;
  if (v.generationFloor !== undefined && !isNonNegInt(v.generationFloor)) return null;
  if (v.hostEpoch !== undefined && !isNonNegInt(v.hostEpoch)) return null;
  if (v.controlEpoch !== undefined && !isNonNegInt(v.controlEpoch)) return null;
  return {
    instance: v.instance,
    epoch: v.epoch,
    role: v.role,
    fence: v.fence,
    enabled: v.enabled,
    keyRetired: v.keyRetired,
    pendingControl: pending,
    status: v.status as PublicationStatus,
    ...(v.detail !== undefined ? { detail: v.detail as string } : {}),
    ...(keys !== undefined ? { keys } : {}),
    ...(v.rotate === true ? { rotate: true } : {}),
    ...(v.generationFloor !== undefined ? { generationFloor: v.generationFloor as number } : {}),
    ...(v.hostEpoch !== undefined ? { hostEpoch: v.hostEpoch as number } : {}),
    ...(v.controlEpoch !== undefined ? { controlEpoch: v.controlEpoch as number } : {}),
  };
}
