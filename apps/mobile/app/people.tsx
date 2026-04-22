/**
 * People — contacts the user has added for D2D messaging.
 *
 * Lists every row from the core contact directory. Tapping a row
 * drills into /chat/[did]; the "+ Add" button in the header drills
 * into /add-contact. The directory doesn't ship a subscribe API, so
 * we re-read on focus (Expo Router's `useFocusEffect`).
 */

import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable, Platform } from 'react-native';
import { Link, useFocusEffect } from 'expo-router';
import { listContacts, type Contact } from '../../core/src/contacts/directory';
import { colors, spacing, radius, shadows } from '../src/theme';

export default function PeopleScreen() {
  const [contacts, setContacts] = useState<Contact[]>([]);

  // Refresh on screen focus. Cheap: listContacts reads the in-memory
  // map and returns a snapshot array.
  useFocusEffect(
    useCallback(() => {
      setContacts(listContacts());
    }, []),
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.heading}>People</Text>
        <Text style={styles.subheading}>Trusted contacts you can message end-to-end.</Text>
        <Link href="/add-contact" asChild>
          <Pressable style={styles.addButton} accessibilityLabel="Add a contact">
            <Text style={styles.addButtonText}>+ Add contact</Text>
          </Pressable>
        </Link>
      </View>

      {contacts.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>{'\u2302'}</Text>
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
          renderItem={({ item }) => <ContactRow contact={item} />}
        />
      )}
    </View>
  );
}

function ContactRow({ contact }: { contact: Contact }) {
  return (
    <Link href={{ pathname: '/chat/[did]', params: { did: contact.did } }} asChild>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityLabel={`Open chat with ${contact.displayName}`}
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
  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  subheading: {
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    lineHeight: 20,
  },
  addButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderLight,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    marginTop: spacing.xs,
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
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  rowText: { flex: 1 },
  rowName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
    letterSpacing: 0.1,
  },
  rowDid: {
    fontSize: 12,
    color: colors.textMuted,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    marginLeft: spacing.sm,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyIcon: {
    fontSize: 48,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  emptyBody: {
    fontSize: 14,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    lineHeight: 20,
  },
});
