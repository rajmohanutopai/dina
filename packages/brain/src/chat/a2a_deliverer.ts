/**
 * Put an A2A Lane 1 outcome into the asking conversation (design A2A-I7).
 * Core re-delivers an event whose delivery failed, so the append is keyed by
 * the workflow event id: a second delivery of one event adds nothing.
 */

import { addMessage, getThread, type ChatMessage } from './thread';

export interface A2AChatDelivery {
  threadId: string;
  text: string;
  eventId: number;
  operationId: string;
}

export function deliverA2AOutcome(delivery: A2AChatDelivery): ChatMessage {
  const existing = getThread(delivery.threadId).find(
    (m) => m.metadata?.a2a_event_id === delivery.eventId,
  );
  if (existing !== undefined) return existing;
  return addMessage(delivery.threadId, 'dina', delivery.text, {
    metadata: { a2a_event_id: delivery.eventId, a2a_operation_id: delivery.operationId },
  });
}
