/**
 * Vaults — list every persona vault on this device with name, lock
 * icon, tier label, classifier description, and item count.
 *
 * Tap a row → `/vault/<name>` detail screen.
 * Tap "+ New vault" → inline form: name + tier + description.
 *
 * Mirrors main Dina's Settings → Personas screen (`admin-cli`) but
 * surfaces the vaults FIRST (people care about their data, not their
 * persona configuration). Description is the field that actually
 * drives the LLM persona classifier — so we render it prominently
 * with an "edit" affordance on the detail page.
 */

import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';

import {
  addPersona,
  formatPersonaDisplayName,
  getPersonaUIStates,
  getTierOptions,
  type PersonaUIState,
} from '../../src/hooks/usePersonas';
import { countVaultItems } from '../../src/hooks/useVaultItems';
import { colors, radius, shadows, spacing, textStyles } from '../../src/theme';

import type { PersonaTier } from '@dina/core';

interface VaultRow extends PersonaUIState {
  itemCount: number | null;
}

/**
 * Wrap `countVaultItems` so the strict-mode `requireRepo` throw on
 * non-wired personas (sensitive vaults that haven't been opened yet)
 * shows up as `0` rather than crashing the screen. The user's vault
 * is fine — there's just no SQLite repo to count from yet.
 */
function safeCount(persona: string): number | null {
  try {
    return countVaultItems(persona);
  } catch {
    // Sensitive / locked vault — DEK not in RAM. Distinguish from a
    // genuinely empty vault by returning null; the row renders an
    // em-dash placeholder instead of misleading "0".
    return null;
  }
}

