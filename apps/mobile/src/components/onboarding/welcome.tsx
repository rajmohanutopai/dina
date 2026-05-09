/**
 * Welcome — entry screen for the onboarding flow.
 *
 * Plays the brand first so the user knows what app they just opened.
 * Intentionally minimal: one hero line, one supporting paragraph, one
 * call to action.
 */

import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { OnboardingShell } from './shell';
import { colors, fonts, spacing, radius } from '../../theme';

export interface WelcomeProps {
  onGetStarted: () => void;
}

export function Welcome(props: WelcomeProps): React.ReactElement {
  return (
    <OnboardingShell canGoBack={false} primaryLabel="Get started" onPrimary={props.onGetStarted}>
      <View style={styles.hero}>
        <Text style={styles.brand}>DINA</Text>
        <Text style={styles.headline}>Your sovereign{'\n'}personal AI</Text>
        <View style={styles.pills}>
          {['Data Security', 'Agent Tasks', 'Reminders', 'Dina-to-Dina Talk', 'Services', 'PeerLens'].map((label) => (
            <View key={label} style={styles.pill}>
              <Text style={styles.pillText}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.pillars}>
        <Pillar
          icon={<Ionicons name="finger-print" size={18} color={colors.accent} />}
          title="Sovereign Identity"
          body="One identity, with all your data, memories, and connections anchored to it."
        />
        <Pillar
          icon={<Ionicons name="lock-closed-outline" size={18} color={colors.accent} />}
          title="Private by default"
          body="All data encrypted and in your device, signed by your identity. Delete the key to delete everything, forever."
        />
        <Pillar
          icon={<Ionicons name="alarm-outline" size={18} color={colors.accent} />}
          title="Smart reminders"
          body="Dina sets reminders automatically, with context from your vault."
        />
        <Pillar
          icon={<Ionicons name="chatbubbles-outline" size={18} color={colors.accent} />}
          title="Dina-to-Dina Talk"
          body="Encrypted peer-to-peer messaging with the people you trust, without a server in the middle."
        />
        <Pillar
          icon={<MaterialCommunityIcons name="robot-outline" size={18} color={colors.accent} />}
          title="Agent Tasks"
          body="Give Dina a task and she delegates it to your connected agents."
        />
        <Pillar
          icon={<Ionicons name="shield-checkmark-outline" size={18} color={colors.accent} />}
          title="Approvals & Security"
          body="Sensitive actions from connected agents wait for your approval."
        />
        <Pillar
          icon={<Ionicons name="glasses-outline" size={18} color={colors.accent} />}
          title="PeerLens"
          body="Reviews signed by real people, used by Dina during high value decisions."
        />
        <Pillar
          icon={<Ionicons name="compass-outline" size={18} color={colors.accent} />}
          title="Services"
          body="A network of Dinas acting as service providers. Ask a question, and the right service provider answers you directly."
        />
      </View>
    </OnboardingShell>
  );
}

function Pillar({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}): React.ReactElement {
  return (
    <View style={styles.pillar}>
      <View style={styles.pillarIcon}>{icon}</View>
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
  pills: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
  },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgSecondary,
  },
  pillText: {
    fontSize: 12,
    fontFamily: fonts.sansSemibold,
    color: colors.textSecondary,
    letterSpacing: 0.2,
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
  pillarIcon: {
    width: 22,
    marginTop: 1,
    alignItems: 'center',
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
