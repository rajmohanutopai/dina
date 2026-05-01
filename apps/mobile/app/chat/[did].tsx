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

import React, { useEffect, useRef, useState, useCallback } from 'react';
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
import { getProfile as getTrustProfile } from '../../src/trust/appview_runtime';
import { displayName as displayNameOf } from '../../src/trust/handle_display';
import { colors, fonts, spacing } from '../../src/theme';
import { ChatSendError } from '../../src/services/chat_d2d';
import { IdentityModal } from '../../src/components/identity/identity_modal';

export default function ChatScreen() {
  const params = useLocalSearchParams<{ did: string }>();
  const router = useRouter();
  const peerDID = typeof params.did === 'string' ? params.did : '';

  const { messages, peerContact, isKnownContact, send } = useD2DChat(peerDID);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);

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

    // Slash commands (/remember, /ask, /search, /help, /trust, \u2026) are
    // addressed to the local Dina, not to the peer. Sending them
    // literally over D2D is almost never what the user wants \u2014 it
    // surfaces as a confusing peer message and the command never runs.
    // Block + redirect rather than silently re-route, so the user keeps
    // control of which surface they're talking to.
    if (text.startsWith('/')) {
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
  }, [draft, busy, send]);

  // Title preference: user-set contact displayName > short username
  // (first label of resolved PLC handle) > truncated DID. Tapping the
  // header opens the IdentityModal with the full handle, DID, and
  // PLC services.
  const title =
    peerContact?.displayName ?? displayNameOf(resolvedHandle, peerDID);

  const [identityOpen, setIdentityOpen] = useState(false);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}
    >
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
            <Pressable
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
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textPrimary,
    marginRight: spacing.sm,
  },
  warningAction: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
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
    fontFamily: fonts.sans,
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
    fontFamily: fonts.sans,
    color: colors.dinaBubbleText,
    fontSize: 15,
    lineHeight: 20,
  },
  bubbleTextMe: {
    fontFamily: fonts.sans,
    color: colors.userBubbleText,
    fontSize: 15,
    lineHeight: 20,
  },
  errorRow: {
    alignItems: 'center',
    marginVertical: spacing.sm,
  },
  errorText: {
    fontFamily: fonts.sans,
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
    fontFamily: fonts.sans,
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
    fontFamily: fonts.headingBold,
    color: '#FFFFFF',
    fontSize: 18,
  },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  headerTitleBtn: {
    alignItems: 'center',
  },
  headerTitleText: {
    fontFamily: fonts.headingBold,
    fontSize: 16,
    color: colors.textPrimary,
  },
  headerTitleHint: {
    fontFamily: fonts.sans,
    fontSize: 9,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: 1,
  },
});
