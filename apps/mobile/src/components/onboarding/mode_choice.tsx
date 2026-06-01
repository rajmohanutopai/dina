/**
 * ModeChoice — second screen. User picks create-new vs recover-existing.
 *
 * Two big cards, stacked vertically, each with a glyph + title + blurb.
 * No "Continue" button; tapping a card advances.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { OnboardingShell } from './shell';
import { colors, radius, shadows, spacing, textStyles } from '../../theme';

export interface ModeChoiceProps {
  onCreate: () => void;
  onRecover: () => void;
  onExternalAtproto: () => void;
  onBack: () => void;
}

export function ModeChoice(props: ModeChoiceProps): React.ReactElement {
  return (
    <OnboardingShell onBack={props.onBack}>
      {/* Brand-continuation headline — matches the Welcome screen's
          serif-italic display face so the visual identity carries
          from Welcome → Choose without a typography jump. */}
      <Text style={styles.headline}>Welcome to Dina</Text>
      <Text style={styles.subtitle}>
        Start fresh, connect an AT Protocol account you already own, or restore from your
        recovery phrase.
      </Text>
      <ChoiceCard
        glyph={'\u002B'}
        title="Create a new Dina"
        body="Generate a fresh identity, new recovery phrase, new vault on this device."
        onPress={props.onCreate}
      />
      <View style={styles.spacer} />
      <ChoiceCard
        glyph={'@'}
        title="Use existing AT Protocol identity"
        body="Connect a Bluesky or custom PDS account you already own."
        onPress={props.onExternalAtproto}
      />
      <View style={styles.spacer} />
      <ChoiceCard
        glyph={'\u21BA'}
        title="Restore from recovery phrase"
        body="Restore your identity on this device. Saved memories stay on your old device's vault."
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
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${body}`}
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
  headline: {
    ...textStyles.display,
    marginBottom: spacing.md,
  },
  subtitle: {
    ...textStyles.body,
    color: colors.textSecondary,
    marginBottom: spacing.xl,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.md,
    minHeight: 112,
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
    ...textStyles.h3,
    color: colors.accent,
  },
  cardText: { flex: 1 },
  cardTitle: textStyles.bodyStrong,
  cardBody: {
    ...textStyles.bodySmall,
    marginTop: 2,
    color: colors.textSecondary,
  },
  cardArrow: {
    ...textStyles.h3,
    color: colors.textMuted,
  },
  pressed: { opacity: 0.7 },
});
