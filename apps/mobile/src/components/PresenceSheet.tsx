/**
 * The "confirm it's you" sheet (WEB_OWNER_SURFACE_PLAN §3.8).
 *
 * Core asks a person to prove they are here before the powerful owner
 * actions: spending, staff authority, pairing, plugin consent and the money
 * cards. Every screen that can hit such a refusal shows this one sheet, driven
 * by `usePresenceGate`. A failed proof is said here, inside the sheet, not in
 * an alert (RN-Web's alerts do nothing).
 */

import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radius, spacing, textStyles } from '../theme';

export interface PresenceSheetProps {
  visible: boolean;
  /** An owner proves presence with the passphrase; a staff phone with its PIN. */
  secretKind: 'passphrase' | 'pin';
  secret: string;
  onChangeSecret: (secret: string) => void;
  /** Why this action asks, in the screen's words. */
  reason?: string;
  /** Why the last proof failed, if it did. */
  error: string | null;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}

export function PresenceSheet(props: PresenceSheetProps): React.ReactElement {
  const pin = props.secretKind === 'pin';
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card} testID="presence-sheet">
          <Text style={styles.title}>Confirm it’s you</Text>
          <Text style={styles.hint}>
            {props.reason ??
              (pin
                ? 'Enter your staff PIN to go on.'
                : 'This needs a person here, so Dina asks for your passphrase.')}
          </Text>
          <TextInput
            testID="presence-passphrase"
            style={styles.input}
            secureTextEntry
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={pin ? 'number-pad' : 'default'}
            placeholder={pin ? 'Your PIN' : 'Your passphrase'}
            placeholderTextColor={colors.textSecondary}
            value={props.secret}
            onChangeText={props.onChangeSecret}
            onSubmitEditing={props.onSubmit}
          />
          {props.error !== null && (
            <Text style={styles.error} testID="presence-error">
              {props.error}
            </Text>
          )}
          <View style={styles.actions}>
            <Pressable testID="presence-cancel" onPress={props.onCancel} disabled={props.busy}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="presence-submit"
              onPress={props.onSubmit}
              disabled={props.busy || props.secret.trim() === ''}
            >
              {props.busy ? (
                <ActivityIndicator color={colors.core} />
              ) : (
                <Text style={[styles.link, props.secret.trim() === '' && styles.disabled]}>
                  Verify
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg },
  title: {
    ...textStyles.caption,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  hint: { ...textStyles.caption, color: colors.textSecondary, marginBottom: spacing.md },
  // The card is white, so the field takes a tinted ground and a hairline
  // edge; white on white left it invisible.
  input: {
    backgroundColor: colors.bgTertiary,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    color: colors.textPrimary,
    ...textStyles.body,
  },
  error: { ...textStyles.caption, color: colors.error, marginTop: spacing.sm },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  link: { ...textStyles.body, color: colors.core },
  disabled: { opacity: 0.4 },
});
