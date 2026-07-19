/**
 * Infrastructure settings — advanced endpoint overrides.
 *
 * Defaults are applied silently during onboarding. This screen exists
 * for self-hosting, test environments, and recovery from a bad URL.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';

import { IdentityModal } from '../src/components/identity/identity_modal';
import { getBootedNode } from '../src/hooks/useNodeBootstrap';
import {
  DEFAULT_APPVIEW_URL,
  DEFAULT_PDS_URL,
  loadInfraPreferences,
  saveAppViewURL,
  savePdsUrl,
  saveServicesAppViewURL,
} from '../src/services/infra_preferences';
import { reloadApp } from '../src/services/reload_app';
import { colors, radius, shadows, spacing, textStyles } from '../src/theme';

export default function InfrastructureScreen(): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pdsUrl, setPdsUrl] = useState(DEFAULT_PDS_URL);
  const [appViewURL, setAppViewURL] = useState(DEFAULT_APPVIEW_URL);
  const [servicesAppViewURL, setServicesAppViewURL] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Advanced identity sheet (signing keys + network services). Lives here
  // — not on the People page — because it's infrastructure, not everyday.
  const [showIdentity, setShowIdentity] = useState(false);
  const ownDid = getBootedNode()?.did ?? '';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const prefs = await loadInfraPreferences();
        if (cancelled) return;
        setPdsUrl(prefs.pdsUrl ?? DEFAULT_PDS_URL);
        setAppViewURL(prefs.appViewURL ?? DEFAULT_APPVIEW_URL);
        setServicesAppViewURL(prefs.servicesAppViewURL ?? '');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = useCallback(async () => {
    setError(null);
    const nextPds = pdsUrl.trim();
    const nextAppView = appViewURL.trim();
    const nextServicesAppView = servicesAppViewURL.trim();

    if (!isHttpUrl(nextPds)) {
      setError('PDS URL must start with http:// or https://.');
      return;
    }
    if (!isHttpUrl(nextAppView)) {
      setError('PeerLens AppView URL must start with http:// or https://.');
      return;
    }
    if (nextServicesAppView !== '' && !isHttpUrl(nextServicesAppView)) {
      setError('Service Discovery AppView URL must start with http:// or https://.');
      return;
    }

    setSaving(true);
    try {
      await Promise.all([
        savePdsUrl(nextPds),
        saveAppViewURL(nextAppView),
        saveServicesAppViewURL(nextServicesAppView),
      ]);
      Alert.alert(
        'Infrastructure saved',
        'Dina needs to restart to apply these endpoint changes.',
        [
          { text: 'Later', style: 'cancel' },
          { text: 'Restart now', onPress: () => void reloadApp() },
        ],
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [appViewURL, pdsUrl, servicesAppViewURL]);

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      bottomOffset={24}
    >
      <Text style={styles.subtitle}>
        Dina uses hosted defaults automatically. Change these only when you are using a
        different PDS or AppView.
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>ENDPOINTS</Text>
        <View style={styles.card}>
          <Field
            label="PDS URL"
            value={pdsUrl}
            onChangeText={setPdsUrl}
            placeholder={DEFAULT_PDS_URL}
          />
          <View style={styles.divider} />
          <Field
            label="PeerLens AppView URL"
            value={appViewURL}
            onChangeText={setAppViewURL}
            placeholder={DEFAULT_APPVIEW_URL}
          />
          <View style={styles.divider} />
          <Field
            label="Service Discovery AppView URL"
            value={servicesAppViewURL}
            onChangeText={setServicesAppViewURL}
            placeholder="Leave blank to use PeerLens AppView"
          />
        </View>
      </View>

      {ownDid !== '' ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>IDENTITY &amp; KEYS</Text>
          <View style={styles.card}>
            <Pressable
              testID="infrastructure-identity"
              onPress={() => setShowIdentity(true)}
              accessibilityRole="button"
              accessibilityLabel="View your identity, signing keys, and network services"
              style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.linkTitle}>Your identity, keys &amp; services</Text>
                <Text style={styles.linkSub}>
                  Handle, Dina ID, signing keys, and the PDS / messaging servers.
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>
      ) : null}

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}

      <IdentityModal
        visible={showIdentity}
        onClose={() => setShowIdentity(false)}
        did={ownDid}
        variant="self"
        showAdvanced
      />

      <Pressable
        testID="infrastructure-save"
        onPress={() => void onSave()}
        disabled={saving}
        style={({ pressed }) => [
          styles.primary,
          pressed && styles.pressed,
          saving && styles.disabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Save infrastructure"
      >
        {saving ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text style={styles.primaryText}>Save infrastructure</Text>
        )}
      </Pressable>
    </KeyboardAwareScrollView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}): React.ReactElement {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        testID={`infrastructure-input-${label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')}`}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
      />
    </View>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  subtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  section: {
    marginTop: spacing.xl,
  },
  sectionTitle: {
    ...textStyles.eyebrow,
    letterSpacing: 1.5,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.sm,
  },
  field: {
    padding: spacing.md,
  },
  label: {
    ...textStyles.label,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  input: {
    ...textStyles.bodyLarge,
    minHeight: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
  },
  error: {
    ...textStyles.bodySmall,
    color: colors.error,
    marginTop: spacing.md,
  },
  primary: {
    marginTop: spacing.xl,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: textStyles.button,
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  linkTitle: {
    ...textStyles.bodyStrong,
    color: colors.textPrimary,
  },
  linkSub: {
    ...textStyles.caption,
    color: colors.textMuted,
    marginTop: 2,
  },
});
