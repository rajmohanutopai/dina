/**
 * Welcome — entry screen for the onboarding flow.
 *
 * Plays the brand first so the user knows what app they just opened.
 * Intentionally minimal: one hero line, one supporting paragraph, one
 * call to action.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { FEATURES, FeatureIcon } from '../../features';
import { colors, spacing, radius, textStyles } from '../../theme';

import { OnboardingShell } from './shell';

export interface WelcomeProps {
  onGetStarted: () => void;
}

// Match the pillars list below: 8 entries (adds Identity + Approvals
// & Security to the original 6). Keeps the hero promise honest with
// the detailed breakdown that follows so users don't feel like the
// page contradicts itself.
const PILL_FEATURES = [
  'identity',
  'vault',
  'reminders',
  'talk',
  'agentTasks',
  'security',
  'peerlens',
  'services',
] as const;

export function Welcome(props: WelcomeProps): React.ReactElement {
  return (
    <OnboardingShell canGoBack={false} primaryLabel="Get started" onPrimary={props.onGetStarted}>
      <View style={styles.hero}>
        <Text style={styles.brand}>Dina</Text>
        <Text style={styles.headline}>{'Your sovereign AI.\nYour open network.'}</Text>
        <View style={styles.pills}>
          {PILL_FEATURES.map((key) => (
            <View key={key} style={styles.pill}>
              <Text style={styles.pillText}>{FEATURES[key].pillLabel ?? FEATURES[key].name}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.pillars}>
        <Pillar
          feature="identity"
          body="One identity, with all your data, memories, and connections anchored to it."
          spec="Open AT Protocol · did:plc"
        />
        <Pillar
          feature="vault"
          title="Private by default"
          body="All your data is encrypted on your device, signed by your identity. Export or delete anytime."
        />
        <Pillar
          feature="reminders"
          title="Smart reminders"
          body="Dina sets reminders automatically, with context from your vault."
        />
        <Pillar
          feature="talk"
          body="Encrypted peer-to-peer messaging with the people you trust, without a server in the middle."
        />
        <Pillar
          feature="agentTasks"
          body="Give Dina a task and it gets delegated to your connected agents."
        />
        <Pillar
          feature="security"
          body="Sensitive actions from connected agents wait for your approval."
        />
        <Pillar
          feature="peerlens"
          title="Ranked Reviews"
          body="Reviews signed by real people, ranked by how many others trust them. Used by Dina when you search for products or services."
          spec="Open AT Protocol · AppView"
        />
        <Pillar
          feature="services"
          body="A network of Dinas acting as service providers. Ask a question, and the right service provider answers you directly. Or publish your own, answered straight from your vault or through an agent working for you."
          spec="Open AT Protocol · AppView"
        />
      </View>
    </OnboardingShell>
  );
}

function Pillar({
  feature,
  title,
  body,
  spec,
}: {
  feature: import('../../features').FeatureKey;
  /** Overrides the feature's canonical name when the welcome copy differs. */
  title?: string;
  body: string;
  /**
   * Optional "spec receipt" line — names the open-protocol artifact
   * (did:plc, AppView) ONLY on the features genuinely on AT Protocol
   * (identity, reviews, services). Substantiates the hero's "open
   * network" precisely, without the blanket "all atproto" overclaim
   * (the vault, talk, reminders, etc. are NOT atproto).
   */
  spec?: string;
}): React.ReactElement {
  return (
    <View style={styles.pillar}>
      <View style={styles.pillarIcon}>
        <FeatureIcon feature={feature} size={18} color={colors.accent} />
      </View>
      <View style={styles.pillarText}>
        <Text style={styles.pillarTitle}>{title ?? FEATURES[feature].name}</Text>
        <Text style={styles.pillarBody}>{body}</Text>
        {spec ? <Text style={styles.pillarSpec}>{spec}</Text> : null}
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
    ...textStyles.wordmark,
    marginBottom: spacing.lg,
  },
  headline: {
    ...textStyles.display,
    textAlign: 'center',
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
    ...textStyles.caption,
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
  pillarTitle: textStyles.bodyStrong,
  pillarBody: {
    ...textStyles.bodySmall,
    marginTop: 2,
    color: colors.textSecondary,
  },
  pillarSpec: {
    // Quiet "spec receipt" — mono + dimmed so it reads as a credential
    // for the curious, skippable by everyone else.
    ...textStyles.monoSmall,
    marginTop: 5,
    color: colors.textMuted,
    letterSpacing: 0.2,
  },
});
