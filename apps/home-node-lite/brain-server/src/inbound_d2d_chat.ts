/**
 * Bridge: an inbound peer D2D message → a bubble in the main chat thread.
 *
 * The staging drain fires `onD2DMessage` for a received message from a KNOWN
 * contact. On the lite server stack we mirror mobile's boot_service.ts: post
 * it into the `main` chat thread as a left-aligned bubble (type='dina' +
 * metadata.source='d2d', attributed to the sender). The web SPA receives it
 * live via the existing `/api/v1/chat/stream` SSE subscription to `main`
 * (F4 — without this the thin-client's chat never surfaces inbound D2D; the
 * message would only be staged to the vault).
 */

import { addMessage } from '@dina/brain/chat';

/** The fields of the drain's `D2DInboundMessage` this bridge needs. */
export interface InboundD2DChatMessage {
  senderDid: string;
  senderName: string;
  body: string;
  messageType: string;
  /** Sender's wire time (ms since epoch), or 0 if unknown. */
  timestamp: number;
}

export function postInboundD2DToMainChat(msg: InboundD2DChatMessage): void {
  addMessage('main', 'dina', msg.body, {
    metadata: {
      source: 'd2d',
      senderDID: msg.senderDid,
      senderName: msg.senderName,
      messageType: msg.messageType,
    },
    ...(msg.timestamp > 0 ? { timestamp: msg.timestamp } : {}),
  });
}
