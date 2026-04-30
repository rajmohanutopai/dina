/**
 * First-run modal — Trust Network landing dialog (TN-MOB-022 / Plan §13.5).
 *
 * Renders the one-shot orientation modal that surfaces on the user's
 * first visit to the Trust tab. Per Plan §13.5 the modal explains:
 *
 *   1. What the trust scores mean (network-derived, not opaque).
 *   2. What pseudonymous namespaces give the user (compartmentalisation).
 *   3. The honest pseudonymity caveat (DID document is correlatable;
 *      a sophisticated observer can de-anonymise).
 *
 * The copy lives in `FIRST_RUN_MODAL_COPY` (frozen at module load) so
 * a future i18n bundle lifts it cleanly. This component is purely the
 * RENDERER — the dismissal-flag persistence (`isFirstRunModalDismissed`,
 * `markFirstRunModalDismissed`) lives in the data layer.
 *
 * Why a presentational shell over the persisted flag:
 *   - The screen-level wrapper subscribes to the dismissal flag at
 *     mount, decides whether to render the modal, and on dismissal
 *     fires `onDismiss` which the wrapper translates into a
 *     `markFirstRunModalDismissed()` call. This file knows nothing
 *     about keystore I/O.
 *   - Visual modals are notoriously hard to test under jest; keeping
 *     this layer purely-renderered means tests can assert the modal
 *     children without an animated overlay.
 *
 * `visible=false` renders `null` — the host can mount this component
 * unconditionally and toggle visibility via the prop without
 * unmount-thrash. `visible=true` renders the dialog backdrop + body.
 *
 * **Honest scope decision**: this component does NOT animate in /
 * out. RN's `Modal` primitive has its own animation; if the host
 * wraps this component in a `Modal`, animation lands for free.
 * Layering animation here would couple to a specific screen's
 * navigation pattern — the V1 cohort sees this exactly once per
 * device, so the animation polish is deferrable to a follow-up.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from 'react-native';

import { colors, fonts, spacing, radius } from '../../theme';
import { FIRST_RUN_MODAL_COPY } from '../first_run';

export interface FirstRunModalViewProps {
  /**
   * Render-gate. `false` returns `null` so the host can mount this
   * unconditionally; `true` renders the dialog. Driven by the
   * persisted dismissal flag (`isFirstRunModalDismissed`).
   */
  visible: boolean;
  /** Fired when the user taps the dismiss CTA. */
  onDismiss?: () => void;
}

export function FirstRunModalView(
  props: FirstRunModalViewProps,
): React.ReactElement | null {
  if (!props.visible) return null;

  const { title, body, dismissLabel } = FIRST_RUN_MODAL_COPY;
  return (
    <View style={styles.backdrop} testID="first-run-modal-backdrop">
      <View style={styles.card} testID="first-run-modal">
        <View style={styles.header}>
          <Ionicons name="shield-checkmark" size={36} color={colors.accent} />
          <Text style={styles.title}>{title}</Text>
        </View>
        <View style={styles.bodyStack}>
          {body.map((paragraph, idx) => (
            <Text
              key={idx}
              style={styles.bodyText}
              testID={`first-run-modal-body-${idx}`}
            >
              {paragraph}
            </Text>
          ))}
        </View>
        <Pressable
          onPress={props.onDismiss}
          style={({ pressed }) => [
            styles.dismissBtn,
            pressed && styles.dismissBtnPressed,
          ]}
          testID="first-run-modal-dismiss"
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
        >
          <Text style={styles.dismissLabel}>{dismissLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    maxWidth: 480,
    width: '100%',
  },
  header: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    fontFamily: fonts.heading,
    fontSize: 20,
    color: colors.textPrimary,
  },
  bodyStack: { gap: spacing.md },
  bodyText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  dismissBtn: {
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: 48,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  dismissBtnPressed: { backgroundColor: colors.accentHover },
  dismissLabel: {
    fontFamily: fonts.headingBold,
    fontSize: 15,
    color: colors.bgSecondary,
  },
});
