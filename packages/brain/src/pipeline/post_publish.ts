/**
 * Post-publish handler — triggered after a vault item is stored.
 *
 * Responsibilities:
 * 1. Extract temporal events (birthdays, deadlines) → create reminders
 * 2. Update contact last_interaction timestamp
 * 3. Flag ambiguous routing for user review
 *
 * This runs as a post-hook on the staging resolve → stored transition.
 * It does NOT block the store operation — failures are logged, not thrown.
 *
 * Source: ARCHITECTURE.md Task 3.29
 */

import { planReminders } from './reminder_planner';
import { getContact, updateContact } from '../../../core/src/contacts/directory';
import { extractIdentityLinks, type IdentityLink } from './identity_extraction';

export interface PostPublishResult {
  remindersCreated: number;
  contactUpdated: boolean;
  ambiguousRouting: boolean;
  identityLinksFound: number;
  llmRefinedReminders: boolean;
  errors: string[];
}

/**
 * Run post-publish processing on a stored vault item.
 *
 * Safe: catches all errors internally. Returns a result summary.
 */
export async function handlePostPublish(item: {
  id: string;
  type: string;
  summary: string;
  body: string;
  timestamp: number;
  persona: string;
  sender_did?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}): Promise<PostPublishResult> {
  const result: PostPublishResult = {
    remindersCreated: 0,
    contactUpdated: false,
    ambiguousRouting: false,
    identityLinksFound: 0,
    llmRefinedReminders: false,
    errors: [],
  };

  // 1. Plan reminders via the full reminder planner (deterministic + optional LLM)
  try {
    const planResult = await planReminders({
      itemId: item.id,
      type: item.type,
      summary: item.summary,
      body: item.body,
      timestamp: item.timestamp,
      persona: item.persona,
      metadata: item.metadata,
    });
    result.remindersCreated = planResult.remindersCreated;
    result.llmRefinedReminders = planResult.llmRefined;
  } catch (err) {
    result.errors.push(`reminders: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Update contact last_interaction
  if (item.sender_did) {
    try {
      const contact = getContact(item.sender_did);
      if (contact) {
        updateContact(item.sender_did, {});
        result.contactUpdated = true;
      }
    } catch (err) {
      result.errors.push(`contact: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Flag ambiguous routing (low confidence classification)
  if (item.confidence !== undefined && item.confidence < 0.5) {
    result.ambiguousRouting = true;
  }

  // 4. Extract identity/relationship links from text content
  try {
    const text = `${item.summary} ${item.body}`.trim();
    if (text.length > 0) {
      const extraction = await extractIdentityLinks(text);
      result.identityLinksFound = extraction.links.length;
    }
  } catch (err) {
    result.errors.push(`identity: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
