/**
 * /chat/[did] — per-peer chat screen.
 *
 * Live-subscribed to `thread(peerDID)` via `useD2DChat`. Renders
 * message bubbles (user right, peer left) and a composer that drops
 * into `sendChatMessage` on submit.
 *
 * When the peer isn't a known contact, the screen offers an inline
 * "Add to contacts" shortcut that routes to /add-contact with the DID
 * pre-filled. That matters because messages from non-contacts are
 * quarantined on the receiving side — the reply you're waiting for
 * simply never arrives unless both sides have the other in contacts.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  FlatList,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import { readLifecycle, type ChatMessage } from '@dina/brain/chat';

import { IdentityModal } from '../../src/components/identity/identity_modal';
import { InlineGrantRequestCard } from '../../src/components/InlineGrantRequestCard';
import { InlineServiceQueryCard } from '../../src/components/InlineServiceQueryCard';
import { runChatTurn } from '../../src/hooks/chat_transport';
import { useD2DChat } from '../../src/hooks/useD2DChat';
import { getProfile as getTrustProfile } from '../../src/peerlens/appview_runtime';
import { displayName as displayNameOf } from '../../src/peerlens/handle_display';
import {
  routeComposerText,
  isScheduleCommand,
  SCHEDULE_SEED,
} from '../../src/services/chat_composer_routing';
import { ChatSendError } from '../../src/services/chat_d2d';
import { colors, spacing, textStyles } from '../../src/theme';

export default function ChatScreen() {
  const headerHeight = useHeaderHeight();
  const params = useLocalSearchParams<{ did: string }>();
  const router = useRouter();
  const peerDID = typeof params.did === 'string' ? params.did : '';

  const { messages, peerContact, isKnownContact, send } = useD2DChat(peerDID);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const inputRef = useRef<TextInput>(null);

  // Best-effort handle resolution for non-contacts. The chat title
  // would otherwise show `did:plc:abc1…7890`, which is hard to read
  // and tells the user nothing. AppView lookup is fire-and-forget
  // (silent on failure); contacts use their stored displayName.
  const [resolvedHandle, setResolvedHandle] = useState<string | null>(null);
  useEffect(() => {
    if (peerDID === '' || isKnownContact) return;
    let cancelled = false;
    void (async () => {
      try {
        const profile = await getTrustProfile(peerDID);
        if (!cancelled && profile?.handle) {
          setResolvedHandle(profile.handle);
        }
      } catch {
        // Best-effort — silent fallback to shortDID.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peerDID, isKnownContact]);

  const onSubmit = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || busy) return;

    // Route the submission via the pure, tested control-point logic
    // (chat_composer_routing) \u2014 never a hand-rolled regex here. The chip only
    // SEEDS `/schedule `; this dispatch happens on the user's explicit submit.
    const route = routeComposerText(text);

    // Contact Services (CONTACT_SERVICES_ARCHITECTURE.md \u00a77 seam 2/6): a
    // `/schedule \u2026` command IS addressed to the local Dina, but it is
    // contact-scoped \u2014 it asks Dina to coordinate a time with THIS peer. Route
    // it through the orchestrator with the peer DID as the thread, so seam 2's
    // contact-scoped routing fires a `service.query` to this contact (seam 5)
    // and the pending card lands in THIS thread. Unlike a stray /ask, this is
    // exactly where the user meant it to run, so we do NOT redirect them away.
    if (route === 'schedule') {
      setBusy(true);
      setDraft('');
      try {
        await runChatTurn(text, peerDID);
      } catch (err) {
        Alert.alert('Couldn\u2019t schedule', err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setTimeout(() => {
          listRef.current?.scrollToEnd({ animated: true });
        }, 0);
      }
      return;
    }

    // Other slash commands (/remember, /ask, /search, /help, /trust, \u2026) are
    // addressed to the local Dina, not to the peer. Sending them
    // literally over D2D is almost never what the user wants \u2014 it
    // surfaces as a confusing peer message and the command never runs.
    // Block + redirect rather than silently re-route, so the user keeps
    // control of which surface they're talking to.
    if (route === 'slash') {
      Alert.alert(
        'Slash commands talk to Dina, not your contact',
        'Switch to the Chat tab to use commands like /remember or /ask. Or remove the leading "/" if you really meant to send this as a message.',
        [{ text: 'OK', style: 'default' }],
        { cancelable: true },
      );
      return;
    }

    setBusy(true);
    setDraft('');
    try {
      await send(text);
    } catch (err) {
      const msg = err instanceof ChatSendError ? err.message : String(err);
      Alert.alert('Couldn\u2019t send', msg);
    } finally {
      setBusy(false);
      // Defer scroll-to-end until after React commits the new row.
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 0);
    }
  }, [draft, busy, send, peerDID]);

  // Seam 6: tapping the suggestion chip SEEDS the composer with `/schedule `
  // and focuses it \u2014 it never auto-fires (the user confirms by submitting).
  // Misreading "let's hang out sometime" as a service call is the failure mode
  // the spec warns about (\u00a77), so the human stays in control of the send.
  const onSeedSchedule = useCallback((): void => {
    setDraft(SCHEDULE_SEED);
    inputRef.current?.focus();
  }, []);

  // Title preference: user-set contact displayName > short username
  // (first label of resolved PLC handle) > truncated DID. Tapping the
  // header opens the IdentityModal with the full handle, DID, and
  // PLC services.
  const title = peerContact?.displayName ?? displayNameOf(resolvedHandle, peerDID);

  const [identityOpen, setIdentityOpen] = useState(false);

  return (
    <KeyboardAvoidingView
      // `padding` on both platforms — Android's adjustResize is neutralised by
      // SDK 55 edge-to-edge, so behavior=undefined left the composer under the
      // keyboard (#390). Android measures this route below its native Stack
      // header, so subtract that known height instead of a device constant.
      behavior="padding"
      style={styles.container}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : headerHeight}
    >
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
            <Pressable
              testID="chat-identity"
              onPress={() => setIdentityOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={`Show identity for ${title}`}
              hitSlop={8}
              style={styles.headerTitleBtn}
            >
              <Text style={styles.headerTitleText} numberOfLines={1}>
                {title}
              </Text>
              <Text style={styles.headerTitleHint}>tap for identity</Text>
            </Pressable>
          ),
        }}
      />
      <IdentityModal
        visible={identityOpen}
        onClose={() => setIdentityOpen(false)}
        did={peerDID}
        initialHandle={resolvedHandle}
      />

      {!isKnownContact && peerDID !== '' && (
        <Pressable
          testID="chat-add-contact"
          accessibilityRole="button"
          style={styles.warningBanner}
          onPress={() => router.push({ pathname: '/add-contact', params: { did: peerDID } })}
        >
          <Text style={styles.warningText}>
            This DID is not in your contacts. Replies may be quarantined until you add them.
          </Text>
          <Text style={styles.warningAction}>Add {'\u2192'}</Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => <Bubble message={item} peerDID={peerDID} contactName={title} />}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={() => (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No messages yet. Say hello.</Text>
          </View>
        )}
      />

      {/* Seam 6: contextual suggestion chip. Only for known contacts (a
          relationship service is never offered to a non-contact), and only
          when the user hasn't already started a /schedule (so it doesn't
          fight the composer). Suggest-only — tapping seeds, never sends. */}
      {isKnownContact && !isScheduleCommand(draft) && (
        <View style={styles.suggestionRow}>
          <Pressable
            testID="chat-suggest-schedule"
            accessibilityRole="button"
            accessibilityLabel={`Find a time with ${title}`}
            onPress={onSeedSchedule}
            disabled={busy}
            style={({ pressed }) => [styles.suggestionChip, pressed && styles.pressed]}
          >
            <Text style={styles.suggestionChipText} numberOfLines={1}>
              {'📅'} Find a time with {title}
            </Text>
          </Pressable>
        </View>
      )}

      <View style={styles.composer}>
        <TextInput
          ref={inputRef}
          testID="chat-message-input"
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          multiline
          editable={!busy}
          onSubmitEditing={onSubmit}
          blurOnSubmit={false}
        />
        <Pressable
          testID="chat-send"
          accessibilityRole="button"
          onPress={onSubmit}
          style={({ pressed }) => [
            styles.sendButton,
            pressed && styles.pressed,
            (busy || draft.trim() === '') && styles.disabled,
          ]}
          disabled={busy || draft.trim() === ''}
          accessibilityLabel="Send message"
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.sendText}>{'\u2191'}</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({
  message,
  peerDID,
  contactName,
}: {
  message: ChatMessage;
  peerDID: string;
  contactName?: string;
}) {
  const fromPeer =
    message.type === 'dina' &&
    (message.metadata?.source === 'd2d' || message.metadata?.senderDID === peerDID);
  const isError = message.type === 'error';

  if (isError) {
    return (
      <View style={styles.errorRow}>
        <Text style={styles.errorText}>{message.content}</Text>
      </View>
    );
  }

  // Contact Services (CONTACT_SERVICES_ARCHITECTURE.md §7, seam 1): a 'dina'
  // message with a VALID service_query lifecycle renders the SAME inline card
  // the main chat tab uses — it patches in place (pending → resolved) as the
  // request rides the wire. We use the canonical `readLifecycle` reader (not a
  // raw cast) so a malformed/legacy service_query row (e.g. missing taskId)
  // returns null and falls through to the plain-text bubble below rather than
  // dispatching to a card that would render nothing and drop the message.
  if (message.type === 'dina' && readLifecycle(message)?.kind === 'service_query') {
    return <InlineServiceQueryCard message={message} />;
  }

  // Contact Services §5.2 ask_to_enable prompt: a friend asked to use a
  // relationship service; surface the one-time "Allow <contact>?" card. Read
  // off the raw metadata.lifecycle (the quarantine-card convention — this kind
  // isn't part of brain's typed `MessageLifecycle` union); the card itself
  // validates the shape and renders null on a malformed row.
  if (
    message.type === 'dina' &&
    (message.metadata?.lifecycle as { kind?: unknown } | undefined)?.kind === 'grant_request_prompt'
  ) {
    return <InlineGrantRequestCard message={message} contactName={contactName} />;
  }

  // Outbound delivery status — drives the tick / spinner / exclamation
  // glyph next to the user's own bubble. Peer-side bubbles never carry
  // a deliveryStatus (those messages came from the relay, the sender's
  // node is what tracks delivery to us). MT-19-I1.
  const deliveryStatus =
    !fromPeer && typeof message.metadata?.deliveryStatus === 'string'
      ? (message.metadata.deliveryStatus as 'sending' | 'delivered' | 'failed')
      : null;

  return (
    <View style={[styles.bubbleRow, fromPeer ? styles.bubbleRowLeft : styles.bubbleRowRight]}>
      <View style={[styles.bubble, fromPeer ? styles.bubblePeer : styles.bubbleMe]}>
        <Text style={fromPeer ? styles.bubbleTextPeer : styles.bubbleTextMe}>
          {message.content}
        </Text>
      </View>
      {deliveryStatus !== null ? <DeliveryIndicator status={deliveryStatus} /> : null}
    </View>
  );
}

