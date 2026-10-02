/**
 * MsgBox bootstrap — wire WebSocket transport into runtime.
 *
 * Routes incoming RPC envelopes through the pure `CoreRouter` via
 * `createInProcessDispatch`. Express is not involved at any point —
 * dina-mobile runs under Expo managed and never ships an HTTP server.
 */

import { createInProcessDispatch } from '../server/in_process_dispatch';
import { setWSDeliverFn } from '../transport/delivery';

import {
  handleInboundD2D,
  handleInboundRPC,
  rpcReady,
  handleRPCCancel,
  setRPCRouter,
  sendD2DViaWS,
  type RPCRouterFn,
} from './msgbox_handlers';
import {
  setIdentity,
  setWSFactory,
  connectToMsgBox,
  onD2DMessage,
  onRPCRequest,
  onRPCCancel,
  type WSFactory,
} from './msgbox_ws';

import type { CoreRouter } from '../server/router';

export interface MsgBoxBootConfig {
  /** Home node DID (did:key:z...) */
  did: string;
  /** Home node Ed25519 private key (32 bytes) */
  privateKey: Uint8Array;
  /** MsgBox relay URL (wss://mailbox.dinakernel.com/ws) */
  msgboxURL: string;
  /** WebSocket factory (production: React Native WebSocket) */
  wsFactory: WSFactory;
  /** CoreRouter — where incoming RPC envelopes are dispatched. */
  coreRouter: CoreRouter;
  /** Resolve sender info for D2D receive pipeline */
  resolveSender: (did: string) => Promise<{ keys: Uint8Array[]; trust: string }>;
  /**
   * Called when the receive pipeline bypasses the contact gate for a
   * `service.query` / `service.response`. Brain's D2D dispatcher receives
   * the parsed body here so the provider-side handler (or
   * requester-side orchestrator for response traffic) runs. Without this
   * wiring, inbound service.query traffic is validated and then silently
   * discarded.
   */
  onBypassedD2D?: (info: {
    senderDID: string;
    messageType: string;
    body: unknown;
  }) => Promise<void> | void;
  /**
   * Called when the receive pipeline successfully staged (or treated
   * as ephemeral) an inbound D2D message. The raw verified body is
   * handed up so UI-layer surfaces — specifically the per-peer chat
   * thread for coordination.* traffic — can render it live without
   * reading back from the vault. Quarantined messages never fire
   * this; those go through the approvals flow.
   */
  onStagedD2D?: (info: {
    senderDID: string;
    messageType: string;
    body: string;
    /**
     * Sender's `created_time` from the verified DinaMessage envelope
     * (Unix milliseconds). Use this for chronological ordering in the
     * UI fan-out instead of receive-time so a multi-message MsgBox
     * replay-on-reconnect renders in the order the sender intended.
     * MT-19-I2.
     */
    senderCreatedTime?: number;
  }) => Promise<void> | void;
  /**
   * Called when the receive pipeline QUARANTINED an inbound D2D message
   * — i.e. it decrypted + signature-verified fine, but the sender isn't
   * a known contact. Surfaces an "unknown sender wants to message you"
   * review card so the user can accept (add as contact + release the
   * message) or block. WITHOUT this, a stranger's message decrypts,
   * verifies, then vanishes into the quarantine store with zero UI
   * trace — installed users reasonably conclude "messages aren't
   * arriving". The message BODY is intentionally NOT forwarded: the
   * user decides before seeing content (anti-spam). MT-D2D quarantine UX.
   */
  onQuarantinedD2D?: (info: {
    senderDID: string;
    messageType: string;
    quarantineId: string;
  }) => Promise<void> | void;
  /**
   * Timeout for the initial WS handshake. Forwarded to
   * `connectToMsgBox`. Default 10s (matches `connectToMsgBox`).
   */
  readyTimeoutMs?: number;
}

/**
 * Wire identity + envelope handlers + RPC dispatch into a connected
 * MsgBox WebSocket. Returns once the relay is reachable.
 */
