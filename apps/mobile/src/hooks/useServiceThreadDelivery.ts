/**
 * Service-response delivery wiring — MOBILE-009.
 *
 * Composes `WorkflowEventConsumer` (brain) with the chat-thread module
 * (brain) so that service-query completions arrive in the chat bubble
 * automatically. The `deliver` callback writes the formatted text via
 * `addDinaResponse(threadId, text, [correlationId, capability])` so the
 * source badge stays useful for tap-through.
 *
 * The consumer is owned by the caller — they receive `start()` / `stop()`
 * lifecycle handles and dispose on unmount or app-background.
 *
 * Source: BUS_DRIVER_IMPLEMENTATION.md MOBILE-009.
 */

import type { BrainCoreClient } from '@dina/brain/src/core_client/http';
import {
  WorkflowEventConsumer,
  type WorkflowEventDeliverer,
  type WorkflowEventTickResult,
} from '@dina/brain/src/service/workflow_event_consumer';
import { addDinaResponse, type ChatMessage } from '@dina/brain/src/chat/thread';

export type DeliveryCoreClient = Pick<
  BrainCoreClient,
  | 'listWorkflowEvents'
  | 'acknowledgeWorkflowEvent'
  | 'getWorkflowTask'
  | 'failWorkflowEventDelivery'
>;

export interface ThreadDeliveryOptions {
  coreClient: DeliveryCoreClient;
  /** Thread to deliver service responses into. Defaults to `'main'`. */
  threadId?: string;
  /** Optional interceptor — e.g., for logging or push-notifications. */
  onDelivered?: (message: ChatMessage) => void;
  /** Surface errors to a dashboard/telemetry sink. */
  onError?: (err: unknown) => void;
  /** Poll cadence in ms. Defaults to `WorkflowEventConsumer`'s default. */
  intervalMs?: number;
}

export interface ThreadDeliveryHandle {
  /** Start polling. Fires an immediate tick. */
  start: () => void;
  /** Stop polling. Safe to call multiple times. */
  stop: () => void;
  /** Force a single poll synchronously (bypasses the interval). */
  runOnce: () => Promise<WorkflowEventTickResult>;
}

const DEFAULT_THREAD = 'main';

/**
 * Wire a `WorkflowEventConsumer` to the chat thread. Returns a
 * lifecycle handle the caller owns.
 */
export function wireServiceThreadDelivery(options: ThreadDeliveryOptions): ThreadDeliveryHandle {
  if (!options.coreClient) {
    throw new Error('wireServiceThreadDelivery: coreClient is required');
  }
  const threadId = options.threadId ?? DEFAULT_THREAD;
  const onDelivered = options.onDelivered;

  const deliver: WorkflowEventDeliverer = ({ text, event, details }) => {
    const sources: string[] = [];
    if (event.task_id !== '') sources.push(event.task_id);
    if (details.capability !== undefined && details.capability !== '') {
      sources.push(details.capability);
    }
    const message = addDinaResponse(threadId, text, sources.length > 0 ? sources : undefined);
    if (onDelivered !== undefined) onDelivered(message);
  };

  const consumer = new WorkflowEventConsumer({
    coreClient: options.coreClient,
    deliver,
    intervalMs: options.intervalMs,
    onError: options.onError,
  });

  return {
    start: () => consumer.start(),
    stop: () => consumer.stop(),
    runOnce: () => consumer.runTick(),
  };
}
