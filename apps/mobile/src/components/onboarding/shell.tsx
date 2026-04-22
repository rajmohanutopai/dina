/**
 * OnboardingShell — shared chrome for every non-terminal step.
 *
 * Renders a consistent frame with:
 *   - back-arrow in the top-left (hidden on `canGoBack={false}` screens)
 *   - compact progress pill — "2 of 5 · Passphrase" — in the top-center
 *     so the user always sees how far they are
 *   - a scrollable content slot the per-step component owns
 *   - a sticky footer with the primary action button
 *
 * Every screen component passes its own title, body, and primary-button
 * label through this shell so the layout, spacing, and transitions stay
 * identical across the flow. The `onPrimary` callback runs on tap; when
 * `busy` is true the button shows a spinner and taps are ignored.
 */

import React from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { colors, fonts, radius, spacing } from '../../theme';
import type { StepLocation } from '../../onboarding/state';

export interface OnboardingShellProps {
  /** Optional hero title ("Set your passphrase"). Renders in heavy sans-serif. */
  title?: string;
  /** Optional serif-italic eyebrow rendered above the title, Dina-branded. */
  eyebrow?: string;
  /** Long-form copy under the title — 1–3 short paragraphs. */
  subtitle?: string;
  /** Position pill. Hidden when null. */
  location?: StepLocation | null;
  /** Show the back arrow? Defaults to true. Auto-hides on welcome + provisioning. */
  canGoBack?: boolean;
  onBack?: () => void;
  /** Primary-action button label. Hidden when undefined. */
  primaryLabel?: string;
  onPrimary?: () => void;
  /** Primary disabled-state (e.g. form incomplete). */
  primaryDisabled?: boolean;
  /** Primary busy-state (async action in flight). */
  primaryBusy?: boolean;
  /** Secondary link below the primary button, rendered as understated text. */
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Body content. */
  children?: React.ReactNode;
}

export function OnboardingShell(props: OnboardingShellProps): React.ReactElement {
  const showBack = (props.canGoBack ?? true) && props.onBack !== undefined;
  const showPrimary = props.primaryLabel !== undefined && props.onPrimary !== undefined;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerSide}>
          {showBack ? (
            <Pressable
              onPress={props.onBack}
              style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
              accessibilityLabel="Go back"
              hitSlop={10}
            >
              <Text style={styles.backGlyph}>{'\u2190'}</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.headerCenter}>
          {props.location !== null && props.location !== undefined ? (
            <Text style={styles.locationPill}>
              {props.location.current} of {props.location.total} · {props.location.label}
            </Text>
          ) : null}
        </View>
        <View style={styles.headerSide} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {props.eyebrow !== undefined ? <Text style={styles.eyebrow}>{props.eyebrow}</Text> : null}
        {props.title !== undefined ? <Text style={styles.title}>{props.title}</Text> : null}
        {props.subtitle !== undefined ? (
          <Text style={styles.subtitle}>{props.subtitle}</Text>
        ) : null}
        <View style={styles.body}>{props.children}</View>
      </ScrollView>

      {showPrimary ? (
        <View style={styles.footer}>
          <Pressable
            onPress={props.onPrimary}
            disabled={props.primaryDisabled === true || props.primaryBusy === true}
            style={({ pressed }) => [
              styles.primary,
              pressed && styles.pressed,
              (props.primaryDisabled === true || props.primaryBusy === true) &&
                styles.primaryDisabled,
            ]}
            accessibilityLabel={props.primaryLabel}
          >
            {props.primaryBusy === true ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryText}>{props.primaryLabel}</Text>
            )}
          </Pressable>
          {props.secondaryLabel !== undefined && props.onSecondary !== undefined ? (
            <Pressable
              onPress={props.onSecondary}
              hitSlop={8}
              style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryText}>{props.secondaryLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 56 : 24,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerSide: { width: 40 },
  headerCenter: { flex: 1, alignItems: 'center' },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  backGlyph: {
    fontSize: 22,
    color: colors.textPrimary,
  },
  locationPill: {
    fontSize: 11,
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    fontWeight: '600',
  },
  scroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  eyebrow: {
    fontSize: 13,
    letterSpacing: 3,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginBottom: spacing.md,
  },
  title: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  subtitle: {
    marginTop: spacing.md,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
  },
  body: {
    marginTop: spacing.xl,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.md,
    borderTopColor: colors.borderLight,
    borderTopWidth: 1,
    backgroundColor: colors.bgPrimary,
  },
  primary: {
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryDisabled: {
    opacity: 0.35,
  },
  primaryText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  secondary: {
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  secondaryText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '500',
  },
  pressed: { opacity: 0.7 },
  // Referenced in style array above for consistency even when unused.
  _fontsReference: { fontFamily: fonts.serif },
});
