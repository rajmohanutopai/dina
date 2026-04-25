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
import { isVaultItemType } from '../../../core/src/vault/validation';
import type { VaultItemType } from '../../../core/src/vault/validation';
import {
  classifyDeterministic,
  type ClassificationResult as SilenceResult,
} from '../guardian/silence';
import { mapTierToPriority, shouldInterrupt } from '../../../core/src/notify/priority';
import { assembleNudge } from '../nudge/assembler';
import {
  writeCheckpoint,
  deleteCheckpoint,
} from '../scratchpad/lifecycle';

export type EventType =
  | 'approval_needed'
  | 'reminder_fired'
  | 'post_publish'
  | 'persona_unlocked'
  | 'staging_batch'
  | 'd2d_received';

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
      case 'd2d_received':
        return await handleD2DReceived(input);
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

  const rawType = String(type ?? 'note');
  const itemType: VaultItemType = isVaultItemType(rawType) ? rawType : 'note';
  const result: PostPublishResult = await handlePostPublish({
    id: String(id),
    type: itemType,
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

/**
 * Handle a D2D message arrival — fires AFTER the drain has stored the
 * item in the vault. Port of Python's `guardian.process_event` D2D
 * branch:
 *
 *   1. Classify Silence-First priority (fiduciary / solicited /
 *      engagement / silent) from the item metadata.
 *   2. Checkpoint step 1 via scratchpad (crash recovery — if the
 *      process dies mid-nudge, the next boot can resume).
 *   3. If priority is fiduciary/solicited and a sender_did is known,
 *      assemble a nudge using the contact's vault history + promise
 *      detection.
 *   4. Checkpoint step 2 with the assembled nudge.
 *   5. Return a notification envelope the outer layer pushes to the
 *      client via Core's `/v1/notify`. Scratchpad cleared on success.
 *
 * Engagement-tier items don't get an immediate nudge — they batch
 * into the daily briefing. Silent-tier items produce no notification.
 *
 * Fail-soft: every step is wrapped — if nudge assembly throws or the
 * scratchpad is unreachable, the event returns `handled: true` with
 * a partial result. The drain never fails an item over a nudge
 * glitch.
 */
async function handleD2DReceived(input: EventInput): Promise<EventResult> {
  const {
    task_id,
    item_id,
    sender_did,
    sender_name,
    persona,
    summary,
    body,
    type,
    source,
  } = input.data;

  // `task_id` is the correlator for scratchpad + eventual ack; when
  // the caller supplies one, we use it. Otherwise synthesise from
  // the item id so crash recovery still has a handle.
  const taskId = String(task_id ?? item_id ?? '');
  if (taskId === '') {
    return {
      event: 'd2d_received',
      handled: false,
      error: 'task_id or item_id is required',
    };
  }

  const classifyInput = {
    type: String(type ?? 'message'),
    source: String(source ?? 'd2d'),
    sender: String(sender_did ?? sender_name ?? ''),
    subject: String(summary ?? ''),
    body: String(body ?? ''),
  };
  const classification: SilenceResult = classifyDeterministic(classifyInput);
  const priority = mapTierToPriority(classification.tier);
  const interrupt = shouldInterrupt(classification.tier);

  // Silence-First guard — Law 1. Tier 3 (engagement) batches into
  // the daily briefing; only fiduciary (1) + solicited (2) produce
  // an immediate notification envelope. Matches Python's
  // `process_event` short-circuit on `engagement` events.
  if (classification.tier === 3) {
    return {
      event: 'd2d_received',
      handled: true,
      result: {
        type: 'silent_log',
        taskId,
        tier: classification.tier,
        priority,
      },
    };
  }

  // Step 1 checkpoint — Python stores `{priority, event}`. Fail-soft
  // (scratchpad unavailable should not block nudge delivery).
  try {
    await writeCheckpoint(taskId, 1, {
      priority,
      tier: classification.tier,
      item_id: String(item_id ?? ''),
      sender_did: String(sender_did ?? ''),
    });
  } catch {
    /* swallow — step 2 below is still meaningful without step 1 */
  }

  // Nudge assembly — only if we know the sender. An unknown-sender
  // D2D would be quarantined upstream (see the D2D Scenario 3 test),
  // so reaching this path with no sender_did is the "arrived but
  // unauthenticated" edge. Surface the raw summary instead.
  let nudgeSummary: string = String(summary ?? 'Message received');
  let nudgeItemCount = 0;
  if (typeof sender_did === 'string' && sender_did !== '') {
    try {
      const nudge = assembleNudge(
        sender_did,
        typeof sender_name === 'string' && sender_name !== ''
          ? sender_name
          : sender_did,
        typeof persona === 'string' && persona !== '' ? [persona] : undefined,
      );
      if (nudge !== null) {
        nudgeSummary = nudge.summary;
        nudgeItemCount = nudge.items.length;
      }
    } catch {
      /* nudge assembly is best-effort — fall back to the raw summary */
    }
  }

  // Step 2 checkpoint — store the assembled nudge.
  try {
    await writeCheckpoint(taskId, 2, {
      priority,
      tier: classification.tier,
      nudge_summary: nudgeSummary,
      nudge_item_count: nudgeItemCount,
    });
  } catch {
    /* ignore */
  }

  // Clear the scratchpad — we're about to return the notification
  // to the caller. If the caller-side notify fails, the caller is
  // responsible for re-queueing; scratchpad is purely brain-side
  // crash recovery and we've computed our output.
  try {
    await deleteCheckpoint(taskId);
  } catch {
    /* ignore */
  }

  return {
    event: 'd2d_received',
    handled: true,
    result: {
      type: 'notification',
      taskId,
      title: typeof sender_name === 'string' && sender_name !== ''
        ? sender_name
        : 'New message',
      body: nudgeSummary,
      persona: String(persona ?? 'general'),
      priority,
      interrupt,
      tier: classification.tier,
      nudgeItems: nudgeItemCount,
    },
  };
}
