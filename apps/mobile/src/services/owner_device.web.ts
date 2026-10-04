/**
 * This browser as the owner's device (WEB_OWNER_SURFACE_PLAN §3.3) — WEB.
 *
 * The browser holds an Ed25519 signing key made by WebCrypto as
 * NON-EXTRACTABLE: the page can ask the browser to sign with it, but no
 * script can read it out. Core knows only its public half, registered as a
 * paired device with role `owner`. Every owner request the page sends is
 * signed with it (`owner_dispatcher.web.ts`); no reusable secret is kept.
 *
 * Connecting needs the owner, once: the owner key (the node's
 * `owner_capability`) mints a single-use pairing code, and the passphrase
 * proves a person is present where the node can check one. The owner key is
 * used for those two requests and then dropped; it is never stored.
 *
 * Only a page Core served may connect (`web_runtime.ts`): a page Brain serves
 * must never be where the owner key is typed.
 */

import { deriveDIDKey, publicKeyToMultibase, type RequestSigner } from '@dina/core';

import {
  OwnerDeviceError,
  type ConnectOwnerDeviceInput,
  type OwnerAccessState,
  type OwnerDeviceInfo,
} from './owner_device_types';
import { loadWebRuntimeConfig } from './web_runtime_config';

export { OwnerDeviceError };
export type { ConnectOwnerDeviceInput, OwnerAccessState, OwnerDeviceInfo };

/** Whether this surface offers "connect as the owner" at all. */
export const OWNER_ACCESS_ON_THIS_SURFACE = true;

interface StoredOwnerDevice {
  id: typeof RECORD_ID;
  did: string;
  deviceName: string;
  /** Non-extractable; IndexedDB keeps the CryptoKey by structured clone. */
  privateKey: CryptoKey;
}

const DB_NAME = 'dina-owner-device';
const STORE = 'device';
const RECORD_ID = 'owner';

const listeners = new Set<() => void>();

/**
 * Every tab of this origin shares the one stored device. The record is read
 * fresh on each use (no per-tab copy), so a disconnect in one tab stops every
 * tab signing at once; a BroadcastChannel tells the other tabs' screens to
 * redraw. It is open only while a screen here is listening.
 */
