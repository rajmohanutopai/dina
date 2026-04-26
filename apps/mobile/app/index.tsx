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
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, spacing, radius, shadows } from '../src/theme';
import { useLiveThread } from '../src/hooks/useChatThread';
import type { ChatMessage } from '@dina/brain/src/chat/thread';
import { InlineApprovalCard } from '../src/components/InlineApprovalCard';
import { InlineServiceApprovalCard } from '../src/components/InlineServiceApprovalCard';
import { InlineNudgeCard } from '../src/components/InlineNudgeCard';
import { InlineReminderCard } from '../src/components/InlineReminderCard';
import { InlineBriefingCard } from '../src/components/InlineBriefingCard';
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
    | 'nudge'
    | 'reminder'
    | 'briefing';
};

function toDisplayType(m: ChatMessage): UiMessage['displayType'] {
  if (m.type === 'user') return 'user';
  if (m.type === 'dina') return 'dina';
  if (m.type === 'approval' && m.metadata?.kind === 'ask_approval') {
    return 'ask-approval';
  }
  if (m.type === 'approval' && m.metadata?.kind === 'service_approval') {
    return 'service-approval';
  }
  if (m.type === 'nudge') return 'nudge';
  if (m.type === 'reminder') return 'reminder';
  if (m.type === 'briefing') return 'briefing';
  return 'system';
}

// Action definitions for CTAs
const ACTIONS = [
  {
    key: 'remember',
    label: 'Remember',
    description: 'Store a fact, preference, or anything you want Dina to keep',
    prefix: '/remember ',
    placeholder: "e.g. Emma's birthday is March 15",
  },
  {
    key: 'ask',
    label: 'Ask',
    description: 'Search across everything you\u2019ve stored in your vault',
    prefix: '/ask ',
    placeholder: "e.g. When is Emma's birthday?",
  },
] as const;

