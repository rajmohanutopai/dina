/**
 * ProviderPicker — the shared, presentational AI-provider row list.
 *
 * Both the onboarding "Connect your AI" step and Settings → AI Providers
 * render the same list of providers; this component owns that row's
 * structure (container, header layout, label/subtitle/badge/trailing,
 * and an optional expanded body) so the two screens stop duplicating it.
 *
 * It is deliberately behaviour-free: selection, key entry, validation,
 * active-swap, remove, the credits tile and the onboarding beat all stay
 * in the parent. The parent supplies each row's slots (subtitle/trailing/
 * expanded are arbitrary nodes) and the onPress. The only knob is the
 * visual `variant` (compact bordered row for onboarding vs shadowed card
 * for settings) — a look, not a behaviour, so this is not a god-component.
 *
 * testIDs are passed through verbatim by the parent (the Maestro flows +
 * RTL tests depend on `onboarding-ai-provider-<type>` /
 * `ai-providers-add-key-<type>`), so this refactor changes no selectors.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadows, spacing, textStyles } from '../theme';

import type { ProviderType } from '../ai/provider';
import type { ReactNode } from 'react';

export interface ProviderPickerRow {
  type: ProviderType;
  label: string;
  /** Optional secondary content under the label (description, health pill). */
  subtitle?: ReactNode;
  /** Show an ACTIVE-style badge next to the label. */
  badge?: string;
  /** Right-aligned header content (checkmark, key preview, "Add key", spinner). */
  trailing?: ReactNode;
  /** Tap handler for the header; omit to make the row non-interactive. */
  onPress?: () => void;
  /** Reflected into selected styling + a11y state (onboarding radio rows). */
  selected?: boolean;
  testID?: string;
  /** Arbitrary content rendered below the header (settings key form, models, actions). */
  expanded?: ReactNode;
}

export interface ProviderPickerProps {
  rows: ProviderPickerRow[];
  /** 'compact' = onboarding bordered rows; 'card' = settings shadowed cards. */
  variant: 'compact' | 'card';
}

export function ProviderPicker({ rows, variant }: ProviderPickerProps): React.JSX.Element {
  const isCard = variant === 'card';
  return (
    <View style={isCard ? undefined : styles.compactList}>
      {rows.map((row) => {
        const Header = row.onPress !== undefined ? Pressable : View;
        const headerProps =
          row.onPress !== undefined
            ? {
                onPress: row.onPress,
                testID: row.testID,
                accessibilityRole: 'button' as const,
                accessibilityState: { selected: row.selected ?? false },
              }
            : { testID: row.testID };

        return (
          <View
            key={row.type}
            style={isCard ? styles.card : [styles.compactRow, row.selected && styles.compactRowSelected]}
          >
            <Header style={styles.header} {...headerProps}>
              <View style={styles.info}>
                <View style={styles.labelRow}>
                  <Text
                    style={[
                      isCard ? styles.cardLabel : styles.compactLabel,
                      !isCard && row.selected ? styles.compactLabelSelected : null,
                    ]}
                  >
                    {row.label}
                  </Text>
                  {row.badge !== undefined ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{row.badge}</Text>
                    </View>
                  ) : null}
                </View>
                {row.subtitle !== undefined ? <View style={styles.subtitle}>{row.subtitle}</View> : null}
              </View>
              {row.trailing !== undefined ? <View>{row.trailing}</View> : null}
            </Header>
            {row.expanded}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // compact (onboarding)
  compactList: { gap: spacing.sm },
  compactRow: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  compactRowSelected: { borderColor: colors.accent },
  compactLabel: { ...textStyles.bodyStrong, color: colors.textPrimary },
  compactLabelSelected: { color: colors.accent },

  // card (settings)
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    ...shadows.sm,
  },
  cardLabel: textStyles.bodyLargeStrong,

  // shared
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  info: { flex: 1, marginRight: spacing.md },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subtitle: { marginTop: 2 },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  badgeText: {
    ...textStyles.caption,
    color: colors.white,
    fontSize: 10,
    letterSpacing: 0.5,
  },
});
