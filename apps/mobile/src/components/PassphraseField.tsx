/**
 * PassphraseField — text input with built-in show/hide eye toggle.
 *
 * Shared across the onboarding passphrase step, the recovery-phrase
 * gate, the confirm-recovery gate, and the unlock-gate prompt. The
 * toggle is local to the field; nothing about the visible state
 * leaks to the caller. The caller still owns the value + onChange.
 *
 * Visual idiom: a single bordered row wrapping the TextInput on the
 * left and the eye button on the right. Border / height / radius
 * match the canonical input scale in passphrase_set; other call
 * sites that previously rolled their own input style now route
 * through here so all passphrase-shaped inputs look identical.
 */

import React, { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
  type StyleProp,
} from 'react-native';
import { colors, radius, spacing, textStyles } from '../theme';

export interface PassphraseFieldProps
  extends Omit<TextInputProps, 'secureTextEntry' | 'style'> {
  /** Optional caption rendered above the input (e.g. "PASSPHRASE"). */
  label?: string;
  /** Optional error message rendered below the input. */
  error?: string;
  /** Optional style applied to the outer wrapper. */
  style?: StyleProp<ViewStyle>;
}

export const PassphraseField = React.forwardRef<TextInput, PassphraseFieldProps>(
  function PassphraseField(
    { label, error, style, accessibilityLabel, ...inputProps },
    ref,
  ): React.ReactElement {
    const [visible, setVisible] = useState(false);
    return (
      <View style={style}>
        {label !== undefined ? <Text style={styles.label}>{label}</Text> : null}
        <View style={[styles.row, error !== undefined && error !== '' ? styles.rowError : null]}>
          <TextInput
            ref={ref}
            testID="passphrase-field-input"
            {...inputProps}
            secureTextEntry={!visible}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            textContentType="password"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            accessibilityLabel={accessibilityLabel}
          />
          <Pressable
            onPress={() => setVisible((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={visible ? 'Hide passphrase' : 'Show passphrase'}
            testID="passphrase-field-toggle"
            style={({ pressed }) => [styles.eye, pressed && styles.pressed]}
          >
            <Ionicons
              name={visible ? 'eye-off-outline' : 'eye-outline'}
              size={20}
              color={colors.textMuted}
            />
          </Pressable>
        </View>
        {error !== undefined && error !== '' ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  label: {
    ...textStyles.label,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
    paddingHorizontal: spacing.md,
  },
  rowError: {
    borderColor: colors.error,
  },
  input: {
    ...textStyles.bodyLarge,
    flex: 1,
  },
  eye: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -8,
  },
  pressed: { opacity: 0.7 },
  errorText: {
    ...textStyles.caption,
    color: colors.error,
    marginTop: 6,
  },
});
