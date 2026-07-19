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

import { Ionicons } from '@expo/vector-icons';
import { Link, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  Platform,
  Share,
} from 'react-native';

import {
  getPeopleRepository,
  type Contact,
  type Person,
} from '@dina/core';

import { IdentityModal } from '../src/components/identity/identity_modal';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import { getProfile as getTrustProfile } from '../src/peerlens/appview_runtime';
import { confirmDecision } from '../src/services/confirm_decision';
import { buildContactCard } from '../src/services/contact_card';
import { deleteContact, loadContacts } from '../src/services/contacts_source';
import { getDisplayNameOverride } from '../src/services/display_name_override';
import { loadInfraPreferences } from '../src/services/infra_preferences';
import { relationsOnly } from '../src/services/people_relations';
import { colors, spacing, radius, shadows, textStyles } from '../src/theme';

type SubTab = 'contacts' | 'relations';

export default function PeopleScreen() {
  const [subTab, setSubTab] = useState<SubTab>('contacts');
  const [contacts, setContacts] = useState<Contact[]>([]);
  // Distinguishes a genuine empty directory from a FAILED first fetch (a broken
  // /api/v1/contacts proxy). Only meaningful when `contacts` is still empty:
  // once we have data, a later blip preserves the list silently (below).
  const [contactsLoadFailed, setContactsLoadFailed] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const router = useRouter();
  // Honor a `?tab=relations` deep-link (used by the guided demo to show the
  // just-added person under Relations). Reacts to param changes too.
  const params = useLocalSearchParams<{ tab?: string; pick?: string }>();
  // `?pick=talk` arrives from the chat composer's Talk chip: land on Contacts
  // and hint that tapping a contact opens their D2D thread.
  const pickTalk = params.pick === 'talk';
  // Tab deep-link (guided demo): jump straight to Contacts / Relations.
  useEffect(() => {
    if (params.tab === 'contacts') setSubTab('contacts');
    else if (params.tab === 'relations') setSubTab('relations');
  }, [params.tab]);
  // Force Contacts on EVERY Talk entry, not just the first. Using
  // `useFocusEffect` (fires once per navigation into this screen) instead of a
  // mount-once ref means a second Talk tap reliably lands on Contacts, while a
  // manual switch to Relations WITHIN the session is not re-yanked (a tab tap is
  // not a focus event). The hint stays driven by `pickTalk`.
  useFocusEffect(
    useCallback(() => {
      if (pickTalk) setSubTab('contacts');
    }, [pickTalk]),
  );

  const refresh = useCallback((isActive?: () => boolean) => {
    // Async source: native reads the in-process directory; web fetches from
    // the brain's /api/v1/contacts proxy (thin-client directory is empty; F4).
    // `isActive` guards the async setState so a slow web fetch that resolves
    // after blur/unmount (or is superseded by a newer refresh) doesn't write
    // stale contacts back into state.
    void loadContacts()
      .then((c) => {
        if (isActive === undefined || isActive()) {
          setContacts(c);
          setContactsLoadFailed(false); // a good load clears any prior error
        }
      })
      .catch(() => {
        // Preserve the previously-loaded list on a transient fetch failure
        // (a web /api/v1/contacts blip) instead of wiping to [] and flashing
        // "No contacts yet". But FLAG the failure so a FIRST-load error (no
        // prior data) surfaces as retry/error instead of a false "no contacts"
        // empty state.
        if (isActive === undefined || isActive()) setContactsLoadFailed(true);
      });
    const repo = getPeopleRepository();
    setPeople(repo === null ? [] : repo.listPeople());
  }, []);

  // Refresh on screen focus. On native listContacts is an in-memory snapshot;
  // on web loadContacts is a fetch, so the effect owns an `active` flag that
  // the async completion checks before writing state.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      refresh(() => active);
      return () => {
        active = false;
      };
    }, [refresh]),
  );

  // Add-contact lives in the bottom-right FAB (see below) — the single,
  // conventional "add" target. The old top-right header "+" was removed:
  // it collided with the Expo dev-client Tools overlay and duplicated the
  // FAB.

  const onLongPress = useCallback(
    (contact: Contact) => {
      // `confirmDecision` is platform-split: native → Alert.alert, web →
      // window.confirm (RN-Web's Alert.alert is a no-op, so a bare Alert would
      // never show the dialog on the web thin-client — the delete could never
      // be triggered there). `deleteContact` is likewise split: native removes
      // from the authoritative in-process directory, web hits the Core-backed
      // DELETE proxy. Refresh only when Core/the store confirms the removal, so
      // we never claim a removal that won't stick.
      void confirmDecision(
        `Remove ${contact.displayName || 'contact'}?`,
        "You’ll need to add them again to talk with them. Their DID stays on PLC; this only removes them from your contact list.",
        'Remove',
        true,
      ).then((confirmed) => {
        if (!confirmed) return;
        void deleteContact(contact.did).then((removed) => {
          if (removed) refresh();
        });
      });
    },
    [refresh],
  );

  return (
    <View style={styles.container}>
      <OwnIdentityCard />
      <SubTabBar value={subTab} onChange={setSubTab} />
      {subTab === 'contacts' ? (
        <>
          {pickTalk && (
            <View style={styles.talkPickHint} testID="people-talk-pick-hint">
              <Text style={styles.talkPickHintText}>Tap a contact to start a conversation.</Text>
            </View>
          )}
          <ContactsView
            contacts={contacts}
            loadFailed={contactsLoadFailed}
            onRetry={() => refresh()}
            onLongPress={onLongPress}
            onAdd={() => router.push('/add-contact' as never)}
          />
        </>
      ) : (
        <RelationsView people={people} />
      )}
      {/* Bottom-right FAB — the conventional, always-visible "add" target.
          The header also has a "+", but the top-right corner collides with
          the Expo dev-client Tools overlay and is easy to miss. */}
      {subTab === 'contacts' ? (
        <Pressable
          testID="people-add-contact-fab"
          onPress={() => router.push('/add-contact' as never)}
          accessibilityRole="button"
          accessibilityLabel="Add a contact"
          style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85 }]}
        >
          <Ionicons name="add" size={30} color={colors.white} />
        </Pressable>
      ) : null}
    </View>
  );
}

