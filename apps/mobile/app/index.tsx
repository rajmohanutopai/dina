/**
 * Chat tab — main interaction screen.
 *
 * Supports /remember and /ask commands via Brain orchestrator.
 * Messages render in a scrollable list with typing indicator.
 * Primary actions surfaced as tappable CTAs, not hidden slash commands.
 *
 * Styled with Dina warm design system (FAF8F5 palette).
 */

import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  Modal,
  Pressable,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ScrollView,
  type GestureResponderEvent,
  type ViewProps,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { ACTIONS, resolveUserChip } from '../src/components/composer_modes';
import { InlineApprovalCard } from '../src/components/InlineApprovalCard';
import { InlineBriefingCard } from '../src/components/InlineBriefingCard';
import { InlineCreditsCard } from '../src/components/InlineCreditsCard';
import { InlineDemoApprovalCard } from '../src/components/InlineDemoApprovalCard';
import { InlineDemoReviewCard } from '../src/components/InlineDemoReviewCard';
import { InlineDemoServicePreviewCard } from '../src/components/InlineDemoServicePreviewCard';
import { InlineMarkdownText } from '../src/components/InlineMarkdownText';
import { InlineMissingCapabilityCard } from '../src/components/InlineMissingCapabilityCard';
import { InlineNudgeCard } from '../src/components/InlineNudgeCard';
import { InlineQuarantineCard } from '../src/components/InlineQuarantineCard';
import { InlineReasoningJobCard } from '../src/components/InlineReasoningJobCard';
import { InlineReminderCard } from '../src/components/InlineReminderCard';
import { InlineReviewDraftCard } from '../src/components/InlineReviewDraftCard';
import { InlineServiceApprovalCard } from '../src/components/InlineServiceApprovalCard';
import { InlineServiceQueryCard } from '../src/components/InlineServiceQueryCard';
import { InlineVaultReadApprovalCard } from '../src/components/InlineVaultReadApprovalCard';
import { MessageActionMenu } from '../src/components/MessageActionMenu';
import { GUIDED_DEMO_LIST_CLEARANCE, useGuidedDemoActive } from '../src/guided_demo/active_context';
import { useLiveThread, addSystemNotification } from '../src/hooks/useChatThread';
import { useCredits } from '../src/hooks/useCredits';
import { useHasActiveAgent } from '../src/hooks/useHasActiveAgent';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import { reviewSourceLabel } from '../src/peerlens/review_source_label';
import {
  trySubmitConnectedBrainAsk,
  useConnectedBrainChatReconciler,
} from '../src/reasoning/connected_brain_chat';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

import type { ChatMessage } from '@dina/brain/chat';

// Render message shape used by the screen's bubble logic. The chat UI
// treats Brain's MessageType union as eight display buckets: user
// text, Dina reply, ask-approval card (5.21-H), service-approval
// card (5.65), nudge card (5.62), reminder card (5.64), briefing
// card (5.63), everything-else-system (error / unrecognised).
type UiMessage = ChatMessage & {
  displayType:
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
    | 'nudge'
    | 'reminder'
    | 'briefing';
};

function toDisplayType(m: ChatMessage): UiMessage['displayType'] {
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
  if (m.type === 'dina') return 'dina';
  if (m.type === 'nudge') return 'nudge';
  if (m.type === 'reminder') return 'reminder';
  if (m.type === 'briefing') return 'briefing';
  return 'system';
}

// ── E2E row contract (docs/E2E_TESTING.md §5) ──────────────────────────
// Every chat row is wrapped once (at the FlatList `renderItem`) in a
// `testID="chat-row"` View carrying `data-*` attributes so the
// Playwright/judge suite can select "the latest card of kind X" or "the
// service card once its status is resolved" without racing a re-mount.
// `dataSet` is a react-native-web prop → `data-*` on the web DOM (camelCase
// maps to kebab, e.g. `rowSeq` → `data-row-seq`); native RN ignores it.
// The inner per-branch testIDs (`chat-card-*`, `chat-msg-*`, and each
// card's `*-card-body-*`) are unchanged — this only adds an outer handle.

