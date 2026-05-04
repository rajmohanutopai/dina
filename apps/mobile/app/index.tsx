/**
 * Chat tab — main interaction screen.
 *
 * Supports /remember and /ask commands via Brain orchestrator.
 * Messages render in a scrollable list with typing indicator.
 * Primary actions surfaced as tappable CTAs, not hidden slash commands.
 *
 * Styled with Dina warm design system (FAF8F5 palette).
 */

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
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';
import { colors, spacing, radius, shadows } from '../src/theme';
import { useLiveThread } from '../src/hooks/useChatThread';
import type { ChatMessage } from '@dina/brain/chat';
import { InlineApprovalCard } from '../src/components/InlineApprovalCard';
import { InlineServiceApprovalCard } from '../src/components/InlineServiceApprovalCard';
import { InlineNudgeCard } from '../src/components/InlineNudgeCard';
import { InlineReminderCard } from '../src/components/InlineReminderCard';
import { InlineBriefingCard } from '../src/components/InlineBriefingCard';
import { InlineServiceQueryCard } from '../src/components/InlineServiceQueryCard';
import { InlineReviewDraftCard } from '../src/components/InlineReviewDraftCard';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';

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
    | 'service-query'
    | 'ask-pending'
    | 'review-draft'
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
    description: 'Hand work to an agent \u2014 fetch email, run a workflow, \u2026',
    prefix: '/task ',
    placeholder: 'e.g. Fetch my new email',
  },
] as const;

