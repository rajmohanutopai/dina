/**
 * The profile host's HTTP contract (UCP plan §3.5), shared by the node's
 * publisher (Core) and the host (AppView):
 *
 *   PUT    https://<host>/v1/profiles/<label>          upload  {envelope, documents}
 *   DELETE https://<host>/v1/profiles/<label>          pause   {envelope}
 *   POST   https://<host>/v1/profiles/<label>/retire   retire  {envelope}
 *   GET    https://<host>/v1/profiles/<label>/state    the public state, or 404 when unbound
 *   GET    https://<label>.<host>/.well-known/ucp      the served profile
 *
 * Every answer to a change is `{status, state}`: `applied` or `replay` (both
 * success), or `refused` with a reason and the current state, so the node can
 * read it and try again.
 */

import { isPlainObject } from '@dina/a2a';

import {
  isNonNegInt,
  LABEL_PATTERN,
  readPublishedKey,
  THUMBPRINT_RE,
  UCP_PROFILE_HOST,
  UUID_RE,
  type PublicationEnvelope,
  type PublishedKey,
} from './publication';

import type { HostRefusal } from './host';

/** How long the host lets a served profile be cached (§3.5, timed for key rotation, §4.8). */
export const PROFILE_MAX_AGE_SECONDS = 300;

export interface HostEndpoints {
  /** PUT to upload, DELETE to pause. */
  profile: string;
  retire: string;
  state: string;
}

export function hostEndpoints(
  label: string,
  profileHost: string = UCP_PROFILE_HOST,
): HostEndpoints {
  if (!LABEL_PATTERN.test(label)) throw new Error('host api: bad label');
  const base = `https://${profileHost}/v1/profiles/${label}`;
  return { profile: base, retire: `${base}/retire`, state: `${base}/state` };
}

export interface UploadBody {
  envelope: PublicationEnvelope;
  /** UCP version → the exact profile text the envelope hashes. */
  documents: Record<string, string>;
}

export interface ControlBody {
  envelope: PublicationEnvelope;
}

/** A key in the public state: the published key record. */
export type PublicKeyState = PublishedKey;

/** The public state of a label (no DID). */
export interface PublicState {
  revision: number;
  epoch: number;
  instance: string;
  highest_generation: number;
  keys: PublicKeyState[];
  retired: string[];
  serving: boolean;
}

export type HostAnswer =
  | { status: 'applied' | 'replay'; state: PublicState }
  | { status: 'refused'; reason: HostRefusal | 'invalid'; state: PublicState | null };

const REFUSALS: ReadonlySet<string> = new Set([
  'not_bound',
  'label_owned',
  'stale_epoch',
  'other_instance',
  'stale_revision',
  'document_keys',
  'retired_key',
  'generation',
  'invalid',
]);

const STATE_MEMBERS = [
  'revision',
  'epoch',
  'instance',
  'highest_generation',
  'keys',
  'retired',
  'serving',
];

/** The public state, read strictly: exactly its members, each checked. */
export function parsePublicState(value: unknown): PublicState | null {
  if (!isPlainObject(value)) return null;
  const own = Object.keys(value);
  if (own.length !== STATE_MEMBERS.length || !STATE_MEMBERS.every((k) => own.includes(k)))
    return null;
  const { revision, epoch, instance, highest_generation, keys, retired, serving } = value;
  if (!isNonNegInt(revision) || !isNonNegInt(epoch)) return null;
  if (typeof instance !== 'string' || !UUID_RE.test(instance)) return null;
  if (typeof highest_generation !== 'number' || !Number.isSafeInteger(highest_generation))
    return null;
  if (highest_generation < -1 || typeof serving !== 'boolean') return null;
  if (
    !Array.isArray(retired) ||
    !retired.every((t) => typeof t === 'string' && THUMBPRINT_RE.test(t))
  )
    return null;
  if (!Array.isArray(keys)) return null;
  const parsedKeys: PublicKeyState[] = [];
  for (const k of keys) {
    const key = readPublishedKey(k);
    if (key === null) return null;
    parsedKeys.push(key);
  }
  return {
    revision,
    epoch,
    instance,
    highest_generation,
    keys: parsedKeys,
    retired: retired as string[],
    serving,
  };
}

export function parseHostAnswer(value: unknown): HostAnswer | null {
  if (!isPlainObject(value)) return null;
  if (value.status === 'applied' || value.status === 'replay') {
    const state = parsePublicState(value.state);
    return state === null ? null : { status: value.status, state };
  }
  if (
    value.status === 'refused' &&
    typeof value.reason === 'string' &&
    REFUSALS.has(value.reason)
  ) {
    const state =
      value.state === null || value.state === undefined ? null : parsePublicState(value.state);
    if (value.state !== null && value.state !== undefined && state === null) return null;
    return { status: 'refused', reason: value.reason as HostRefusal | 'invalid', state };
  }
  return null;
}
