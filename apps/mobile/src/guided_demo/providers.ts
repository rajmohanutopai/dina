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

import { router } from 'expo-router';

import { addLifecycleMessage, addMessage } from '@dina/brain/chat';
import { getApprovalManager } from '@dina/core';

import { addSystemNotification, sendMessage } from '../hooks/useChatThread';

import { describePeerLensReview, type GuidedDemoSeams } from './runner';

import type { DemoMode, DemoNavTarget } from './content';

const MAIN_THREAD = 'main';

/**
 * How long Dina "checks" before the recommend / service answer appears. The
 * deterministic demo data would otherwise render in <1ms, which reads as obviously
 * canned; a brief pause makes it feel like a real lookup. Lives only in the real
 * seams (the runner awaits them) — fake seams in tests resolve instantly.
 */
const DINA_THINKING_MS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

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
      // Make sure Chat is focused before sending — after the People › Relations
      // peek (the single nav step) the user is on the People tab; this returns
      // them so they see the message land. No-op when already on Chat.
      router.navigate('/');
      // Route through the exact path the composer uses, so the demo exercises
      // intent routing, vault writes, people extraction, reminders, and card
      // rendering identically to a real user message.
      await sendMessage(`${prefixFor(mode)}${message}`);
    },
    async postRecommendation(question, answer) {
      // A real user→Dina exchange via the live chat renderer. Deterministic +
      // grounded in the demo PeerLens chairs (no fabricated peers) — see the
      // 'recommend' note in content.ts. Both rows are scope-bound to the demo.
      // Prefix with the `/ask ` command so the bubble shows the ASK badge
      // (the renderer derives the badge from the prefix + strips it), matching
      // how the remember steps render the REMEMBER badge.
      addMessage(MAIN_THREAD, 'user', `/ask ${question}`);
      // Pause before the answer so it doesn't render instantly (canned-looking).
      await sleep(DINA_THINKING_MS);
      addMessage(MAIN_THREAD, 'dina', answer);
    },
    async postServiceCard(card) {
      // Post the user's question first, then a REAL resolved service-query card
      // — the same lifecycle the live service path posts, so
      // `InlineServiceQueryCard` renders it through `buildResultCardSpec`
      // exactly as a genuine provider response would.
      // `/ask ` prefix → the bubble shows the ASK badge (renderer strips it).
      if (card.question !== '') addMessage(MAIN_THREAD, 'user', `/ask ${card.question}`);
      // Pause so the resolved card lands like a real lookup, not instantly.
      await sleep(DINA_THINKING_MS);
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
          // what/why so the card prompt is actually decidable.
          what: req.what,
          why: req.why,
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
    postUserMessage(text) {
      // The task hand-off, shown as a real user message — NOT routed through the
      // /task LLM path (which would dispatch to a non-existent agent + time out).
      // The approval card that follows IS the demo's agent-safety moment. The
      // `/task ` prefix makes the bubble show the TASK badge (renderer strips it).
      addMessage(MAIN_THREAD, 'user', `/task ${text}`);
    },
    navigate(target: DemoNavTarget) {
      // Drive the app so the user SEES where data landed. The demo dock is
      // rendered at the Tabs level, so it stays visible across this navigation.
      if (target === 'people-relations') {
        router.navigate({ pathname: '/people', params: { tab: 'relations' } });
      } else {
        router.navigate('/');
      }
    },
    async postD2DMessage(from, message, reminder) {
      // Dina-to-Dina Talk (simulation): show the incoming peer message, pause
      // while Dina processes it, then post the enriched reminder as a real
      // reminder card (scheduled → display-only, no actions). The reminder text
      // is pre-enriched from the cold-brew memory (the real path would do this
      // via staging + vault search; here it's deterministic seed data).
      addMessage(MAIN_THREAD, 'system', `${from} (a contact) messaged you: "${message}"`);
      await sleep(DINA_THINKING_MS);
      addMessage(MAIN_THREAD, 'reminder', reminder, {
        metadata: {
          kind: 'reminder',
          reminderId: 'guided-demo-d2d',
          shortId: 'd2d',
          reminderKind: 'social',
          persona: 'general',
          dueAt: Date.now() + 86_400_000, // ~tomorrow
          recurring: '',
          scheduled: true, // confirmation card → no Snooze / Mark-done actions
        },
      });
    },
    postReviewCard(review) {
      // A demo-only PeerLens review card (InlineDemoReviewCard) with an inert
      // Publish button — does NOT touch the real publish path (injectAttestation
      // etc.), so demo data can never reach the AppView. Scope-bound chat row.
      addMessage(MAIN_THREAD, 'system', describePeerLensReview(), {
        metadata: {
          kind: 'demo_review',
          product: review.product,
          rating: review.rating,
          text: review.text,
        },
      });
    },
    async delay(ms = DINA_THINKING_MS) {
      // Default: the "agent is working" beat for the task step (between the
      // hand-off and the approval card), same as the recommend/service pauses.
      // A caller may pass a shorter gap (e.g. between the two opening remembers).
      await sleep(ms);
    },
  };
}
