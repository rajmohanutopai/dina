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

import { getContact, updateContact } from '../../../core/src/contacts/directory';

import { extractIdentityLinks } from './identity_extraction';
import {
  applyPeopleGraphExtraction,
  type ApplyPeopleGraphOutcome,
} from './people_graph_extraction';
import { planReminders } from './reminder_planner';

import type { VaultItemType } from '../../../core/src/vault/validation';

export interface PostPublishResult {
  remindersCreated: number;
  contactUpdated: boolean;
  ambiguousRouting: boolean;
  identityLinksFound: number;
  llmRefinedReminders: boolean;
  /**
   * People-graph apply outcome. `null` when the people repo wasn't
   * registered (mobile/test paths that don't carry one yet) or when
   * the extractor produced no usable links. Populated only when the
   * repo wrote something — `created + updated > 0` means the people
   * graph changed for this item.
   */
  peopleGraph: PeopleGraphTelemetry | null;
  errors: string[];
}

export interface PeopleGraphTelemetry {
  /** How many person-link records the repo accepted. */
  applied: number;
  /** Newly-inserted people. */
  created: number;
  /** Existing people whose canonical/relationship/surfaces changed. */
  updated: number;
  /** Role-phrase conflicts the repo flagged for operator review. */
  conflicts: number;
  /** True when the extractor fingerprint already existed in the
   *  idempotency log — repeat ingest of the same item. */
  skipped: boolean;
}

/**
 * Run post-publish processing on a stored vault item.
 *
 * Safe: catches all errors internally. Returns a result summary.
 */
export async function handlePostPublish(item: {
  id: string;
  type: VaultItemType;
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
    peopleGraph: null,
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
      // Sender DID drives the people-graph lookup inside the planner —
      // when set, the LLM prompt carries "Sender: Sancho (brother)"
      // and the FTS keyword set is expanded with every confirmed
      // alias so vault facts about Sancho surface regardless of
      // which name the user wrote them under.
      senderDid: item.sender_did,
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
  const text = `${item.summary} ${item.body}`.trim();
  try {
    if (text.length > 0) {
      const extraction = await extractIdentityLinks(text);
      result.identityLinksFound = extraction.links.length;
    }
  } catch (err) {
    result.errors.push(`identity: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. People-graph apply — runs the typed person-link extractor and
  //    persists the result via `peopleRepo.applyExtraction`. Fail-soft;
  //    if the repo isn't registered yet (mobile bootstrap not yet
  //    upgraded), this is a no-op rather than an error.
  if (text.length > 0) {
    const outcome = await applyPeopleGraphExtraction(text, item.id);
    result.peopleGraph = telemetryFromOutcome(outcome);
    if (!outcome.ok && (outcome.reason === 'extractor_failed' || outcome.reason === 'apply_failed')) {
      result.errors.push(`people_graph: ${outcome.reason}: ${outcome.error}`);
    }
  }

  return result;
}

function telemetryFromOutcome(outcome: ApplyPeopleGraphOutcome): PeopleGraphTelemetry | null {
  if (!outcome.ok) return null;
  return {
    applied: outcome.linkCount,
    created: outcome.applied.created,
    updated: outcome.applied.updated,
    conflicts: outcome.applied.conflicts.length,
    skipped: outcome.applied.skipped,
  };
}
