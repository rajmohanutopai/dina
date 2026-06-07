/**
 * Real seam implementations for the guided-demo runner. Each binds a runner
 * seam (`GuidedDemoSeams`) to the SAME mechanism the app uses normally, so the
 * demo's cards/answers come from real renderers (design doc § Risks: "cards
 * should come from real renderers"):
 *   - send        → the chat composer's `sendMessage` with the /remember | /ask
 *                   prefix the mode chips use;
 *   - requestApproval / denyApproval → the shared `ApprovalManager` singleton
 *                   that backs the real approval cards + notifications inbox;
 *   - postDemoCard → a scope-bound system chat message (cleaned up with the
 *                   demo scope's chat rows).
 *
 * Note on fidelity: `send` runs the REAL pipeline, but `postRecommendation`
 * (PeerLens), `postServiceCard` (service availability), and `requestApproval`
 * (agent-safety) are SIMULATIONS — deterministic seed data rendered through the
 * real card components, not the real PeerLens AppView / cross-Dina service D2D /
 * external-agent gateway. See content.ts "SCOPE OF FIDELITY" for why + where the
 * real end-to-end coverage of those paths lives.
 *
 * Source: docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md § Phase 5.
 */

import { addLifecycleMessage, addMessage } from '@dina/brain/chat';
import { getApprovalManager } from '@dina/core';

import { addSystemNotification, sendMessage } from '../hooks/useChatThread';

import type { DemoMode } from './content';
import type { GuidedDemoSeams } from './runner';

const MAIN_THREAD = 'main';

/** Map a composer mode to the slash-command prefix `handleChat` recognises. */
function prefixFor(mode: DemoMode): string {
  return mode === 'remember' ? '/remember ' : '/ask ';
}

/**
 * Build the production seams. The runner stays pure; this is the only place
 * that touches live app singletons, so it's swapped for fakes in tests.
 */
export function makeGuidedDemoSeams(): GuidedDemoSeams {
  return {
    async send(mode, message) {
      // Route through the exact path the composer uses, so the demo exercises
      // intent routing, vault writes, people extraction, reminders, and card
      // rendering identically to a real user message.
      await sendMessage(`${prefixFor(mode)}${message}`);
    },
    postRecommendation(question, answer) {
      // A real user→Dina exchange via the live chat renderer. Deterministic +
      // grounded in the demo PeerLens chairs (no fabricated peers) — see the
      // 'recommend' note in content.ts. Both rows are scope-bound to the demo.
      addMessage(MAIN_THREAD, 'user', question);
      addMessage(MAIN_THREAD, 'dina', answer);
    },
    postServiceCard(card) {
      // A REAL resolved service-query card — the same lifecycle the live
      // service path posts, so `InlineServiceQueryCard` renders it through
      // `buildResultCardSpec` exactly as a genuine provider response would.
      addLifecycleMessage(MAIN_THREAD, card.content, {
        kind: 'service_query',
        status: 'resolved',
        taskId: card.taskId,
        queryId: card.taskId,
        capability: card.capability,
        serviceName: card.serviceName,
        providerDid: card.providerDid,
        params: card.params,
        result: card.result,
        resolvedAt: Date.now(),
      });
    },
    requestApproval(req) {
      // Create the REAL ApprovalManager request (so approve/deny + the runner's
      // teardown-deny operate on genuine state + the inbox bridge fires), then
      // post an actionable demo approval CARD into the chat thread. We post it
      // ourselves with `metadata.kind: 'demo_approval'` — the chat renderer
      // dispatches that to InlineDemoApprovalCard, which resolves via the
      // ApprovalManager directly (no gateway/workflow/grant → leak-free for a
      // standalone demo request). `createApprovalCard` was NOT enough: its
      // message carries no metadata.kind, so the renderer ignored it. The chat
      // message is scope-bound → torn down with the demo scope.
      getApprovalManager().requestApproval({
        id: req.id,
        action: req.action,
        requester_did: req.requesterDid,
        persona: req.persona,
        reason: req.reason,
        preview: req.preview,
        created_at: Date.now(),
      });
      addMessage(MAIN_THREAD, 'approval', req.preview, {
        metadata: {
          kind: 'demo_approval',
          approvalId: req.id,
          persona: req.persona,
          preview: req.preview,
        },
      });
      return req.id;
    },
    denyApproval(id) {
      getApprovalManager().denyRequest(id);
    },
    postDemoCard(text) {
      // System chat message → scope-bound via the chat repository, so the
      // demo's publish-draft card is removed when the demo scope is torn down.
      addSystemNotification(text);
    },
  };
}
