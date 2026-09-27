/**
 * This device as the owner's (WEB_OWNER_SURFACE_PLAN §3.3) — PHONE version.
 *
 * On the phone the in-app user IS the owner and owner calls run in-process;
 * there is nothing to connect. The browser build has the real version
 * (`owner_device.web.ts`); this one exports the same names so shared screens
 * compile, and says owner access is not a phone concept.
 */

import {
  OwnerDeviceError,
  type ConnectOwnerDeviceInput,
  type OwnerAccessState,
  type OwnerDeviceInfo,
} from './owner_device_types';

import type { RequestSigner } from '@dina/core';

export { OwnerDeviceError };
export type { ConnectOwnerDeviceInput, OwnerAccessState, OwnerDeviceInfo };

/** Whether this surface offers "connect as the owner" at all. */
export const OWNER_ACCESS_ON_THIS_SURFACE = false;

export async function loadOwnerSigner(): Promise<RequestSigner | null> {
  return null;
}

export async function ownerAccessState(): Promise<OwnerAccessState> {
  return { kind: 'not_applicable' };
}

export async function connectOwnerDevice(
  _input: ConnectOwnerDeviceInput,
): Promise<OwnerDeviceInfo> {
  throw new OwnerDeviceError('not_applicable', 'Owner access is not needed on the phone.');
}

export async function disconnectOwnerDevice(
  _revoke: (did: string) => Promise<void>,
): Promise<{ revoked: boolean }> {
  return { revoked: false };
}

export async function forgetOwnerDeviceCoreDropped(_did: string): Promise<void> {
  /* the phone signs nothing as an owner device */
}

export function subscribeOwnerAccess(_listener: () => void): () => void {
  return () => undefined;
}
