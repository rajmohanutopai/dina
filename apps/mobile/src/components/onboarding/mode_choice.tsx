/**
 * ModeChoice — second screen. User picks create-new vs recover-existing.
 *
 * Two big cards, stacked vertically, each with a glyph + title + blurb.
 * No "Continue" button; tapping a card advances.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { OnboardingShell } from './shell';
import { colors, radius, shadows, spacing } from '../../theme';

export interface ModeChoiceProps {
  onCreate: () => void;
  onRecover: () => void;
  onBack: () => void;
}

export function ModeChoice(props: ModeChoiceProps): React.ReactElement {
  return (
    <OnboardingShell
      title="Let's get your Dina set up"
      subtitle="New to Dina? Start fresh. Coming back? Restore from your 24-word recovery phrase."
      onBack={props.onBack}
    >
      <ChoiceCard
        glyph={'\u002B'}
        title="Create a new Dina"
        body="Generate a fresh identity, new recovery phrase, new vault."
        onPress={props.onCreate}
      />
      <View style={styles.spacer} />
      <ChoiceCard
        glyph={'\u21BA'}
        title="Restore from recovery phrase"
        body="I already have a 24-word phrase from a previous Dina install."
        onPress={props.onRecover}
      />
    </OnboardingShell>
  );
}

function ChoiceCard({
  glyph,
  title,
  body,
  onPress,
}: {
  glyph: string;
  title: string;
  body: string;
  onPress: () => void;
}): React.ReactElement {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      accessibilityLabel={title}
    >
      <View style={styles.cardGlyph}>
        <Text style={styles.cardGlyphText}>{glyph}</Text>
      </View>
      <View style={styles.cardText}>
        <Text style={styles.cardTitle}>{title}</Text>
        <Text style={styles.cardBody}>{body}</Text>
      </View>
      <Text style={styles.cardArrow}>{'\u2192'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadows.sm,
  },
  spacer: { height: spacing.md },
  cardGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardGlyphText: {
    fontSize: 20,
    color: colors.accent,
    fontWeight: '500',
  },
  cardText: { flex: 1 },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.textPrimary,
    letterSpacing: -0.1,
  },
  cardBody: {
    marginTop: 2,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
  },
  cardArrow: {
    fontSize: 18,
    color: colors.textMuted,
  },
  pressed: { opacity: 0.7 },
});
