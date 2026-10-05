/**
 * The owner's controls over UCP publication (UCP plan §3.5, §4.8; U7): what
 * the owner's UCP settings show (whether the host serves the profile, which
 * device holds shopping, the key ring) and the four actions: "Use this device
 * for shopping", "Turn UCP off", "Rotate my shopping key" and "My key may be
 * compromised". Each runs through the publisher's schedule, one at a time
 * with its runs. A host installs the pair when it starts the publisher.
 */

import { promoteAt } from '../../crypto/key_rotation';

import {
  KEY_SWITCH_WAIT_MS,
  type PublicationStatus,
  type PublisherSchedule,
  type UcpPublisher,
} from './publisher';

export interface UcpPublication {
  publisher: UcpPublisher;
  schedule: PublisherSchedule;
}

let installed: UcpPublication | null = null;

export function installUcpPublication(publication: UcpPublication | null): void {
  installed = publication;
}

export function getUcpPublication(): UcpPublication | null {
  return installed;
}

export type UcpPublicationAction = 'activate' | 'turn_off' | 'rotate' | 'compromised';

export const UCP_PUBLICATION_ACTIONS: readonly UcpPublicationAction[] = [
  'activate',
  'turn_off',
  'rotate',
  'compromised',
];

/** What the owner sees: no request content, no key material beyond generations and times. */
export interface UcpPublicationView {
  status: PublicationStatus;
  /** Whether this device holds shopping (`stood_down`: another one does). */
  role: 'active' | 'stood_down';
  enabled: boolean;
  /** "My key may be compromised" is still being carried out. */
  compromise_pending: boolean;
  /** An owner control the host has not confirmed (retried while `stopping`; not after a refusal). */
  pending_control: 'pause' | 'retire' | 'activate' | null;
  /** The host's refusal or fault, a short code. */
  detail: string | null;
  key: {
    generation: number;
    /** A rotation under way: the key that will sign, and when (null until the host is seen serving it). */
    next: { generation: number; signs_from: number | null } | null;
    /** Keys still listed after a rotation, each until its time. */
    retiring: { generation: number; until: number }[];
  } | null;
  /** The owner asked for a rotation the next upload has not started yet. */
  rotation_requested: boolean;
}

export async function ucpPublicationView(publisher: UcpPublisher): Promise<UcpPublicationView> {
  const s = await publisher.state();
  const keys = s.keys;
  return {
    status: s.status,
    role: s.role,
    enabled: s.enabled,
    compromise_pending: s.keyRetired,
    pending_control: s.pendingControl,
    detail: s.detail ?? null,
    key:
      keys === undefined
        ? null
        : {
            generation: keys.active,
            next:
              keys.staged === undefined
                ? null
                : {
                    generation: keys.staged.generation,
                    signs_from: promoteAt(keys, KEY_SWITCH_WAIT_MS),
                  },
            retiring: keys.retiring.map((r) => ({
              generation: r.generation,
              until: r.retireAfter,
            })),
          },
    rotation_requested: s.rotate === true,
  };
}

/** Carry out one owner action through the schedule; the status it leaves. */
export function runUcpPublicationAction(
  publication: UcpPublication,
  action: UcpPublicationAction,
): Promise<PublicationStatus> {
  const p = publication.publisher;
  // The compromised key stops signing now, not when the action's turn comes.
  if (action === 'compromised') p.stopSigningNow();
  const op =
    action === 'activate'
      ? () => p.activate()
      : action === 'turn_off'
        ? () => p.turnOff()
        : action === 'rotate'
          ? () => p.rotateKey()
          : () => p.retireKey();
  return publication.schedule.act(op);
}
