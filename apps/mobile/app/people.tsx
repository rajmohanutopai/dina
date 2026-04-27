/**
 * People — contacts the user has added for D2D messaging.
 *
 * Lists every row from the core contact directory. Tapping a row
 * drills into /chat/[did]; the "+ Add" button in the header drills
 * into /add-contact. The directory doesn't ship a subscribe API, so
 * we re-read on focus (Expo Router's `useFocusEffect`).
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Platform, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Link, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { listContacts, deleteContact, type Contact } from '@dina/core/src/contacts/directory';
import { colors, fonts, spacing, radius, shadows } from '../src/theme';

export default function PeopleScreen() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const navigation = useNavigation();
  const router = useRouter();

  const refresh = useCallback(() => {
    setContacts(listContacts());
  }, []);

  // Refresh on screen focus. Cheap: listContacts reads the in-memory
  // map and returns a snapshot array.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  // Pin the "+ Add contact" action into the navbar's headerRight so
  // the in-page hero stays clean.  Using `setOptions` instead of
  // setting it from the parent Tabs layout keeps the action local
  // to the screen that owns it.
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => router.push('/add-contact' as never)}
          accessibilityRole="button"
          accessibilityLabel="Add a contact"
          hitSlop={8}
          style={{ paddingHorizontal: spacing.sm + 4, paddingVertical: 6 }}
        >
          <Ionicons name="add" size={26} color={colors.textPrimary} />
        </Pressable>
      ),
    });
  }, [navigation, router]);

  const onLongPress = useCallback(
    (contact: Contact) => {
      Alert.alert(
        `Remove ${contact.displayName || 'contact'}?`,
        'You’ll need to add them again to send or receive D2D messages. Their DID stays on PLC; this only removes them from your local contact list.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: () => {
              deleteContact(contact.did);
              refresh();
            },
          },
        ],
        { cancelable: true },
      );
    },
    [refresh],
  );

  return (
    <View style={styles.container}>
      {contacts.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons
            name="people-outline"
            size={40}
            color={colors.textMuted}
            style={{ marginBottom: spacing.md }}
          />
          <Text style={styles.emptyTitle}>No contacts yet</Text>
          <Text style={styles.emptyBody}>
            Add someone by their DID or handle to start an end-to-end encrypted conversation.
          </Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={contacts}
          keyExtractor={(c) => c.did}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          renderItem={({ item }) => <ContactRow contact={item} onLongPress={onLongPress} />}
        />
      )}
    </View>
  );
}

function ContactRow({
  contact,
  onLongPress,
}: {
  contact: Contact;
  onLongPress: (contact: Contact) => void;
}) {
  return (
    <Link href={{ pathname: '/chat/[did]', params: { did: contact.did } }} asChild>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityLabel={`Open chat with ${contact.displayName}. Long-press to remove.`}
        onLongPress={() => onLongPress(contact)}
        delayLongPress={400}
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {contact.displayName.slice(0, 1).toUpperCase() || '?'}
          </Text>
        </View>
        <View style={styles.rowText}>
          <Text style={styles.rowName} numberOfLines={1}>
            {contact.displayName || shortDID(contact.did)}
          </Text>
          <Text style={styles.rowDid} numberOfLines={1}>
            {shortDID(contact.did)}
          </Text>
        </View>
        <TrustBadge trust={contact.trustLevel} />
      </Pressable>
    </Link>
  );
}

function TrustBadge({ trust }: { trust: Contact['trustLevel'] }) {
  const config: Record<Contact['trustLevel'], { label: string; bg: string; fg: string }> = {
    blocked: { label: 'Blocked', bg: '#FDE8E8', fg: colors.error },
    unknown: { label: 'Unknown', bg: '#F0EDE8', fg: colors.textSecondary },
    verified: { label: 'Verified', bg: '#E6F4EE', fg: colors.success },
    trusted: { label: 'Trusted', bg: '#E6F4EE', fg: colors.success },
  };
  const c = config[trust];
  return (
    <View style={[styles.badge, { backgroundColor: c.bg }]}>
      <Text style={[styles.badgeText, { color: c.fg }]}>{c.label}</Text>
    </View>
  );
}

function shortDID(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 14)}\u2026${did.slice(-4)}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  separator: {
    height: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    ...(Platform.OS === 'ios' ? shadows.sm : {}),
  },
  rowPressed: {
    backgroundColor: colors.bgTertiary,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  avatarText: {
    fontFamily: fonts.headingBold,
    fontSize: 16,
    color: colors.textPrimary,
  },
  rowText: { flex: 1 },
  rowName: {
    fontFamily: fonts.heading,
    fontSize: 15,
    color: colors.textPrimary,
    letterSpacing: 0.1,
  },
  rowDid: {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    marginLeft: spacing.sm,
  },
  badgeText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    fontFamily: fonts.heading,
    fontSize: 18,
    color: colors.textPrimary,
  },
  emptyBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
});
