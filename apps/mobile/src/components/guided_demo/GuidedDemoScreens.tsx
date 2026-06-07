/**
 * Guided-demo UI surfaces — presentational only (callbacks wire to the
 * controller). Copy follows docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md verbatim
 * where it specifies user-facing strings.
 *
 *   GuidedDemoEntry          — first-run "See Dina in action" / Start demo / Start empty
 *   GuidedDemoBanner         — persistent "Guided demo · N/M" tag + caption + Next
 *   GuidedDemoRecoveryPrompt — boot Continue / Delete after a crash mid-demo
 */

import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fonts, radius, spacing, textStyles } from '../../theme';

export function GuidedDemoEntry({
  onStartDemo,
  onStartEmpty,
}: {
  onStartDemo: () => void;
  onStartEmpty: () => void;
}): React.JSX.Element {
  return (
    <View testID="guided-demo-entry" style={styles.entry}>
      <Text style={styles.title}>See Dina in action</Text>
      <Text style={styles.subtitle}>
        A 3-minute guided demo using sample data. Nothing from the demo is kept.
      </Text>
      <Pressable
        testID="guided-demo-start"
        accessibilityRole="button"
        onPress={onStartDemo}
        style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>Start demo</Text>
      </Pressable>
      <Pressable
        testID="guided-demo-skip"
        accessibilityRole="button"
        onPress={onStartEmpty}
        style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
      >
        <Text style={styles.secondaryText}>Start empty</Text>
      </Pressable>
    </View>
  );
}

