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

  // The drain reads `data.ingress_channel` + `data.origin_did` to drive
  // its D2D-aware branches: the contact_did wire onto the vault row,
  // the sender_did into post_publish (which feeds reminder planning +
  // contact last-seen), and the d2d_received nudge chain. Without these
  // keys the row looks like a generic inbox item and the D2D paths
  // silently no-op even though the bytes were sealed and verified.
  // Python parity: `staging_processor.py` checks `ingress_channel ==
  // "d2d"` and `origin_did` for the same routing.
  //
  // `summary` carries plain text the regex classifier + reminder-planner
  // event extractor can scan. The wire body is JSON-wrapped per the
  // message family schema (e.g. social.update → `{"text": "..."}`),
  // and feeding the raw JSON into the planner produced reminders with
  // generic messages because the extractor couldn't find the subject
  // outside of quotes. Pull `text` out when present and otherwise leave
  // summary empty — downstream consumers that need the structured body
  // still read `body`.
  let summary = '';
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'text' in parsed &&
      typeof (parsed as { text: unknown }).text === 'string'
    ) {
      summary = (parsed as { text: string }).text;
    }
  } catch {
    /* opaque non-JSON body — leave summary empty */
  }

  // TEMP DIAGNOSTIC LOG — confirms stageMessage runs on-device with the
  // new D2D-routing keys (ingress_channel/origin_did/summary). Remove
  // once Bug #1 is validated end-to-end on the simulator.
  console.log(
    '[d2d:stageMessage]',
    JSON.stringify({
      messageType,
      vaultItemType,
      senderDID,
      messageId,
      bodyPreview: body.slice(0, 80),
      summary,
    }),
  );

  const { id } = ingest({
    source: 'd2d',
    source_id: messageId,
    producer_id: senderDID,
    data: {
      type: vaultItemType,
      message_type: messageType,
      sender_did: senderDID,
      ingress_channel: 'd2d',
      origin_did: senderDID,
      summary,
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