let tabs: BroadcastChannel | null = null;

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/** The owner device's signer, or null when this browser is not connected. */
export async function loadOwnerSigner(): Promise<RequestSigner | null> {
  const stored = await readRecord();
  if (stored === null) return null;
  return {
    did: stored.did,
    // `new Uint8Array(message)` gives WebCrypto an ArrayBuffer-backed view.
    sign: async (message) =>
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', stored.privateKey, new Uint8Array(message)),
      ),
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export async function ownerAccessState(): Promise<OwnerAccessState> {
  if (!(await loadWebRuntimeConfig()).servedByCore) {
    return {
      kind: 'unavailable',
      reason: 'Open Dina from your Home Node’s Core address to act as the owner here.',
    };
  }
  const stored = await readRecord();
  return stored === null
    ? { kind: 'disconnected' }
    : { kind: 'connected', device: { did: stored.did, deviceName: stored.deviceName } };
}

export function subscribeOwnerAccess(listener: () => void): () => void {
  listeners.add(listener);
  if (tabs === null && typeof BroadcastChannel !== 'undefined') {
    tabs = new BroadcastChannel(DB_NAME);
    tabs.onmessage = () => notify();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      tabs?.close();
      tabs = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

export async function connectOwnerDevice(input: ConnectOwnerDeviceInput): Promise<OwnerDeviceInfo> {
  if (!(await loadWebRuntimeConfig()).servedByCore) {
    throw new OwnerDeviceError(
      'not_served_by_core',
      'This page was not opened from your Home Node’s Core address, so it may not ask for the owner key.',
    );
  }
  // Another tab may have connected since this screen drew: one device per
  // browser, so a second pairing would only orphan the first.
  if ((await readRecord()) !== null) {
    changed();
    throw new OwnerDeviceError(
      'already_connected',
      'This browser is already connected as the owner.',
    );
  }
  const ownerHeader = { 'x-dina-owner-capability': input.ownerKey.trim() };

  // The key first, on a route that only reads: a wrong key is told apart
  // from a wrong passphrase, and never costs a passphrase attempt.
  const status = await requestJson('GET', '/v1/owner/setup/status', undefined, ownerHeader);
  if (status.status === 401 || status.status === 403) throw ownerKeyRejected();
  if (status.status !== 200) {
    throw new OwnerDeviceError(
      'pairing_failed',
      describe('Could not reach owner setup', status.body),
    );
  }

  if (input.passphrase !== '') {
    const proved = await requestJson(
      'POST',
      '/v1/commerce/catalog/drafts/presence',
      { passphrase: input.passphrase },
      ownerHeader,
    );
    // A node that cannot check a passphrase answers presence_unavailable (409);
    // it does not gate pairing either, so carry on.
    if (proved.status === 401 && proved.body.error === 'not_proven') {
      throw new OwnerDeviceError('passphrase_rejected', 'That passphrase is not right.');
    }
    if (proved.status !== 200 && proved.status !== 409) {
      throw new OwnerDeviceError(
        'pairing_failed',
        describe('Could not check the passphrase', proved.body),
      );
    }
  }

  const minted = await requestJson(
    'POST',
    '/v1/owner/setup/owner-device',
    { device_name: input.deviceName },
    ownerHeader,
  );
  if (minted.status === 403) {
    if (minted.body.error === 'no_user_presence') {
      throw new OwnerDeviceError(
        'presence_required',
        'Enter your passphrase to connect this browser.',
      );
    }
    throw ownerKeyRejected();
  }
  const code = typeof minted.body.code === 'string' ? minted.body.code : '';
  if (minted.status !== 201 || code === '') {
    throw new OwnerDeviceError('pairing_failed', describe('Could not start pairing', minted.body));
  }

  let keyPair: CryptoKeyPair;
  try {
    keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
  } catch {
    throw new OwnerDeviceError(
      'unsupported_browser',
      'This browser cannot make an Ed25519 key. Use a current Chrome, Safari or Firefox.',
    );
  }
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));

  const paired = await requestJson('POST', '/v1/pair/complete', {
    code,
    public_key_multibase: publicKeyToMultibase(publicKey),
  });
  if (paired.status !== 201 && paired.status !== 200) {
    throw new OwnerDeviceError('pairing_failed', describe('Pairing failed', paired.body));
  }

  const stored: StoredOwnerDevice = {
    id: RECORD_ID,
    did: deriveDIDKey(publicKey),
    // Core keeps the owner's name for the device; show the same one here.
    deviceName: input.deviceName.trim(),
    privateKey: keyPair.privateKey,
  };
  await writeRecord(stored);
  changed();
  return { did: stored.did, deviceName: stored.deviceName };
}

/**
 * Revoke this browser at Core (signed by the device itself) and forget the
 * key here. The key is forgotten even when the revoke cannot be confirmed
 * (the node unreachable, the device already revoked): a browser the owner
 * wants disconnected must stop signing now. The owner can revoke it from any
 * other owner surface later.
 */
export async function disconnectOwnerDevice(
  revoke: (did: string) => Promise<void>,
): Promise<{ revoked: boolean }> {
  const stored = await readRecord();
  if (stored === null) return { revoked: false };
  let revoked = false;
  try {
    await revoke(stored.did);
    revoked = true;
  } catch {
    // The dispatcher forgets a device Core no longer knows
    // (`forgetOwnerDeviceCoreDropped`): the record gone now means Core had
    // already revoked it elsewhere, which is the outcome asked for.
    revoked = (await readRecord()) === null;
  }
  await deleteRecord();
  changed();
  return { revoked };
}

/**
 * Core no longer recognises this device (revoked from the phone, the console
 * or another tab): forget the key so every screen reads "not connected" and
 * offers Connect, instead of failing each action with an authorization error.
 * Only the record that signed is forgotten; one another tab connected since
 * is left alone.
 */
export async function forgetOwnerDeviceCoreDropped(did: string): Promise<void> {
  const stored = await readRecord();
  if (stored === null || stored.did !== did) return;
  await deleteRecord();
  changed();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ownerKeyRejected(): OwnerDeviceError {
  return new OwnerDeviceError(
    'owner_key_rejected',
    'That owner key is not right for this Home Node.',
  );
}

function describe(prefix: string, body: Record<string, unknown>): string {
  const error = typeof body.error === 'string' ? body.error : '';
  return error === '' ? `${prefix}.` : `${prefix}: ${error}.`;
}

async function requestJson(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: 'omit',
    cache: 'no-store',
  });
  let parsed: unknown = {};
  try {
    parsed = await res.json();
  } catch {
    parsed = {};
  }
  return {
    status: res.status,
    body: parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** This tab's screens and every other tab's redraw from the stored record. */
function changed(): void {
  notify();
  if (typeof BroadcastChannel === 'undefined') return;
  // A channel never hears its own post, so the listening one carries it when
  // open (no second redraw here); otherwise a one-off channel does.
  if (tabs !== null) {
    tabs.postMessage('changed');
    return;
  }
  const once = new BroadcastChannel(DB_NAME);
  once.postMessage('changed');
  once.close();
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function readRecord(): Promise<StoredOwnerDevice | null> {
  try {
    const value = await withStore<StoredOwnerDevice | undefined>('readonly', (s) =>
      s.get(RECORD_ID),
    );
    return value ?? null;
  } catch {
    // No IndexedDB (private window, blocked storage): not connected.
    return null;
  }
}

async function writeRecord(value: StoredOwnerDevice): Promise<void> {
  await withStore('readwrite', (s) => s.put(value));
}

async function deleteRecord(): Promise<void> {
  try {
    await withStore('readwrite', (s) => s.delete(RECORD_ID));
  } catch {
    /* nothing stored to forget */
  }
}
