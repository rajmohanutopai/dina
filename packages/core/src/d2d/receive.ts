/**
 * D2D receive — stage incoming message to vault via staging pipeline.
 *
 * When a D2D message arrives:
 * 1. Map message type → vault item type (using d2d/families.ts)
 * 2. Evaluate trust: blocked → drop, unknown → quarantine, known → process
 * 3. Stage to vault via staging service
 *
 * Ephemeral messages (presence.signal) are never staged.
 * Safety alerts always pass regardless of sharing policy.
 *
 * Source: ARCHITECTURE.md Tasks 6.10–6.12
 */

import { mapToVaultItemType, shouldStore, alwaysPasses } from './families';
import { ingest } from '../staging/service';

export type ReceiveAction = 'staged' | 'quarantined' | 'dropped' | 'ephemeral';

export interface ReceiveResult {
  action: ReceiveAction;
  stagingId?: string;
  vaultItemType?: string;
  reason: string;
}

/** Known trust levels that allow normal processing. */
const TRUSTED_LEVELS = new Set(['trusted', 'verified', 'contact_ring1', 'contact_ring2']);

/** Trust levels that trigger quarantine. */
const QUARANTINE_LEVELS = new Set(['unknown']);

/**
 * Process an incoming D2D message for vault staging.
 *
 * Trust evaluation follows Go's contacts-only model (EvaluateIngress):
 *   - blocked → drop
 *   - Any explicit contact (even with trust_level="unknown") → accept
 *   - Not a contact at all → quarantine
 *
 * The distinction is critical: Go ACCEPTS messages from contacts with
 * trust_level="unknown". The trust level on a contact indicates verification
 * status, not whether the sender is recognized. A contact with "unknown"
 * trust is still an explicit contact the user added.
 *
 * @param messageType — D2D message type (e.g., 'social.update')
 * @param senderDID — DID of the sender
 * @param senderTrust — trust level of the sender
 * @param body — message body (JSON string)
 * @param messageId — unique message ID
 * @param isContact — whether the sender is in the contact directory
 */
export function receiveAndStage(
  messageType: string,
  senderDID: string,
  senderTrust: string,
  body: string,
  messageId: string,
  isContact: boolean = false,
): ReceiveResult {
  // 1. Check if message type should be stored at all
  if (!shouldStore(messageType)) {
    return { action: 'ephemeral', reason: `Ephemeral type: ${messageType}` };
  }

  // 2. Safety alerts always pass — skip trust evaluation
  if (alwaysPasses(messageType)) {
    return stageMessage(messageType, senderDID, body, messageId);
  }

  // 3. Trust evaluation — contacts-only model (matches Go EvaluateIngress)
  if (senderTrust === 'blocked') {
    return { action: 'dropped', reason: 'Sender is blocked' };
  }

  // Any explicit contact passes (even with trust_level="unknown").
  // Only non-contacts get quarantined.
  if (!isContact) {
    return {
      action: 'quarantined',
      vaultItemType: mapToVaultItemType(messageType) ?? messageType,
      reason: 'Unknown sender — quarantined for review',
    };
  }

  // 4. Trusted sender — stage to vault
  return stageMessage(messageType, senderDID, body, messageId);
}

/** Stage a message into the staging inbox. */
function stageMessage(
  messageType: string,
  senderDID: string,
  body: string,
  messageId: string,
): ReceiveResult {
  const vaultItemType = mapToVaultItemType(messageType) ?? messageType;

  const { id } = ingest({
    source: 'd2d',
    source_id: messageId,
    producer_id: senderDID,
    data: {
      type: vaultItemType,
      message_type: messageType,
      sender_did: senderDID,
      body,
    },
  });

  return {
    action: 'staged',
    stagingId: id,
    vaultItemType,
    reason: `Staged as ${vaultItemType}`,
  };
}

/**
 * Evaluate sender trust for D2D receive.
 *
 * Returns the recommended action based on trust level.
 */
export function evaluateSenderTrust(trustLevel: string): ReceiveAction {
  if (trustLevel === 'blocked') return 'dropped';
  if (QUARANTINE_LEVELS.has(trustLevel)) return 'quarantined';
  return 'staged';
}