export async function bootstrapMsgBox(config: MsgBoxBootConfig): Promise<void> {
  setIdentity(config.did, config.privateKey);
  setWSFactory(config.wsFactory);

  // Each handler returns its promise: the relay connection acks an envelope
  // when it settles, and keeps (does not ack) one it resolves `false` for.
  //
  // Staged, quarantined and refused D2D are acked once the receive pipeline
  // has run: the vault or quarantine copy is the durable one, and the UI
  // fan-out runs on its own. Service traffic (`bypassed`) is NOT stored by
  // the pipeline — the dispatcher is where it is taken in — so its ack waits
  // for the dispatcher. A node built with no dispatcher drops service
  // traffic on purpose and acks it: keeping it would not help, because the
  // pipeline has already recorded the message id against replay, so the
  // relay's next copy would be refused as a replay and acked anyway.
  onD2DMessage(async (env) => {
    const result = await handleInboundD2D(env, config.resolveSender);
    if (
      result.success &&
      result.pipelineAction === 'bypassed' &&
      result.bypassedBody !== undefined &&
      result.messageType !== undefined &&
      result.senderDID !== undefined
    ) {
      if (config.onBypassedD2D === undefined) {
        console.warn(`[d2d] service ${result.messageType} dropped: no service dispatcher on this node`);
        return undefined;
      }
      try {
        await config.onBypassedD2D({
          senderDID: result.senderDID,
          messageType: result.messageType,
          body: result.bypassedBody,
        });
      } catch {
        // Dispatcher errors are caller-owned; it has had the message.
      }
      return undefined;
    }
    void fanOutInboundD2D(result, config);
    return undefined;
  });

  onRPCRequest((env) =>
    rpcReady()
      ? handleInboundRPC(env).catch(() => {
          /* handler errors logged inside handleInboundRPC */
        })
      : false,
  );

  onRPCCancel((env) => {
    handleRPCCancel(env);
  });

  // Inbound RPC envelopes → decrypt → CoreRouter dispatch.
  setRPCRouter(createCoreRPCRouter(config.coreRouter));

  // WS-based D2D egress is intentionally NOT installed. The shared
  // Dina MsgBox relay (dina-infra-test-msgbox) logs only `rpc_routed`
  // and `buffered` for envelopes it accepts; `type: 'd2d'` WS frames
  // are silently dropped on its side. The Go Home Node reference impl (
  // openclaw-user) only uses HTTP POST /forward for D2D, which is
  // what the relay actually routes. `deliverMessage` (HTTP /forward
  // fallback) is what every D2D send should hit — setting
  // `setWSDeliverFn(sendD2DViaWS)` would short-circuit into a dead
  // code path. RPC (inbound + outbound RPC response) stays on the WS
  // because that IS supported by the relay (msgbox.rpc_routed).
  setWSDeliverFn(null);

  // bootstrapMsgBox callers (createNode.start) need the WS to be
  // genuinely ready before returning — a silent "connected" log while
  // the handshake is still in flight was issue #7. Default to 10 s,
  // overridable.
  await connectToMsgBox(config.msgboxURL, {
    readyTimeoutMs: config.readyTimeoutMs ?? 10_000,
  });
}

/**
 * Hand a stored inbound D2D result on: staged messages to the UI,
 * quarantined ones to a review card. (Service traffic goes to the dispatcher
 * in the D2D handler above, which holds the ack for it.) Errors here are the
 * caller's; the vault (or quarantine) copy is already authoritative.
 */
async function fanOutInboundD2D(
  result: Awaited<ReturnType<typeof handleInboundD2D>>,
  config: MsgBoxBootConfig,
): Promise<void> {
  if (
    result.success &&
    (result.pipelineAction === 'staged' || result.pipelineAction === 'ephemeral') &&
    result.stagedBody !== undefined &&
    result.messageType !== undefined &&
    result.senderDID !== undefined &&
    config.onStagedD2D !== undefined
  ) {
    try {
      await config.onStagedD2D({
        senderDID: result.senderDID,
        messageType: result.messageType,
        body: result.stagedBody,
        senderCreatedTime: result.senderCreatedTime,
      });
    } catch {
      // UI fan-out errors are caller-owned; the vault copy is authoritative.
    }
  }
  // Quarantined (unknown sender): surface a review card. Note this
  // is NOT gated on `result.success` — quarantine is a "false"
  // outcome (nothing staged), but the user still needs to see it.
  if (
    result.pipelineAction === 'quarantined' &&
    result.quarantineId !== undefined &&
    result.messageType !== undefined &&
    result.senderDID !== undefined &&
    config.onQuarantinedD2D !== undefined
  ) {
    try {
      await config.onQuarantinedD2D({
        senderDID: result.senderDID,
        messageType: result.messageType,
        quarantineId: result.quarantineId,
      });
    } catch {
      // Review-card fan-out errors are caller-owned; the message
      // remains in the quarantine store for later review.
    }
  }
}

/**
 * Build an `RPCRouterFn` that hands decrypted inner HTTP-shaped requests
 * to the CoreRouter. No Express, no req/res objects — just a function
 * call.
 */
function createCoreRPCRouter(router: CoreRouter): RPCRouterFn {
  const dispatch = createInProcessDispatch({ router });
  return async (method, path, headers, body, signal?) => {
    if (signal?.aborted) {
      return { status: 499, headers: {}, body: '{"error":"cancelled"}' };
    }
    // Envelope transports body as a string; dispatch wants bytes.
    const bodyBytes = new TextEncoder().encode(body);
    const coreResp = await dispatch(
      method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
      path,
      headers,
      bodyBytes,
    );
    const bodyStr = coreResp.body === undefined ? '' : JSON.stringify(coreResp.body);
    return {
      status: coreResp.status,
      headers: coreResp.headers ?? { 'content-type': 'application/json' },
      body: bodyStr,
    };
  };
}
