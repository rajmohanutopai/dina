/**
 * Chat-row display classification — pure, so the wiring is unit-testable without
 * mounting the (very large) Chat route. `toDisplayType` maps a persisted
 * `ChatMessage` to the render branch the screen dispatches on; `chatRowKind`
 * maps that to the E2E row-contract kind (docs/E2E_TESTING.md §5).
 *
 * Extracted from `app/index.tsx` so lifecycle-card wiring — including the
 * `commerce_comparison` where-to-buy card (§5.A4/A5) — is covered by a fast
 * behavioural test rather than only exercised through a full screen render.
 */

import { type ChatMessage } from '@dina/brain/chat';

export type DisplayType =
  | 'user'
  | 'dina'
  | 'system'
  | 'ask-approval'
  | 'service-approval'
  | 'vault-read-approval'
  | 'demo-approval'
  | 'demo-review'
  | 'demo-service-preview'
  | 'service-query'
  | 'missing-capability'
  | 'ask-pending'
  | 'reasoning-job'
  | 'review-draft'
  | 'quarantine-request'
  | 'commerce-comparison'
  | 'group-plan'
  | 'nudge'
  | 'reminder'
  | 'briefing';

export function toDisplayType(m: ChatMessage): DisplayType {
  if (m.type === 'user') return 'user';
  if (m.type === 'approval' && m.metadata?.kind === 'ask_approval') {
    return 'ask-approval';
  }
  if (m.type === 'approval' && m.metadata?.kind === 'service_approval') {
    return 'service-approval';
  }
  // F-AGENT-VAULT-GATE round-2: agent-driven vault_read approval cards
  // posted by `installWorkflowApprovalChatBridge`. Discriminator is
  // `metadata.approvalKind` (not `metadata.kind`) since the bridge
  // synthesises a richer metadata bag than the chat-tab approval flow.
  if (m.type === 'approval' && m.metadata?.approvalKind === 'vault_read') {
    return 'vault-read-approval';
  }
  // Guided-demo agent-approval card — backed only by the ApprovalManager (see
  // InlineDemoApprovalCard); no gateway/workflow/grant, so it's leak-free.
  if (m.type === 'approval' && m.metadata?.kind === 'demo_approval') {
    return 'demo-approval';
  }
  // Guided-demo PeerLens review card (InlineDemoReviewCard) — inert Publish,
  // posted as a 'system' message tagged with metadata.kind 'demo_review'.
  if (m.metadata?.kind === 'demo_review') {
    return 'demo-review';
  }
  // Guided-demo read-only services-page preview (InlineDemoServicePreviewCard) —
  // the salon listing shown before the publish popup. Posted as a 'system'
  // message tagged with metadata.kind 'demo_service_preview'.
  if (m.metadata?.kind === 'demo_service_preview') {
    return 'demo-service-preview';
  }
  // Lifecycle-tracked dina message — same MessageType as a plain dina
  // reply, dispatched here on the metadata block. Mirrors the
  // approval-card pattern (kind discriminator on metadata, no new
  // MessageType).
  const lifecycle = m.metadata?.lifecycle as { kind?: unknown; status?: unknown } | undefined;
  if (m.type === 'dina' && lifecycle?.kind === 'service_query') {
    return 'service-query';
  }
  if (m.type === 'dina' && lifecycle?.kind === 'missing_capability') {
    return 'missing-capability';
  }
  // ask_pending bubble — show as animated dots while status is
  // 'pending'. Once the bridge patches it to 'complete', content
  // becomes the answer text and we fall through to the regular
  // 'dina' branch so the same row renders as a normal reply.
  if (m.type === 'dina' && lifecycle?.kind === 'ask_pending' && lifecycle.status === 'pending') {
    return 'ask-pending';
  }
  if (m.type === 'dina' && lifecycle?.kind === 'reasoning_job' && lifecycle.status !== 'complete') {
    return 'reasoning-job';
  }
  // review_draft card — chat-driven `/ask write a review of <X>`
  // flow. Renders editable sentiment / headline / body + Publish.
  // No status gate: every state has a card variant (drafting →
  // ready → publishing → published / discarded / failed) so the
  // dispatch always lands on the inline component.
  if (m.type === 'dina' && lifecycle?.kind === 'review_draft') {
    return 'review-draft';
  }
  // Unknown-sender D2D review card — a stranger's message was
  // quarantined; offer Add-to-contacts / Block inline.
  if (m.type === 'dina' && lifecycle?.kind === 'quarantine_request') {
    return 'quarantine-request';
  }
  // commerce_comparison card — the money-free where-to-buy result from the
  // product-research loop (§5.A4/A5). One terminal 'ready' state, so no status
  // gate; the card renders its recommendation + alternatives + where-to-buy
  // links beside the loop's narrative.
  if (m.type === 'dina' && lifecycle?.kind === 'commerce_comparison') {
    return 'commerce-comparison';
  }
  // group_plan card — the organizer's plan (GROUP_COORDINATION §9): a view
  // keyed by the plan id that reads the fold from Core and carries the
  // organizer's decisions. Renders beside the one-line ack the loop wrote.
  if (m.type === 'dina' && lifecycle?.kind === 'group_plan') {
    return 'group-plan';
  }
  if (m.type === 'dina') return 'dina';
  if (m.type === 'nudge') return 'nudge';
  if (m.type === 'reminder') return 'reminder';
  if (m.type === 'briefing') return 'briefing';
  return 'system';
}

export function chatRowKind(displayType: DisplayType): string {
  switch (displayType) {
    case 'user':
      return 'user';
    case 'dina':
      return 'answer';
    case 'system':
      return 'system';
    case 'reminder':
      return 'reminder';
    case 'service-query':
      return 'service-query';
    case 'commerce-comparison':
      return 'commerce-comparison';
    case 'group-plan':
      return 'group-plan';
    case 'quarantine-request':
      return 'quarantine';
    case 'ask-approval':
    case 'service-approval':
      return 'approval';
    case 'vault-read-approval':
      return 'vault-read-approval';
    case 'missing-capability':
      return 'missing-capability';
    case 'review-draft':
      return 'review-draft';
    case 'nudge':
      return 'nudge';
    case 'briefing':
      return 'briefing';
    default:
      return String(displayType);
  }
}
