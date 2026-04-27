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
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { colors, fonts, radius, shadows, spacing } from '../src/theme';

interface CapabilityCard {
  icon: string;
  title: string;
  description: string;
  /**
   * Visual example — shown above the description when present. Renders
   * as a 16:9 `<Image>` with rounded corners. Falls back to the text
   * `example` below when not set so a half-screenshotted help screen
   * still ships cleanly.
   */
  screenshot?: ImageSourcePropType;
  /**
   * Text fallback example (italic chat-bubble look). Always rendered
   * when set AND `screenshot` is not — the two are mutually exclusive
   * by intent: one card has either a real screenshot OR a phrasing
   * example, never both.
   */
  example?: string;
  /** When set, taps the card and routes to this expo-router path. */
  href?: string;
}

const STORAGE_CARDS: CapabilityCard[] = [
  {
    icon: '✦',
    title: 'Remember something',
    description:
      'Store a fact, preference, event, or note. Dina classifies it into the right vault, scrubs PII, and indexes it for later search.',
    screenshot: require('../assets/help/remember_confirmation.png'),
  },
  {
    icon: '?',
    title: 'Ask a question',
    description:
      'Search across everything you’ve stored. Dina runs hybrid keyword + semantic search across your unlocked personas and answers from your own data.',
    example: '“When is Emma’s birthday?”',
  },
];

const TIME_CARDS: CapabilityCard[] = [
  {
    icon: '⏰',
    title: 'Reminders that just work',
    description:
      'Mention a date or time and Dina sets a reminder. When it fires you’ll get a card right in your chat with Snooze and Mark-done buttons.',
    example: '“Pay rent on the 1st.”',
  },
  {
    icon: '✉',
    title: 'Notifications, three tiers',
    description:
      'Fiduciary (silence would harm you) interrupts. Solicited (you asked) lands in the shade. Engagement (background) batches into a briefing — never a spammy push.',
  },
];

const SERVICES_CARDS: CapabilityCard[] = [
  {
    icon: '🚌',
    title: 'Ask the world, through Dina',
    description:
      'Some questions live outside your vault — bus arrivals, store hours, a clinic’s next opening. Dina searches the public Dina network for a service that can answer, fills in the right parameters from your question, and brings the structured reply back as a card.',
    example:
      '“When does bus 42 reach Castro?” → Dina finds the SF Transit service, asks it, replies with the ETA and a map link.',
  },
];

const SAFETY_CARDS: CapabilityCard[] = [
  {
    icon: '✓',
    title: 'You approve risky actions',
    description:
      'Agents can ask Dina for permission before sending money, sharing data, or running anything sensitive. You see the request as a card and tap Approve or Deny.',
  },
  {
    icon: '❖',
    title: 'Trust before you buy',
    description:
      'Ask about a product, vendor, or doctor — Dina checks the Trust Network for verified peer reviews instead of ads.',
    example: '“Is the Calmly mattress any good?”',
  },
];

const PRIVACY_CARDS: CapabilityCard[] = [
  {
    icon: '···',
    title: 'Your data stays on this device',
    description:
      'Vault is encrypted with keys derived from your passphrase. The Dina network sees only what you explicitly publish — never your raw notes.',
  },
  {
    icon: '✎',
    title: 'Manage paired devices',
    description:
      'Pair openclaw, dina-cli, or another phone via an 8-character code. Revoke any device anytime.',
    href: '/paired-devices',
  },
  {
    icon: '☰',
    title: 'Admin & diagnostics',
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

        <CardSection title="Your data" cards={STORAGE_CARDS} onPress={onCardPress} />
        <CardSection title="Time-aware" cards={TIME_CARDS} onPress={onCardPress} />
        <CardSection title="Beyond your data" cards={SERVICES_CARDS} onPress={onCardPress} />
        <CardSection title="Safety net" cards={SAFETY_CARDS} onPress={onCardPress} />
        <CardSection title="Privacy & control" cards={PRIVACY_CARDS} onPress={onCardPress} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Dina is a sovereign AI. The keys live on your phone — no one, including Anthropic, can
            read your data without you.
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
              <Text style={styles.iconText}>{card.icon}</Text>
            </View>
            <Text style={styles.cardTitle}>{card.title}</Text>
            {card.href !== undefined ? <Text style={styles.cardArrow}>{'›'}</Text> : null}
          </View>
          {card.screenshot !== undefined ? (
            <Image
              source={card.screenshot}
              style={styles.screenshot}
              resizeMode="cover"
              accessibilityIgnoresInvertColors
            />
          ) : null}
          <Text style={styles.cardDesc}>{card.description}</Text>
          {card.screenshot === undefined && card.example !== undefined ? (
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
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 2.4,
    color: colors.textMuted,
  },
  heroTitle: {
    fontFamily: fonts.serif,
    fontStyle: 'italic',
    marginTop: spacing.xs,
    fontSize: 30,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  heroSubtitle: {
    fontFamily: fonts.sans,
    marginTop: spacing.sm,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
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
  iconText: {
    fontFamily: fonts.sansSemibold,
    fontSize: 16,
    color: colors.accent,
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
  screenshot: {
    marginTop: spacing.sm,
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.sm,
    backgroundColor: colors.bgTertiary,
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
