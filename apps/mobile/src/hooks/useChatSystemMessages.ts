/**
 * Chat system messages hook — typed system notifications for the chat thread.
 *
 * System messages appear inline in chat for lifecycle events:
 *   - persona_unlocked: "Persona 'health' unlocked"
 *   - persona_locked: "Persona 'health' locked — DEK zeroed"
 *   - reminder_set: "Reminder set: Call dentist (tomorrow 3pm)"
 *   - reminder_fired: "Reminder: Call the dentist"
 *   - approval_resolved: "Approval 'unlock health' was approved"
 *   - config_changed: "Background timeout set to 5 minutes"
 *   - error: "Failed to connect to Brain server"
 *
 * Each event type has a formatting function that produces a human-readable
 * message for display in the chat thread.
 *
 * Source: ARCHITECTURE.md Task 4.13
 */

import { addMessage, addSystemMessage, type ChatMessage } from '@dina/brain/src/chat/thread';

export type SystemEventType =
  | 'persona_unlocked'
  | 'persona_locked'
  | 'reminder_set'
  | 'reminder_fired'
  | 'reminder_dismissed'
  | 'approval_resolved'
  | 'config_changed'
  | 'connection_status'
  | 'error';

export interface SystemEvent {
  type: SystemEventType;
  data: Record<string, unknown>;
  timestamp: number;
}

/** Event history for debugging. */
const eventHistory: SystemEvent[] = [];
import { SYSTEM_MESSAGE_HISTORY_MAX } from '@dina/core/src/constants';
const MAX_HISTORY = SYSTEM_MESSAGE_HISTORY_MAX;

/**
 * Emit a system event — formats and adds to chat thread.
 *
 * Returns the formatted message.
 */
export function emitSystemEvent(
  type: SystemEventType,
  data: Record<string, unknown>,
  threadId?: string,
): string {
  const message = formatEvent(type, data);
  const tid = threadId ?? 'main';

  // Add to chat thread as system or error type
  const msgType = type === 'error' ? 'error' : 'system';
  addMessage(tid, msgType, message);

  // Track in event history
  const event: SystemEvent = { type, data, timestamp: Date.now() };
  eventHistory.push(event);
  if (eventHistory.length > MAX_HISTORY) {
    eventHistory.shift();
  }

  return message;
}

/**
 * Format a system event into a human-readable message.
 */
export function formatEvent(type: SystemEventType, data: Record<string, unknown>): string {
  switch (type) {
    case 'persona_unlocked':
      return `Persona "${data.persona}" unlocked`;

    case 'persona_locked':
      return `Persona "${data.persona}" locked`;

    case 'reminder_set':
      return `Reminder set: ${data.message}${data.dueLabel ? ` (${data.dueLabel})` : ''}`;

    case 'reminder_fired':
      return `Reminder: ${data.message}`;

    case 'reminder_dismissed':
      return `Reminder dismissed: ${data.message}`;

    case 'approval_resolved': {
      const outcome = data.approved ? 'approved' : 'denied';
      return `${data.action} was ${outcome}${data.scope ? ` (${data.scope})` : ''}`;
    }

    case 'config_changed':
      return `${data.setting} set to ${data.value}`;

    case 'connection_status':
      return data.connected ? `Connected to ${data.service}` : `Disconnected from ${data.service}`;

    case 'error':
      return `Error: ${data.message}`;

    default:
      return `System event: ${type}`;
  }
}

/**
 * Convenience: emit persona unlocked event.
 */
export function notifyPersonaUnlocked(persona: string, threadId?: string): string {
  return emitSystemEvent('persona_unlocked', { persona }, threadId);
}

/**
 * Convenience: emit persona locked event.
 */
export function notifyPersonaLocked(persona: string, threadId?: string): string {
  return emitSystemEvent('persona_locked', { persona }, threadId);
}

/**
 * Convenience: emit reminder set event.
 */
export function notifyReminderSet(message: string, dueLabel?: string, threadId?: string): string {
  return emitSystemEvent('reminder_set', { message, dueLabel }, threadId);
}

/**
 * Convenience: emit reminder fired event.
 */
export function notifyReminderFired(message: string, threadId?: string): string {
  return emitSystemEvent('reminder_fired', { message }, threadId);
}

/**
 * Convenience: emit approval resolved event.
 */
export function notifyApprovalResolved(
  action: string,
  approved: boolean,
  scope?: string,
  threadId?: string,
): string {
  return emitSystemEvent('approval_resolved', { action, approved, scope }, threadId);
}

/**
 * Convenience: emit config changed event.
 */
export function notifyConfigChanged(setting: string, value: string, threadId?: string): string {
  return emitSystemEvent('config_changed', { setting, value }, threadId);
}

/**
 * Convenience: emit error event.
 */
export function notifyError(message: string, threadId?: string): string {
  return emitSystemEvent('error', { message }, threadId);
}

/**
 * Get recent event history (for debugging).
 */
export function getEventHistory(): SystemEvent[] {
  return [...eventHistory];
}

/**
 * Reset all system message state (for testing).
 */
export function resetSystemMessages(): void {
  eventHistory.length = 0;
}
