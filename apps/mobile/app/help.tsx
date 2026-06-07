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

import React, { useCallback } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { FEATURES, FeatureIcon } from '../src/features';
import { FEATURE_NAMES } from '@dina/core';
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
      'Store a fact, preference, event, or note. Dina classifies it into the right vault: health into Health, finance into Financial, everyday into General. Sensitive vaults stay locked, so a connected agent will need your approval to read them.',
    example: '"Emma\'s birthday is March 15."',
  },
  {
    icon: 'vault',
    title: 'Ask a question',
    description:
      'Dina looks in your vault first, then reaches out to PeerLens for reviewed opinions and the Dina services network for live answers. Vault search is hybrid keyword + semantic across your unlocked vaults.',
    example: '"When is Emma\'s birthday?"',
  },
];

const REMINDER_CARDS: CapabilityCard[] = [
  {
    icon: 'reminders',
    title: 'Reminders, picked up automatically',
    description:
      'When Dina is doing something for you and a reminder would help, it just adds one automatically. Since Dina also knows the context about the user, the reminder has extra context added. Emma\'s birthday is on Nov 7? On Nov 6 morning a reminder shows up with possible dinosaur toys suggested, since Dina knew from earlier that Emma loves dinosaurs.',
    example: '"Tell Sancho I\'ll be there in 15." A reminder shows up on Sancho\'s phone: Alonso coming in 15 minutes. She reminds you to get the cold brew ready. He likes it extra strong.',
  },
];

const TALK_CARDS: CapabilityCard[] = [
  {
    icon: 'talk',
    title: 'Your Dina talks to theirs',
    description:
      'Tell your Dina to reach a contact. Your Dina hands off to their Dina over an end-to-end encrypted peer-to-peer channel; no server in between. The other Dina announces the message with context from its own vault, so the recipient is prepared without having to remember anything. If a reminder would help either side, both Dinas quietly set one up.',
    example:
      '"Tell Sancho I\'ll be there in 15." Sancho\'s Dina alerts him with the context it has on you. Both Dinas set a reminder for their owners.',
  },
];

const AGENT_CARDS: CapabilityCard[] = [
  {
    icon: 'agentTasks',
    title: 'Run real work through agents',
    description:
      'Agents work with Dina in two directions. Dina can hand work to an agent (fetch new email, book the flight) and the agent executes. Or an agent acts on its own and submits its intent to Dina first, so Dina can apply your rules, approve, or ask you. Install dina-agent (pip install dina-agent) and pair it; both flows are supported.',
    example:
      'Ask Dina to email Sancho a quick note. The mail agent drafts it and sends it on your behalf.',
  },
  {
    icon: 'security',
    title: 'You approve sensitive actions',
    description:
      'Sensitive vaults (health, financial, anything you flag) stay locked by default. When a connected agent needs access or wants to take a risky action, Dina surfaces it for your approval before anything happens.',
    example:
      'Your mail agent drafts a reply to Sancho on your behalf and submits it to Dina. Dina reviews it and decides it needs your approval. An approval notification is shown in the mobile app.',
  },
];

const SERVICES_CARDS: CapabilityCard[] = [
  {
    icon: 'peerlens',
    title: `${FEATURE_NAMES.peerlens} reviews`,
    description:
      'So far everything\'s been inside Dina. PeerLens is the network on top of it. You can review anything on it. Products, restaurants, YouTube videos, books, people. All reviews are signed by their reviewers, and weighted by whether they actually paid for or used the thing. Stale opinions fade. The ranking works like PageRank: a review from someone many people trust counts more than one from a stranger. Even the query your Dina sends to PeerLens is shaped by what it knows about you, so the reviews that come back are already filtered to your context. When several answers fit, PeerLens decides which one Dina takes first.',
    example: '"Is the Calmly mattress any good?" or "Is this YouTube tutorial worth watching?" PeerLens pulls signed reviews and weights them by who said them.',
  },
  {
    icon: 'services',
    title: 'A directory of Dina services',
    description:
      'There\'s a public directory of every Public Dina Service. Each entry says what it answers, who runs it, and where. Any Dina can opt in to become a public service from its settings. When you ask Dina something, it searches the directory. Looking for a bus ETA? It finds the transit authority. Want sourdough? It finds the bakery nearby. Dina also filters the candidates by your settings (budget, location, languages), and PeerLens ranks what\'s left.',
    example:
      '"When does bus 42 reach Castro?" Dina searches the directory, finds SF Transit\'s Dina, and routes the query there.',
  },
  {
    icon: 'services',
    title: 'Behind every service, a real operator',
    description:
      'Each Dina service has a person or organisation behind it, and that person has their own Dina and their own agents. When SF Transit\'s Dina answers a bus ETA, its agent is the one doing the work. It reads from the transit database, the GPS feed, the maps. Your Dina just hands off the question; the operator\'s agent answers it.',
    example:
      'The bus driver has Dina on her phone. Her Dina has an agent reading the GPS and maps. When your Dina asks "Where\'s bus 42?", her agent answers in real time.',
  },
  {
    icon: 'identity',
    title: 'Queries shaped by your context',
    description:
      'Dina applies what it knows about you to every external query. Ask for a chair and Dina searches for one with lumbar support under $500, because it has seen your back-pain notes and your budget. Results come back already shaped to your situation.',
    example: '"Find me a chair." Dina searches for "chair with lumbar support, under $500".',
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
          accessibilityLabel="See Dina in action — replay the guided tour"
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
        <CardSection title={`${FEATURE_NAMES.services} and ${FEATURE_NAMES.peerlens}`} cards={SERVICES_CARDS} onPress={onCardPress} />
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
