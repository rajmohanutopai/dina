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

import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  FlatList,
  Platform,
  KeyboardAvoidingView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import type { ChatMessage } from '@dina/brain/src/chat/thread';
import { useD2DChat } from '../../src/hooks/useD2DChat';
import { colors, spacing, radius } from '../../src/theme';
import { ChatSendError } from '../../src/services/chat_d2d';

export default function ChatScreen() {
  const params = useLocalSearchParams<{ did: string }>();
  const router = useRouter();
  const peerDID = typeof params.did === 'string' ? params.did : '';

  const { messages, peerContact, isKnownContact, send } = useD2DChat(peerDID);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const onSubmit = useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || busy) return;
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
  }, [draft, busy, send]);

  const title = peerContact?.displayName ?? shortDID(peerDID);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <Stack.Screen options={{ title }} />

      {!isKnownContact && peerDID !== '' && (
        <Pressable style={styles.warningBanner} onPress={() => router.push('/add-contact')}>
          <Text style={styles.warningText}>
            This DID is not in your contacts. Replies may be quarantined until you add them.
          </Text>
          <Text style={styles.warningAction}>Add \u2192</Text>
        </Pressable>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => <Bubble message={item} peerDID={peerDID} />}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={() => (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No messages yet. Say hello.</Text>
          </View>
        )}
      />

      <View style={styles.composer}>
        <TextInput
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

function Bubble({ message, peerDID }: { message: ChatMessage; peerDID: string }) {
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

  return (
    <View style={[styles.bubbleRow, fromPeer ? styles.bubbleRowLeft : styles.bubbleRowRight]}>
      <View style={[styles.bubble, fromPeer ? styles.bubblePeer : styles.bubbleMe]}>
        <Text style={fromPeer ? styles.bubbleTextPeer : styles.bubbleTextMe}>
          {message.content}
        </Text>
      </View>
    </View>
  );
}

function shortDID(did: string): string {
  if (!did) return 'Chat';
  if (did.length <= 24) return did;
  return `${did.slice(0, 14)}\u2026${did.slice(-4)}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  warningBanner: {
    backgroundColor: '#FFF4DB',
    borderBottomWidth: 1,
    borderBottomColor: '#D97706',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    color: colors.textPrimary,
    marginRight: spacing.sm,
  },
  warningAction: {
    fontSize: 13,
    fontWeight: '600',
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
    color: colors.textMuted,
    fontSize: 14,
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
    color: colors.dinaBubbleText,
    fontSize: 15,
    lineHeight: 20,
  },
  bubbleTextMe: {
    color: colors.userBubbleText,
    fontSize: 15,
    lineHeight: 20,
  },
  errorRow: {
    alignItems: 'center',
    marginVertical: spacing.sm,
  },
  errorText: {
    fontSize: 12,
    color: colors.error,
    fontStyle: 'italic',
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
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgPrimary,
    color: colors.textPrimary,
    borderRadius: 20,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : 6,
    fontSize: 15,
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
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
});
