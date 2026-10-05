/**
 * The profile host's rules (UCP plan §3.5), as a pure state machine: given a
 * label's state and a verified publication envelope, the next state or the
 * reason it is refused, plus the log record to append. Storage, HTTP, the
 * off-host append-only log and DID resolution belong to the host process
 * (AppView); the envelope's signature and document hash are checked before
 * this runs (`verifyPublication`).
 *
 *  - Label ownership: the first valid upload binds the label to its DID for
 *    good; any other DID is refused whatever its revision.
 *  - Publisher epoch: an envelope from a lower epoch, or from the current
 *    epoch under another installation, is refused. A greater epoch (the owner's
 *    "Use this device for shopping") binds to its installation in the same
 *    compare-and-set that applies it, so of two activations from one observed
 *    state only one wins.
 *  - Revision: exactly the current one plus one, applied by compare-and-set.
 *    A repeat of an applied revision with identical bytes is a replay: success,
 *    no change. Anything else is refused with the current state.
 *  - Keys: every listed thumbprint must be a key in the document; a known
 *    thumbprint keeps its recorded generation; a new one must exceed every
 *    recorded generation; the highest never falls; a retired thumbprint is
 *    refused for ever, and a key an upload drops is retired.
 *  - Pause stops serving and retires nothing; retire adds thumbprints to the
 *    retired list, then stops serving.
 */

import {
  bytesToHex,
  canonicalize,
  isPlainObject,
  LOWER_HEX_64,
  parseStrictJson,
  utf8Bytes,
  type JsonObject,
} from '@dina/a2a';

import { es256Thumbprint } from './jwk';
import {
  DID_RE,
  isNonNegInt,
  LABEL_PATTERN,
  readKeyFields,
  THUMBPRINT_RE,
  UUID_RE,
  type PublicationEnvelope,
  type PublishedKey,
} from './publication';
import { UCP_VERSION } from './version';

import type { PublicState } from './host_api';
import type { Sha256Fn } from './signatures';

export interface HostKey {
  generation: number;
  phase: PublishedKey['phase'];
  not_before?: number;
  retire_after?: number;
}

export interface LabelState {
  did: string;
  revision: number;
  epoch: number;
  instance: string;
  /** Every key ever registered (retired ones included): thumbprint → its record. */
  keys: Readonly<Record<string, HostKey>>;
  retired: readonly string[];
  highestGeneration: number;
  serving: boolean;
  /** UCP version → the exact profile bytes served. */
  documents: Readonly<Record<string, string>>;
  /** revision → sha256 hex of the applied envelope's canonical bytes (for replay detection). */
  applied: Readonly<Record<string, string>>;
}

/** What the host appends to its off-host log before it answers (§3.5 "Surviving a host restore"). */
export interface HostLogRecord {
  label: string;
  did: string;
  revision: number;
  epoch: number;
  instance: string;
  op: PublicationEnvelope['op'];
  envelope_digest: string;
  highest_generation: number;
  retired_added: string[];
  /** The keys this change registered or updated (an upload's listed keys; empty otherwise). */
  keys_set: Record<string, HostKey>;
}

export type HostRefusal =
  | 'not_bound'
  | 'label_owned'
  | 'stale_epoch'
  | 'other_instance'
  | 'stale_revision'
  | 'document_keys'
  | 'retired_key'
  | 'generation';

export type HostOutcome =
  | { kind: 'applied'; state: LabelState; log: HostLogRecord }
  | { kind: 'replay'; state: LabelState }
  | { kind: 'refused'; reason: HostRefusal; state: LabelState | null };

/** The thumbprints of the ES256 keys a profile document lists. */
function documentThumbprints(profileBytes: string, sha256: Sha256Fn): Set<string> | null {
  const parsed = parseStrictJson(profileBytes);
  if (!parsed.ok || !isPlainObject(parsed.value) || !Array.isArray(parsed.value.keys)) return null;
  const out = new Set<string>();
  for (const k of parsed.value.keys) {
    if (
      isPlainObject(k) &&
      k.kty === 'EC' &&
      k.crv === 'P-256' &&
      typeof k.x === 'string' &&
      typeof k.y === 'string'
    ) {
      out.add(es256Thumbprint(k.x, k.y, sha256));
    }
  }
  return out;
}

