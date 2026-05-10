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
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { FEATURES, FeatureIcon } from '../src/features';
import { FEATURE_NAMES } from '@dina/core';
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
      'Store a fact, preference, event, or note. Dina classifies it into the right vault — health into Health, finance into Financial, everyday into General. Sensitive vaults stay locked, so what you tell Dina there stays gated. PII is scrubbed and the entry is indexed for later search.',
    example: '"Emma\'s birthday is March 15."',
  },
  {
    icon: 'vault',
    title: 'Ask a question',
    description:
      'Search across everything you\'ve stored. Dina runs hybrid keyword and semantic search across your unlocked vaults and answers from your own data.',
    example: '"When is Emma\'s birthday?"',
  },
];

const REMINDER_CARDS: CapabilityCard[] = [
  {
    icon: 'reminders',
    title: 'Reminders that just work',
    description:
      'Mention a date or time and Dina sets a reminder automatically, with context pulled from your vault. When it fires you\'ll get a card in your chat with Snooze and Mark-done buttons.',
    example: '"Pay rent on the 1st."',
  },
  {
    icon: 'notifications',
    title: 'Notifications, three tiers',
    description:
      'Fiduciary (silence would harm you) interrupts immediately. Solicited (you asked) lands in the notification shade. Engagement (background) batches into a briefing — no spammy pushes.',
  },
];

const TALK_CARDS: CapabilityCard[] = [
  {
    icon: 'talk',
    title: 'Your Dina talks to theirs',
    description:
      'Tell your Dina to inform a contact and your Dina hands off to their Dina over an encrypted peer-to-peer channel. Their Dina notifies them AND pulls context from its own vault about you, so they\'re prepared without having to remember anything. Each Dina enriches the message with what its own user would want to know.',
    example:
      '"Inform Sancho I\'ll be there in 15" — Sancho\'s Dina alerts him with a reminder and the context it knows about you.',
  },
];

const AGENT_CARDS: CapabilityCard[] = [
  {
    icon: 'agentTasks',
    title: 'Run real work through agents',
    description:
      'Agents work with Dina in two directions. Dina can hand work to an agent — "fetch new email", "book the flight" — and the agent executes. Or an agent acts on its own and submits its intent to Dina first, so Dina can apply your rules, approve, or ask you. Install dina-agent (pip install dina-agent) and pair it; both flows are supported.',
    example:
      'dina-agent fetches your Gmail. Dina classifies new mail. Reminders, contacts, and notes land in the right vault.',
  },
  {
    icon: 'security',
    title: 'You approve sensitive actions',
    description:
      'Sensitive vaults (health, financial, anything you flag) stay locked by default. When a connected agent needs access or wants to take a risky action, Dina surfaces it for your approval before anything happens.',
  },
];

const SERVICES_CARDS: CapabilityCard[] = [
  {
    icon: 'services',
    title: 'Direct answers from the source',
    description:
      'A network of Dinas acting as service providers. Your Dina finds the right provider and sends a typed query directly to their Dina. The provider\'s agent computes the answer and sends it back. No central platform, no middleman.',
    example:
      '"When does bus 42 reach Castro?" — SF Transit\'s Dina answers with the ETA and a map link.',
  },
  {
    icon: 'peerlens',
    title: `${FEATURE_NAMES.peerlens} reviews`,
    description:
      'All reviews live in PeerLens. Each review is signed by the reviewer\'s identity, weighted by whether they actually transacted, vouched for by peers, and time-decayed. Used by Dina during high value decisions — picking a product, choosing a service, evaluating a creator.',
    example: '"Is the Calmly mattress any good?"',
  },
  {
    icon: 'identity',
    title: 'Queries shaped by your context',
    description:
      'Dina applies what she knows about you to every external query. Ask for a chair and Dina searches for one with lumbar support under $500 — because she\'s seen your back-pain notes and your budget. Results come back already shaped to your situation.',
    example: '"Find me a chair" — Dina searches for "chair with lumbar support, under $500".',
  },
];

const PRIVACY_CARDS: CapabilityCard[] = [
  {
    icon: 'vault',
    title: 'Your data stays on this device',
    description:
      'Vault is encrypted with keys derived from your passphrase. The Dina network sees only what you explicitly publish — never your raw notes.',
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
      if (card.href !== undefined) router.push(card.href);
    },
    [router],
  );

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

        <CardSection title="Your vault" cards={VAULT_CARDS} onPress={onCardPress} />
        <CardSection title="Reminders" cards={REMINDER_CARDS} onPress={onCardPress} />
        <CardSection title={FEATURE_NAMES.talk} cards={TALK_CARDS} onPress={onCardPress} />
        <CardSection title={FEATURE_NAMES.agentTasks} cards={AGENT_CARDS} onPress={onCardPress} />
        <CardSection title={`${FEATURE_NAMES.services} and ${FEATURE_NAMES.peerlens}`} cards={SERVICES_CARDS} onPress={onCardPress} />
        <CardSection title="Privacy and control" cards={PRIVACY_CARDS} onPress={onCardPress} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Dina is a sovereign AI. The keys live on your phone — one identity, all your data
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
  heroEyebrow: {
    ...textStyles.screenEyebrow,
  },
  heroTitle: {
    ...textStyles.screenHeadline,
    marginTop: spacing.xs,
    fontSize: 30,
    lineHeight: 38,
  },
  heroSubtitle: {
    ...textStyles.screenBody,
    marginTop: spacing.sm,
    fontSize: 14,
    lineHeight: 20,
  },
  section: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  sectionTitle: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
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
  cardLinkable: {},
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
    flex: 1,
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    color: colors.textPrimary,
  },
  cardArrow: {
    fontFamily: fonts.sans,
    fontSize: 22,
    color: colors.textMuted,
    paddingLeft: spacing.xs,
  },
  cardDesc: {
    fontFamily: fonts.sans,
    marginTop: spacing.sm,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textSecondary,
  },
  exampleBox: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
  },
  exampleText: {
    fontFamily: fonts.sans,
    fontStyle: 'italic',
    fontSize: 13,
    color: colors.textSecondary,
  },
  footer: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  footerText: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
