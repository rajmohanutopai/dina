/**
 * Settings → Backup (docs/USER_BACKUP.md §4.6).
 *
 * The switch, when the last copy was written, "Back up now", where copies
 * go, and "Delete all backups" (a second tap confirms; no system dialog).
 * The copies are sealed with a key from the recovery phrase, so the store
 * cannot read them, and the 24 words alone bring them back on a new phone.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import {
  backupStatus,
  backUpNowFromSettings,
  deleteAllBackups,
  restoreNewestBackupFromSettings,
  setBackupEnabled,
  type BackupStatus,
} from '../src/services/cloud_backup';
import { reloadApp } from '../src/services/reload_app';
import { colors, radius, spacing, textStyles } from '../src/theme';

type Busy = 'idle' | 'backing_up' | 'deleting' | 'restoring';

function describeLast(lastAt: number | null): string {
  if (lastAt === null) return 'No copy from this phone yet.';
  const when = new Date(lastAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Last copy: ${when}.`;
}

export default function BackupScreen(): React.ReactElement {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setStatus(await backupStatus());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = async (on: boolean): Promise<void> => {
    setError('');
    setMessage('');
    await setBackupEnabled(on);
    await reload();
  };

  const restore = async (): Promise<void> => {
    setBusy('restoring');
    setError('');
    setMessage('');
    try {
      await restoreNewestBackupFromSettings();
      // The stores in memory hold the old rows; a fresh boot reads the new ones.
      await reloadApp();
    } catch (err) {
      setError(`Couldn't restore: ${err instanceof Error ? err.message : String(err)}.`);
    } finally {
      setBusy('idle');
      await reload();
    }
  };

  const backUp = async (): Promise<void> => {
    // A held phone's copy becomes the newest one, so it takes a second tap.
    if (status?.heldForOwner === true && !confirmFresh) {
      setConfirmFresh(true);
      return;
    }
    setConfirmFresh(false);
    setBusy('backing_up');
    setError('');
    setMessage('');
    try {
      const result = await backUpNowFromSettings();
      setMessage(
        result.storeBehind
          ? 'Backed up. The store showed fewer copies than this phone wrote before; your newest copies may be missing there.'
          : 'Backed up.',
      );
    } catch (err) {
      setError(
        `Couldn't back up: ${err instanceof Error ? err.message : String(err)}. Check your connection and try again.`,
      );
    } finally {
      setBusy('idle');
      await reload();
    }
  };

  const remove = async (): Promise<void> => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy('deleting');
    setError('');
    setMessage('');
    try {
      await deleteAllBackups();
      setMessage('All backups deleted. Backup is off.');
    } catch (err) {
      setError(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}.`);
    } finally {
      setConfirmDelete(false);
      setBusy('idle');
      await reload();
    }
  };

  if (status === null) {
    return <View style={styles.container} testID="backup-loading" />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.switchRow}>
          <Text style={[styles.title, styles.flex]}>Keep an encrypted copy</Text>
          <Switch
            testID="backup-enabled"
            value={status.enabled}
            disabled={busy !== 'idle'}
            onValueChange={(on) => void toggle(on)}
            accessibilityLabel="Keep an encrypted copy"
          />
        </View>
        <Text style={styles.sub}>
          Get your Dina back on a new phone with your 24-word recovery phrase. The copy is locked
          with a key from those words, so we can't read it. Anyone with the words can restore it.
        </Text>
        <Text style={styles.body} testID="backup-last">
          {describeLast(status.lastAt)}
        </Text>
        <Text style={styles.sub}>Copies go to {status.storeUrl.replace(/^https?:\/\//, '')}.</Text>
      </View>

      {status.heldForOwner ? (
        <View style={styles.card} testID="backup-held">
          <Text style={styles.title}>Backup is waiting for you</Text>
          <Text style={styles.sub}>
            The store holds a backup this phone never restored. Dina stopped backing up so that
            backup stays your newest. Restore it, or back up now to start fresh from this phone.
          </Text>
          <Pressable
            style={[styles.primary, busy !== 'idle' && styles.disabled]}
            disabled={busy !== 'idle'}
            onPress={() => void restore()}
            accessibilityRole="button"
            testID="backup-held-restore"
          >
            <Text style={styles.primaryText}>
              {busy === 'restoring' ? 'Restoring…' : 'Restore newest backup'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <Pressable
        style={[styles.primary, busy !== 'idle' && styles.disabled]}
        disabled={busy !== 'idle'}
        onPress={() => void backUp()}
        accessibilityRole="button"
        testID="backup-now"
      >
        <Text style={styles.primaryText}>
          {busy === 'backing_up'
            ? 'Backing up…'
            : confirmFresh
              ? 'Tap again to start fresh'
              : 'Back up now'}
        </Text>
      </Pressable>

      {message !== '' && (
        <Text style={styles.notice} testID="backup-message">
          {message}
        </Text>
      )}
      {error !== '' && (
        <Text style={styles.error} testID="backup-error">
          {error}
        </Text>
      )}

      <View style={styles.card}>
        <Text style={styles.sub}>
          Deleting removes every copy from the store and turns backup off. Our own server backups
          may still hold a sealed copy until they age out; we can't open those either.
        </Text>
        <Pressable
          style={[styles.danger, busy !== 'idle' && styles.disabled]}
          disabled={busy !== 'idle'}
          onPress={() => void remove()}
          accessibilityRole="button"
          testID="backup-delete"
        >
          <Text style={styles.dangerText}>
            {busy === 'deleting'
              ? 'Deleting…'
              : confirmDelete
                ? 'Tap again to delete every copy'
                : 'Delete all backups'}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
  card: {
    backgroundColor: colors.bgSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
  title: { ...textStyles.body, color: colors.textPrimary, fontWeight: '600' },
  body: { ...textStyles.body, color: colors.textPrimary },
  sub: { ...textStyles.body, color: colors.textSecondary },
  primary: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  primaryText: { ...textStyles.body, color: colors.white, fontWeight: '600' },
  danger: {
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  dangerText: { ...textStyles.body, color: colors.error, fontWeight: '600' },
  notice: { ...textStyles.body, color: colors.textSecondary },
  error: { ...textStyles.body, color: colors.error },
  disabled: { opacity: 0.6 },
});