function ContactsView({
  contacts,
  loadFailed,
  onRetry,
  onLongPress,
  onAdd,
}: {
  contacts: Contact[];
  loadFailed: boolean;
  onRetry: () => void;
  onLongPress: (contact: Contact) => void;
  onAdd: () => void;
}) {
  if (contacts.length === 0) {
    // FIRST-load failure (no prior data) → retry/error, NOT a false "no
    // contacts" — a broken /api/v1/contacts proxy must not read as an empty
    // directory. A genuine empty directory keeps the add-a-contact prompt.
    const failed = loadFailed;
    return (
      <View style={styles.emptyState}>
        <Ionicons
          name={failed ? 'cloud-offline-outline' : 'people-outline'}
          size={40}
          color={colors.textMuted}
          style={{ marginBottom: spacing.md }}
        />
        <Text style={styles.emptyTitle}>{failed ? "Couldn't load contacts" : 'No contacts yet'}</Text>
        <Text style={styles.emptyBody}>
          {failed
            ? 'We couldn’t reach your directory. Check your connection and try again.'
            : 'Add someone by their handle to start an end-to-end encrypted conversation.'}
        </Text>
        <Pressable
          testID={failed ? 'people-retry-contacts' : 'people-add-contact'}
          onPress={failed ? onRetry : onAdd}
          accessibilityRole="button"
          accessibilityLabel={failed ? 'Retry loading contacts' : 'Add a contact'}
          style={({ pressed }) => [styles.emptyCta, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.emptyCtaText}>{failed ? 'Retry' : 'Add a contact'}</Text>
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

function RelationsView({ people: allPeople }: { people: Person[] }) {
  // Being a contact is NOT being a relation: service providers added for
  // grants (e.g. a bus depot) stay in Contacts; Relations shows only
  // people with relational evidence. See people_relations.ts.
  const people = relationsOnly(allPeople);
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
/** 'aalber.test-pds.dinakernel.com' → 'Aalber'. Null/empty → null. */
function deriveNameFromHandle(handle: string | null): string | null {
  if (handle === null || handle.trim() === '') return null;
  const first = handle.split('.')[0] ?? '';
  if (first === '') return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function OwnIdentityCard(): React.ReactElement | null {
  const [identity, setIdentity] = useState<{
    did: string;
    handle: string | null;
  } | null>(null);
  // Tap the card to reveal your identity (handle + Dina ID) via the shared
  // IdentityModal, pointed at your own DID. This is the persistent "show me
  // my details" front-door, visible whether or not you have contacts (the
  // card sits above the empty/list split). Signing keys + network services
  // are intentionally NOT here — they live in Settings → Infrastructure
  // (reached via the modal's "Signing keys & network services →" link).
  const [showIdentity, setShowIdentity] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      // The node singleton may not be set the instant this card mounts
      // (People can render mid-boot, before SQLCipher open + argon2 key
      // derivation finish). Reading it once and bailing left the card
      // permanently hidden whenever it lost that race — the contacts
      // list survived only because it re-fetches via useFocusEffect.
      // Poll briefly until the node is ready instead of giving up.
      let node = getBootedNode();
      for (let i = 0; node === null && i < 25 && !cancelled; i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        node = getBootedNode();
      }
      if (node === null || cancelled) return;
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

  // Friendly name: the local display-name override (what the user entered
  // at "what should I call you"), falling back to the handle's first label
  // so the card always has a human label.
  const ownerName = getDisplayNameOverride() ?? deriveNameFromHandle(identity.handle);
  const onShareCard = (): void => {
    void Share.share({
      message: buildContactCard({
        name: ownerName,
        handle: identity.handle,
        did: identity.did,
      }),
    });
  };

  return (
    <View style={styles.identityCard}>
      <Pressable
        style={styles.identityText}
        testID="people-own-identity"
        onPress={() => setShowIdentity(true)}
        accessibilityRole="button"
        accessibilityLabel="View and share your contact card"
      >
        <Text style={styles.identityLabel}>{ownerName !== null ? 'YOU' : 'YOUR HANDLE'}</Text>
        <Text style={styles.identityValue} numberOfLines={1} ellipsizeMode="tail">
          {ownerName ?? identity.handle ?? identity.did}
        </Text>
        {ownerName !== null && identity.handle !== null ? (
          <Text style={styles.identitySub} numberOfLines={1} ellipsizeMode="middle">
            {identity.handle}
          </Text>
        ) : null}
        <View style={styles.identityHintRow}>
          <Text style={styles.identityHint}>Tap to view &amp; share your contact card</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
        </View>
      </Pressable>
      <Pressable
        testID="people-share-handle"
        onPress={onShareCard}
        accessibilityRole="button"
        accessibilityLabel="Share your contact card"
        hitSlop={8}
        style={({ pressed }) => [styles.shareButton, pressed && styles.shareButtonPressed]}
      >
        <Ionicons name="share-outline" size={18} color="#FFFFFF" />
        <Text style={styles.shareButtonText}>Share</Text>
      </Pressable>
      <IdentityModal
        visible={showIdentity}
        onClose={() => setShowIdentity(false)}
        did={identity.did}
        initialHandle={identity.handle}
        variant="self"
        selfName={ownerName}
        onShowAdvanced={() => {
          setShowIdentity(false);
          router.push('/infrastructure' as never);
        }}
      />
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
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
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
  identityValue: { ...textStyles.bodyStrong, color: colors.textPrimary },
  identitySub: {
    ...textStyles.monoSmall,
    color: colors.textSecondary,
    marginTop: 1,
  },
  identityHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  identityHint: {
    ...textStyles.caption,
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
  // "Tap a contact to start a conversation" hint shown when arriving from the
  // chat composer's Talk chip (`?pick=talk`).
  talkPickHint: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  talkPickHintText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
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
