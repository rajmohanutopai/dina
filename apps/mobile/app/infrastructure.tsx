/**
 * Infrastructure settings — advanced endpoint overrides.
 *
 * Defaults are applied silently during onboarding. This screen exists
 * for self-hosting, test environments, and recovery from a bad URL.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  DEFAULT_APPVIEW_URL,
  DEFAULT_PDS_URL,
  loadInfraPreferences,
  saveAppViewURL,
  savePdsUrl,
  saveServicesAppViewURL,
} from '../src/services/infra_preferences';
import { colors, radius, shadows, spacing, textStyles } from '../src/theme';

export default function InfrastructureScreen(): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pdsUrl, setPdsUrl] = useState(DEFAULT_PDS_URL);
  const [appViewURL, setAppViewURL] = useState(DEFAULT_APPVIEW_URL);
  const [servicesAppViewURL, setServicesAppViewURL] = useState('');
  const [error, setError] = useState<string | null>(null);

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
        'Force-quit and reopen Dina to apply these endpoint changes.',
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
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
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

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}

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
    </ScrollView>
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
});