export default function ChatScreen() {
  const router = useRouter();
  // Live-subscribed view of the Brain thread store. Issue #1 + #2:
  // - `send` routes through `handleChat` → uses the installed /ask,
  //   /service, /service_approve, /service_deny command handlers.
  // - `messages` re-renders on every thread write, including async
  //   arrivals from `WorkflowEventConsumer.deliver` (Bus 42 replies).
  const { messages: threadMessages, send, sending } = useLiveThread('main');
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

      await send(fullText);

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
    // Pattern A inline approval card — 5.21-H. The bridge writes
    // `'approval'`-typed messages with `metadata.kind === 'ask_approval'`
    // when the agentic loop bails on a sensitive persona; render an
    // inline card with Approve / Deny buttons instead of a plain bubble.
    if (item.displayType === 'ask-approval') {
      const node = getBootedNode();
      const approverDID = node?.did ?? '';
      return <InlineApprovalCard message={item} approverDID={approverDID} />;
    }
    // Service-capability approval card — 5.65. `defaultApprovalNotifier`
    // writes these when a peer's D2D `service.query` lands and the
    // operator's review policy says "ask". Same dispatch shape, but
    // routes Approve/Deny to the orchestrator's service handlers.
    if (item.displayType === 'service-approval') {
      return <InlineServiceApprovalCard message={item} />;
    }
    // Lifecycle-tracked service-query message. Posted as a regular
    // 'dina' message tagged with `metadata.lifecycle.kind ===
    // 'service_query'` at dispatch time (`/ask` agentic OR `/service`),
    // patched in place by the WorkflowEventConsumer when the response
    // lands. One message for the whole lifecycle replaces the prior
    // LLM-narrative + workflow-event-push double message.
    if (item.displayType === 'service-query') {
      return <InlineServiceQueryCard message={item} />;
    }
    // review_draft card — chat-driven `/ask write a review of <X>`
    // flow. Editable sentiment / headline / body inline; Publish
    // calls injectAttestation directly. State machine drafting →
    // ready → publishing → published / discarded / failed lives on
    // the lifecycle metadata, the card renders the matching variant.
    if (item.displayType === 'review-draft') {
      return <InlineReviewDraftCard message={item} />;
    }
    // ask_pending placeholder — Dina hasn't returned the answer in
    // the fast-path window. Render as animated typing dots inside a
    // dina-style bubble; when the bridge patches lifecycle.status to
    // 'complete', toDisplayType falls through to 'dina' and this row
    // re-renders as a normal reply with the answer text.
    if (item.displayType === 'ask-pending') {
      return (
        <View style={[styles.messageBubble, styles.dinaBubble]}>
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
      return <InlineNudgeCard message={item} />;
    }
    // Fired reminder — 5.64. Posted by `useReminderFireWatcher` when
    // a pending reminder's due_at elapses. Mark done / Snooze 1h.
    if (item.displayType === 'reminder') {
      return <InlineReminderCard message={item} />;
    }
    // Daily briefing card — 5.63. Collapsible aggregate of recent
    // activity; tap-through links route per-item via expo-router.
    if (item.displayType === 'briefing') {
      return <InlineBriefingCard message={item} />;
    }

    const isUser = item.displayType === 'user';
    const isSystem = item.displayType === 'system';

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
        <Text
          style={[styles.messageText, isUser && styles.userText, isSystem && styles.systemText]}
        >
          {displayContent}
        </Text>
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

      {messages.length === 0 ? (
        <ScrollView
          style={styles.emptyScroll}
          contentContainerStyle={styles.emptyState}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero — header already shows the Dina wordmark, so no
              redundant DINA label here. */}
          <Text style={styles.heroTitle}>Your sovereign{'\n'}personal AI</Text>
          <Text style={styles.heroSubtitle}>
            Everything stays on your device.{'\n'}Your data, your rules.
          </Text>

          {/* Help CTA \u2014 first-time-user discovery surface. The previous
              two action cards (Remember / Ask) duplicated the chip
              bar above the input AND only taught two of the eight
              capabilities; tapping through to Help is a richer entry
              point. The header `?` icon (added in _layout.tsx) keeps
              Help reachable once the user is past this empty state. */}
          <View style={styles.actionCards}>
            <TouchableOpacity
              style={styles.actionCard}
              onPress={() => router.push('/help')}
              activeOpacity={0.7}
            >
              <View style={styles.actionCardHeader}>
                <View style={styles.actionIcon}>
                  <Text style={styles.actionIconText}>?</Text>
                </View>
                <Text style={styles.actionCardTitle}>What can Dina do?</Text>
                <Text style={styles.actionArrow}>{'\u2192'}</Text>
              </View>
              <Text style={styles.actionCardDesc}>
                {'Tour the capabilities \u2014 your vault, working with agents, coordinating with people, and queries to the Dina network.'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          style={styles.messageList}
          contentContainerStyle={styles.messageListContent}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
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
                {ACTIONS.map((action) => (
                  <TouchableOpacity
                    key={action.key}
                    style={styles.modeChip}
                    onPress={() => handleAction(action)}
                    activeOpacity={0.7}
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
              >
                <Text style={styles.modePillLabel}>{activeAction.label}</Text>
                <Text style={styles.modePillChevron}>{'\u25BE'}</Text>
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
              >
                <Text
                  style={[
                    styles.sendArrow,
                    (!inputText.trim() || isTyping) && styles.sendArrowDisabled,
                  ]}
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
        >
          <Pressable style={styles.popoverSheet} onPress={() => undefined}>
            <Text style={styles.popoverHint}>Switch mode</Text>
            {ACTIONS.map((action) => {
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
  heroTitle: {
    fontSize: 32,
    fontWeight: '300',
    color: colors.textPrimary,
    textAlign: 'center',
    lineHeight: 40,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    fontStyle: 'italic',
  },
  heroSubtitle: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 22,
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
  actionIconText: {
    fontSize: 14,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  actionCardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
    flex: 1,
  },
  actionArrow: {
    fontSize: 16,
    color: colors.textMuted,
  },
  actionCardDesc: {
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
    marginLeft: 40,
  },
  // Message list
  messageList: {
    flex: 1,
  },
  messageListContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
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
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 3,
    letterSpacing: 0.3,
  },
  systemLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 3,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  messageText: {
    fontSize: 16,
    lineHeight: 23,
    color: colors.dinaBubbleText,
  },
  userText: {
    color: colors.userBubbleText,
  },
  systemText: {
    color: colors.textSecondary,
    textAlign: 'center',
    fontSize: 14,
  },
  timestamp: {
    fontSize: 10,
    color: colors.textMuted,
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
    fontSize: 13,
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
  modeChipLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textPrimary,
  },

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
    fontSize: 13,
    fontWeight: '600',
    color: colors.white,
    letterSpacing: 0.3,
  },
  modePillChevron: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
    marginLeft: 5,
    fontWeight: '600',
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
    fontSize: 11,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
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
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
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
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: 2,
  },
  popoverLabelActive: {
    color: colors.accent,
  },
  popoverDesc: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18,
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
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
    color: colors.textPrimary,
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
    color: colors.white,
    fontSize: 18,
    fontWeight: '700',
    marginTop: -1,
  },
  sendArrowDisabled: {
    color: colors.textMuted,
  },
});