export function GuidedDemoBanner({
  onExit,
  onAdvance,
  caption,
  step,
  stepCount,
  demoComplete,
  actionInFlight = false,
}: {
  onExit: () => void;
  /** Run the next scripted step. Omit to render the indicator-only banner. */
  onAdvance?: () => void;
  /** Caption of the next step (shown above the Next button). */
  caption?: string | null;
  step?: number;
  stepCount?: number;
  /** True once every step has run → show "complete" instead of Next. */
  demoComplete?: boolean;
  /** True while a step is running → disable "Next" so a double-tap can't run two steps. */
  actionInFlight?: boolean;
}): React.JSX.Element {
  const showStepper = onAdvance !== undefined;
  // The banner is mounted above the app's own safe-area-padded header, so it
  // sits at the very top of the screen. Without this inset it renders UNDER the
  // status bar / Dynamic Island — hiding it and making its Exit/Next buttons
  // untappable (taps land on the system status bar). Pad by the top inset so
  // the banner + its controls clear the notch.
  const insets = useSafeAreaInsets();
  const hasProgress =
    stepCount !== undefined && stepCount > 0 && step !== undefined && step > 0;
  return (
    <View testID="guided-demo-banner" style={[styles.bannerWrap, { paddingTop: insets.top }]}>
      {/* Header: small "demo / sample data" tag on the left, Exit on the right. */}
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow} numberOfLines={1}>
          Guided demo{hasProgress ? `  ·  ${step}/${stepCount}` : ''}
        </Text>
        <Pressable
          testID="guided-demo-exit"
          accessibilityRole="button"
          accessibilityLabel="Exit guided demo"
          hitSlop={12}
          onPress={onExit}
          style={({ pressed }) => [styles.exitBtn, pressed && styles.pressed]}
        >
          <Text style={styles.exitText}>Exit</Text>
        </Pressable>
      </View>
      {showStepper && (
        <View style={styles.stepWrap}>
          {demoComplete === true ? (
            <>
              <Text testID="guided-demo-complete" style={styles.caption} numberOfLines={2}>
                Demo complete. This was sample data, nothing is kept.
              </Text>
              {/* The primary action when done is to leave — make it an obvious
                  body button, not just the small Exit link in the header. */}
              <Pressable
                testID="guided-demo-exit-cta"
                accessibilityRole="button"
                accessibilityLabel="Exit guided demo and clear the sample data"
                onPress={onExit}
                style={({ pressed }) => [styles.nextBtn, pressed && styles.pressed]}
              >
                <Text style={styles.nextText}>Exit and clear sample data</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text testID="guided-demo-caption" style={styles.caption} numberOfLines={2}>
                {caption ?? ''}
              </Text>
              {/* Compact, centred pill — clears the top-right dev-tools FAB and
                  reads as a CTA, not a full-width slab. Disabled while a step is
                  running so a double-tap can't run two steps. */}
              <Pressable
                testID="guided-demo-next"
                accessibilityRole="button"
                accessibilityLabel="Run next demo step"
                accessibilityState={{ disabled: actionInFlight }}
                disabled={actionInFlight}
                onPress={onAdvance}
                style={({ pressed }) => [
                  styles.nextBtn,
                  (pressed || actionInFlight) && styles.pressed,
                ]}
              >
                <Text style={styles.nextText}>
                  {actionInFlight ? 'Working…' : 'Next step  ›'}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

/**
 * Non-interactive surface shown WHILE a demo scope is being torn down (after
 * Exit/Delete, before the runtime scope is reset to `user`). It deliberately
 * replaces the app so the user can't write into the soon-deleted demo scope
 * during the teardown window (notably when a long `/remember` is still
 * settling). See `useGuidedDemoGate.teardown`.
 */
export function GuidedDemoTeardown(): React.JSX.Element {
  return (
    <View testID="guided-demo-tearing-down" style={styles.entry}>
      <ActivityIndicator color={colors.textSecondary} />
      <Text style={styles.teardownText}>Ending demo and clearing the sample data…</Text>
    </View>
  );
}

export function GuidedDemoRecoveryPrompt({
  onContinue,
  onDelete,
}: {
  onContinue: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  return (
    <View testID="guided-demo-recovery" style={styles.entry}>
      <Text style={styles.recoveryTitle}>You were in the guided demo.</Text>
      <Pressable
        testID="guided-demo-recovery-continue"
        accessibilityRole="button"
        onPress={onContinue}
        style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
      >
        <Text style={styles.primaryText}>Continue demo</Text>
      </Pressable>
      <Pressable
        testID="guided-demo-recovery-delete"
        accessibilityRole="button"
        onPress={onDelete}
        style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
      >
        <Text style={styles.secondaryText}>Delete demo and start empty</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  entry: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.bgPrimary,
  },
  // Hero title — the app-wide brand/heading voice (Cormorant Garamond),
  // matching the onboarding welcome / mode-choice screens this gate sits
  // alongside. NOT a hand-rolled sans weight.
  title: { ...textStyles.display, marginBottom: spacing.xs },
  subtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  // Functional recovery prompt — upright serif heading (h2), not the
  // italic display hero.
  recoveryTitle: { ...textStyles.h2 },
  teardownText: {
    ...textStyles.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  primaryBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  primaryText: { ...textStyles.button },
  secondaryBtn: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  secondaryText: { ...textStyles.button, color: colors.textPrimary },
  pressed: { opacity: 0.7 },
  bannerWrap: {
    backgroundColor: colors.warningBgSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  // Small-caps tag: "GUIDED DEMO · 7/9" — quiet, not a heading.
  eyebrow: {
    fontFamily: fonts.sansSemibold,
    fontSize: 10,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.warningTextDeep,
    flex: 1,
  },
  exitBtn: { paddingVertical: spacing.xs, paddingLeft: spacing.md },
  exitText: { fontFamily: fonts.sansSemibold, fontSize: 13, color: colors.warningTextDeepest },
  stepWrap: {
    gap: spacing.sm,
    paddingTop: 2,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  caption: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.warningTextDeep,
  },
  // Compact, centred pill (not a full-width slab) — clears the top-right
  // dev-tools FAB and reads as a CTA.
  nextBtn: {
    alignSelf: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.lg,
  },
  nextText: { fontFamily: fonts.sansSemibold, fontSize: 13, color: colors.white },
});
