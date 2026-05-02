/**
 * Single-vault detail — items list + delete + description-edit + lock.
 *
 * Reached via `/vault/<name>` from the index screen. Shows:
 *   - Header: persona name, tier, lock state
 *   - Description (editable inline) — the field that drives the LLM
 *     classifier, so changes here change routing for FUTURE
 *     `/remember` calls
 *   - Item list (newest first, soft-deletable)
 *
 * Vault writes still come through `/remember` → drain → storeItem.
 * This screen is read + delete + describe; it deliberately doesn't
 * surface a "manually add an item" affordance. Adding a row outside
 * the staging pipeline would skip classification, PII scrubbing, and
 * reminder planning — Python's dina-cli has the same restriction.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Redirect, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, fonts, radius, shadows, spacing } from '../../src/theme';
import {
  formatPersonaDisplayName,
  getPersonaUI,
  updateDescription,
  type PersonaUIState,
} from '../../src/hooks/usePersonas';
import {
  deleteVaultItem,
  listVaultItemsUI,
  type VaultItemUI,
} from '../../src/hooks/useVaultItems';

interface ScreenState {
  persona: PersonaUIState | null;
  items: VaultItemUI[];
  /** True when the persona's SQLite repo isn't wired (e.g. sensitive
   *  vault never opened). Different from "0 items" — the vault is
   *  locked, not empty. */
  locked: boolean;
}

function loadState(name: string): ScreenState {
  const persona = getPersonaUI(name);
  if (persona === null) {
    return { persona: null, items: [], locked: false };
  }
  try {
    const items = listVaultItemsUI(name, 200);
    return { persona, items, locked: false };
  } catch {
    // Strict `requireRepo` throws when the SQLite vault hasn't been
    // opened — sensitive/locked tiers stay closed at boot until the
    // user grants access. Surface that as `locked` instead of an
    // empty list so the UI can show the right affordance.
    return { persona, items: [], locked: true };
  }
}