/**
 * Apply a verified envelope to a label's state. `envelopeDigest` identifies
 * the exact envelope (sha256 of its canonical bytes); `profileBytes` are the
 * documents of an upload.
 */
export function applyPublication(
  state: LabelState | null,
  env: PublicationEnvelope,
  envelopeDigest: string,
  profileBytes: string | undefined,
  sha256: Sha256Fn,
): HostOutcome {
  // Ownership: a label is bound by its first valid upload, to that DID, for good.
  if (state === null) {
    if (env.op !== 'upload' || env.revision !== 1)
      return { kind: 'refused', reason: 'not_bound', state };
  } else if (state.did !== env.did) {
    return { kind: 'refused', reason: 'label_owned', state };
  }

  // Replay: a repeat of an applied revision with identical bytes changes nothing.
  if (state !== null && state.applied[String(env.revision)] === envelopeDigest)
    return { kind: 'replay', state };

  if (state !== null) {
    if (env.epoch < state.epoch) return { kind: 'refused', reason: 'stale_epoch', state };
    if (env.epoch === state.epoch && env.instance !== state.instance) {
      return { kind: 'refused', reason: 'other_instance', state };
    }
    if (env.revision !== state.revision + 1)
      return { kind: 'refused', reason: 'stale_revision', state };
  }

  const keys: Record<string, HostKey> = { ...(state?.keys ?? {}) };
  const retired = new Set(state?.retired ?? []);
  let highest = state?.highestGeneration ?? -1;
  let serving = state?.serving ?? false;
  let documents = state?.documents ?? {};
  const retiredAdded: string[] = [];
  const keysSet: Record<string, HostKey> = {};

  if (env.op === 'upload') {
    const listed = env.keys ?? [];
    const inDocument =
      profileBytes === undefined ? null : documentThumbprints(profileBytes, sha256);
    // The document serves exactly the keys the envelope registers: a key the
    // envelope left out would skip the retired list and the generation rules.
    if (
      inDocument === null ||
      inDocument.size !== listed.length ||
      !listed.every((k) => inDocument.has(k.thumbprint))
    ) {
      return { kind: 'refused', reason: 'document_keys', state };
    }
    if (listed.some((k) => retired.has(k.thumbprint)))
      return { kind: 'refused', reason: 'retired_key', state };
    let uploadHighest = -1;
    for (const k of listed) {
      const known = keys[k.thumbprint];
      if (known !== undefined ? known.generation !== k.generation : k.generation <= highest) {
        return { kind: 'refused', reason: 'generation', state };
      }
      uploadHighest = Math.max(uploadHighest, k.generation);
    }
    if (uploadHighest < highest) return { kind: 'refused', reason: 'generation', state };
    // A registered key the upload no longer lists is retired for good.
    const listedPrints = new Set(listed.map((k) => k.thumbprint));
    for (const thumbprint of Object.keys(keys)) {
      if (!listedPrints.has(thumbprint) && !retired.has(thumbprint)) {
        retired.add(thumbprint);
        retiredAdded.push(thumbprint);
      }
    }
    for (const k of listed) {
      const record: HostKey = {
        generation: k.generation,
        phase: k.phase,
        ...(k.not_before !== undefined ? { not_before: k.not_before } : {}),
        ...(k.retire_after !== undefined ? { retire_after: k.retire_after } : {}),
      };
      keys[k.thumbprint] = record;
      keysSet[k.thumbprint] = record;
    }
    highest = Math.max(highest, uploadHighest);
    serving = true;
    documents = { [UCP_VERSION]: profileBytes as string };
  } else if (env.op === 'pause') {
    serving = false;
  } else {
    for (const thumbprint of env.retire ?? []) {
      if (!retired.has(thumbprint)) {
        retired.add(thumbprint);
        retiredAdded.push(thumbprint);
      }
    }
    serving = false;
  }

  const next: LabelState = {
    did: env.did,
    revision: env.revision,
    epoch: env.epoch,
    instance: env.instance,
    keys,
    retired: [...retired],
    highestGeneration: highest,
    serving,
    documents,
    applied: { ...(state?.applied ?? {}), [String(env.revision)]: envelopeDigest },
  };
  return {
    kind: 'applied',
    state: next,
    log: {
      label: env.label,
      did: env.did,
      revision: env.revision,
      epoch: env.epoch,
      instance: env.instance,
      op: env.op,
      envelope_digest: envelopeDigest,
      highest_generation: highest,
      retired_added: retiredAdded,
      keys_set: keysSet,
    },
  };
}

