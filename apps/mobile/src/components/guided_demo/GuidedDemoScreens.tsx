/**
 * Guided-demo UI surfaces — presentational only (callbacks wire to the
 * controller). Copy follows docs/GUIDED_DEMO_DATA_SCOPE_DESIGN.md verbatim
 * where it specifies user-facing strings.
 *
 *   GuidedDemoEntry          — first-run "See Dina in action" / Start demo / Start empty
 *   GuidedDemoBanner         — bottom dock (over the composer): caption + Next + Exit
 *   GuidedDemoRecoveryPrompt — boot Continue / Delete after a crash mid-demo
 */

import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fonts, radius, spacing, textStyles } from '../../theme';

/** Bottom padding for the dock — just enough to clear the home indicator. The
 *  dock is anchored to the screen bottom and its opaque background still covers
 *  the (taller) tab-bar zone behind it, so the tab bar stays non-tappable. We no
 *  longer reserve the FULL tab-bar height — that left a tall empty band below the
 *  buttons. iOS home-indicator ≈ 34; Android gesture area ≈ 16. */
const DOCK_BOTTOM_PAD = Platform.OS === 'ios' ? 34 : 16;

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
        A quick guided tour with sample data. Your real data stays untouched.
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
  nextMode,
  nextLabel,
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
  /**
   * Composer mode this step exercises. When set, the advance button is styled +
   * labelled like the real composer chip ("Remember" / "Ask") so the user learns
   * the affordance ("to remember, tap Remember"). Undefined for steps with no
   * composer analog (approval / publish) → a generic "Next step" button.
   */
  nextMode?: 'remember' | 'ask';
  /** Explicit advance-button label (navigate steps: "Show me" / "Back to chat").
   *  Overrides the mode-derived label; rendered as a generic (non-chip) button. */
  nextLabel?: string;
}): React.JSX.Element {
  const showStepper = onAdvance !== undefined;
  // Collapse toggle — lets a screen recording shrink the dock to a thin bar
  // (chevron + advance + Exit) so the caption block doesn't eat the lower
  // third of the frame. Persists across steps (the banner stays mounted for
  // the whole demo). Defaults expanded so first-run users still get the copy.
  const [collapsed, setCollapsed] = useState(false);
  // Compact dock pinned just ABOVE the tab bar, OVER the composer (Ask/Remember)
  // so those can't be tapped mid-demo. It only covers the composer (not the tab
  // bar), keeping the top of the screen + most of the chat visible. `insets`
  // unused for bottom now (we sit above the tab bar) but kept for the notch-free
  // contract.
  const hasProgress =
    stepCount !== undefined && stepCount > 0 && step !== undefined && step > 0;
  // Show the running count on every actionable step (incl. the last, e.g. 10/10);
  // only the COMPLETE state drops the number for "End Demo".
  const eyebrowSuffix =
    demoComplete === true
      ? '  ·  End Demo'
      : hasProgress
        ? `  ·  ${step}/${stepCount}`
        : '';
  // Chip-styled (Remember/Ask) only for composer steps; navigate/approval/
  // publish use a generic button (with an explicit label when provided).
  const composerStyle = nextMode !== undefined;
  const advanceLabel = actionInFlight
    ? 'Working…'
    : nextLabel !== undefined
      ? nextLabel
      : nextMode === 'remember'
        ? 'Remember'
        : nextMode === 'ask'
          ? 'Ask'
          : 'Next step  ›';
  // The advance button (Remember / Ask / Next step ›). Shared so it can sit in
  // the expanded action row OR, when collapsed, inline in the thin header bar.
  const advanceButton = (
    <Pressable
      testID="guided-demo-next"
      accessibilityRole="button"
      accessibilityLabel={`Run next demo step${composerStyle ? `: ${advanceLabel}` : ''}`}
      accessibilityState={{ disabled: actionInFlight }}
      disabled={actionInFlight}
      onPress={onAdvance}
      style={({ pressed }) => [
        composerStyle ? styles.chipBtn : styles.nextBtn,
        (pressed || actionInFlight) && styles.pressed,
      ]}
    >
      <Text style={composerStyle ? styles.chipText : styles.nextText}>{advanceLabel}</Text>
    </Pressable>
  );
  // The terminal "End Demo" button — same dual placement as advanceButton.
  const endDemoButton = (
    <Pressable
      testID="guided-demo-exit-cta"
      accessibilityRole="button"
      accessibilityLabel="End the demo and clear the sample data"
      onPress={onExit}
      style={({ pressed }) => [styles.nextBtn, pressed && styles.pressed]}
    >
      <Text style={styles.nextText}>End Demo</Text>
    </Pressable>
  );
  const primaryButton = demoComplete === true ? endDemoButton : advanceButton;

  return (
    <View testID="guided-demo-banner" style={styles.dock}>
      {/* Header row: chevron toggle + "Guided demo · N/M" tag + (collapsed:
          inline advance/End button) + Exit. Collapsed drops the step count to
          stay as quiet as possible. */}
      <View style={styles.dockHeaderRow}>
        {showStepper && (
          <Pressable
            testID="guided-demo-collapse"
            accessibilityRole="button"
            accessibilityLabel={
              collapsed ? 'Expand guided demo controls' : 'Collapse guided demo controls'
            }
            hitSlop={12}
            onPress={() => setCollapsed((c) => !c)}
            style={({ pressed }) => [styles.chevronBtn, pressed && styles.pressed]}
          >
            {/* ▴ = tap to expand (collapsed); ▾ = tap to collapse (expanded). */}
            <Text style={styles.chevronText}>{collapsed ? '▴' : '▾'}</Text>
          </Pressable>
        )}
        <Text style={styles.eyebrow} numberOfLines={1}>
          Guided demo{collapsed ? '' : eyebrowSuffix}
        </Text>
        {collapsed && showStepper && <View style={styles.collapsedAction}>{primaryButton}</View>}
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
      {!collapsed &&
        showStepper &&
        (demoComplete === true ? (
          <View style={styles.actionRow}>
            <Text
              testID="guided-demo-complete"
              style={[styles.caption, styles.captionFlex]}
              numberOfLines={2}
            >
              All done. Welcome to Dina.
            </Text>
            {endDemoButton}
          </View>
        ) : (
          <>
            {/* Up to 6 lines: the PeerLens / service-network / D2D captions are
                two-to-three-sentence explanations. The dock grows upward into the
                chat area (which has room), pushing the Next row down. */}
            <Text testID="guided-demo-caption" style={styles.caption} numberOfLines={6}>
              {caption ?? ''}
            </Text>
            {/* "Next step" hint (left) points at the advance button (right). When
                the step maps to a composer mode the button is styled + labelled
                like the real Remember/Ask chip, so the user learns to tap that
                affordance. Disabled while a step runs (no double-fire). */}
            <View style={styles.actionRow}>
              <Text style={styles.nextHint}>{composerStyle ? 'Next step' : ''}</Text>
              {advanceButton}
            </View>
          </>
        ))}
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
  // Bottom dock pinned to the very bottom (bottom:0), covering BOTH the composer
  // (Ask/Remember) AND the tab bar so neither is tappable mid-demo — only the
  // demo control is interactive. The CONTENT stays compact at the top (3 short
  // rows landing over the composer). The opaque background still covers the
  // tab-bar zone behind it (so the tabs stay non-tappable), but we only pad the
  // bottom enough to clear the home indicator — reserving the full tab-bar
  // height left a tall empty band below the buttons.
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.warningBgSoft,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    paddingBottom: DOCK_BOTTOM_PAD,
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
  },
  dockHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  // Collapse/expand chevron — sits left of the eyebrow in the header row.
  chevronBtn: { paddingVertical: spacing.xs, paddingRight: spacing.sm },
  chevronText: { fontFamily: fonts.sansSemibold, fontSize: 13, color: colors.warningTextDeepest },
  // Wrapper around the advance/End button when it rides inline in the collapsed
  // thin bar, so it keeps a little breathing room from the Exit control.
  collapsedAction: { marginLeft: spacing.sm },
  caption: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.warningTextDeep,
  },
  captionFlex: { flex: 1, marginRight: spacing.sm },
  // "Next step" hint (left) + advance button (right).
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  nextHint: { fontFamily: fonts.sansSemibold, fontSize: 13, color: colors.warningTextDeep },
  // Advance button styled like the composer's Remember/Ask chip — a light
  // bordered pill on white — so the user learns the real affordance.
  chipBtn: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
  },
  chipText: { ...textStyles.link },
  // Generic advance / exit button (steps with no composer analog).
  nextBtn: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.full,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  nextText: { fontFamily: fonts.sansSemibold, fontSize: 14, color: colors.white },
});
