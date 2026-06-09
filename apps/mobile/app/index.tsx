/**
 * Chat tab — main interaction screen.
 *
 * Supports /remember and /ask commands via Brain orchestrator.
 * Messages render in a scrollable list with typing indicator.
 * Primary actions surfaced as tappable CTAs, not hidden slash commands.
 *
 * Styled with Dina warm design system (FAF8F5 palette).
 */

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
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
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';


import { InlineApprovalCard } from '../src/components/InlineApprovalCard';
import { InlineBriefingCard } from '../src/components/InlineBriefingCard';
import { InlineDemoApprovalCard } from '../src/components/InlineDemoApprovalCard';
import { InlineDemoReviewCard } from '../src/components/InlineDemoReviewCard';
import { InlineMarkdownText } from '../src/components/InlineMarkdownText';
import { InlineMissingCapabilityCard } from '../src/components/InlineMissingCapabilityCard';
import { InlineNudgeCard } from '../src/components/InlineNudgeCard';
import { InlineQuarantineCard } from '../src/components/InlineQuarantineCard';
import { InlineReminderCard } from '../src/components/InlineReminderCard';
import { InlineReviewDraftCard } from '../src/components/InlineReviewDraftCard';
import { InlineServiceApprovalCard } from '../src/components/InlineServiceApprovalCard';
import { InlineServiceQueryCard } from '../src/components/InlineServiceQueryCard';
import { InlineVaultReadApprovalCard } from '../src/components/InlineVaultReadApprovalCard';
import {
  GUIDED_DEMO_LIST_CLEARANCE,
  useGuidedDemoActive,
} from '../src/guided_demo/active_context';
import { useLiveThread, addSystemNotification } from '../src/hooks/useChatThread';
import { useHasActiveAgent } from '../src/hooks/useHasActiveAgent';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import { reviewSourceLabel } from '../src/peerlens/review_source_label';
import {
  dismissVerificationBanner,
  isVerificationBannerDismissed,
  loadVerificationStatus,
} from '../src/services/verification_status';
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
    | 'service-query'
    | 'missing-capability'
    | 'ask-pending'
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
  // Lifecycle-tracked dina message — same MessageType as a plain dina
  // reply, dispatched here on the metadata block. Mirrors the
  // approval-card pattern (kind discriminator on metadata, no new
  // MessageType).
  const lifecycle = m.metadata?.lifecycle as
    | { kind?: unknown; status?: unknown }
    | undefined;
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
  if (
    m.type === 'dina' &&
    lifecycle?.kind === 'ask_pending' &&
    lifecycle.status === 'pending'
  ) {
    return 'ask-pending';
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

// Action definitions for the chat-mode selector. Three first-class
// categories: Ask, Remember, Task. The user must pick one before they
// can send \u2014 keeps Dina from sliding into open-ended chatbot territory
// (Anti-Her principle: every interaction is transactional).
//
// Task routes through `/task ` (chat orchestrator now has its own
// intent for it). Task mode reuses the agentic-loop pipeline but
// prepends a directive so the LLM routes the user's request through
// the `delegate_to_agent` tool instead of answering itself \u2014 i.e. it
// hands the work off to a paired `dina-agent`. Same composition as
// /ask so context enrichment (vault search, contacts, geocode)
// still runs before the delegation; the difference is the destination.
const ACTIONS = [
  {
    key: 'ask',
    label: 'Ask',
    description: 'Search across everything you\u2019ve stored in your vault',
    prefix: '/ask ',
    placeholder: "e.g. When is Emma's birthday?",
  },
  {
    key: 'remember',
    label: 'Remember',
    description: 'Store a fact, preference, or anything you want Dina to keep',
    prefix: '/remember ',
    placeholder: "e.g. Emma's birthday is March 15",
  },
  {
    key: 'task',
    label: 'Task',
    description: 'Hand work to an agent. Fetch email, run a workflow, \u2026',
    prefix: '/task ',
    placeholder: 'e.g. Fetch my new email',
  },
] as const;

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
  // Gate the /task chip on having a paired delegation-capable agent.
  // Without one, `delegate_to_agent` would dispatch a workflow task no
  // one claims and the user would wait 60 s for "agent did not complete"
  // — a dead-end UX. Hide the chip + popover row instead so the
  // requirement is discovered up-front (Settings → Agents).
  const hasActiveAgent = useHasActiveAgent();
  const availableActions = hasActiveAgent
    ? ACTIONS
    : ACTIONS.filter((a) => a.key !== 'task');
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
  // Verification-status banner. Refreshed on every focus so the
  // banner disappears the instant the user returns from
  // /confirm-recovery-phrase. `useFocusEffect` is the expo-router
  // equivalent of "did this screen become visible again".
  const [verificationPending, setVerificationPending] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.all([loadVerificationStatus(), isVerificationBannerDismissed()]).then(
        ([status, dismissed]) => {
          // Show the banner only if verification is still pending AND the user
          // hasn't explicitly closed it.
          if (!cancelled) setVerificationPending(status === 'pending' && !dismissed);
        },
      );
      return () => {
        cancelled = true;
      };
    }, []),
  );
  // Closing the confirm-your-phrase banner persists the dismissal (Settings →
  // Confirm recovery phrase still works for users who want it later).
  const onDismissVerifyBanner = useCallback(() => {
    setVerificationPending(false);
    void dismissVerificationBanner();
  }, []);
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
      const fullText = activeAction ? `${activeAction.prefix}${content}` : content;

      setInputText('');
      setActiveAction(null);

      try {
        await send(fullText);
      } catch {
        // Provider/runtime errors are normally handled inside the ask
        // pipeline (it writes a friendly reply to the thread). This
        // catches the rare unexpected throw so it surfaces as a message
        // instead of a silent unhandled rejection.
        addSystemNotification(
          'Something went wrong reaching Dina. Please try again.',
          'main',
        );
      }

      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    },
    [inputText, activeAction, send],
  );

  const handleAction = useCallback((action: (typeof ACTIONS)[number]) => {
    setActiveAction(action);
    setInputText('');
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const renderMessage = useCallback(({ item }: { item: UiMessage }) => {
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
    // Source pill: when network reviews informed a Dina answer, attribute them.
    const sourceLabel = !isUser && !isSystem ? reviewSourceLabel(item.sources) : null;

    // Parse action chip from user messages
    let chipLabel: string | null = null;
    let displayContent = item.content;
    if (isUser) {
      for (const action of ACTIONS) {
        if (item.content.startsWith(action.prefix)) {
          chipLabel = action.label;
          displayContent = item.content.slice(action.prefix.length);
          break;
        }
      }
    }

    return (
      <View
        // E2E: a stable, type-keyed handle for transient chat bubbles so
        // tests can assert "a Dina/user message appeared" without matching
        // on volatile LLM text. `chat-msg-dina` / `chat-msg-user` /
        // `chat-msg-system`. Cards use `chat-card-<type>` (see Inline*Card).
        testID={`chat-msg-${item.displayType}`}
        style={[
          styles.messageBubble,
          isUser ? styles.userBubble : styles.dinaBubble,
          isSystem && styles.systemBubble,
        ]}
      >
        {!isUser && !isSystem && <Text style={styles.senderLabel}>Dina</Text>}
        {isSystem && <Text style={styles.systemLabel}>System</Text>}
        {isUser && chipLabel && (
          <View style={styles.msgChip}>
            <Text style={styles.msgChipText}>{chipLabel}</Text>
          </View>
        )}
        {isUser ? (
          // User-typed bubbles render literal — never reinterpret what
          // the user typed (typing `**foo**` should stay visible as-is,
          // not silently bolded).
          <Text style={[styles.messageText, styles.userText]}>{displayContent}</Text>
        ) : (
          // Dina + system bubbles: the LLM frequently emits `**bold**`
          // for entity emphasis (names, numbers, dates). Render it
          // inline instead of leaking literal asterisks into the UI.
          <InlineMarkdownText
            style={[styles.messageText, isSystem && styles.systemText]}
          >
            {displayContent}
          </InlineMarkdownText>
        )}
        {sourceLabel !== null && (
          <View style={styles.sourcePill} testID="chat-source-pill">
            <Text style={styles.sourcePillText}>{sourceLabel} · from other Dinas</Text>
          </View>
        )}
        <Text style={[styles.timestamp, isUser && styles.timestampUser]}>
          {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
    );
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <StatusBar style="dark" />

      {/* Hidden during a guided demo (the dock is the only surface) and once the
          user dismisses it. The tappable area navigates to confirm; the X
          dismisses (persisted). */}
      {verificationPending && !demoActive ? (
        <View style={styles.verifyBanner}>
          <Pressable
            onPress={() =>
              router.push({ pathname: '/confirm-recovery-phrase', params: { from: '/' } })
            }
            testID="index-verify-banner"
            accessibilityRole="button"
            accessibilityLabel="Confirm your recovery phrase"
            style={({ pressed }) => [
              styles.verifyBannerMain,
              pressed && styles.verifyBannerPressed,
            ]}
          >
            <Ionicons
              name="alert-circle-outline"
              size={18}
              color="#8A5A00"
              style={{ marginRight: spacing.sm }}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.verifyBannerTitle}>Confirm your recovery phrase</Text>
              <Text style={styles.verifyBannerBody}>
                Quick check that your written copy is good.
              </Text>
            </View>
          </Pressable>
          <Pressable
            onPress={onDismissVerifyBanner}
            testID="index-verify-banner-close"
            accessibilityRole="button"
            accessibilityLabel="Dismiss recovery phrase reminder"
            hitSlop={10}
            style={({ pressed }) => [styles.verifyBannerClose, pressed && styles.verifyBannerPressed]}
          >
            <Ionicons name="close" size={18} color={colors.warningTextDeep} />
          </Pressable>
        </View>
      ) : null}

      {messages.length === 0 ? (
        <ScrollView
          style={styles.emptyScroll}
          contentContainerStyle={styles.emptyState}
          showsVerticalScrollIndicator={false}
        >
          {/* Small italic brand tagline + supporting body. No big hero
              greeting — keeps the empty state quiet so the action
              card below carries the discovery work. */}
          <Text style={styles.heroTagline}>Your sovereign personal AI</Text>
          <Text style={styles.heroSubtitle}>
            Ask, remember, or hand off a task. Everything stays on your device.
          </Text>

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
                  {'Tour Dina\'s capabilities: your vault, agents, people, and network services.'}
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
          renderItem={renderMessage}
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


      {/* Input area */}
      <View style={styles.inputContainer}>
        {/* Mode selector lives *inside* the input wrapper. Force-pick
            is preserved (Anti-Her: chat is transactional, not
            open-ended) but the chips sit in the message box itself so
            first-time users read them as the input rather than as a
            separate toolbar. Once a mode is picked, the chips collapse
            into a pill at the left of the wrapper; tap the pill to
            swap modes via a popover. */}
        <View
          style={[
            styles.inputWrapper,
            activeAction === null && styles.inputWrapperChips,
          ]}
        >
          {activeAction === null ? (
            <>
              <View style={styles.modeChips}>
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
              </View>
              {/* Decorative ghost send button — anchors the wrapper
                  visually as a message bar so the chips read as the
                  input rather than free-floating buttons. Inert: no
                  message to send until the user picks a mode. */}
              <View
                style={[styles.sendButton, styles.sendButtonDisabled]}
                pointerEvents="none"
              >
                <Text style={[styles.sendArrow, styles.sendArrowDisabled]}>
                  {'↑'}
                </Text>
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
                accessibilityHint="Switch between Ask, Remember, and Task modes"
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
                  <Text
                    style={[styles.popoverLabel, isActive && styles.popoverLabelActive]}
                  >
                    {action.label}
                  </Text>
                  <Text style={styles.popoverDesc}>{action.description}</Text>
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  // Container
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },

  // Recovery-phrase pending banner. Shown above everything else when
  // the user tapped "I'll do this later" during onboarding.
  verifyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warningBgSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.sm,
  },
  // Tappable area (navigates to confirm) — sits left of the close button.
  verifyBannerMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  verifyBannerClose: {
    paddingLeft: spacing.sm,
    paddingVertical: 2,
  },
  verifyBannerPressed: {
    opacity: 0.85,
  },
  verifyBannerTitle: {
    ...textStyles.bodySmallStrong,
    color: colors.warningTextDeepest,
  },
  verifyBannerBody: {
    ...textStyles.caption,
    color: colors.warningTextDeep,
    marginTop: 1,
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
  modeChips: {
    flex: 1,
    flexDirection: 'row',
    gap: 8,
  },
  modeChip: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.full,
    paddingVertical: 8,
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