/** The public state document (`GET /v1/profiles/<label>/state`): no DID, nothing the profile does not imply. */
export function publicState(state: LabelState): PublicState {
  return {
    revision: state.revision,
    epoch: state.epoch,
    instance: state.instance,
    highest_generation: state.highestGeneration,
    keys: Object.entries(state.keys)
      .filter(([thumbprint]) => !state.retired.includes(thumbprint))
      .map(([thumbprint, k]) => ({ thumbprint, ...k })),
    retired: [...state.retired],
    serving: state.serving,
  };
}

/** The digest that identifies an exact envelope: sha256 hex of its RFC 8785 bytes. */
export function envelopeDigest(env: PublicationEnvelope, sha256: Sha256Fn): string {
  return bytesToHex(sha256(utf8Bytes(canonicalize(env as unknown as JsonObject))));
}

export type CatchUp =
  | { ok: true; state: LabelState | null }
  | { ok: false; reason: 'other_did' | 'revision_gap' | 'counter_back' };

/**
 * Bring a label's stored state up to its off-host log (§3.5 "Surviving a host
 * restore"). `records` are the label's log records newer than `state.revision`,
 * in the order they were appended. The binding, revision, epoch, instance,
 * highest generation, registered keys and retired list come back from the log;
 * the documents do not (the log never holds them), so a label that was behind
 * serves nothing until its node uploads again. No counter goes back and no
 * retirement is lost. `state: null` when there is nothing to change.
 *
 * The records must read as one history of this label: one DID (the stored
 * binding's, when there is one); revisions that each repeat the last or add one
 * (a repeat is an append whose database write failed, then retried), starting
 * right after the stored revision; an epoch and a highest generation that never
 * fall. Anything else (a missing record, a rebinding, a counter going back) is
 * a damaged or tampered log, and the label must serve nothing.
 */
export function catchUpFromLog(
  state: LabelState | null,
  records: readonly HostLogRecord[],
): CatchUp {
  const newer = records.filter((r) => state === null || r.revision > state.revision);
  const last = newer[newer.length - 1];
  if (last === undefined) return { ok: true, state: null };
  const did = state?.did ?? (newer[0] as HostLogRecord).did;
  let revision = state?.revision ?? 0;
  let epoch = state?.epoch ?? 0;
  let highest = state?.highestGeneration ?? -1;
  const keys: Record<string, HostKey> = { ...(state?.keys ?? {}) };
  const retired = new Set(state?.retired ?? []);
  const applied: Record<string, string> = { ...(state?.applied ?? {}) };
  for (const r of newer) {
    if (r.did !== did) return { ok: false, reason: 'other_did' };
    if (r.revision !== revision && r.revision !== revision + 1)
      return { ok: false, reason: 'revision_gap' };
    if (r.epoch < epoch || r.highest_generation < highest)
      return { ok: false, reason: 'counter_back' };
    revision = r.revision;
    epoch = r.epoch;
    highest = r.highest_generation;
    Object.assign(keys, r.keys_set);
    for (const t of r.retired_added) retired.add(t);
    applied[String(r.revision)] = r.envelope_digest;
  }
  return {
    ok: true,
    state: {
      did,
      revision: last.revision,
      epoch: last.epoch,
      instance: last.instance,
      keys,
      retired: [...retired],
      highestGeneration: highest,
      serving: false,
      documents: {},
      applied,
    },
  };
}

const RECORD_MEMBERS = [
  'label',
  'did',
  'revision',
  'epoch',
  'instance',
  'op',
  'envelope_digest',
  'highest_generation',
  'retired_added',
  'keys_set',
];

