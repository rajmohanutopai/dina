/**
 * Help — card-based "what can Dina do?" screen.
 *
 * Replaces the prior `/help` chat command, which surfaced a plain-text
 * list of slash commands (`/remember`, `/ask`, …). On iPhone the user
 * never types a slash command — interaction is tap-driven via the
 * action cards on the empty-state chat tab. This screen explains the
 * same capabilities in mobile-native terms (cards + concrete examples)
 * and links to the relevant settings drill-downs.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { FEATURE_NAMES } from '@dina/core';

import { FEATURES, FeatureIcon } from '../src/features';
import { requestGuidedDemoReplay } from '../src/guided_demo/replay_request';
import { colors, fonts, radius, shadows, spacing, textStyles } from '../src/theme';

interface CapabilityCard {
  icon: import('../src/features').FeatureKey;
  title: string;
  description: string;
  /** Italic chat-bubble-style sample phrasing surfaced under the
   *  description. Optional — cards that drill-through (`href`) skip
   *  the example because the destination IS the example. */
  example?: string;
  /** When set, taps the card and routes to this expo-router path. */
  href?: string;
}

const VAULT_CARDS: CapabilityCard[] = [
  {
    icon: 'identity',
    title: 'Remember something',
    description:
      'Store a fact, preference, or event. Dina files it into the right vault (Health, Financial, General) and keeps sensitive ones locked.',
    example: '"Emma\'s birthday is March 15."',
  },
  {
    icon: 'vault',
    title: 'Ask a question',
    description:
      'Dina answers from your vault first, then reaches out to reviews and the services network when it needs more.',
    example: '"When is Emma\'s birthday?"',
  },
];

const REMINDER_CARDS: CapabilityCard[] = [
  {
    icon: 'reminders',
    title: 'Reminders, set automatically',
    description:
      'Mention a date and Dina sets the reminder for you, enriched with what it already knows instead of a bare alarm.',
    example: '"Emma\'s birthday is Nov 7." The day before, Dina reminds you and suggests a dinosaur gift, because it knows she loves them.',
  },
];

const TALK_CARDS: CapabilityCard[] = [
  {
    icon: 'talk',
    title: 'Your Dina talks to theirs',
    description:
      'Message a contact and your Dina hands off to theirs over an encrypted peer-to-peer channel, no server in between. Their Dina adds context from its own vault, so the recipient is ready.',
    example:
      '"Tell Sancho I\'ll be there in 15." His Dina alerts him with context, and both set a reminder.',
  },
];

const AGENT_CARDS: CapabilityCard[] = [
  {
    icon: 'agentTasks',
    title: 'Run real work through agents',
    description:
      'Hand work to a connected agent (fetch email, book a flight), or let an agent act and submit its intent to Dina first. Install dina-agent and pair it.',
    example:
      'Ask Dina to email Sancho a quick note. The mail agent drafts it and sends it on your behalf.',
  },
  {
    icon: 'security',
    title: 'You approve sensitive actions',
    description:
      'When an agent wants a locked vault or a risky action, Dina asks you first. Nothing happens without your approval.',
    example:
      'Your mail agent drafts a reply and submits it. Dina decides it needs your approval before sending.',
  },
];

const SERVICES_CARDS: CapabilityCard[] = [
  {
    icon: 'peerlens',
    title: 'Ranked Reviews',
    description:
      'Reviews of anything (products, places, videos, people) signed by real reviewers and ranked by trust, not ad spend. A review from someone many people trust counts more. You can publish your own reviews too, so others benefit.',
    example: '"Is the Calmly mattress any good?" Dina pulls signed reviews and weights them by who said them.',
  },
  {
    icon: 'services',
    title: 'A directory of Dina services',
    description:
      'A public directory of Dina services. Ask Dina anything and it finds the right one (transit for a bus ETA, the bakery for sourdough), filtered by your settings.',
    example:
      '"When does bus 42 reach Castro?" Dina finds SF Transit\'s Dina and routes the query there.',
  },
  {
    icon: 'identity',
    title: 'Queries shaped by your context',
    description:
      'Dina shapes every external query with what it knows about you, so results come back fit to your situation.',
    example: '"Find me a chair." Dina searches for "chair with lumbar support, under $500".',
  },
];

const PROVIDER_CARDS: CapabilityCard[] = [
  {
    icon: 'services',
    title: 'Publish from your vault',
    description:
      'Offer a service answered straight from your vault. A phone and a sentence, no business account, no server.',
    example:
      'A salon answers "free after 4?" from the owner\'s own notes, and books only after they tap Approve.',
  },
  {
    icon: 'agentTasks',
    title: 'Back it with an agent',
    description:
      'For live data, connect an agent. It does the work; you stay in control with approvals.',
    example: 'A transit service answers bus ETAs from a live GPS agent.',
  },
];

const PRIVACY_CARDS: CapabilityCard[] = [
  {
    icon: 'vault',
    title: 'Your data stays on this device',
    description:
      'Vault is encrypted with keys derived from your passphrase. The Dina network sees only what you explicitly publish, never your raw notes.',
  },
  {
    icon: 'settings',
    title: 'Admin and diagnostics',
    description:
      'See your DID, runtime warnings, sign out, or erase everything on this device.',
    href: '/admin',
  },
];

