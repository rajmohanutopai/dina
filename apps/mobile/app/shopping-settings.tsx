/**
 * Shopping (UCP plan §4.2 U1): which online shops Dina may search, and what
 * a search tells them about where you are.
 *
 * A search goes only to the shops listed here. It carries the query and the
 * fields below, nothing else about you; a postal code goes only if you enter
 * one. Core checks every field and says which one it refused. Edits are kept
 * only on Save; until then the screen says they are unsaved.
 */

import { Stack } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ALLOWED_MERCHANTS_MAX,
  merchantOrigin,
  OwnerUcpHttpError,
  type UcpSettings,
} from '@dina/core';

import { ShoppingKey } from '../src/components/ShoppingKey';
import { getOwnerUcpClient } from '../src/services/owner_ucp_client';
import { colors, radius, spacing, textStyles } from '../src/theme';

type ContextField = 'address_country' | 'address_region' | 'language' | 'postal_code';

const FIELDS: { key: ContextField; label: string; hint: string }[] = [
  { key: 'address_country', label: 'Country', hint: 'Two letters, e.g. DE' },
  { key: 'address_region', label: 'Region', hint: 'e.g. Bavaria (optional)' },
  { key: 'language', label: 'Language', hint: 'e.g. de or en-GB (optional)' },
  { key: 'postal_code', label: 'Postal code', hint: 'Sent only if you enter it' },
];

const FIELD_WORDS: Record<string, string> = {
  merchants:
    'A shop address is https:// and the shop’s domain name, like https://shop.example, with nothing after it.',
  address_country: 'Use the two-letter country code, in capitals (e.g. DE).',
  address_region: 'The region is too long or has characters it cannot carry.',
  language: 'Use a language code such as de or en-GB.',
  postal_code: 'A postal code is letters, digits, spaces and dashes (16 at most).',
};

/**
 * A shop as typed, reduced to its origin (`https://host`); null when it is not
 * an https address at a public domain name (Core's own rule, `merchantOrigin`:
 * no address, no bare local name).
 */
export function shopOrigin(typed: string): string | null {
  const t = typed.trim();
  const withScheme = /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return merchantOrigin(url.origin);
  } catch {
    return null;
  }
}

/** The settings as saved: each context field trimmed, and one emptied by trimming left out. */
export function trimmedSettings(settings: UcpSettings): UcpSettings {
  const context = Object.fromEntries(
    Object.entries(settings.context)
      .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])
      .filter(([, v]) => v !== ''),
  );
  return { merchants: settings.merchants, context };
}

/**
 * Whether two settings save the same: the same shops (in any order) and each
 * field the same once trimmed, an empty field the same as one left out.
 */
export function sameSettings(a: UcpSettings | null, b: UcpSettings | null): boolean {
  if (a === null || b === null) return false;
  const shops = (s: UcpSettings) => [...s.merchants].sort().join('\n');
  const field = (s: UcpSettings, k: ContextField) => (s.context[k] ?? '').trim();
  return shops(a) === shops(b) && FIELDS.every((f) => field(a, f.key) === field(b, f.key));
}

/** Android 9 and older cannot reach shops that need TLS 1.3 (implementation notes, U6). */
export function isOldAndroid(os: string, version: string | number): boolean {
  return os === 'android' && typeof version === 'number' && version < 29;
}

