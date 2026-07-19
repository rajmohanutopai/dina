/**
 * D2D message delivery — MsgBox relay only.
 *
 * Every recipient's DID document advertises a `DinaMsgBox` endpoint
 * (a `wss://…/ws` URL). Delivery converts it to `https://…/forward`
 * and POSTs the sealed payload. The pre-0.16 `DinaDirectHTTPS`
 * alternative was removed: no identity-creation path ever produced
 * it, and direct delivery couldn't reach NAT'd Home Nodes (mobile,
 * residential servers) anyway.
 *
 * Includes: dead drop drain on persona unlock, DID resolution caching.
 *
 * Source: core/test/transport_test.go
 */

import { bytesToHex } from '@noble/hashes/utils.js';

import { getPublicKey } from '../crypto/ed25519';
import { buildForwardHeaders } from '../relay/msgbox_forward';
import { defaultFetch } from '../runtime/fetch';

import { isDiscoverableURL } from './ssrf';


export interface DeliveryResult {
  delivered: boolean;
  buffered: boolean;
  messageId?: string;
  error?: string;
}

/** Sender identity for building MsgBox /forward auth headers. */
export interface SenderIdentity {
  did: string;
  privateKey: Uint8Array;
}

/** Injectable WS delivery function — tries WebSocket before HTTP /forward. */
export type WSDeliverFn = (
  recipientDID: string,
  recipientPub: Uint8Array,
  payload: Record<string, unknown>,
) => boolean;

interface CachedResolution {
  endpoint: string;
  cachedAt: number;
}

const DID_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** In-memory DID → messaging endpoint resolution cache. */
const didCache = new Map<string, CachedResolution>();

/** Injectable fetch function. Tests can override via `setDeliveryFetchFn`. */
let fetchFn: typeof globalThis.fetch = defaultFetch();

/** Injectable DID resolver (for testing/integration). */
let didResolver: ((did: string) => Promise<{ endpoint: string } | null>) | null = null;

/** Injectable spool drain handler (for testing/integration). */
let spoolDrainHandler: (() => Promise<number>) | null = null;

/** Injectable WS delivery (for WS-first send path). */
let wsDeliverFn: WSDeliverFn | null = null;

/** Clear the DID resolution cache (for testing). */
export function clearDIDCache(): void {
  didCache.clear();
}

/** Get the DID cache size (for testing). */
export function didCacheSize(): number {
  return didCache.size;
}

/** Set the fetch function (for testing). */
export function setDeliveryFetchFn(fn: typeof globalThis.fetch): void {
  fetchFn = fn;
}

/** Set the DID resolver (for testing/integration). */
export function setDIDResolver(
  resolver: (did: string) => Promise<{ endpoint: string } | null>,
): void {
  didResolver = resolver;
}

/** Set the spool drain handler (for testing/integration). */
export function setSpoolDrainHandler(handler: () => Promise<number>): void {
  spoolDrainHandler = handler;
}

/** Set the WS delivery function (called by runtime startup to enable WS-first delivery). */
export function setWSDeliverFn(fn: WSDeliverFn | null): void {
  wsDeliverFn = fn;
}

/** Get the installed WS delivery function (null when MsgBox isn't bootstrapped). */
export function getWSDeliverFn(): WSDeliverFn | null {
  return wsDeliverFn;
}

/** Reset all injectable dependencies (for testing). */
export function resetDeliveryDeps(): void {
  fetchFn = defaultFetch();
  didResolver = null;
  spoolDrainHandler = null;
  wsDeliverFn = null;
}

/**
 * Convert a MsgBox WebSocket URL to the HTTP /forward URL.
 *
 * Matches Go server transport.go:462-471:
 *   wss:// → https://
 *   ws://  → http://
 *   Strip trailing /ws or /
 *   Append /forward
 */
