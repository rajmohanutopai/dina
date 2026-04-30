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
import { colors, fonts, radius, shadows, spacing } from '../src/theme';

interface CapabilityCard {
  icon: string;
  title: string;
  description: string;
  /** Italic chat-bubble-style sample phrasing surfaced under the
   *  description. Optional — cards that drill-through (`href`) skip
   *  the example because the destination IS the example. */
  example?: string;
  /** When set, taps the card and routes to this expo-router path. */
  href?: string;
}

const STORAGE_CARDS: CapabilityCard[] = [
  {
    icon: '✦',
    title: 'Remember something',
    description:
      'Store a fact, preference, event, or note. Dina classifies it into the right vault — health into Health, finance into Financial, everyday into General — and sensitive vaults stay locked, so what you tell Dina there stays gated. PII is scrubbed and the entry is indexed for later search.',
    // The previous design used a chat screenshot (16:9 image) here.
    // It rendered ~540px tall — twice the height of every other
    // card on this page — which made Help feel broken before the
    // user even scrolled. Switching to the same `example` pattern
    // every other card uses brings the page into rhythm and lets
    // the user try /remember directly from the Chat tab anyway.
    example: '“Emma’s birthday is March 15.”',
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

// People → People via Dinas. The headline isn't just encrypted P2P
// (that's the channel); it's that the receiving Dina enriches the
// arriving message with context from ITS OWN vault about the sender,
// so the recipient is prepared without having to remember anything.
const PEOPLE_CARDS: CapabilityCard[] = [
  {
    icon: '✉',
    title: 'Your Dina talks to theirs',
    description:
      'Tell your Dina to inform a contact — “Tell Sancho I’ll be there in 15” — and your Dina hands off to Sancho’s Dina over an encrypted peer-to-peer channel. Sancho’s Dina notifies him AND pulls context from its own vault about you: “Alonso’s coming in 15. He loves PB&J. His mother had a fall last week — you might ask how she’s doing.” Each Dina enriches the message with what its own user would want to know.',
    example:
      '“Inform Sancho I’ll be there in 15” → Sancho’s Dina alerts him with a reminder and the context it knows about you.',
  },
];

// Working WITH agents is the primary value prop — Dina coordinates,
// agents (dina-agent installs, today reached via OpenClaw / dina-cli)
// do the real fetching/executing. The safety net (approval gate) is
// part of the agent story — agents do work, Dina holds the keys to
// risky operations — so it lives inside this section instead of
// floating as its own one-card "Safety net" group.
const AGENT_CARDS: CapabilityCard[] = [
  {
    icon: '🤖',
    title: 'Run real work through agents',
    description:
      'Agents work with Dina in two directions. Dina can hand work to an agent (e.g. OpenClaw) — “fetch new email”, “book the flight” — and the agent executes. Or an agent acts on its own and submits its intent to Dina first, so Dina can apply your rules, approve, or ask you. Install dina-agent (pip install dina-agent) and pair it; both flows are supported.',
    example:
      'dina-agent fetches your Gmail → Dina classifies new mail → reminders, contacts, and notes land in the right vault.',
  },
  {
    icon: '✓',
    title: 'You approve risky actions',
    description:
      'Sensitive vaults (health, financial, anything you flag) stay locked by default. When an agent needs to read one, Dina waits for your approval.',
  },
];

// Network capabilities — these reach OUTSIDE your local Dina. The
// previous copy described them like a web crawler ("searches the
// public network"), which made them sound interchangeable with any
// agent that hits the open web (OpenClaw, generic LLM tools). The
// distinction matters: Dina queries the operator's OWN Dina with
// a typed schema, and trust signals come from a decentralized graph
// the network maintains — neither lives on your device.
const NETWORK_CARDS: CapabilityCard[] = [
  {
    icon: '🚌',
    title: 'Direct answers from the source',
    description:
      'You can connect to external services hosted by other Dinas — bus arrivals, store hours, a clinic’s next opening. Each operator runs their own Dina that publishes the capabilities it serves through its connected agents (SF Transit publishes "eta_query", a clinic publishes "next_opening"). Your Dina finds the operator on the Dina network and sends a typed query directly to their Dina; the operator’s agent computes the answer. The reply is a structured response from the source itself.',
    example:
      '“When does bus 42 reach Castro?” → SF Transit’s Dina answers with the ETA and a map link.',
  },
  {
    icon: '❖',
    title: 'Trust signals from the network',
    description:
      'All reviews, including yours, live on a decentralized trust graph the Dina network maintains. Each review is signed by the reviewer’s identity (DID), weighted by whether they actually transacted, vouched for by their peers, and time-decayed.\n\nBecause every reviewer carries a verified reputation, and every review inherits that weight, signals in the graph are believable. Fake reviews or sponsored reviews do not move the trust score.\n\nWhen you ask Dina something, Dina goes through the Trust Network to decide for you — whether you’re picking a chair to buy, or checking whether a YouTube creator typically posts AI-generated videos.',
    example: '“Is the Calmly mattress any good?”',
  },
  {
    icon: '🎯',
    title: 'Searches that know you',
    description:
      'Dina applies what she knows about you to every external query. Ask for a chair and Dina searches for one with lumbar support under $500 — because she’s seen your back-pain notes and your budget. Doctors, restaurants, flights, products: results come back already tuned to your context.',
    example: '“Find me a chair” → Dina searches for “chair with lumbar support, under $500”.',
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
        {/* People comes after Time-aware: contact coordination is
            still about local-life primitives (events, reminders),
            just routed through someone else's Dina. */}
        <CardSection title="Coordinate with people" cards={PEOPLE_CARDS} onPress={onCardPress} />
        {/* Agents come BEFORE Beyond your Dina — the network section
            makes more sense in the context that you have agents
            doing real work for you. The approval-gate card lives
            inside Work-with-agents (it's the safety net for what
            agents do, not its own concept). */}
        <CardSection title="Work with agents" cards={AGENT_CARDS} onPress={onCardPress} />
        <CardSection title="Beyond your Dina" cards={NETWORK_CARDS} onPress={onCardPress} />
        <CardSection title="Privacy & control" cards={PRIVACY_CARDS} onPress={onCardPress} />

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Dina is a sovereign AI. The keys live on your phone — no one can read your data
            without you.
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
