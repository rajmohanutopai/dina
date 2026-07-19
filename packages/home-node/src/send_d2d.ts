/**
 * `makeSendD2D` — shared outbound-D2D builder.
 *
 * Both mobile (`apps/mobile/src/services/boot_capabilities.ts`) and
 * lite Core (`apps/home-node-lite/core-server/src/workflow/...`)
 * build the same `sendD2D(to, type, body)` callback: resolve the
 * recipient's DID doc, pull the Ed25519 signing VM + the
 * `#dina-messaging` endpoint, hand off to `@dina/core.sendD2D`. The
 * only platform difference is the source of the signing key + the
 * default MsgBox URL.
 *
 * Keep this module runtime-agnostic: no node-fs, no react-native
 * primitives. Pure logic over `@dina/core`'s D2D APIs +
 * `pickEd25519VerificationMethod` shared helper.
 */

import { multibaseToPublicKey } from '@dina/core';
import { DIDResolver, sendD2D as coreSendD2D } from '@dina/core/runtime';

import { pickEd25519VerificationMethod } from './resolve_sender';

import type { AppViewServiceResolver, D2DOutboxRow, RedeliverOutcome } from '@dina/core';


export interface MakeSendD2DOptions {
  /** Our own DID — signed as sender on every outbound envelope. */
  senderDID: string;
  /** Our own Ed25519 private signing key (32-byte seed). */
  senderPrivateKey: Uint8Array;
  /**
   * Default MsgBox endpoint used when the recipient's DID doc doesn't
   * advertise its own `#dina-messaging` service. Most peers will
   * publish their own, so this is the fall-back path.
   */
  defaultMsgboxEndpoint: string;
  /** Optional shared DIDResolver — caches PLC fetches across calls. */
  resolver?: DIDResolver;
  /**
   * Optional AppView resolver consulted by `coreSendD2D` to bypass
   * the contact gate when the recipient is a published public-service
   * DID. Without this, the first cross-Dina `service.query` is
   * denied at contact even though the recipient advertises the
   * capability on AppView.
   */
  providerServiceResolver?: AppViewServiceResolver;
}

export type SendD2D = (
  to: string,
  type: string,
  body: Record<string, unknown>,
) => Promise<void>;

const sharedResolver = new DIDResolver();

/**
 * Build a `sendD2D` callback ready to plug into Core's setD2DSender
 * registry, mobile's `createNode.sendD2D` input, or the response-
 * bridge sender. Throws on resolution / signing-key-missing / send-
 * denied — callers wrap in their own audit hooks if needed.
 */
export function makeSendD2D(opts: MakeSendD2DOptions): SendD2D {
  const resolver = opts.resolver ?? sharedResolver;

  return async (to, type, body) => {
    const resolved = await resolver.resolve(to);
    const vm = pickEd25519VerificationMethod(resolved.document.verificationMethod);
    if (vm === null || typeof vm.publicKeyMultibase !== 'string') {
      throw new Error(
        `sendD2D: recipient ${to} has no Ed25519 signing key in its DID doc`,
      );
    }
    const recipientPublicKey = multibaseToPublicKey(vm.publicKeyMultibase);
    const endpoint = resolved.messagingService?.endpoint ?? opts.defaultMsgboxEndpoint;

    const result = await coreSendD2D({
      recipientDID: to,
      messageType: type,
      body: JSON.stringify(body),
      senderDID: opts.senderDID,
      senderPrivateKey: opts.senderPrivateKey,
      recipientPublicKey,
      endpoint,
      ...(opts.providerServiceResolver !== undefined
        ? { providerServiceResolver: opts.providerServiceResolver }
        : {}),
    });

    if (!result.sent) {
      throw new Error(
        `sendD2D: ${type} to ${to} denied at ${result.deniedAt ?? 'unknown'}: ${
          result.error ?? 'no detail'
        }`,
      );
    }
  };
}

/**
 * Build the outbox drainer's re-delivery function (issues.txt §1).
 *
 * Shares `makeSendD2D`'s resolution path — re-resolve the recipient's
 * DID document for a fresh signing key + endpoint, then hand the
 * SEMANTIC body (`row.bodyJson`, stored as a string) to `coreSendD2D`
 * with `suppressEnqueue` so a failed attempt reports back to the
 * drainer instead of enqueueing a duplicate row. Re-resolving here is
 * what lets a queued message survive a recipient key rotation or
 * endpoint move between enqueue and delivery.
 *
 * Returns `{ delivered }` so the drainer can `markSent` / backoff. Never
 * throws — resolution / signing failures are surfaced as a non-delivery.
 */
export function makeOutboxRedeliver(
  opts: MakeSendD2DOptions,
): (row: D2DOutboxRow) => Promise<RedeliverOutcome> {
  const resolver = opts.resolver ?? sharedResolver;

  return async (row) => {
    try {
      const resolved = await resolver.resolve(row.targetDID);
      const vm = pickEd25519VerificationMethod(resolved.document.verificationMethod);
      if (vm === null || typeof vm.publicKeyMultibase !== 'string') {
        return { delivered: false, error: `recipient ${row.targetDID} has no Ed25519 signing key` };
      }
      const recipientPublicKey = multibaseToPublicKey(vm.publicKeyMultibase);
      const endpoint = resolved.messagingService?.endpoint ?? opts.defaultMsgboxEndpoint;

      const result = await coreSendD2D({
        recipientDID: row.targetDID,
        messageType: row.messageType,
        body: row.bodyJson,
        senderDID: opts.senderDID,
        senderPrivateKey: opts.senderPrivateKey,
        recipientPublicKey,
        endpoint,
        suppressEnqueue: true,
        ...(opts.providerServiceResolver !== undefined
          ? { providerServiceResolver: opts.providerServiceResolver }
          : {}),
      });
      return result.delivered
        ? { delivered: true }
        : { delivered: false, error: result.error ?? result.deniedAt ?? 'delivery_failed' };
    } catch (err) {
      return { delivered: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}
