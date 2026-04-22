/**
 * Brain API /v1/process — event processing pipeline.
 *
 * Accepted events: reminder_fired, vault_unlocked, approval_needed,
 * post_publish, incoming_message, text_query, agent_intent.
 *
 * Routes through guardian loop for priority classification, then
 * dispatches to the appropriate handler.
 *
 * Source: brain/tests/test_api.py, Task 3.26
 */

import { classifyPriority } from '../guardian/silence';
import { handlePostPublish } from '../pipeline/post_publish';
import { reason } from '../pipeline/chat_reasoning';
import { drainForPersona } from '../../../core/src/staging/service';

export interface ProcessEvent {
  type: string;
  payload: Record<string, unknown>;
  source?: string;
  timestamp?: number;
}

export interface ProcessResult {
  processed: boolean;
  actions: string[];
  priority?: { tier: number; reason: string; confidence: number; method: string };
  data?: Record<string, unknown>;
}

/** Recognized event types for the /v1/process endpoint. */
const RECOGNIZED_EVENTS = new Set([
  'reminder_fired',
  'vault_unlocked',
  'approval_needed',
  'post_publish',
  'incoming_message',
  'text_query',
  'agent_intent',
]);

/**
 * Process an incoming event through the guardian loop.
 * Validates the event, then routes to the appropriate handler.
 */
export async function processEvent(event: ProcessEvent): Promise<ProcessResult> {
  const validation = validateProcessEvent(event);
  if (!validation.valid) {
    throw new Error(`process: invalid event — ${validation.errors.join(', ')}`);
  }

  if (!isRecognizedEventType(event.type)) {
    throw new Error(`process: unrecognized event type "${event.type}"`);
  }

  const priority = await classifyPriority(event.payload);
  const actions: string[] = [];
  let data: Record<string, unknown> | undefined;

  switch (event.type) {
    case 'reminder_fired':
      actions.push('notify_user');
      data = { reminder_id: event.payload.reminder_id, tier: priority.tier };
      break;

    case 'vault_unlocked': {
      const persona = String(event.payload.persona ?? '');
      if (persona) {
        const drained = drainForPersona(persona);
        actions.push('drain_pending_unlock');
        data = { persona, drained };
      }
      break;
    }

    case 'approval_needed':
      actions.push('prompt_user');
      data = { approval_id: event.payload.approval_id, tier: priority.tier };
      break;

    case 'post_publish': {
      const item = event.payload;
      const result = await handlePostPublish({
        id: String(item.id ?? ''),
        type: String(item.type ?? ''),
        summary: String(item.summary ?? ''),
        body: String(item.body ?? ''),
        timestamp: Number(item.timestamp ?? Date.now()),
        persona: String(item.persona ?? 'general'),
        sender_did: item.sender_did ? String(item.sender_did) : undefined,
        confidence: item.confidence ? Number(item.confidence) : undefined,
      });
      actions.push('extract_reminders', 'update_contact_interaction');
      data = { remindersCreated: result.remindersCreated, contactUpdated: result.contactUpdated };
      break;
    }

    case 'text_query': {
      const query = String(event.payload.query ?? '');
      const persona = String(event.payload.persona ?? 'general');
      const provider = String(event.payload.provider ?? 'none');
      const result = await reason({ query, persona, provider });
      actions.push('vault_search', 'reason');
      data = { answer: result.answer, sources: result.sources };
      break;
    }

    case 'incoming_message':
      actions.push('classify_priority', 'route_to_persona');
      data = { tier: priority.tier, confidence: priority.confidence };
      break;

    case 'agent_intent':
      actions.push('evaluate_intent', 'check_grants');
      data = { action: event.payload.action };
      break;
  }

  return { processed: true, actions, priority, data };
}

/** Validate a process event has required fields. */
export function validateProcessEvent(event: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!event || typeof event !== 'object') {
    return { valid: false, errors: ['event must be a non-null object'] };
  }

  const obj = event as Record<string, unknown>;

  if (!obj.type || typeof obj.type !== 'string') {
    errors.push('type is required and must be a string');
  }

  if (obj.payload !== undefined && (typeof obj.payload !== 'object' || obj.payload === null)) {
    errors.push('payload must be an object');
  }

  return { valid: errors.length === 0, errors };
}

/** Check if an event type is recognized. */
export function isRecognizedEventType(type: string): boolean {
  return RECOGNIZED_EVENTS.has(type);
}
