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
        {/* Header card — name + tier + lock state */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <Ionicons
              name={persona.isOpen ? 'lock-open-outline' : 'lock-closed-outline'}
              size={20}
              color={persona.isOpen ? colors.accent : colors.textMuted}
            />
            <Text style={styles.headerTitle}>{formatPersonaDisplayName(persona.name)}</Text>
          </View>
          <Text style={styles.tierLabel}>{persona.tierLabel}</Text>
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

function ItemCard({
  item,
  onDelete,
}: {
  item: VaultItemUI;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <View style={styles.itemCard}>
      <View style={styles.itemHeader}>
        <Text style={styles.itemHeadline} numberOfLines={2}>
          {item.headline}
        </Text>
        <Pressable onPress={onDelete} hitSlop={10}>
          <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
        </Pressable>
      </View>
      {item.bodyPreview && item.bodyPreview !== item.headline ? (
        <Text style={styles.itemBody} numberOfLines={3}>
          {item.bodyPreview}
        </Text>
      ) : null}
      <Text style={styles.itemMeta}>
        {item.type} · {item.source || 'unknown'} · {formatTimestamp(item.createdAt)}
      </Text>
    </View>
  );
}

function formatTimestamp(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
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
