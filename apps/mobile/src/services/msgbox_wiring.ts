/**
 * MsgBox transport wiring for the Expo boot path.
 *
 * Three knobs the mobile boot needs to actually carry D2D bytes:
 *
 *   `msgboxURL`     — WebSocket URL of the shared relay. Resolved by the
 *                     shared Home Node endpoint policy. Test mode is the
 *                     default; release mode moves MsgBox, PDS, AppView,
 *                     and PLC config together.
 *
 *   `wsFactory`     — Wraps RN's global `WebSocket`. The core msgbox_ws
 *                     client drives the handshake + read pump; all we do
 *                     here is hand it a `WSLike`.
 *
 *   `resolveSender` — Called on every inbound D2D envelope. For a known
 *                     DID:PLC peer we fetch + cache the PLC doc via
 *                     DIDResolver, pull the Ed25519 signing key out of
 *                     the first verificationMethod, and return it paired
 *                     with the contact's trust level. `did:key` is a
 *                     local derivation (no network). Unknown or
 *                     unresolvable senders get `{ keys: [], trust:
 *                     'unknown' }` so the receive pipeline quarantines
 *                     them rather than crashing on a verify-miss.
 *
 * Self-lookups are answered locally so we never round-trip to PLC for
 * our own DID (and so a did:key self-identity that has no PLC doc
 * still works). The caller passes our identity in as a closure.
 */

import {
  makeResolveSender,
  resolveHostedDinaEndpoints,
  type MakeResolveSenderOptions,
} from '@dina/home-node';

import { mobileHostedEndpoints } from './hosted_endpoints';

import type { WSFactory, WSLike } from '@dina/core/d2d';

/** Default shared Dina mailbox for greenfield test installs. */
export const DEFAULT_MSGBOX_URL = resolveHostedDinaEndpoints('test').msgboxWsUrl;

export function resolveMsgBoxURL(): string {
  return mobileHostedEndpoints().msgboxWsUrl;
}

/**
 * RN WebSocket factory. Relies on the global `WebSocket` constructor
 * every RN runtime ships — we cast to `WSLike` because RN's type
 * doesn't carry `readyState` in the same shape Core expects, but at
 * runtime the fields line up.
 */
export function makeWSFactory(): WSFactory {
  return (url: string): WSLike => {
    const ws = new WebSocket(url);
    return ws as unknown as WSLike;
  };
}

// `makeResolveSender` + `pickEd25519VerificationMethod` are now
// shared via `@dina/home-node` so the lite Core's boot consumes the
// exact same logic. Mobile re-exports them here so legacy callers
// (boot_capabilities.ts) keep their existing import path.
export { makeResolveSender } from '@dina/home-node';
export type { MakeResolveSenderOptions } from '@dina/home-node';