function chatRowKind(displayType: UiMessage['displayType']): string {
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

/** A peer's literal D2D message renders as a left bubble with
 *  `displayType === 'dina'` + `metadata.source === 'd2d'` (mirrors
 *  `fromD2DPeer` in the bubble render). It is NOT a Dina-generated answer,
 *  so the row contract must distinguish it — otherwise `latestAnswerText`
 *  could scrape a peer's words as if Dina said them. */
function isD2DPeerMessage(item: UiMessage): boolean {
  return item.displayType === 'dina' && item.metadata?.source === 'd2d';
}

/** Lifecycle status for cards that update in place (pending → resolved). */
function chatRowStatus(item: UiMessage): string {
  const lifecycle = (item.metadata ?? {}).lifecycle as Record<string, unknown> | undefined;
  const status = lifecycle?.status;
  return typeof status === 'string' ? status : '';
}

/** Best-effort stable id for addressing a specific row (falls back to the
 *  message id, which is always unique). */
function chatRowEntityId(item: UiMessage): string {
  const md = (item.metadata ?? {}) as Record<string, unknown>;
  const lifecycle = (md.lifecycle ?? {}) as Record<string, unknown>;
  const candidates = [
    md.approvalId,
    md.approvalTaskId,
    md.taskId,
    md.reminderId,
    lifecycle.quarantineId,
    lifecycle.taskId,
    lifecycle.queryId,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c;
  }
  return item.id;
}

function chatRowProps(item: UiMessage, index: number): ViewProps {
  // `dataSet` is not in RN's ViewProps types (it's a react-native-web
  // extension), so the cast is localized here.
  const d2d = isD2DPeerMessage(item);
  const kind = d2d ? 'd2d-message' : chatRowKind(item.displayType);
  const role = d2d
    ? 'peer'
    : item.type === 'user'
      ? 'user'
      : item.type === 'dina'
        ? 'assistant'
        : 'system';
  return {
    testID: 'chat-row',
    dataSet: {
      rowSeq: String(index),
      kind,
      role,
      status: chatRowStatus(item),
      entityId: chatRowEntityId(item),
    },
  } as unknown as ViewProps;
}

// The chat-mode chips (Ask / Remember / Task / Services / Reviews) + the
// user-bubble chip resolver live in `src/components/composer_modes`. The user
// must pick a mode before they can send \u2014 keeps Dina transactional rather than
// an open-ended chatbot (Anti-Her). Talk is rendered separately below as a
// navigation chip (contact picker), not a text mode.
export default function ChatScreen() {
  const router = useRouter();
  // While the guided demo's bottom dock is up, reserve extra space at the end of
  // the message list so the last message isn't hidden behind it (the dock is an
  // absolute overlay taller than the composer the list normally clears).
  const demoActive = useGuidedDemoActive();
  // Live-subscribed view of the Brain thread store. Issue #1 + #2:
  // - `send` routes through `handleChat` → uses the installed /ask,
  //   /service, /service_approve, /service_deny command handlers.
  // - `messages` re-renders on every thread write, including async
  //   arrivals from `WorkflowEventConsumer.deliver` (Bus 42 replies).
  const { messages: threadMessages, send, sending } = useLiveThread('main');
  useConnectedBrainChatReconciler('main');
  // Starter Credits cards (wall / low-balance) — re-evaluated as the
  // thread grows so exhaustion surfaces at the send that hit the cap
  // (each send/answer/error appends a message → refreshBalance runs).
  const credits = useCredits(threadMessages.length);
  // Gate the /task chip on having a paired delegation-capable agent.
  // Without one, `delegate_to_agent` would dispatch a workflow task no
  // one claims and the user would wait 60 s for "agent did not complete"
  // — a dead-end UX. Hide the chip + popover row instead so the
  // requirement is discovered up-front (Settings → Agents).
  const hasActiveAgent = useHasActiveAgent();
  const availableActions = hasActiveAgent ? ACTIONS : ACTIONS.filter((a) => a.key !== 'task');
  // The reminder fire watcher used to mount here, but it now lives in
  // `app/_layout.tsx` so it ticks across every tab. Keeping it Chat-only
  // meant a reminder firing while the user was on Notifications /
  // Reminders / Settings produced an OS push but no in-app fan-out
  // until they wandered back. The root mount fixes that.
  const [inputText, setInputText] = useState('');
  const [activeAction, setActiveAction] = useState<(typeof ACTIONS)[number] | null>(null);
  // Mode-switch popover (opened by tapping the pill once a mode is
  // active). Replaces the legacy chip bar above the input.
  const [modePopoverOpen, setModePopoverOpen] = useState(false);
  // Deep-press (long-press) action menu for a chat bubble — the text to act on
  // plus the screen-space press point so the floating menu anchors to it.
  const [actionMenu, setActionMenu] = useState<{ content: string; x: number; y: number } | null>(
    null,
  );
  // Recovery-phrase backup is no longer surfaced as a passive banner here —
  // it's a deferred, value-proportionate page popped by useBackupPrompt once
  // the vault is worth protecting (see services/backup_prompt). Settings →
  // Confirm recovery phrase remains the proactive entry point.
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);

  // Map Brain's MessageType (user/dina/approval/nudge/briefing/system/error)
  // onto the three display buckets the bubble renderer knows.
  const messages: UiMessage[] = threadMessages.map((m) => ({
    ...m,
    displayType: toDisplayType(m),
  }));
  const isTyping = sending;

  const sendMessage = useCallback(
    async (overrideText?: string) => {
      const raw = overrideText ?? inputText;
      const content = raw.trim();
      if (!content && !overrideText) return;

      // Build the full command: prefix + user content. handleChat recognises
      // /remember, /ask, /service, /service_approve, /service_deny, /help.
      const selectedAction = activeAction;
      const fullText = selectedAction ? `${selectedAction.prefix}${content}` : content;

      setInputText('');
      setActiveAction(null);

      try {
        // An explicitly enabled connected host can serve the Ask lane without
        // a second model API key. The trusted mobile edge creates the
        // Core-owned durable job; every other mode keeps its existing path.
        const connected =
          !demoActive && selectedAction?.key === 'ask'
            ? await trySubmitConnectedBrainAsk(content, 'main')
            : { handled: false };
        if (!connected.handled) await send(fullText);
      } catch {
        // Provider/runtime errors are normally handled inside the ask
        // pipeline (it writes a friendly reply to the thread). This
        // catches the rare unexpected throw so it surfaces as a message
        // instead of a silent unhandled rejection.
        addSystemNotification('Something went wrong reaching Dina. Please try again.', 'main');
      }

      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    },
    [inputText, activeAction, demoActive, send],
  );

  const handleAction = useCallback((action: (typeof ACTIONS)[number]) => {
    setActiveAction(action);
    setInputText('');
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Talk is a NAV action, not a text mode: it opens the contact picker (People
  // → Contacts) where tapping a contact lands on the per-contact D2D thread.
  // Talk is "message a specific person", not free-text to your own Dina, so it
  // never enters the ask pipeline (docs/COMPOSER_MODES_DESIGN.md section 7.7).
  const onTalk = useCallback(() => {
    router.push({ pathname: '/people', params: { pick: 'talk' } });
  }, [router]);

  // Deep-press on a chat bubble → open the action menu anchored to the press
  // point. Captures the visible text so Copy acts on exactly what's on screen.
  const onBubbleLongPress = useCallback((content: string, evt: GestureResponderEvent) => {
    if (content.trim() === '') return;
    const { pageX, pageY } = evt.nativeEvent;
    setActionMenu({ content, x: pageX, y: pageY });
    // Fire a subtle Taptic "tic" the moment the menu pops, matching the iOS
    // context-menu feel (the deep-press confirmation in your finger). Lazy +
    // guarded like clipboard: the expo-haptics native module ships with the next
    // dev-client / EAS build; until then it's a clean no-op (and the simulator
    // has no haptics regardless — this is felt on a real device).
    void (async () => {
      try {
        const Haptics = await import('expo-haptics');
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      } catch {
        // haptics native module not in this build yet — no-op
      }
    })();
  }, []);

  // Copy the long-pressed message to the clipboard. expo-clipboard is loaded
  // LAZILY (dynamic import) on the Copy tap, not at module load: its native
  // module ships with the next dev-client / EAS build, and a top-level import
  // would throw at screen load on an older build. The whole thing is guarded so
  // a missing native module just makes Copy a clean no-op until the rebuild.
  const copyMessage = useCallback(async (text: string) => {
    setActionMenu(null);
    if (text === '') return;
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(text);
    } catch {
      // clipboard native module not in this build yet — no-op
    }
  }, []);

  const renderMessage = useCallback(
    ({ item }: { item: UiMessage }) => {
      // Skip empty Dina rows. A resolved ask placeholder is blanked when a
      // service-query card carries the turn's message (see
      // coordinator_ask_handler) — rendering it would leave a stray empty
      // bubble above the card.
      if (item.displayType === 'dina' && (item.content ?? '').trim() === '') {
        return null;
      }
      // Pattern A inline approval card — 5.21-H. The bridge writes
      // `'approval'`-typed messages with `metadata.kind === 'ask_approval'`
      // when the agentic loop bails on a sensitive persona; render an
      // inline card with Approve / Deny buttons instead of a plain bubble.
      if (item.displayType === 'ask-approval') {
        const node = getBootedNode();
        const approverDID = node?.did ?? '';
        // E2E: `chat-card-<type>` wraps every inline card so tests can assert
        // "the right card showed up for the scenario" by a stable id.
        return (
          <View testID="chat-card-ask-approval">
            <InlineApprovalCard message={item} approverDID={approverDID} />
          </View>
        );
      }
      // Service-capability approval card — 5.65. `defaultApprovalNotifier`
      // writes these when a peer's D2D `service.query` lands and the
      // operator's review policy says "ask". Same dispatch shape, but
      // routes Approve/Deny to the orchestrator's service handlers.
      if (item.displayType === 'service-approval') {
        return (
          <View testID="chat-card-service-approval">
            <InlineServiceApprovalCard message={item} />
          </View>
        );
      }
      // F-AGENT-VAULT-GATE round-2: agent-driven vault-read approval
      // card. Posted by `installWorkflowApprovalChatBridge` when an
      // external dina-agent hits a sensitive persona. Approve/Deny drive
      // the same `approveWorkflowTask` / `cancelWorkflowTask` path the
      // Approvals tab uses (via `approvePending` / `denyPending`).
      if (item.displayType === 'vault-read-approval') {
        return (
          <View testID="chat-card-vault-read-approval">
            <InlineVaultReadApprovalCard message={item} />
          </View>
        );
      }
      if (item.displayType === 'demo-approval') {
        return (
          <View testID="chat-card-demo-approval">
            <InlineDemoApprovalCard message={item} />
          </View>
        );
      }
      if (item.displayType === 'demo-review') {
        return (
          <View testID="chat-card-demo-review">
            <InlineDemoReviewCard message={item} />
          </View>
        );
      }
      if (item.displayType === 'demo-service-preview') {
        return (
          <View testID="chat-card-demo-service-preview">
            <InlineDemoServicePreviewCard message={item} />
          </View>
        );
      }
      // Lifecycle-tracked service-query message. Posted as a regular
      // 'dina' message tagged with `metadata.lifecycle.kind ===
      // 'service_query'` at dispatch time (`/ask` agentic OR `/service`),
      // patched in place by the WorkflowEventConsumer when the response
      // lands. One message for the whole lifecycle replaces the prior
      // LLM-narrative + workflow-event-push double message.
      if (item.displayType === 'service-query') {
        return (
          <View testID="chat-card-service-query">
            <InlineServiceQueryCard message={item} />
          </View>
        );
      }
      if (item.displayType === 'missing-capability') {
        return (
          <View testID="chat-card-missing-capability">
            <InlineMissingCapabilityCard message={item} />
          </View>
        );
      }
      // review_draft card — chat-driven `/ask write a review of <X>`
      // flow. Editable sentiment / headline / body inline; Publish
      // calls injectAttestation directly. State machine drafting →
      // ready → publishing → published / discarded / failed lives on
      // the lifecycle metadata, the card renders the matching variant.
      if (item.displayType === 'review-draft') {
        return (
          <View testID="chat-card-review-draft">
            <InlineReviewDraftCard message={item} />
          </View>
        );
      }
      // Unknown-sender review card — Add to contacts / Block.
      if (item.displayType === 'quarantine-request') {
        return (
          <View testID="chat-card-quarantine">
            <InlineQuarantineCard message={item} />
          </View>
        );
      }
      // ask_pending placeholder — Dina hasn't returned the answer in
      // the fast-path window. Render as animated typing dots inside a
      // dina-style bubble; when the bridge patches lifecycle.status to
      // 'complete', toDisplayType falls through to 'dina' and this row
      // re-renders as a normal reply with the answer text.
      if (item.displayType === 'ask-pending') {
        return (
          <View testID="chat-msg-ask-pending" style={[styles.messageBubble, styles.dinaBubble]}>
            <View style={styles.typingDots}>
              <View style={[styles.typingDot, { opacity: 0.4 }]} />
              <View style={[styles.typingDot, { opacity: 0.6 }]} />
              <View style={[styles.typingDot, { opacity: 0.8 }]} />
            </View>
          </View>
        );
      }
      if (item.displayType === 'reasoning-job') {
        return <InlineReasoningJobCard message={item} />;
      }
      // Proactive nudge card — 5.62. Reconnection / reminder context /
      // pending promise / health alert. Tier dot indicates urgency.
      if (item.displayType === 'nudge') {
        return (
          <View testID="chat-card-nudge">
            <InlineNudgeCard message={item} />
          </View>
        );
      }
      // Fired reminder — 5.64. Posted by `useReminderFireWatcher` when
      // a pending reminder's due_at elapses. Mark done / Snooze 1h.
      if (item.displayType === 'reminder') {
        return (
          <View testID="chat-card-reminder">
            <InlineReminderCard message={item} />
          </View>
        );
      }
      // Daily briefing card — 5.63. Collapsible aggregate of recent
      // activity; tap-through links route per-item via expo-router.
      if (item.displayType === 'briefing') {
        return (
          <View testID="chat-card-briefing">
            <InlineBriefingCard message={item} />
          </View>
        );
      }

      const isUser = item.displayType === 'user';
      const isSystem = item.displayType === 'system';
      // A peer's D2D message surfaced in the main thread (type='dina' +
      // metadata.source='d2d'). Attribute it to the sender, not "Dina", and
      // render its text literally — it's the peer's words, not LLM output.
      const fromD2DPeer = !isUser && !isSystem && item.metadata?.source === 'd2d';
      const d2dSenderName =
        typeof item.metadata?.senderName === 'string' ? item.metadata.senderName : '';
      const peerLabel = d2dSenderName !== '' ? d2dSenderName : 'A contact';
      // Source pill: when network reviews informed a Dina answer, attribute them.
      const sourceLabel = !isUser && !isSystem ? reviewSourceLabel(item.sources) : null;

      // Mode chip on a user message: clean content + a mode chip, never a leaked
      // slash prefix (docs/COMPOSER_MODES_DESIGN.md 7.1). Logic lives in the pure,
      // unit-tested `resolveUserChip` (prefers metadata.mode, legacy prefix-strip
      // fallback) so the contract is covered without rendering this whole screen.
      let chipLabel: string | null = null;
      let displayContent = item.content;
      if (isUser) {
        ({ chipLabel, displayContent } = resolveUserChip(item.content, item.metadata?.mode));
      }

      return (
        <Pressable
          // E2E: a stable, type-keyed handle for transient chat bubbles so
          // tests can assert "a Dina/user message appeared" without matching
          // on volatile LLM text. `chat-msg-dina` / `chat-msg-user` /
          // `chat-msg-system`. Cards use `chat-card-<type>` (see Inline*Card).
          testID={`chat-msg-${fromD2DPeer ? 'd2d' : item.displayType}`}
          // Deep-press opens the action menu (Copy). onLongPress only — a normal
          // tap does nothing, so list scrolling is unaffected.
          onLongPress={(e) => onBubbleLongPress(displayContent, e)}
          delayLongPress={300}
          style={[
            styles.messageBubble,
            isUser ? styles.userBubble : styles.dinaBubble,
            isSystem && styles.systemBubble,
          ]}
        >
          {!isUser && !isSystem && (
            <Text style={styles.senderLabel}>{fromD2DPeer ? peerLabel : 'Dina'}</Text>
          )}
          {isSystem && <Text style={styles.systemLabel}>System</Text>}
          {isUser && chipLabel && (
            <View style={styles.msgChip}>
              <Text style={styles.msgChipText}>{chipLabel}</Text>
            </View>
          )}
          {/* E2E: `row-primary-text` is the clean, chrome-free handle the
            Playwright suite scrapes and hands to the Gemini judge — it
            wraps ONLY the message body (no sender label, source pill, or
            timestamp), across all three render branches. See
            docs/E2E_TESTING.md §5. A style-less View is layout-neutral:
            the inner Text was already a block child of the bubble. */}
          <View testID="row-primary-text">
            {isUser ? (
              // User-typed bubbles render literal — never reinterpret what
              // the user typed (typing `**foo**` should stay visible as-is,
              // not silently bolded).
              <Text style={[styles.messageText, styles.userText]}>{displayContent}</Text>
            ) : fromD2DPeer ? (
              // A peer's literal words — render verbatim (no markdown
              // interpretation), in the standard left-bubble text colour.
              <Text style={styles.messageText}>{displayContent}</Text>
            ) : (
              // Dina + system bubbles: the LLM frequently emits `**bold**`
              // for entity emphasis (names, numbers, dates). Render it
              // inline instead of leaking literal asterisks into the UI.
              <InlineMarkdownText style={[styles.messageText, isSystem && styles.systemText]}>
                {displayContent}
              </InlineMarkdownText>
            )}
          </View>
          {sourceLabel !== null && (
            <View style={styles.sourcePill} testID="chat-source-pill">
              <Text style={styles.sourcePillText}>{sourceLabel} · from other Dinas</Text>
            </View>
          )}
          <Text style={[styles.timestamp, isUser && styles.timestampUser]}>
            {new Date(item.timestamp).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </Pressable>
      );
    },
    [onBubbleLongPress],
  );

  // E2E: wrap every rendered row once in the `chat-row` contract (see the
  // helpers above). Preserves the skip-empty behavior (renderMessage
  // returns null → no wrapper). `index` is the row's CURRENT position in
  // the rendered list (`data-row-seq`) — good for "the newest is the
  // highest seq / .last()", but NOT a stable append id across
  // reorder/replay; address a specific row by `data-entity-id`.
  const renderRow = useCallback(
    ({ item, index }: { item: UiMessage; index: number }) => {
      const el = renderMessage({ item });
      if (el === null) return null;
      return <View {...chatRowProps(item, index)}>{el}</View>;
    },
    [renderMessage],
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      // Both platforms: `padding` lifts the composer above the keyboard.
      // Android can no longer rely on `windowSoftInputMode=adjustResize`
      // (behavior=undefined): SDK 55 / Android 15 edge-to-edge neutralises
      // adjustResize, so the OS stops shrinking the view and the composer
      // ends up UNDER the keyboard (#390). `padding` makes KeyboardAvoidingView
      // do the lift itself from the JS keyboard frame. Offset subtracts the
      // tab bar (88pt iOS, 64pt Android) so we don't over-lift.
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 64}
    >
      <StatusBar style="dark" />

      {messages.length === 0 ? (
        <ScrollView
          style={styles.emptyScroll}
          contentContainerStyle={styles.emptyState}
          showsVerticalScrollIndicator={false}
        >
          {/* Small italic brand tagline + supporting body. No big hero
              greeting — keeps the empty state quiet so the action
              card below carries the discovery work. */}
          <Text style={styles.heroTagline}>{'Your sovereign AI.\nYour open network.'}</Text>
          <Text style={styles.heroSubtitle}>Ask Dina. Ask a service. Ask around.</Text>

          {/* During a guided demo the "What can Dina do?" card is an escape
              hatch (it routes to Help). Swap it for a non-interactive "Demo
              running" card so the empty chat doesn't look bare while the dock
              drives the flow. Outside the demo: the Help CTA (first-run
              discovery surface; Help also stays reachable via the header `?`). */}
          <View style={styles.actionCards}>
            {demoActive ? (
              <View style={styles.actionCard} testID="index-demo-running-card">
                <View style={styles.actionCardHeader}>
                  <View style={styles.actionIcon}>
                    <Text style={styles.actionIconText}>{'\u25b6'}</Text>
                  </View>
                  <Text style={styles.actionCardTitle}>Demo running</Text>
                </View>
                <Text style={styles.actionCardDesc}>
                  Follow the guided steps below. Tap Exit any time to end the demo and clear the
                  sample data.
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.actionCard}
                onPress={() => router.push('/help')}
                activeOpacity={0.7}
                testID="index-help-card"
                accessibilityRole="button"
              >
                <View style={styles.actionCardHeader}>
                  <View style={styles.actionIcon}>
                    <Text style={styles.actionIconText}>?</Text>
                  </View>
                  <Text style={styles.actionCardTitle}>What can Dina do?</Text>
                  <Text style={styles.actionArrow}>{'\u2192'}</Text>
                </View>
                <Text style={styles.actionCardDesc}>
                  {"Tour Dina's capabilities: your vault, agents, people, and network services."}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderRow}
          style={styles.messageList}
          contentContainerStyle={[
            styles.messageListContent,
            demoActive && { paddingBottom: spacing.lg + GUIDED_DEMO_LIST_CLEARANCE },
          ]}
          onContentSizeChange={() =>
            // Defer to after the layout commit so scrollToEnd uses the
            // *final* content height. A direct call races tall last
            // items (e.g. the service-handoff card, whose Ionicons /
            // spinner glyphs size in async) — the scroll then lands
            // short and the card slips behind the composer.
            requestAnimationFrame(() => flatListRef.current?.scrollToEnd({ animated: false }))
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      {isTyping && (
        <View style={styles.typingIndicator}>
          <View style={styles.typingDots}>
            <View style={[styles.typingDot, { opacity: 0.4 }]} />
            <View style={[styles.typingDot, { opacity: 0.6 }]} />
            <View style={[styles.typingDot, { opacity: 0.8 }]} />
          </View>
          <Text style={styles.typingText}>Dina is thinking</Text>
        </View>
      )}

      {/* Starter Credits — single pinned instance at thread bottom
          (spec: docs/CREDITS_DESIGN.md §UI 3+4). Wall wins over the
          low-balance nudge; non-LLM features stay usable either way. */}
      {(credits.showWall || credits.showLowBalance) && (
        <View style={{ paddingHorizontal: 12 }}>
          <InlineCreditsCard
            variant={credits.showWall ? 'wall' : 'low-balance'}
            estConversationsLeft={credits.estConversationsLeft ?? undefined}
            onSetUp={() => router.push('/ai-providers')}
            onDismiss={credits.dismissLowBalance}
          />
        </View>
      )}

      {/* Input area */}
      <View style={styles.inputContainer}>
        {/* Mode selector lives *inside* the input wrapper. Force-pick
            is preserved (Anti-Her: chat is transactional, not
            open-ended) but the chips sit in the message box itself so
            first-time users read them as the input rather than as a
            separate toolbar. Once a mode is picked, the chips collapse
            into a pill at the left of the wrapper; tap the pill to
            swap modes via a popover. */}
        <View style={[styles.inputWrapper, activeAction === null && styles.inputWrapperChips]}>
          {activeAction === null ? (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                style={styles.modeChipsScroll}
                contentContainerStyle={styles.modeChips}
              >
                {availableActions.map((action) => (
                  <TouchableOpacity
                    key={action.key}
                    style={styles.modeChip}
                    onPress={() => handleAction(action)}
                    activeOpacity={0.7}
                    testID={`index-mode-chip-${action.key}`}
                    accessibilityRole="button"
                  >
                    <Text style={styles.modeChipLabel}>{action.label}</Text>
                  </TouchableOpacity>
                ))}
                {/* Talk is a nav chip, not a text mode — it opens the contact
                    picker (see onTalk), so it sits after the text-mode chips. */}
                <TouchableOpacity
                  key="talk"
                  style={styles.modeChip}
                  onPress={onTalk}
                  activeOpacity={0.7}
                  testID="index-mode-chip-talk"
                  accessibilityRole="button"
                  accessibilityLabel="Talk to a contact"
                >
                  <Text style={styles.modeChipLabel}>Talk</Text>
                </TouchableOpacity>
              </ScrollView>
              {/* Decorative ghost send button — anchors the wrapper
                  visually as a message bar so the chips read as the
                  input rather than free-floating buttons. Inert: no
                  message to send until the user picks a mode. */}
              <View style={[styles.sendButton, styles.sendButtonDisabled]} pointerEvents="none">
                <Text style={[styles.sendArrow, styles.sendArrowDisabled]}>{'↑'}</Text>
              </View>
            </>
          ) : (
            <>
              <TouchableOpacity
                style={styles.modePill}
                onPress={() => setModePopoverOpen(true)}
                activeOpacity={0.7}
                testID="index-mode-pill"
                accessibilityRole="button"
                accessibilityLabel={`${activeAction.label} mode. Double tap to switch.`}
                accessibilityHint="Switch the chat mode"
              >
                <Text style={styles.modePillLabel}>{activeAction.label}</Text>
                <Text
                  style={styles.modePillChevron}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                >
                  {'\u25BE'}
                </Text>
              </TouchableOpacity>
              <TextInput
                ref={inputRef}
                testID="chat-input"
                style={[styles.textInput, styles.textInputWithChip]}
                value={inputText}
                onChangeText={setInputText}
                placeholder={activeAction.placeholder}
                placeholderTextColor={colors.textMuted}
                returnKeyType="send"
                onSubmitEditing={() => sendMessage()}
                editable={!isTyping}
                autoCorrect={false}
                multiline
                maxLength={2000}
              />
              <TouchableOpacity
                testID="send-button"
                style={[
                  styles.sendButton,
                  (!inputText.trim() || isTyping) && styles.sendButtonDisabled,
                ]}
                onPress={() => sendMessage()}
                disabled={!inputText.trim() || isTyping}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Send message"
                accessibilityState={{ disabled: !inputText.trim() || isTyping }}
              >
                <Text
                  style={[
                    styles.sendArrow,
                    (!inputText.trim() || isTyping) && styles.sendArrowDisabled,
                  ]}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                >
                  {'\u2191'}
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/* Mode-switch popover \u2014 slides up when user taps the pill. */}
      <Modal
        visible={modePopoverOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setModePopoverOpen(false)}
      >
        <Pressable
          style={styles.popoverBackdrop}
          onPress={() => setModePopoverOpen(false)}
          testID="index-popover-backdrop"
          accessibilityRole="button"
          accessibilityLabel="Close mode switcher"
        >
          <Pressable
            style={styles.popoverSheet}
            onPress={() => undefined}
            testID="index-popover-sheet"
          >
            <Text style={styles.popoverHint}>Switch mode</Text>
            {availableActions.map((action) => {
              const isActive = activeAction?.key === action.key;
              return (
                <TouchableOpacity
                  key={action.key}
                  style={[styles.popoverRow, isActive && styles.popoverRowActive]}
                  onPress={() => {
                    setActiveAction(action);
                    setModePopoverOpen(false);
                    setTimeout(() => inputRef.current?.focus(), 100);
                  }}
                  activeOpacity={0.7}
                  testID={`index-popover-row-${action.key}`}
                  accessibilityRole="button"
                >
                  <Text style={[styles.popoverLabel, isActive && styles.popoverLabelActive]}>
                    {action.label}
                  </Text>
                  <Text style={styles.popoverDesc}>{action.description}</Text>
                </TouchableOpacity>
              );
            })}
            {/* Talk is a NAV action, not a text mode — but it must be reachable
                from the switcher too, otherwise a user already in Ask/Services/
                etc. can't get to it (the chip strip is hidden while a mode is
                active). Tapping it closes the popover and opens the contact
                picker instead of setting a text mode. */}
            <TouchableOpacity
              key="talk"
              style={styles.popoverRow}
              onPress={() => {
                setModePopoverOpen(false);
                onTalk();
              }}
              activeOpacity={0.7}
              testID="index-popover-row-talk"
              accessibilityRole="button"
            >
              <Text style={styles.popoverLabel}>Talk</Text>
              <Text style={styles.popoverDesc}>Message a contact</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Deep-press (long-press) action menu for a chat bubble — Copy. Floats
          above the list, anchored to the press point; backdrop tap dismisses. */}
      <MessageActionMenu
        anchor={actionMenu}
        actions={[
          {
            key: 'copy',
            label: 'Copy',
            icon: 'copy-outline',
            onPress: () => {
              void copyMessage(actionMenu?.content ?? '');
            },
          },
        ]}
        onDismiss={() => setActionMenu(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // Container
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },

  // Empty state / hero
  emptyScroll: {
    flex: 1,
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: 20,
    paddingBottom: spacing.xl,
  },
  heroTagline: {
    ...textStyles.tagline,
    // Larger than the 18pt tagline — sized into the h2 range so the
    // empty-chat brand line reads as a soft hero. Keeps the italic
    // Cormorant face (not the upright h2) for the brand voice.
    fontSize: 26,
    lineHeight: 32,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  heroTitle: {
    ...textStyles.displaySmall,
    textAlign: 'center',
  },
  heroSubtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
  },

  // Action cards
  actionCards: {
    width: '100%',
    marginTop: 28,
  },
  actionCard: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    padding: 20,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  actionCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  actionIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  actionIconText: textStyles.bodySmallStrong,
  actionCardTitle: {
    ...textStyles.bodyLargeStrong,
    flex: 1,
  },
  actionArrow: {
    ...textStyles.bodyLarge,
    color: colors.textMuted,
  },
  actionCardDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginLeft: 40,
  },
  // Message list
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },

  // Message bubbles
  messageBubble: {
    maxWidth: '82%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: radius.lg,
    marginBottom: 10,
  },
  userBubble: {
    backgroundColor: colors.userBubble,
    alignSelf: 'flex-end',
    borderBottomRightRadius: 6,
  },
  dinaBubble: {
    backgroundColor: colors.dinaBubble,
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 6,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  systemBubble: {
    backgroundColor: colors.systemBubble,
    alignSelf: 'center',
    maxWidth: '90%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  senderLabel: {
    ...textStyles.eyebrow,
    letterSpacing: 0.3,
    marginBottom: 3,
  },
  systemLabel: {
    ...textStyles.eyebrow,
    letterSpacing: 0.3,
    marginBottom: 3,
    textAlign: 'center',
  },
  messageText: {
    ...textStyles.bodyLarge,
    color: colors.dinaBubbleText,
  },
  userText: {
    color: colors.userBubbleText,
  },
  systemText: {
    ...textStyles.body,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  sourcePill: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
  },
  sourcePillText: {
    ...textStyles.tiny,
    color: colors.textMuted,
  },
  timestamp: {
    ...textStyles.tiny,
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  timestampUser: {
    color: 'rgba(255,255,255,0.5)',
    alignSelf: 'flex-end',
  },

  // Typing indicator
  typingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  typingDots: {
    flexDirection: 'row',
    gap: 4,
    marginRight: 8,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.textMuted,
  },
  typingText: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
    fontStyle: 'italic',
  },

  // Mode selector — 3-chip row that fills the input wrapper when no
  // mode is active. Once a mode is picked, the wrapper switches to
  // the pill + TextInput + send layout.
  // The chip row scrolls horizontally now that there are 6 modes; it takes the
  // available width in the input wrapper, the ghost send button sits after it.
  modeChipsScroll: {
    flexGrow: 1,
    flexShrink: 1,
  },
  modeChips: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  modeChip: {
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.full,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  modeChipLabel: textStyles.link,

  // Mode pill — selected mode shown inside the input wrapper.
  // Tappable: opens the mode-switch popover.
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
    alignSelf: 'center',
  },
  modePillLabel: {
    ...textStyles.bodySmallStrong,
    color: colors.white,
    letterSpacing: 0.3,
  },
  modePillChevron: {
    ...textStyles.caption,
    color: 'rgba(255,255,255,0.85)',
    marginLeft: 5,
  },

  // Message chip (in user bubble)
  msgChip: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 6,
  },
  msgChipText: {
    ...textStyles.eyebrow,
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 0.5,
  },

  // Mode-switch popover (modal slide-up sheet)
  popoverBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  popoverSheet: {
    backgroundColor: colors.bgPrimary,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    ...shadows.sm,
  },
  popoverHint: {
    ...textStyles.eyebrow,
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  popoverRow: {
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    marginBottom: 4,
  },
  popoverRowActive: {
    backgroundColor: colors.bgSecondary,
  },
  popoverLabel: {
    ...textStyles.bodyLargeStrong,
    marginBottom: 2,
  },
  popoverLabelActive: {
    color: colors.accent,
  },
  popoverDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },

  // Input
  inputContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    paddingBottom: Platform.OS === 'ios' ? 4 : 10,
    backgroundColor: colors.bgPrimary,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
    ...shadows.sm,
  },
  // No-mode wrapper override: symmetric padding + center alignment
  // so the 3 chips sit centered inside the input box.
  inputWrapperChips: {
    paddingLeft: 6,
    paddingRight: 6,
    alignItems: 'center',
  },
  textInput: {
    ...textStyles.bodyLarge,
    flex: 1,
    lineHeight: 22,
    maxHeight: 100,
    paddingVertical: Platform.OS === 'ios' ? 8 : 6,
  },
  textInputWithChip: {
    paddingLeft: 0,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendButtonDisabled: {
    backgroundColor: colors.bgTertiary,
  },
  sendArrow: {
    ...textStyles.h3,
    color: colors.white,
    marginTop: -1,
  },
  sendArrowDisabled: {
    color: colors.textMuted,
  },
});
