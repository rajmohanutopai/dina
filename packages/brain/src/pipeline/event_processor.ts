/**
 * Event processor — dispatches Brain events to appropriate handlers.
 *
 * Event types:
 *   approval_needed  → create approval request via Core API
 *   reminder_fired   → classify priority, send notification via Core
 *   post_publish     → run post-publish handler (reminders, contacts, ambiguous routing)
 *   persona_unlocked → drain pending_unlock items for that persona
 *   staging_batch    → trigger batch processing of staging queue
 *
 * Events arrive via Brain's POST /v1/process endpoint (from Core or UI).
 * Each handler is fail-safe — errors are captured, never thrown.
 *
 * Source: ARCHITECTURE.md Task 3.26
 */

import { handlePostPublish, type PostPublishResult } from './post_publish';
import {
  classifyDeterministic,
  type ClassificationResult as SilenceResult,
} from '../guardian/silence';
import { mapTierToPriority, shouldInterrupt } from '../../../core/src/notify/priority';

export type EventType =
  | 'approval_needed'
  | 'reminder_fired'
  | 'post_publish'
  | 'persona_unlocked'
  | 'staging_batch';

export interface EventInput {
  event: EventType;
  data: Record<string, unknown>;
}

export interface EventResult {
  event: EventType;
  handled: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Process a single event. Dispatches to the appropriate handler.
 *
 * Fail-safe: never throws. Returns an EventResult with error details on failure.
 */
export async function processEvent(input: EventInput): Promise<EventResult> {
  try {
    switch (input.event) {
      case 'approval_needed':
        return handleApprovalNeeded(input);
      case 'reminder_fired':
        return handleReminderFired(input);
      case 'post_publish':
        return await handlePostPublishEvent(input);
      case 'persona_unlocked':
        return handlePersonaUnlocked(input);
      case 'staging_batch':
        return handleStagingBatch(input);
      default:
        return {
          event: input.event,
          handled: false,
          error: `Unknown event type: ${input.event}`,
        };
    }
  } catch (err) {
    return {
      event: input.event,
      handled: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Process multiple events. Returns results for each.
 */
export async function processEvents(inputs: EventInput[]): Promise<EventResult[]> {
  return Promise.all(inputs.map(processEvent));
}

// ---------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------

function handleApprovalNeeded(input: EventInput): EventResult {
  const { action, requester_did, persona, reason } = input.data;

  if (!action) {
    return { event: 'approval_needed', handled: false, error: 'action is required' };
  }

  // In production, this calls Core POST /v1/approvals to create the request.
  // For now, return the approval request payload for the caller to forward.
  return {
    event: 'approval_needed',
    handled: true,
    result: {
      type: 'approval_request',
      action: String(action),
      requester_did: String(requester_did ?? ''),
      persona: String(persona ?? 'general'),
      reason: String(reason ?? ''),
    },
  };
}

function handleReminderFired(input: EventInput): EventResult {
  const { message, persona, source } = input.data;

  if (!message) {
    return { event: 'reminder_fired', handled: false, error: 'message is required' };
  }

  // Classify the reminder's notification priority using the guardian
  const classification = classifyDeterministic({
    type: 'reminder',
    source: String(source ?? 'reminder'),
    sender: 'system',
    subject: String(message),
    body: '',
  });

  const priority = mapTierToPriority(classification.tier);
  const interrupt = shouldInterrupt(classification.tier);

  return {
    event: 'reminder_fired',
    handled: true,
    result: {
      type: 'notification',
      title: 'Reminder',
      body: String(message),
      persona: String(persona ?? 'general'),
      priority,
      interrupt,
      tier: classification.tier,
    },
  };
}

async function handlePostPublishEvent(input: EventInput): Promise<EventResult> {
  const { id, type, summary, body, timestamp, persona, sender_did, confidence } = input.data;

  if (!id || !summary) {
    return { event: 'post_publish', handled: false, error: 'id and summary are required' };
  }

  const result: PostPublishResult = await handlePostPublish({
    id: String(id),
    type: String(type ?? 'note'),
    summary: String(summary),
    body: String(body ?? ''),
    timestamp: Number(timestamp ?? Date.now()),
    persona: String(persona ?? 'general'),
    sender_did: sender_did ? String(sender_did) : undefined,
    confidence: confidence ? Number(confidence) : undefined,
  });

  return {
    event: 'post_publish',
    handled: true,
    result,
  };
}

function handlePersonaUnlocked(input: EventInput): EventResult {
  const { persona } = input.data;

  if (!persona) {
    return { event: 'persona_unlocked', handled: false, error: 'persona is required' };
  }

  // In production, this triggers Core POST /v1/staging/drain?persona={name}
  // to move all pending_unlock items for the persona into the vault.
  return {
    event: 'persona_unlocked',
    handled: true,
    result: {
      type: 'drain_request',
      persona: String(persona),
    },
  };
}

function handleStagingBatch(input: EventInput): EventResult {
  const limit = Number(input.data.limit ?? 10);

  // In production, this triggers the staging processor pipeline.
  return {
    event: 'staging_batch',
    handled: true,
    result: {
      type: 'batch_trigger',
      limit,
    },
  };
}