export default function HelpScreen(): React.ReactElement {
  const router = useRouter();

  const onCardPress = useCallback(
    (card: CapabilityCard) => {
      if (card.href !== undefined)
        router.push({ pathname: card.href, params: { from: '/help' } } as never);
    },
    [router],
  );

  // "See Dina in action" — relaunch the guided demo on demand. The gate (at the
  // root layout) listens for the request and starts an isolated demo scope; we
  // navigate to Chat so the demo dock is visible over the composer. The demo's
  // sample data is torn down on Exit, leaving the real vault untouched.
  const onReplayDemo = useCallback(() => {
    requestGuidedDemoReplay();
    router.navigate('/');
  }, [router]);

  return (
    <>
      <Stack.Screen options={{ title: 'Help', headerShown: true }} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.heroEyebrow}>HELP</Text>
          <Text style={styles.heroTitle}>What can Dina do?</Text>
          <Text style={styles.heroSubtitle}>
            Tap an action card on the chat screen, or type naturally. Dina figures out what you
            want.
          </Text>
        </View>

        <Pressable
          onPress={onReplayDemo}
          testID="help-replay-demo"
          accessibilityRole="button"
          accessibilityLabel="See Dina in action. Replay the guided tour"
          style={({ pressed }) => [styles.demoCta, pressed && styles.cardPressed]}
        >
          {/* The Dina app icon (domino-D glyph) as a small rounded-square
              badge — "meet Dina". (The wider brand rule reserves the domino-D
              for the app icon; reusing it here is an intentional exception for
              the "see Dina in action" CTA.) */}
          <Image
            source={require('../assets/branding/dina-icon.png')}
            style={styles.demoCtaIcon}
            resizeMode="cover"
            accessible={false}
          />
          <View style={styles.demoCtaText}>
            <Text style={styles.demoCtaTitle}>See Dina in action</Text>
            <Text style={styles.demoCtaDesc}>
              Replay the 2-minute guided tour with sample data. Your real vault stays untouched.
            </Text>
          </View>
          <Text style={styles.demoCtaArrow}>{'›'}</Text>
        </Pressable>

        <CardSection title="Your vault" cards={VAULT_CARDS} onPress={onCardPress} />
        <CardSection title="Reminders" cards={REMINDER_CARDS} onPress={onCardPress} />
        <CardSection title={FEATURE_NAMES.talk} cards={TALK_CARDS} onPress={onCardPress} />
        <CardSection title={FEATURE_NAMES.agentTasks} cards={AGENT_CARDS} onPress={onCardPress} />
        <CardSection title={`${FEATURE_NAMES.services} and Ranked Reviews`} cards={SERVICES_CARDS} onPress={onCardPress} />
        <CardSection title="Offer your own service" cards={PROVIDER_CARDS} onPress={onCardPress} />
        <CardSection title="Privacy and control" cards={PRIVACY_CARDS} onPress={onCardPress} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Dina is a sovereign AI. The keys live on your phone. One identity, all your data
            anchored to it.
          </Text>
        </View>
      </ScrollView>
    </>
  );
}

function CardSection({
  title,
  cards,
  onPress,
}: {
  title: string;
  cards: CapabilityCard[];
  onPress: (card: CapabilityCard) => void;
}): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
      {cards.map((card) => (
        <Pressable
          key={card.title}
          onPress={() => onPress(card)}
          disabled={card.href === undefined}
          testID={`help-card-${card.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.card,
            card.href !== undefined && styles.cardLinkable,
            pressed && card.href !== undefined && styles.cardPressed,
          ]}
        >
          <View style={styles.cardHeader}>
            <View style={styles.iconBubble}>
              <FeatureIcon feature={card.icon} size={18} color={colors.accent} />
            </View>
            <Text style={styles.cardTitle}>{card.title}</Text>
            {card.href !== undefined ? <Text style={styles.cardArrow}>{'›'}</Text> : null}
          </View>
          <Text style={styles.cardDesc}>{card.description}</Text>
          {card.example !== undefined ? (
            <View style={styles.exampleBox}>
              <Text style={styles.exampleText}>{card.example}</Text>
            </View>
          ) : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
  },
  content: {
    paddingBottom: spacing.xl,
  },
  hero: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  heroEyebrow: textStyles.eyebrow,
  heroTitle: {
    ...textStyles.displaySmall,
    marginTop: spacing.xs,
  },
  heroSubtitle: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  // "See Dina in action" CTA — a prominent accent banner above the cards.
  demoCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgCard,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    ...shadows.sm,
  },
  demoCtaIcon: {
    width: 38,
    height: 38,
    // Squircle-ish corner so the app icon reads as an app icon inline.
    borderRadius: 9,
  },
  demoCtaText: { flex: 1 },
  demoCtaTitle: textStyles.bodyStrong,
  demoCtaDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: 2,
  },
  demoCtaArrow: {
    ...textStyles.h2,
    color: colors.textMuted,
  },
  section: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    ...textStyles.eyebrow,
    letterSpacing: 1.5,
    marginBottom: spacing.sm,
    paddingLeft: 4,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    ...shadows.sm,
  },
  // Linkable cards get a left-edge accent stripe so a glance
  // distinguishes "this card opens something" from "this card is
  // explanatory text". The chevron alone was too subtle.
  cardLinkable: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingLeft: spacing.md - 3, // keep content alignment despite border
  },
  cardPressed: { opacity: 0.7 },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconBubble: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.bgTertiary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    ...textStyles.bodyStrong,
    flex: 1,
  },
  cardArrow: {
    ...textStyles.h2,
    color: colors.textMuted,
    paddingLeft: spacing.xs,
  },
  cardDesc: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    marginTop: spacing.sm,
  },
  exampleBox: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
  },
  exampleText: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
    fontStyle: 'italic',
  },
  footer: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  footerText: {
    ...textStyles.caption,
    fontStyle: 'italic',
  },
});