export default function VaultsIndex(): React.ReactElement {
  const router = useRouter();
  const [rows, setRows] = useState<VaultRow[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  // Re-fetch on focus — covers the case where the user added a new
  // memory in chat, then navigated to Vaults: counts must update.
  useFocusEffect(
    useCallback(() => {
      setRows(getPersonaUIStates().map((p) => ({ ...p, itemCount: safeCount(p.name) })));
      return () => {
        /* nothing to cleanup */
      };
    }, []),
  );

  const refresh = useCallback(() => {
    setRows(getPersonaUIStates().map((p) => ({ ...p, itemCount: safeCount(p.name) })));
  }, []);

  const onTap = useCallback(
    (name: string) => {
      router.push({ pathname: '/vault/[name]', params: { name } });
    },
    [router],
  );

  // When adding, the form takes the whole screen so its Cancel/Create
  // footer can pin to the bottom (always reachable above the keyboard) —
  // an inline form below the vault cards parked Create below the fold.
  if (showAdd) {
    return (
      <>
        <Stack.Screen options={{ title: 'New vault', headerShown: true }} />
        <AddVaultForm
          onCancel={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            refresh();
          }}
        />
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Vaults', headerShown: true }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.heroEyebrow}>YOUR VAULTS</Text>
          <Text style={styles.heroSubtitle}>
            Each vault is a separate encrypted compartment. Dina classifies new memories into the
            right one based on the vault’s description.
          </Text>
        </View>

        <View style={styles.section}>
          {rows.map((row) => (
            <VaultCard key={row.name} row={row} onPress={() => onTap(row.name)} />
          ))}
        </View>

        <Pressable
          style={styles.addButton}
          onPress={() => setShowAdd(true)}
          testID="vault-new-vault"
          accessibilityRole="button"
        >
          <Ionicons name="add-circle-outline" size={20} color={colors.accent} />
          <Text style={styles.addButtonText}>New vault</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

function VaultCard({ row, onPress }: { row: VaultRow; onPress: () => void }): React.ReactElement {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      testID={`vault-open-${row.name}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${formatPersonaDisplayName(row.name)} vault`}
    >
      <View style={styles.cardHeader}>
        <Ionicons
          name={row.isOpen ? 'lock-open-outline' : 'lock-closed-outline'}
          size={18}
          color={row.isOpen ? colors.accent : colors.textMuted}
        />
        <Text style={styles.cardTitle}>{formatPersonaDisplayName(row.name)}</Text>
        <Text style={styles.cardCount}>{row.itemCount ?? '—'}</Text>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </View>
      <Text style={styles.tierLabel}>{row.tierLabel}</Text>
      {row.description ? <Text style={styles.description}>{row.description}</Text> : null}
    </Pressable>
  );
}

function AddVaultForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [tier, setTier] = useState<PersonaTier>('standard');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Tier options — `usePersonas.getTierOptions()` excludes `default`
  // by design (only one default vault per device — `general`).
  const tierOptions = useMemo(() => getTierOptions(), []);

  // Mirror the hook's rule (usePersonas) so the button + inline hint agree
  // with what `addPersona` accepts — no "tap Create, then get rejected".
  const trimmedName = name.trim().toLowerCase();
  const nameError = useMemo<string | null>(() => {
    if (trimmedName.length === 0) return null; // empty: no message, button just stays disabled
    if (trimmedName.length < 2) return 'Name must be at least 2 characters.';
    if (trimmedName.length > 30) return 'Name must be at most 30 characters.';
    if (!/^[a-zA-Z0-9_]+$/.test(trimmedName)) {
      return 'Use only letters, numbers, and underscores.';
    }
    return null;
  }, [trimmedName]);
  const canCreate = trimmedName.length >= 2 && nameError === null;

  const submit = useCallback(() => {
    setError(null);
    const trimmed = name.trim().toLowerCase();
    const desc = description.trim();
    // addPersona is async (it persists + opens + wires the vault DB on
    // create); run it in a fire-and-forget async IIFE so the callback stays
    // sync for onPress, surfacing any error into the form.
    void (async () => {
      const err = await addPersona(trimmed, tier, desc.length > 0 ? desc : undefined);
      if (err !== null) {
        setError(err);
        return;
      }
      onCreated();
    })();
  }, [name, tier, description, onCreated]);

  return (
    <KeyboardAvoidingView
      style={styles.formScreen}
      behavior="padding"
    >
      <ScrollView
        style={styles.scrollFlex}
        contentContainerStyle={styles.formScrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.formTitle}>New vault</Text>

        <Text style={styles.formLabel}>Name</Text>
        <TextInput
          style={styles.formInput}
          value={name}
          onChangeText={setName}
          placeholder="e.g. travel"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          testID="vault-name-input"
        />
        {nameError !== null ? (
          <Text style={styles.errorText} testID="vault-name-error">
            {nameError}
          </Text>
        ) : null}

        <Text style={styles.formLabel}>Access tier</Text>
        <View style={styles.tierRow}>
          {tierOptions.map((opt) => (
            <Pressable
              key={opt.value}
              style={[styles.tierChip, tier === opt.value && styles.tierChipActive]}
              onPress={() => setTier(opt.value)}
              testID={`vault-tier-${opt.value}`}
              accessibilityRole="button"
              accessibilityState={{ selected: tier === opt.value }}
            >
              <Text style={[styles.tierChipText, tier === opt.value && styles.tierChipTextActive]}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.tierHelpText}>
          {tierOptions.find((o) => o.value === tier)?.description ?? ''}
        </Text>

        <Text style={styles.formLabel}>Description</Text>
        <Text style={styles.formHelp}>
          Used by Dina’s classifier to route new memories into this vault. Be concrete: list the
          kinds of facts that should land here.
        </Text>
        <TextInput
          style={[styles.formInput, styles.formInputMultiline]}
          value={description}
          onChangeText={setDescription}
          placeholder="Travel plans, hotel bookings, flight numbers, restaurant lists, packing notes…"
          placeholderTextColor={colors.textMuted}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          testID="vault-description-input"
        />

        {error !== null ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>

      {/* Pinned footer — Create/Cancel stay reachable above the keyboard. */}
      <View style={styles.footer}>
        <View style={styles.formButtons}>
          <Pressable
            style={styles.formButtonSecondary}
            onPress={onCancel}
            testID="vault-cancel"
            accessibilityRole="button"
          >
            <Text style={styles.formButtonSecondaryText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.formButtonPrimary, !canCreate && styles.formButtonDisabled]}
            onPress={submit}
            disabled={!canCreate}
            testID="vault-create"
            accessibilityRole="button"
          >
            <Text style={styles.formButtonPrimaryText}>Create</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

// Suppress unused-import warning when the `Alert` API isn't called in
// the trimmed view above — kept available for future delete-vault
// confirmations.
void Alert;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { paddingBottom: spacing.xl },
  hero: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  heroEyebrow: {
    ...textStyles.eyebrow,
    letterSpacing: 2.4,
  },
  heroSubtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  section: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  cardPressed: { opacity: 0.7 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: {
    ...textStyles.bodyLargeStrong,
    flex: 1,
  },
  cardCount: {
    ...textStyles.bodySmallStrong,
    color: colors.textMuted,
    minWidth: 24,
    textAlign: 'right',
  },
  tierLabel: {
    ...textStyles.caption,
    marginTop: spacing.xs,
  },
  description: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  addButtonText: {
    ...textStyles.buttonSmall,
    color: colors.accent,
  },
  formCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    ...shadows.sm,
  },
  formScreen: { flex: 1, backgroundColor: colors.bgPrimary },
  scrollFlex: { flex: 1 },
  formScrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgPrimary,
  },
  formTitle: {
    ...textStyles.bodyLargeStrong,
    marginBottom: spacing.sm,
  },
  formLabel: {
    ...textStyles.label,
    color: colors.textMuted,
    letterSpacing: 1.2,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  formHelp: {
    ...textStyles.caption,
    marginBottom: spacing.xs,
  },
  formInput: {
    ...textStyles.body,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  formInputMultiline: {
    minHeight: 80,
  },
  tierRow: { flexDirection: 'row', gap: spacing.xs },
  tierChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tierChipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  tierChipText: {
    ...textStyles.caption,
    color: colors.textSecondary,
  },
  tierChipTextActive: { color: colors.bgPrimary },
  tierHelpText: {
    ...textStyles.caption,
    marginTop: spacing.xs,
  },
  errorText: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.sm,
  },
  formButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  formButtonSecondary: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  formButtonSecondaryText: {
    ...textStyles.buttonSmall,
    color: colors.textSecondary,
  },
  formButtonPrimary: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  formButtonDisabled: { opacity: 0.4 },
  formButtonPrimaryText: {
    ...textStyles.buttonSmall,
    color: colors.bgPrimary,
  },
});
