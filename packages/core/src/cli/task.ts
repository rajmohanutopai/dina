/**
 * CLI task validation — research intent, denied tasks, dry-run, session lifecycle.
 *
 * Validates task commands before delegating to OpenClaw.
 * Uses gatekeeper evaluateIntent for risk classification.
 * Session start/end always called (end in finally).
 *
 * Source: cli/tests/test_task.py
 */

import { evaluateIntent, isBrainDenied } from '../gatekeeper/intent';
import { startSession, endSession } from '../session/lifecycle';

export interface TaskValidation {
  valid: boolean;
  action: string;
  denied: boolean;
  reason?: string;
}

/** Action keywords for intent detection. */
const ACTION_KEYWORDS: Record<string, string> = {
  research: 'search',
  find: 'search',
  look: 'search',
  search: 'search',
  delete: 'delete_large',
  remove: 'delete_large',
  erase: 'delete_large',
  send: 'send_large',
  email: 'send_large',
  message: 'send_large',
  buy: 'purchase',
  purchase: 'purchase',
  order: 'purchase',
  export: 'credential_export',
};

/**
 * Validate a task command (check intent + gatekeeper).
 * If no action provided, infer from description keywords.
 */
export function validateTask(description: string, action?: string): TaskValidation {
  const resolvedAction = action ?? inferAction(description);

  // Check brain-denied first
  if (isBrainDenied(resolvedAction)) {
    return {
      valid: false,
      action: resolvedAction,
      denied: true,
      reason: `Action "${resolvedAction}" is denied (brain-denied)`,
    };
  }

  // Check gatekeeper
  const decision = evaluateIntent(resolvedAction);
  if (!decision.allowed) {
    return { valid: false, action: resolvedAction, denied: true, reason: decision.reason };
  }

  return { valid: true, action: resolvedAction, denied: false };
}

/**
 * Dry-run a task: validates but does NOT invoke OpenClaw.
 * Returns the same validation result as validateTask.
 */
export function dryRunTask(description: string): TaskValidation {
  return validateTask(description);
}

/**
 * Ensure session lifecycle: start before, end in finally.
 * Creates a session, passes session ID to fn, ends session in finally.
 */
export async function withSessionLifecycle<T>(
  agentDID: string,
  sessionName: string,
  fn: (sessionId: string) => Promise<T>,
): Promise<T> {
  const session = startSession(agentDID, sessionName);
  try {
    return await fn(session.id);
  } finally {
    endSession(session.id);
  }
}

/** Infer action from description keywords. */
function inferAction(description: string): string {
  const lower = description.toLowerCase();
  for (const [keyword, action] of Object.entries(ACTION_KEYWORDS)) {
    if (lower.includes(keyword)) return action;
  }
  return 'search'; // default to safe action
}
