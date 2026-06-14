/**
 * Backup reminder — the periodic, value-proportionate prompt to back up the
 * recovery phrase. Popped by `useBackupPrompt` once the vault holds enough to
 * be worth protecting (see `services/backup_prompt`). Two exits only:
 *
 *   - Back up now  -> /recovery-phrase (reveal + write down; marks verified on
 *     Done, so this never asks again).
 *   - Remind me later -> snooze for a few days, back to chat.
 *
 * No "recovery phrase" wall at onboarding and no passive banner — this page is
 * the single mechanism, and it only ever appears after the user has invested.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { countAllVaultItems, snoozeBackupPrompt } from '../src/services/backup_prompt';
import { colors, radius, spacing, textStyles } from '../src/theme';

export default function BackupReminderScreen(): React.ReactElement {
  const router = useRouter();
  const count = countAllVaultItems();

  const remindLater = (): void => {
    void snoozeBackupPrompt();
    try {
      router.back();
    } catch {
      router.replace('/' as never);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.title}>Back up Dina</Text>
        <Text style={styles.body}>
          You&apos;ve saved {count} {count === 1 ? 'thing' : 'things'} to Dina. Right now they live
          only on this phone — if it&apos;s lost or replaced, they&apos;re gone.
        </Text>
        <Text style={styles.body}>
          Your recovery phrase is the one way to restore everything on a new device. It takes about
          two minutes, and you only do it once.
        </Text>
      </View>

      <Pressable
        testID="backup-reminder-now"
        accessibilityRole="button"
        accessibilityLabel="Back up my recovery phrase now"
        onPress={() =>
          router.replace({
            pathname: '/recovery-phrase',
            params: { from: '/backup-reminder' },
          } as never)
        }
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>Back up now</Text>
      </Pressable>

      <Pressable
        testID="backup-reminder-later"
        accessibilityRole="button"
        accessibilityLabel="Remind me later"
        onPress={remindLater}
        style={styles.secondary}
      >
        <Text style={styles.secondaryText}>Remind me later</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  hero: { marginBottom: spacing.xl },
  title: {
    ...textStyles.display,
    marginBottom: spacing.md,
  },
  body: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: spacing.md,
  },
  primary: {
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.85 },
  primaryText: textStyles.button,
  secondary: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryText: {
    ...textStyles.body,
    color: colors.textMuted,
  },
});
