/**
 * DinaWordmark — the canonical "D I N A" brand logotype.
 *
 * Renders the spaced small-caps wordmark used everywhere Dina shows its
 * name as a LOGO: the chat header, the onboarding welcome, the unlock
 * gate. This is the single source of truth for the brand mark — do not
 * hand-roll the spaced-caps style at call sites.
 *
 * NOT for "Dina" as a noun/verb in running copy (those stay sentence
 * case in the normal text styles). And the domino-D glyph is the APP
 * ICON only — it is never rendered inline as a logo.
 */

import React from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';

import { textStyles } from '../theme';

export function DinaWordmark({
  style,
}: {
  /** Optional per-site override (e.g. a larger size or different color). */
  style?: StyleProp<TextStyle>;
}): React.ReactElement {
  return (
    <Text
      style={[styles.wordmark, style]}
      accessibilityRole="header"
      accessibilityLabel="Dina"
      allowFontScaling={false}
    >
      DINA
    </Text>
  );
}

const styles = StyleSheet.create({
  wordmark: textStyles.wordmark,
});