export function msgboxWSToForwardURL(wsURL: string): string {
  let url = wsURL;

  if (url.startsWith('wss://')) {
    url = 'https://' + url.slice(6);
  } else if (url.startsWith('ws://')) {
    url = 'http://' + url.slice(5);
  }

  if (url.endsWith('/ws')) {
    url = url.slice(0, -3);
  }

  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }

  return url + '/forward';
}

/** Invalidate the DID resolution cache entry for a specific DID. */
export function invalidateDIDCache(did: string): void {
  didCache.delete(did);
}

/** Add a resolution to the DID cache. */
export function cacheDIDResolution(did: string, endpoint: string): void {
  didCache.set(did, { endpoint, cachedAt: Date.now() });
}

/** Look up a DID in the resolution cache. Returns null if not cached or expired. */
export function lookupDIDCache(did: string, now?: number): { endpoint: string } | null {
  const cached = didCache.get(did);
  if (!cached) return null;

  const currentTime = now ?? Date.now();
  if (currentTime - cached.cachedAt > DID_CACHE_TTL_MS) {
    didCache.delete(did);
    return null;
  }

  return { endpoint: cached.endpoint };
}

/**
 * Deliver a sealed D2D payload to a recipient via their MsgBox endpoint.
 *
 * POSTs to `https://<host>/forward` with the 6 auth headers built by
 * `buildForwardHeaders` (Ed25519-signed by the sender). MsgBox responds
 * `{"status":"delivered"}` (recipient online) or `{"status":"buffered"}`
 * (queued for later pickup).
 *
 * @param senderIdentity — required to build /forward auth headers. When
 *   omitted, the call falls back to an unsigned POST. MsgBox will reject
 *   the unsigned form in production; the option exists only to keep
 *   legacy fixtures compiling.
 */
export async function deliverMessage(
  recipientDID: string,
  payload: Uint8Array,
  endpoint: string,
  senderIdentity?: SenderIdentity,
): Promise<DeliveryResult> {
  // SSRF protection: block delivery to private/reserved IPs
  if (!isDiscoverableURL(endpoint)) {
    return {
      delivered: false,
      buffered: false,
      error: `SSRF blocked: endpoint "${endpoint}" resolves to a private or reserved address`,
    };
  }

  try {
    const forwardURL = msgboxWSToForwardURL(endpoint);

    // Build request headers: include auth headers when sender identity is available
    const reqHeaders: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (senderIdentity) {
      const pubHex = bytesToHex(getPublicKey(senderIdentity.privateKey));
      const authHeaders = buildForwardHeaders(
        recipientDID,
        senderIdentity.did,
        pubHex,
        senderIdentity.privateKey,
        payload,
      );
      Object.assign(reqHeaders, authHeaders);
    }

    const response = await fetchFn(forwardURL, {
      method: 'POST',
      headers: reqHeaders,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: payload as any,
    });

    if (!response.ok) {
      return { delivered: false, buffered: false, error: `HTTP ${response.status}` };
    }

    const body = (await response.json()) as Record<string, unknown>;
    const status = body.status as string;

    return {
      delivered: status === 'delivered',
      buffered: status === 'buffered',
      messageId: body.msg_id as string | undefined,
    };
  } catch (err) {
    return {
      delivered: false,
      buffered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Drain the dead drop spool — process all spooled messages after
 * a persona vault is unlocked.
 *
 * Delegates to the injected spool drain handler.
 * Returns the count of drained messages.
 */
export async function drainDeadDrop(): Promise<number> {
  if (!spoolDrainHandler) return 0;
  return spoolDrainHandler();
}

/**
 * Resolve a DID to its messaging service endpoint.
 *
 * Checks the local cache first (10-min TTL). On cache miss,
 * delegates to the injected DID resolver.
 */
export async function resolveMessagingEndpoint(
  did: string,
): Promise<{ endpoint: string } | null> {
  // Check cache first
  const cached = lookupDIDCache(did);
  if (cached) return cached;

  // Delegate to injected resolver
  if (!didResolver) return null;

  const resolved = await didResolver(did);
  if (resolved) {
    cacheDIDResolution(did, resolved.endpoint);
  }
  return resolved;
}