export default function ShoppingSettingsScreen(): React.JSX.Element {
  // Room for the tab bar below the last row (as Settings): its warnings stay readable.
  const bottomPad = useSafeAreaInsets().bottom + 49 + spacing.md;
  const [settings, setSettings] = useState<UcpSettings | null>(null);
  const [saved, setSaved] = useState<UcpSettings | null>(null);
  /** Whether this node runs shop search now; the settings apply once it does. */
  const [searching, setSearching] = useState<boolean | null>(null);
  // The settings as they stand, read when a save returns: edits made while it ran are kept.
  const current = useRef<UcpSettings | null>(null);
  current.current = settings;
  const [adding, setAdding] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const client = getOwnerUcpClient();
    if (client === null) {
      setNote('Shopping settings are not available yet.');
      return;
    }
    client
      .settings()
      .then(({ searching: on, ...s }) => {
        setSettings(s);
        setSaved(s);
        setSearching(on);
      })
      .catch(() => setNote('Your shopping settings could not be loaded.'));
  }, []);

  /** An edit: the old note (a "Saved." or a refusal) no longer applies. */
  const edit = useCallback((next: UcpSettings) => {
    setSettings(next);
    setNote(null);
  }, []);

  const addShop = useCallback(() => {
    if (settings === null) return;
    const origin = shopOrigin(adding);
    if (origin === null) {
      setNote(FIELD_WORDS.merchants ?? null);
      return;
    }
    if (
      settings.merchants.length >= ALLOWED_MERCHANTS_MAX &&
      !settings.merchants.includes(origin)
    ) {
      setNote(`At most ${ALLOWED_MERCHANTS_MAX} shops.`);
      return;
    }
    edit({ ...settings, merchants: [...new Set([...settings.merchants, origin])].sort() });
    setAdding('');
  }, [adding, edit, settings]);

  const save = useCallback(async () => {
    const client = getOwnerUcpClient();
    if (client === null || settings === null) return;
    setSaving(true);
    try {
      const submitted = trimmedSettings(settings);
      const { searching: on, ...stored } = await client.saveSettings(submitted);
      setSaved(stored);
      setSearching(on);
      if (sameSettings(current.current, submitted)) {
        setSettings(stored);
        setNote('Saved.');
      } else {
        // Typed while the save ran: those edits stay on screen, still unsaved.
        setNote('Saved. Your newer changes are not saved yet.');
      }
    } catch (err) {
      const field = err instanceof OwnerUcpHttpError ? err.field : null;
      setNote(
        (field !== null ? FIELD_WORDS[field] : undefined) ??
          'Your shopping settings could not be saved.',
      );
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const unsaved = settings !== null && !sameSettings(settings, saved);
  return (
    <ScrollView
      contentContainerStyle={[styles.page, { paddingBottom: bottomPad }]}
      // One tap on Add or Save works with the keyboard up (Android dismissed it and ate the tap).
      keyboardShouldPersistTaps="handled"
      testID="shopping-settings"
    >
      <Stack.Screen options={{ title: 'Shopping' }} />
      <Text style={styles.lead}>
        Dina searches only the shops listed here. Each search sends the shop your query and the
        details below, nothing else about you.
      </Text>
      {searching === false && (
        <Text style={styles.meta} testID="shopping-off">
          Shop search is not switched on for this Dina yet. These settings are kept and apply once
          it is.
        </Text>
      )}

      <Text style={styles.heading}>Shops Dina may search</Text>
      {settings?.merchants.length === 0 && <Text style={styles.meta}>No shops yet.</Text>}
      {settings?.merchants.map((m) => (
        <View key={m} style={styles.row}>
          <Text style={styles.value}>{m}</Text>
          <Pressable
            testID={`shopping-remove-${m}`}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${m}`}
            onPress={() =>
              edit({ ...settings, merchants: settings.merchants.filter((x) => x !== m) })
            }
          >
            <Text style={styles.link}>Remove</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.row}>
        <TextInput
          testID="shopping-add-input"
          style={styles.input}
          value={adding}
          onChangeText={setAdding}
          accessibilityLabel="Shop address to add"
          placeholder="shop.example"
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor={colors.textSecondary}
        />
        <Pressable
          testID="shopping-add"
          accessibilityRole="button"
          accessibilityLabel="Add this shop"
          onPress={addShop}
        >
          <Text style={styles.link}>Add</Text>
        </Pressable>
      </View>

      <Text style={styles.heading}>What a search tells the shop</Text>
      {FIELDS.map((f) => (
        <View key={f.key} style={styles.field}>
          <Text style={styles.label}>{f.label}</Text>
          <TextInput
            testID={`shopping-${f.key}`}
            style={styles.input}
            value={settings?.context[f.key] ?? ''}
            accessibilityLabel={f.label}
            placeholder={f.hint}
            placeholderTextColor={colors.textSecondary}
            autoCapitalize={f.key === 'address_country' ? 'characters' : 'none'}
            autoCorrect={false}
            onChangeText={(text) => {
              if (settings === null) return;
              // An emptied field is left out: Core sends only what is set.
              const context = Object.fromEntries(
                Object.entries({ ...settings.context, [f.key]: text }).filter(([, v]) => v !== ''),
              );
              edit({ ...settings, context });
            }}
          />
        </View>
      ))}

      {isOldAndroid(Platform.OS, Platform.Version) && (
        <Text style={styles.meta} testID="shopping-old-android">
          This phone runs Android 9 or older: shops that need newer security (TLS 1.3) cannot be
          reached from it.
        </Text>
      )}
      {unsaved && (
        <Text style={styles.meta} testID="shopping-unsaved">
          Unsaved changes: they take effect once you save.
        </Text>
      )}
      {note !== null && (
        <Text style={styles.note} testID="shopping-note">
          {note}
        </Text>
      )}
      <Pressable
        testID="shopping-save"
        accessibilityRole="button"
        style={[styles.button, (!unsaved || saving) && styles.disabled]}
        disabled={!unsaved || saving}
        accessibilityState={{ disabled: !unsaved || saving }}
        onPress={() => void save()}
      >
        <Text style={styles.buttonLabel}>{saving ? 'Saving…' : 'Save'}</Text>
      </Pressable>
      <ShoppingKey />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.bgPrimary },
  lead: { ...textStyles.body, color: colors.textSecondary },
  heading: {
    ...textStyles.caption,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    marginTop: spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  value: { ...textStyles.body, color: colors.textPrimary, flex: 1 },
  meta: { ...textStyles.caption, color: colors.textSecondary },
  field: { gap: spacing.xs },
  label: { ...textStyles.caption, color: colors.textPrimary },
  input: {
    ...textStyles.body,
    flex: 1,
    color: colors.textPrimary,
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  link: { ...textStyles.caption, color: colors.accent },
  note: { ...textStyles.caption, color: colors.textPrimary },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  disabled: { opacity: 0.5 },
  buttonLabel: { ...textStyles.button, color: colors.bgPrimary },
});
