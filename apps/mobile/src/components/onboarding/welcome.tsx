/**
 * Welcome — entry screen for the onboarding flow.
 *
 * Plays the brand first so the user knows what app they just opened.
 * Intentionally minimal: one hero line, one supporting paragraph, one
 * call to action.
 */

import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { OnboardingShell } from './shell';
import { colors, fonts, spacing } from '../../theme';

export interface WelcomeProps {
  onGetStarted: () => void;
}

export function Welcome(props: WelcomeProps): React.ReactElement {
  return (
    <OnboardingShell canGoBack={false} primaryLabel="Get started" onPrimary={props.onGetStarted}>
      <View style={styles.hero}>
        <Text style={styles.brand}>DINA</Text>
        <Text style={styles.headline}>Your sovereign{'\n'}personal AI</Text>
        <Text style={styles.tagline}>
          Everything stays on your device. Your data, your keys, your rules.
        </Text>
      </View>

      <View style={styles.pillars}>
        <Pillar
          glyph={'\u2726'}
          title="Remember for you"
          body="Tell Dina a fact once and she'll surface it when it matters."
        />
        <Pillar
          glyph={'\u25CF'}
          title="Private by default"
          body="Identity keys are encrypted on-device. Never leave your phone."
        />
        <Pillar
          glyph={'\u25E2'}
          title="Direct, peer to peer"
          body="Chat with the people you trust without a server in the middle."
        />
      </View>
    </OnboardingShell>
  );
}

function Pillar({
  glyph,
  title,
  body,
}: {
  glyph: string;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <View style={styles.pillar}>
      <Text style={styles.pillarGlyph}>{glyph}</Text>
      <View style={styles.pillarText}>
        <Text style={styles.pillarTitle}>{title}</Text>
        <Text style={styles.pillarBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    alignItems: 'center',
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  brand: {
    fontSize: 12,
    letterSpacing: 6,
    color: colors.textMuted,
    fontWeight: '700',
    marginBottom: spacing.lg,
  },
  headline: {
    fontFamily: Platform.OS === 'ios' ? fonts.serif : undefined,
    fontStyle: 'italic',
    fontSize: 40,
    lineHeight: 46,
    textAlign: 'center',
    color: colors.textPrimary,
    letterSpacing: -0.4,
  },
  tagline: {
    marginTop: spacing.lg,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.md,
  },
  pillars: {
    gap: spacing.lg,
    paddingHorizontal: spacing.xs,
  },
  pillar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  pillarGlyph: {
    fontSize: 16,
    color: colors.accent,
    marginTop: 2,
    width: 20,
    textAlign: 'center',
  },
  pillarText: {
    flex: 1,
  },
  pillarTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  pillarBody: {
    marginTop: 2,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },
});