export default function ChatScreen() {
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
  const flatListRef = useRef<FlatList>(null);
  const inputRef = useRef<TextInput>(null);
  const prevInputLen = useRef(0);

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

  const handleChipAction = useCallback((action: (typeof ACTIONS)[number]) => {
    setActiveAction(action);
    setInputText('');
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const handleInputChange = useCallback(
    (text: string) => {
      // Detect backspace on empty input — clear the action chip
      if (activeAction && text === '' && prevInputLen.current === 0) {
        setActiveAction(null);
      }
      prevInputLen.current = text.length;
      setInputText(text);
    },
    [activeAction],
  );

  const clearAction = useCallback(() => {
    setActiveAction(null);
    setInputText('');
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
          {/* Hero */}
          <Text style={styles.brandLabel}>DINA</Text>
          <Text style={styles.heroTitle}>Your sovereign{'\n'}personal AI</Text>
          <Text style={styles.heroSubtitle}>
            Everything stays on your device.{'\n'}Your data, your rules.
          </Text>

          {/* Action cards */}
          <View style={styles.actionCards}>
            <Text style={styles.actionSectionTitle}>WHAT WOULD YOU LIKE TO DO?</Text>

            <TouchableOpacity
              style={styles.actionCard}
              onPress={() => handleAction(ACTIONS[0])}
              activeOpacity={0.7}
            >
              <View style={styles.actionCardHeader}>
                <View style={styles.actionIcon}>
                  <Text style={styles.actionIconText}>{'\u2726'}</Text>
                </View>
                <Text style={styles.actionCardTitle}>Remember something</Text>
                <Text style={styles.actionArrow}>{'\u2192'}</Text>
              </View>
              <Text style={styles.actionCardDesc}>
                Store a fact, event, preference, or anything you want to keep safe
              </Text>
              <View style={styles.actionExample}>
                <Text style={styles.actionExampleText}>"Emma's birthday is March 15"</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionCard}
              onPress={() => handleAction(ACTIONS[1])}
              activeOpacity={0.7}
            >
              <View style={styles.actionCardHeader}>
                <View style={[styles.actionIcon, styles.actionIconAsk]}>
                  <Text style={styles.actionIconText}>?</Text>
                </View>
                <Text style={styles.actionCardTitle}>Ask a question</Text>
                <Text style={styles.actionArrow}>{'\u2192'}</Text>
              </View>
              <Text style={styles.actionCardDesc}>
                Search across everything you've stored in your vault
              </Text>
              <View style={styles.actionExample}>
                <Text style={styles.actionExampleText}>"When is Emma's birthday?"</Text>
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionCardMini}
              onPress={() => sendMessage('/help')}
              activeOpacity={0.7}
            >
              <Text style={styles.miniLabel}>View all commands</Text>
              <Text style={styles.miniArrow}>{'\u2192'}</Text>
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

      {/* Quick action chips — always visible when there are messages */}
      {messages.length > 0 && !isTyping && (
        <View style={styles.chipBar}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipScroll}
          >
            <TouchableOpacity
              style={[styles.chip, activeAction?.key === 'remember' && styles.chipActive]}
              onPress={() => handleChipAction(ACTIONS[0])}
              activeOpacity={0.7}
            >
              <Text style={styles.chipIcon}>{'\u2726'}</Text>
              <Text
                style={[
                  styles.chipLabel,
                  activeAction?.key === 'remember' && styles.chipLabelActive,
                ]}
              >
                Remember
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chip, activeAction?.key === 'ask' && styles.chipActive]}
              onPress={() => handleChipAction(ACTIONS[1])}
              activeOpacity={0.7}
            >
              <Text style={styles.chipIcon}>?</Text>
              <Text
                style={[styles.chipLabel, activeAction?.key === 'ask' && styles.chipLabelActive]}
              >
                Ask
              </Text>
            </TouchableOpacity>
            {/* Legacy in-memory count chip removed: /remember writes
                to Brain's staging pipeline now, which this counter
                didn't observe. The real vault count surfaces via the
                Vault tab once the Core-side list-items endpoint lands
                (issue #16). */}
          </ScrollView>
        </View>
      )}

      {/* Input area */}
      <View style={styles.inputContainer}>
        <View style={styles.inputWrapper}>
          {activeAction && (
            <TouchableOpacity style={styles.inputChip} onPress={clearAction} activeOpacity={0.7}>
              <Text style={styles.inputChipText}>{activeAction.label}</Text>
              <Text style={styles.inputChipX}>{'\u00D7'}</Text>
            </TouchableOpacity>
          )}
          <TextInput
            ref={inputRef}
            testID="chat-input"
            style={[styles.textInput, activeAction && styles.textInputWithChip]}
            value={inputText}
            onChangeText={handleInputChange}
            placeholder={activeAction?.placeholder ?? 'Message Dina...'}
            placeholderTextColor={colors.textMuted}
            returnKeyType="send"
            onSubmitEditing={() => sendMessage()}
            editable={!isTyping}
            autoCorrect={false}
            multiline
            maxLength={2000}
            onKeyPress={({ nativeEvent }) => {
              if (nativeEvent.key === 'Backspace' && inputText === '' && activeAction) {
                clearAction();
              }
            }}
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
        </View>
      </View>
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
  brandLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 3,
    color: colors.textMuted,
    marginBottom: spacing.md,
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
  actionSectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginBottom: spacing.md,
    marginLeft: spacing.xs,
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
  actionIconAsk: {
    backgroundColor: colors.bgTertiary,
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
  actionExample: {
    marginTop: 10,
    marginLeft: 40,
    backgroundColor: colors.bgTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionExampleText: {
    fontSize: 13,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  actionCardMini: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    marginTop: 4,
  },
  miniLabel: {
    fontSize: 14,
    color: colors.textMuted,
    fontWeight: '500',
  },
  miniArrow: {
    fontSize: 14,
    color: colors.textMuted,
    marginLeft: 6,
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

  // Quick-action chips
  chipBar: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgPrimary,
  },
  chipScroll: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipIcon: {
    fontSize: 12,
    color: colors.textSecondary,
    marginRight: 6,
  },
  chipLabel: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textPrimary,
  },
  chipLabelActive: {
    color: colors.white,
  },
  chipInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipInfoText: {
    fontSize: 12,
    color: colors.textMuted,
    fontWeight: '500',
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

  // Input chip (in input bar)
  inputChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
    alignSelf: 'center',
  },
  inputChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.white,
    letterSpacing: 0.3,
  },
  inputChipX: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    marginLeft: 5,
    fontWeight: '600',
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
