/**
 * KeyHealthPill — problem-only status pill for an AI provider key.
 *
 * Probes the BILLED generation path (src/ai/key_health.ts) and renders:
 *   credits_exhausted → "Credits exhausted" (red, card icon)
 *   invalid_key       → "Key not working"  (red, key icon)
 *   ok / unreachable / unknown → NOTHING (Silence First — a healthy key
 *                       earns no chrome; a transient network blip must not
 *                       scare the user about billing)
 *
 * Tapping the pill shows the provider's own error message and offers a
 * re-check. The probe runs only for the provider this pill mounts for —
 * callers gate mounting on the ACTIVE provider so background tiles don't
 * burn probe tokens.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';

import {
  getCachedKeyHealth,
  refreshKeyHealth,
  subscribeKeyHealth,
  type KeyHealth,
} from '../ai/key_health';
import { getApiKey, PROVIDERS } from '../ai/provider';
import { colors, radius, spacing, textStyles } from '../theme';

import type { ProviderType } from '../ai/provider';

export function useKeyHealth(provider: ProviderType | null): {
  health: KeyHealth | null;
  refresh: (force?: boolean) => void;
} {
  // Subscribe so a refresh triggered on one screen updates the other.
  const health = useSyncExternalStore(
    subscribeKeyHealth,
    () => (provider !== null ? getCachedKeyHealth(provider) : null),
    () => (provider !== null ? getCachedKeyHealth(provider) : null),
  );
  const [, setTick] = useState(0);

  const refresh = useCallback(
    (force = false) => {
      if (provider === null) return;
      void (async () => {
        const key = await getApiKey(provider);
        if (key === null || key === '') return;
        await refreshKeyHealth(provider, key, { force });
        setTick((t) => t + 1);
      })();
    },
    [provider],
  );

  useEffect(() => {
    refresh(false); // TTL-cached — cheap on re-mounts
  }, [refresh]);

  return { health, refresh };
}

export function KeyHealthPill({ provider }: { provider: ProviderType }): React.JSX.Element | null {
  const { health, refresh } = useKeyHealth(provider);

  if (health === null) return null;
  if (health.status !== 'credits_exhausted' && health.status !== 'invalid_key') return null;

  const exhausted = health.status === 'credits_exhausted';
  const label = exhausted ? 'Credits exhausted' : 'Key not working';
  const icon = exhausted ? ('card-outline' as const) : ('key-outline' as const);

  const onPress = (): void => {
    const providerLabel = PROVIDERS[provider].label;
    Alert.alert(
      label,
      (exhausted
        ? `${providerLabel} accepted the key but refused to generate: the project's credits or quota are used up. Top up / check billing with ${providerLabel}, then re-check.`
        : `${providerLabel} rejected this key. It may have been revoked — check it on the provider's console, or replace it here.`) +
        (health.detail !== undefined ? `\n\nProvider says: “${health.detail}”` : ''),
      [
        { text: 'Close', style: 'cancel' },
        { text: 'Re-check now', onPress: () => refresh(true) },
      ],
    );
  };

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      testID={`key-health-pill-${provider}`}
      accessibilityRole="button"
      accessibilityLabel={`${label}. Tap for details.`}
    >
      <Ionicons name={icon} size={12} color={colors.white} />
      <Text style={styles.pillText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    backgroundColor: colors.error,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginTop: spacing.xs,
  },
  pillPressed: { opacity: 0.75 },
  pillText: {
    ...textStyles.caption,
    color: colors.white,
    fontWeight: '600',
  },
});
