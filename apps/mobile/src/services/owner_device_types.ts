/**
 * The shape both versions of `owner_device` share (WEB_OWNER_SURFACE_PLAN
 * §3.3): the phone version, which has nothing to connect, and the browser
 * version, which connects this browser as the owner's device. Kept in one
 * place so the two cannot drift, and so shared screens type-check against
 * either.
 */

export interface OwnerDeviceInfo {
  did: string;
  deviceName: string;
}

export type OwnerAccessState =
  | { kind: 'not_applicable' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'disconnected' }
  | { kind: 'connected'; device: OwnerDeviceInfo };

export interface ConnectOwnerDeviceInput {
  /** The node's owner key (`owner_capability`). Used twice, never stored. */
  ownerKey: string;
  /** The owner passphrase, where the node checks one; `''` otherwise. */
  passphrase: string;
  deviceName: string;
}

/** Refusals `connectOwnerDevice` can raise, by key, so the screen can say what to fix. */
export class OwnerDeviceError extends Error {
  constructor(
    readonly errorKey:
      | 'not_applicable'
      | 'not_served_by_core'
      | 'unsupported_browser'
      | 'owner_key_rejected'
      | 'passphrase_rejected'
      | 'presence_required'
      | 'already_connected'
      | 'pairing_failed',
    message: string,
  ) {
    super(message);
    this.name = 'OwnerDeviceError';
  }
}
