/**
 * People — two-sub-tab surface.
 *
 *   - Contacts (default): paired peers from the core contact
 *     directory (`listContacts()`). Tap → /chat/[did]; long-press →
 *     remove from local list (the DID stays on PLC). The "+" in the
 *     navbar still routes to /add-contact.
 *   - Relations: the local people graph (`getPeopleRepository()`).
 *     Read-only first cut — shows every confirmed/suggested person
 *     with their relationship hint and surface aliases.
 *
 * Why both sub-tabs see DID-bound persons: a paired contact is also a
 * relation (e.g. Sancho the peer is also "my brother"), so suppressing
 * DID-bound rows from Relations would hide useful context.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Platform,
  Alert,
  Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Link, useFocusEffect, useNavigation, useRouter } from 'expo-router';
import {
  listContacts,
  deleteContact,
  getPeopleRepository,
  type Contact,
  type Person,
} from '@dina/core';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import { getProfile as getTrustProfile } from '../src/peerlens/appview_runtime';
import { loadInfraPreferences } from '../src/services/infra_preferences';

type SubTab = 'contacts' | 'relations';

export default function PeopleScreen() {
  const [subTab, setSubTab] = useState<SubTab>('contacts');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const navigation = useNavigation();
  const router = useRouter();

  const refresh = useCallback(() => {
    setContacts(listContacts());
    const repo = getPeopleRepository();
    setPeople(repo === null ? [] : repo.listPeople());
  }, []);

  // Refresh on screen focus. Cheap: listContacts reads the in-memory
  // map and returns a snapshot array; listPeople is a single SQLite
  // read.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  // Pin the "+ Add contact" action into the navbar's headerRight so
  // the in-page hero stays clean.  Using `setOptions` instead of
  // setting it from the parent Tabs layout keeps the action local
  // to the screen that owns it. The "+" is contact-only for now;
  // adding a relation manually is the next milestone.
  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          testID="people-add-contact-header"
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
        "You’ll need to add them again to talk with them. Their DID stays on PLC; this only removes them from your local contact list.",
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
      <OwnIdentityCard />
      <SubTabBar value={subTab} onChange={setSubTab} />
      {subTab === 'contacts' ? (
        <ContactsView
          contacts={contacts}
          onLongPress={onLongPress}
          onAdd={() => router.push('/add-contact' as never)}
        />
      ) : (
        <RelationsView people={people} />
      )}
    </View>
  );
}

function ContactsView({
  contacts,
  onLongPress,
  onAdd,
}: {
  contacts: Contact[];
  onLongPress: (contact: Contact) => void;
  onAdd: () => void;
}) {
  if (contacts.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Ionicons
          name="people-outline"
          size={40}
          color={colors.textMuted}
          style={{ marginBottom: spacing.md }}
        />
        <Text style={styles.emptyTitle}>No contacts yet</Text>
        <Text style={styles.emptyBody}>
          Add someone by their handle to start an end-to-end encrypted conversation.
        </Text>
        <Pressable
          testID="people-add-contact"
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel="Add a contact"
          style={({ pressed }) => [styles.emptyCta, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.emptyCtaText}>Add a contact</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={contacts}
      keyExtractor={(c) => c.did}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      renderItem={({ item }) => <ContactRow contact={item} onLongPress={onLongPress} />}
    />
  );
}

function RelationsView({ people }: { people: Person[] }) {
  if (people.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Ionicons
          name="git-network-outline"
          size={40}
          color={colors.textMuted}
          style={{ marginBottom: spacing.md }}
        />
        <Text style={styles.emptyTitle}>No relations yet</Text>
        <Text style={styles.emptyBody}>
          As you tell Dina about people in your life (for example, "Emma is my daughter" or
          "Sancho is my brother"), they’ll show up here.
        </Text>
      </View>
    );
  }
  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={people}
      keyExtractor={(p) => p.personId}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      renderItem={({ item }) => <RelationRow person={item} />}
    />
  );
}

function SubTabBar({
  value,
  onChange,
}: {
  value: SubTab;
  onChange: (v: SubTab) => void;
}) {
  return (
    <View style={styles.subTabBar}>
      <Pressable
        testID="people-subtab-contacts"
        onPress={() => onChange('contacts')}
        accessibilityRole="tab"
        accessibilityState={{ selected: value === 'contacts' }}
        style={[styles.subTab, value === 'contacts' && styles.subTabActive]}
      >
        <Text
          style={[
            styles.subTabLabel,
            value === 'contacts' && styles.subTabLabelActive,
          ]}
        >
          Contacts
        </Text>
      </Pressable>
      <Pressable
        testID="people-subtab-relations"
        onPress={() => onChange('relations')}
        accessibilityRole="tab"
        accessibilityState={{ selected: value === 'relations' }}
        style={[styles.subTab, value === 'relations' && styles.subTabActive]}
      >
        <Text
          style={[
            styles.subTabLabel,
            value === 'relations' && styles.subTabLabelActive,
          ]}
        >
          Relations
        </Text>
      </Pressable>
    </View>
  );
}

function RelationRow({ person }: { person: Person }) {
  // Show up to 3 non-rejected, non-canonical surfaces so the row stays
  // readable even when the LLM has captured many aliases.
  const aliasSurfaces = (person.surfaces ?? [])
    .filter((s) => s.status !== 'rejected' && s.surface !== person.canonicalName)
    .slice(0, 3)
    .map((s) => s.surface);

  return (
    <View
      style={[styles.row, person.status === 'suggested' && styles.rowSuggested]}
      accessibilityLabel={
        `${person.canonicalName}` +
        (person.relationshipHint !== '' ? `, ${person.relationshipHint}` : '')
      }
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {person.canonicalName.slice(0, 1).toUpperCase() || '?'}
        </Text>
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {person.canonicalName}
        </Text>
        {person.relationshipHint !== '' && (
          <Text style={styles.rowDid} numberOfLines={1}>
            {person.relationshipHint}
          </Text>
        )}
        {aliasSurfaces.length > 0 && (
          <Text style={styles.rowAliases} numberOfLines={1}>
            also: {aliasSurfaces.join(', ')}
          </Text>
        )}
      </View>
      {person.contactDid !== '' && (
        <View style={[styles.badge, { backgroundColor: colors.badgePairedBg }]}>
          <Text style={[styles.badgeText, { color: colors.badgePairedText }]}>Paired</Text>
        </View>
      )}
      {person.status === 'suggested' && (
        <View style={[styles.badge, { backgroundColor: colors.badgeSuggestedBg }]}>
          <Text style={[styles.badgeText, { color: colors.badgeSuggestedText }]}>Suggested</Text>
        </View>
      )}
    </View>
  );
}

/**
 * UX-2: card at the top of the People screen that surfaces the
 * user's own handle (or DID if no handle is published yet) with a
 * Share button. Lets a user hand their identity to someone else by
 * tapping Share → Copy / Send via SMS / iMessage / etc — same UX as
 * sharing a phone number, no QR scanner needed.
 *
 * Why a card on the People list instead of a separate route: the
 * People screen IS the contact-management surface, and "share my
 * own contact" is the symmetric operation to "+ Add a contact". A
 * separate /share-handle route would hide the affordance behind an
 * extra tap.
 *
 * Why we resolve the handle from AppView rather than from the
 * `node.did` directly: the local DinaNode only knows its own DID;
 * the handle (the human-friendly `alice.test-pds.dinakernel.com`)
 * lives in the published PLC document's `alsoKnownAs[0]` and is
 * mirrored into the AppView's profile row. AppView is the cheap
 * lookup. Falls back to the DID when the AppView lookup fails (no
 * handle published yet, AppView unreachable, etc.) so the share
 * flow is never blocked.
 */