export default function VaultDetail(): React.ReactElement {
  const { name } = useLocalSearchParams<{ name: string }>();
  const personaName = typeof name === 'string' ? name : (name?.[0] ?? '');

  const [state, setState] = useState<ScreenState>({
    persona: null,
    items: [],
    locked: false,
  });
  const [editingDesc, setEditingDesc] = useState(false);
  const [draftDesc, setDraftDesc] = useState('');
  const [descError, setDescError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setState(loadState(personaName));
  }, [personaName]);

  useFocusEffect(
    useCallback(() => {
      refresh();
      return () => {
        /* nothing to cleanup */
      };
    }, [refresh]),
  );

  const onStartEditDesc = useCallback(() => {
    setDraftDesc(state.persona?.description ?? '');
    setDescError(null);
    setEditingDesc(true);
  }, [state.persona]);

  const onSaveDesc = useCallback(() => {
    const err = updateDescription(personaName, draftDesc.trim());
    if (err !== null) {
      setDescError(err);
      return;
    }
    setEditingDesc(false);
    refresh();
  }, [personaName, draftDesc, refresh]);

  const onDeleteItem = useCallback(
    (itemId: string) => {
      Alert.alert(
        'Delete this item?',
        'It will be removed from your vault. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              try {
                deleteVaultItem(personaName, itemId);
                refresh();
              } catch (err) {
                Alert.alert('Could not delete', err instanceof Error ? err.message : String(err));
              }
            },
          },
        ],
      );
    },
    [personaName, refresh],
  );

  const { persona, items, locked } = state;

  // Defensive: when the user navigates to `/vault` (hamburger menu)
  // and expo-router routes through this dynamic file with empty
  // params instead of `vault/index.tsx`, send them back to the index.
  // Without this they'd see "Vault not found / No persona named ''".
  // Placed after all hooks so the Rules of Hooks aren't violated.
  if (personaName.trim() === '') {
    return <Redirect href="/vault" />;
  }

  if (persona === null) {
    return (
      <>
        <Stack.Screen
          options={{ title: formatPersonaDisplayName(personaName), headerShown: true }}
        />
        <View style={styles.emptyContainer}>
          <Ionicons name="alert-circle-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Vault not found</Text>
          <Text style={styles.emptySub}>
            No persona named "{formatPersonaDisplayName(personaName)}".
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{ title: formatPersonaDisplayName(persona.name), headerShown: true }}
      />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        {/* Header card — lock state + tier. The persona name lives
          * in the Stack title above, so don't duplicate it here.
          * Showing "General" twice (page title + this card) read as
          * a layout bug. */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <Ionicons
              name={persona.isOpen ? 'lock-open-outline' : 'lock-closed-outline'}
              size={20}
              color={persona.isOpen ? colors.accent : colors.textMuted}
            />
            <Text style={styles.tierLabel}>{persona.tierLabel}</Text>
          </View>
        </View>

        {/* Description (editable) */}
        <View style={styles.descCard}>
          <View style={styles.descHeader}>
            <Text style={styles.descLabel}>DESCRIPTION</Text>
            {!editingDesc ? (
              <Pressable onPress={onStartEditDesc}>
                <Text style={styles.editLink}>Edit</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.descHelp}>
            Used by Dina’s classifier to route new memories into this vault.
          </Text>
          {editingDesc ? (
            <>
              <TextInput
                style={styles.descInput}
                value={draftDesc}
                onChangeText={setDraftDesc}
                multiline
                numberOfLines={4}
                textAlignVertical="top"
                placeholder="What kinds of facts belong here?"
                placeholderTextColor={colors.textMuted}
              />
              {descError !== null ? <Text style={styles.errorText}>{descError}</Text> : null}
              <View style={styles.descButtonRow}>
                <Pressable
                  style={styles.descCancelButton}
                  onPress={() => {
                    setEditingDesc(false);
                    setDescError(null);
                  }}
                >
                  <Text style={styles.descCancelText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.descSaveButton} onPress={onSaveDesc}>
                  <Text style={styles.descSaveText}>Save</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Text style={styles.descBody}>
              {persona.description.length > 0
                ? persona.description
                : 'No description yet. Add one so the classifier knows what belongs here.'}
            </Text>
          )}
        </View>

        {/* Items list */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            ITEMS {locked ? '(VAULT LOCKED)' : `(${items.length})`}
          </Text>
          {locked ? (
            <View style={styles.lockedCard}>
              <Ionicons name="lock-closed" size={24} color={colors.textMuted} />
              <Text style={styles.lockedTitle}>This vault is locked</Text>
              <Text style={styles.lockedSub}>
                Sensitive and locked vaults stay closed until you authorize access. Items will
                appear here once the vault is opened.
              </Text>
            </View>
          ) : items.length === 0 ? (
            <View style={styles.emptyItems}>
              <Text style={styles.emptyItemsText}>
                No items yet. Use /remember in chat or send Dina a message to populate this vault.
              </Text>
            </View>
          ) : (
            items.map((item) => (
              <ItemCard key={item.id} item={item} onDelete={() => onDeleteItem(item.id)} />
            ))
          )}
        </View>
      </ScrollView>
    </>
  );
}

/**
 * Strip the L0 enricher's `(unverified sender)` suffix from a
 * vault-item headline and surface it as a separate signal. The
 * enricher (brain/src/enrichment/l0_deterministic.ts) appends the
 * literal " (unverified sender)" to the headline when an item came
 * in from a sender Dina doesn't recognise. Rendering it inline with
 * the title made the suffix read like part of the subject's name —
 * "Sarah likes hibiscus tea (unverified sender)" — visually
 * confusing and accessibility-hostile. Splitting here lets the row
 * render a clean title plus a small badge.
 */
const UNVERIFIED_SUFFIX_RE = /\s*\(unverified sender\)\s*$/i;
function splitUnverifiedSuffix(headline: string): {
  cleanHeadline: string;
  hasUnverifiedSuffix: boolean;
} {
  if (!UNVERIFIED_SUFFIX_RE.test(headline)) {
    return { cleanHeadline: headline, hasUnverifiedSuffix: false };
  }
  return {
    cleanHeadline: headline.replace(UNVERIFIED_SUFFIX_RE, '').trimEnd(),
    hasUnverifiedSuffix: true,
  };
}

function ItemCard({
  item,
  onDelete,
}: {
  item: VaultItemUI;
  onDelete: () => void;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const { cleanHeadline, hasUnverifiedSuffix } = splitUnverifiedSuffix(item.headline);
  const hasMoreBody =
    item.bodyPreview.length > 0 && item.bodyPreview !== cleanHeadline;
  // Tap toggles expanded state — when collapsed, headline + body are
  // truncated; when expanded, they wrap fully. This is the "drill-in"
  // affordance: vault rows used to be plain Views with no tap target,
  // so users couldn't see the full content of long items or know the
  // row was interactive at all.
  const onTogglePress = () => setExpanded((prev) => !prev);
  // Suppress the press handler when there's nothing to expand (item
  // headline === bodyPreview, no overflow). Otherwise the row reads
  // as tappable but yields no visual change.
  const isPressable = hasMoreBody;

  return (
    <Pressable
      onPress={isPressable ? onTogglePress : undefined}
      style={({ pressed }) => [
        styles.itemCard,
        pressed && isPressable && styles.itemCardPressed,
      ]}
      accessibilityRole={isPressable ? 'button' : 'text'}
      accessibilityLabel={
        isPressable
          ? `${cleanHeadline}${hasUnverifiedSuffix ? ', unverified sender' : ''}, tap to ${expanded ? 'collapse' : 'expand'}`
          : `${cleanHeadline}${hasUnverifiedSuffix ? ', unverified sender' : ''}`
      }
      accessibilityState={isPressable ? { expanded } : undefined}
    >
      <View style={styles.itemHeader}>
        <Text
          style={styles.itemHeadline}
          numberOfLines={expanded ? 0 : 2}
        >
          {cleanHeadline}
        </Text>
        <Pressable onPress={onDelete} hitSlop={10} accessibilityLabel="Delete item">
          <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
        </Pressable>
      </View>
      {hasUnverifiedSuffix && (
        <View style={styles.unverifiedBadge} testID="vault-item-unverified-badge">
          <Ionicons name="alert-circle-outline" size={12} color={colors.warning} />
          <Text style={styles.unverifiedText}>Unverified sender</Text>
        </View>
      )}
      {hasMoreBody ? (
        <Text
          style={styles.itemBody}
          numberOfLines={expanded ? 0 : 3}
        >
          {item.bodyPreview}
        </Text>
      ) : null}
      <Text style={styles.itemMeta}>
        {humaniseVaultMeta(item)} · {formatTimestamp(item.createdAt)}
      </Text>
    </Pressable>
  );
}

/**
 * Humanise the `type` + `source` combo for the meta line. The raw
 * fields are internal storage labels (`user_memory`, `user_remember`,
 * `gmail`, `d2d`, …) that read as jargon in the UI. Map known values
 * to friendly copy and fall back to title-cased text for unknowns.
 *
 * When type and source describe the same thing (e.g. `user_memory` +
 * `user_remember` — both mean "the user told Dina to remember this"),
 * collapse to a single label rather than printing redundant "Memory ·
 * Saved by you · 9:05 AM".
 */
function humaniseVaultMeta(item: VaultItemUI): string {
  const typeLabel = humaniseType(item.type);
  const sourceLabel = humaniseSource(item.source);
  if (sourceLabel === '' || sourceLabel === typeLabel) {
    return typeLabel;
  }
  return `${typeLabel} · ${sourceLabel}`;
}

function humaniseType(t: string): string {
  switch (t) {
    case 'user_memory':
      return 'Memory';
    case 'note':
      return 'Note';
    case 'email':
      return 'Email';
    case 'calendar_event':
      return 'Calendar';
    case 'reminder':
      return 'Reminder';
    case 'document':
      return 'Document';
    default:
      return titleCase(t);
  }
}

function humaniseSource(s: string): string {
  switch (s) {
    case '':
    case 'unknown':
      return '';
    case 'user_remember':
    case 'user_memory':
      return 'Saved by you';
    case 'gmail':
      return 'Gmail';
    case 'd2d':
      return 'From contact';
    case 'connector':
      return 'Connector';
    default:
      return titleCase(s);
  }
}

function titleCase(s: string): string {
  if (s.length === 0) return s;
  return s
    .split(/[_\s]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Locale-safe date format. The previous `toLocaleDateString()` call
 * deferred to the device locale, which surfaces `29/4/2026` on en-GB
 * builds and is parsed as malformed by US readers. The explicit
 * `{ month: 'short', day: 'numeric', year: 'numeric' }` options
 * produce `Apr 29, 2026` everywhere and reads unambiguously
 * regardless of the device's date-format preference.
 */
function formatTimestamp(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { paddingBottom: spacing.xl },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.bgPrimary,
  },
  emptyTitle: {
    fontFamily: fonts.serif,
    fontSize: 22,
    color: colors.textPrimary,
    marginTop: spacing.md,
  },
  emptySub: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  headerCard: {
    backgroundColor: colors.bgCard,
    margin: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    ...shadows.sm,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 18,
    color: colors.textPrimary,
  },
  tierLabel: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  descCard: {
    backgroundColor: colors.bgCard,
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    ...shadows.sm,
  },
  descHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  descLabel: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  editLink: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.accent,
  },
  descHelp: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  descBody: {
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  descInput: {
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
    minHeight: 90,
  },
  descButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  descCancelButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  descCancelText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.textSecondary,
  },
  descSaveButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  descSaveText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    color: colors.bgPrimary,
  },
  errorText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.error,
    marginTop: spacing.sm,
  },
  section: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
    marginBottom: spacing.sm,
    paddingLeft: 4,
  },
  lockedCard: {
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    ...shadows.sm,
  },
  lockedTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    color: colors.textPrimary,
    marginTop: spacing.sm,
  },
  lockedSub: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  emptyItems: {
    padding: spacing.md,
    alignItems: 'center',
  },
  emptyItemsText: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    textAlign: 'center',
  },
  itemCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  itemCardPressed: { opacity: 0.7 },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  itemHeadline: {
    flex: 1,
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
  },
  unverifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: '#FFF7ED',
    borderWidth: 1,
    borderColor: '#FED7AA',
  },
  unverifiedText: {
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '600',
    color: colors.warning,
  },
  itemBody: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  itemMeta: {
    fontFamily: fonts.sans,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
});