function DeliveryIndicator({ status }: { status: 'sending' | 'delivered' | 'failed' }) {
  // The glyphs are intentionally low-contrast — they confirm state on
  // demand without taking visual weight away from the message itself.
  // Single character so each bubble row stays visually compact.
  const glyph = status === 'sending' ? '···' : status === 'delivered' ? '✓' : '!';
  const label =
    status === 'sending'
      ? 'Sending'
      : status === 'delivered'
        ? 'Delivered to relay'
        : 'Failed to send';
  const color =
    status === 'failed'
      ? colors.error
      : status === 'delivered'
        ? colors.textMuted
        : colors.textMuted;
  return (
    <Text
      style={[styles.deliveryIndicator, { color }]}
      accessibilityLabel={label}
      accessibilityRole="text"
    >
      {glyph}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  warningBanner: {
    backgroundColor: colors.warningBgSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.warning,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  warningText: {
    ...textStyles.bodySmall,
    flex: 1,
    marginRight: spacing.sm,
  },
  warningAction: {
    ...textStyles.bodySmallStrong,
    color: colors.accent,
  },
  list: {
    padding: spacing.md,
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
  },
  emptyText: {
    ...textStyles.body,
    color: colors.textMuted,
  },
  bubbleRow: {
    marginVertical: 4,
    flexDirection: 'row',
  },
  bubbleRowLeft: { justifyContent: 'flex-start' },
  bubbleRowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '78%',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubblePeer: {
    backgroundColor: colors.dinaBubble,
    borderBottomLeftRadius: 4,
  },
  bubbleMe: {
    backgroundColor: colors.userBubble,
    borderBottomRightRadius: 4,
  },
  bubbleTextPeer: {
    ...textStyles.body,
    color: colors.dinaBubbleText,
    lineHeight: 20,
  },
  bubbleTextMe: {
    ...textStyles.body,
    color: colors.userBubbleText,
    lineHeight: 20,
  },
  deliveryIndicator: {
    // Sits to the right of the outgoing bubble, vertically centered
    // against the bubble's bottom edge. Tiny font keeps the row
    // height stable — without `alignSelf` the FlexRow would baseline
    // the indicator against the bubble's text and look misaligned.
    ...textStyles.tiny,
    marginLeft: 6,
    marginRight: 2,
    alignSelf: 'flex-end',
    paddingBottom: 4,
  },
  errorRow: {
    alignItems: 'center',
    marginVertical: spacing.sm,
  },
  errorText: {
    ...textStyles.caption,
    color: colors.error,
    fontStyle: 'italic',
  },
  suggestionRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: 4,
    backgroundColor: colors.bgSecondary,
  },
  suggestionChip: {
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.bgPrimary,
  },
  suggestionChipText: {
    ...textStyles.bodySmallStrong,
    color: colors.accent,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSecondary,
    gap: spacing.sm,
  },
  input: {
    ...textStyles.body,
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgPrimary,
    borderRadius: 20,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : 6,
    maxHeight: 120,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: {
    ...textStyles.h3,
    color: colors.white,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  headerTitleBtn: {
    alignItems: 'center',
  },
  headerTitleText: textStyles.bodyLargeStrong,
  headerTitleHint: {
    ...textStyles.tiny,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    marginTop: 1,
  },
});