function OwnIdentityCard(): React.ReactElement | null {
  const [identity, setIdentity] = useState<{
    did: string;
    handle: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const node = getBootedNode();
      if (node === null) return;
      // Optimistic: render with DID immediately, replace with handle
      // when the local lookup completes. Avoids a loading spinner —
      // the DID is already useful.
      if (!cancelled) setIdentity({ did: node.did, handle: null });
      // Local source of truth for the user's published handle: the
      // PDS handle persisted during onboarding/recovery in
      // `infra_preferences::pdsHandle`. Reading it locally is faster
      // and more reliable than the AppView round-trip — AppView may
      // be offline or the profile row may lag the PLC publish, but
      // the handle is locked in at provisionIdentity / recoverIdentity
      // time. AppView remains a fallback for the case where the
      // device-local handle was wiped (Settings reset, partial
      // restore) but the published PLC doc still has it.
      try {
        const infra = await loadInfraPreferences();
        if (!cancelled && infra.pdsHandle !== null && infra.pdsHandle !== '') {
          setIdentity({ did: node.did, handle: infra.pdsHandle });
          return;
        }
      } catch {
        // Silent — fall through to the AppView fetch below.
      }
      try {
        const profile = await getTrustProfile(node.did);
        if (!cancelled && profile?.handle) {
          setIdentity({ did: node.did, handle: profile.handle });
        }
      } catch {
        // Silent — keep the DID-only state. AppView may be offline
        // or the profile may not be published yet; sharing the DID
        // is still functional.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  if (identity === null) return null;

  // Prefer the handle as the primary share string — it's the form
  // the recipient will paste back into add-contact. The DID is
  // shown smaller as a fallback identity reference.
  const primary = identity.handle ?? identity.did;
  const onShare = (): void => {
    void Share.share({ message: primary });
  };

  return (
    <View style={styles.identityCard}>
      <View style={styles.identityText}>
        <Text style={styles.identityLabel}>YOUR HANDLE</Text>
        <Text style={styles.identityValue} numberOfLines={2} ellipsizeMode="middle">
          {primary}
        </Text>
        {identity.handle === null && (
          <Text style={styles.identityHint}>
            No handle published yet. Share your DID for now.
          </Text>
        )}
      </View>
      <Pressable
        testID="people-share-handle"
        onPress={onShare}
        accessibilityRole="button"
        accessibilityLabel="Share your handle"
        hitSlop={8}
        style={({ pressed }) => [styles.shareButton, pressed && styles.shareButtonPressed]}
      >
        <Ionicons name="share-outline" size={18} color="#FFFFFF" />
        <Text style={styles.shareButtonText}>Share</Text>
      </Pressable>
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
        testID={`people-contact-row-${contact.did}`}
        accessibilityRole="button"
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
  // UX-2: own-handle "Share" card. Lives at the top of the screen
  // above both the populated list and the empty-state hero.
  identityCard: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  identityText: {
    flex: 1,
    minWidth: 0,
  },
  identityLabel: {
    ...textStyles.eyebrow,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  identityValue: textStyles.mono,
  identityHint: {
    ...textStyles.caption,
    marginTop: 2,
  },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    minHeight: 36,
  },
  shareButtonPressed: {
    opacity: 0.7,
  },
  shareButtonText: {
    ...textStyles.bodySmallStrong,
    color: colors.white,
  },
  // Segmented [Contacts | Relations] strip below the OwnIdentityCard.
  // A thin pill row rather than a full segmented control — keeps the
  // visual weight matching the contact-list rows that follow.
  subTabBar: {
    flexDirection: 'row',
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    padding: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  subTab: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: radius.sm,
  },
  subTabActive: {
    // Filled-accent treatment so the selected sub-tab is unmistakable
    // at a glance — previously a near-white card on cream that was
    // hard to distinguish from the unselected pill.
    backgroundColor: colors.accent,
    ...(Platform.OS === 'ios' ? shadows.sm : {}),
  },
  subTabLabel: {
    ...textStyles.bodySmallStrong,
    color: colors.textMuted,
    letterSpacing: 0.2,
  },
  subTabLabelActive: {
    color: colors.white,
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
  // Subtle treatment for unconfirmed Person rows so the user can tell
  // at a glance what Dina is still guessing at vs. what's locked in.
  rowSuggested: {
    opacity: 0.85,
  },
  rowAliases: {
    ...textStyles.caption,
    marginTop: 2,
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
  avatarText: textStyles.bodyLargeStrong,
  rowText: { flex: 1 },
  rowName: {
    ...textStyles.bodyStrong,
    letterSpacing: 0.1,
  },
  rowDid: {
    ...textStyles.monoSmall,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    marginLeft: spacing.sm,
  },
  badgeText: {
    ...textStyles.eyebrow,
    letterSpacing: 0.3,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: textStyles.h3,
  emptyBody: {
    ...textStyles.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  emptyCta: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
  },
  emptyCtaText: {
    ...textStyles.bodyStrong,
    color: colors.white,
  },
});