/** A log record read back from the off-host store, checked member by member; null when any is wrong. */
export function readHostLogRecord(value: unknown): HostLogRecord | null {
  if (!isPlainObject(value)) return null;
  const own = Object.keys(value);
  if (own.length !== RECORD_MEMBERS.length || !RECORD_MEMBERS.every((k) => own.includes(k)))
    return null;
  const v = value;
  if (typeof v.label !== 'string' || !LABEL_PATTERN.test(v.label)) return null;
  if (typeof v.did !== 'string' || !DID_RE.test(v.did)) return null;
  if (!isNonNegInt(v.revision) || v.revision < 1 || !isNonNegInt(v.epoch)) return null;
  if (typeof v.instance !== 'string' || !UUID_RE.test(v.instance)) return null;
  if (v.op !== 'upload' && v.op !== 'pause' && v.op !== 'retire') return null;
  if (typeof v.envelope_digest !== 'string' || !LOWER_HEX_64.test(v.envelope_digest)) return null;
  if (typeof v.highest_generation !== 'number' || !Number.isSafeInteger(v.highest_generation))
    return null;
  if (v.highest_generation < -1) return null;
  if (!Array.isArray(v.retired_added)) return null;
  if (!v.retired_added.every((t) => typeof t === 'string' && THUMBPRINT_RE.test(t))) return null;
  if (!isPlainObject(v.keys_set)) return null;
  const keys: Record<string, HostKey> = {};
  for (const [t, k] of Object.entries(v.keys_set)) {
    const key = readKeyFields(k);
    if (!THUMBPRINT_RE.test(t) || key === null) return null;
    keys[t] = key;
  }
  return {
    label: v.label,
    did: v.did,
    revision: v.revision,
    epoch: v.epoch,
    instance: v.instance,
    op: v.op,
    envelope_digest: v.envelope_digest,
    highest_generation: v.highest_generation,
    retired_added: [...(v.retired_added as string[])],
    keys_set: keys,
  };
}

const STATE_MEMBERS = [
  'did',
  'revision',
  'epoch',
  'instance',
  'keys',
  'retired',
  'highestGeneration',
  'serving',
  'documents',
  'applied',
];

/** A stored LabelState read back, checked member by member; null when any is wrong. */
export function readLabelState(value: unknown): LabelState | null {
  if (!isPlainObject(value)) return null;
  const own = Object.keys(value);
  if (own.length !== STATE_MEMBERS.length || !STATE_MEMBERS.every((k) => own.includes(k)))
    return null;
  const v = value;
  if (typeof v.did !== 'string' || !DID_RE.test(v.did)) return null;
  if (!isNonNegInt(v.revision) || v.revision < 1 || !isNonNegInt(v.epoch)) return null;
  if (typeof v.instance !== 'string' || !UUID_RE.test(v.instance)) return null;
  if (typeof v.highestGeneration !== 'number' || !Number.isSafeInteger(v.highestGeneration))
    return null;
  if (v.highestGeneration < -1 || typeof v.serving !== 'boolean') return null;
  if (!Array.isArray(v.retired)) return null;
  if (!v.retired.every((t) => typeof t === 'string' && THUMBPRINT_RE.test(t))) return null;
  if (!isPlainObject(v.keys) || !isPlainObject(v.documents) || !isPlainObject(v.applied))
    return null;
  const keys: Record<string, HostKey> = {};
  for (const [t, k] of Object.entries(v.keys)) {
    const key = readKeyFields(k);
    if (!THUMBPRINT_RE.test(t) || key === null) return null;
    keys[t] = key;
  }
  const documents: Record<string, string> = {};
  for (const [version, bytes] of Object.entries(v.documents)) {
    if (version !== UCP_VERSION || typeof bytes !== 'string') return null;
    documents[version] = bytes;
  }
  const applied: Record<string, string> = {};
  for (const [revision, digest] of Object.entries(v.applied)) {
    if (!/^[1-9][0-9]*$/.test(revision)) return null;
    if (typeof digest !== 'string' || !LOWER_HEX_64.test(digest)) return null;
    applied[revision] = digest;
  }
  return {
    did: v.did,
    revision: v.revision,
    epoch: v.epoch,
    instance: v.instance,
    keys,
    retired: [...(v.retired as string[])],
    highestGeneration: v.highestGeneration,
    serving: v.serving,
    documents,
    applied,
  };
}
