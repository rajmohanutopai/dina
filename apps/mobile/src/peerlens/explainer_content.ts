/**
 * "About Ranked Reviews" explainer — the long-form, human-friendly page
 * behind the reviewer dashboard's About row. It answers, in plain language:
 * what Ranked Reviews is for, what makes a review count, what builds (and
 * lowers) a reviewer's trust, how a review is created, where the feature is
 * heading, and what you control.
 *
 * User-facing name: "Ranked Reviews". The internal/brand name "PeerLens"
 * is deliberately NOT shown to users (it stays in code, lexicons, and
 * logs) — see the naming note in `apps/mobile/src/features.tsx`. A test
 * pins that no "PeerLens" string appears in this copy.
 *
 * Structure: an ordered list of titled sections. Each section has an icon
 * and either plain paragraphs, a list of icon "bullets" (a trust signal
 * with a bold lead-in), or both. The screen (`app/peerlens/about.tsx`)
 * renders this so the page reads as scannable signal rows, not a wall of
 * text. Bullet `tone` colours the icon: positive (builds trust), negative
 * (lowers it), neutral (informational).
 *
 * House copy rules: NO em-dashes; avoid "X, not Y" contrast constructions;
 * stay understated; describe what Dina does for you rather than what other
 * products do.
 *
 * Accuracy: the trust-weighting (network proximity, reviewer reputation),
 * the verified + evidence boosts, and the sybil/coordination filtering all
 * describe what the AppView scorer does today (see `appview/src/scorer/`
 * and `appview/src/config/constants.ts`). The ONLY forward-looking part is
 * "Where this is heading": Dina drafting reviews on your behalf and
 * following up over time. Keep that framed as the direction, not a shipping
 * feature.
 */

/** User-facing label. The internal brand "PeerLens" is never shown here. */
const LABEL = 'Ranked Reviews';

// ─── Public types ───────────────────────────────────────────────────────────

/** A single trust-signal row: an icon, a bold lead-in, and a short line. */
export interface ExplainerBullet {
  /** Ionicons glyph name (cast at the render site). */
  readonly icon: string;
  /** Bold lead-in. */
  readonly title: string;
  /** The explanatory line. */
  readonly text: string;
  /** Icon tone: 'positive' lifts trust, 'negative' lowers it, else neutral. */
  readonly tone?: 'positive' | 'negative' | 'neutral';
}

export interface ExplainerSection {
  /** Ionicons glyph name for the section header (cast at the render site). */
  readonly icon: string;
  /** Section heading. */
  readonly title: string;
  /** Optional plain paragraphs (rendered above any bullets). */
  readonly paragraphs?: readonly string[];
  /** Optional trust-signal rows. */
  readonly bullets?: readonly ExplainerBullet[];
}

export interface PeerLensExplainer {
  /** Navigation-bar title for the screen. */
  readonly screenTitle: string;
  /** One-line opener rendered above the sections. */
  readonly intro: string;
  /** Ordered explainer sections. */
  readonly sections: readonly ExplainerSection[];
}

// ─── Content ────────────────────────────────────────────────────────────────

/** Recursively freeze so every nested array/object is immutable. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * The exact content the "About Ranked Reviews" screen renders. Deep-frozen
 * so any accidental mutation crashes loudly instead of silently editing the
 * source of truth.
 */
export const PEERLENS_EXPLAINER: PeerLensExplainer = deepFreeze({
  screenTitle: `About ${LABEL}`,
  intro: `${LABEL} are how Dina finds trustworthy products and published services, limiting the effect of ads and sybil attacks.`,
  sections: [
    {
      icon: 'people-circle-outline',
      title: 'What makes a review count',
      paragraphs: [
        `A rating is shaped by who is doing the rating, along with the value of the score.`,
      ],
      bullets: [
        {
          icon: 'person-outline',
          tone: 'neutral',
          title: 'People you know',
          text: 'A review from one of your contacts counts more than one from a stranger.',
        },
        {
          icon: 'git-network-outline',
          tone: 'neutral',
          title: 'Their circles too',
          text: 'Dina uses the anonymous combined rating of all your contacts and their contacts to calculate the score.',
        },
        {
          icon: 'trending-up-outline',
          tone: 'neutral',
          title: 'Trusted voices rise',
          text: 'When many trusted people rate someone highly, that person becomes a trusted voice too, much like PageRank.',
        },
      ],
    },
    {
      icon: 'shield-checkmark-outline',
      title: "What builds a reviewer's trust",
      paragraphs: [`Every reviewer has a trust score.`],
      bullets: [
        {
          icon: 'checkmark-circle-outline',
          tone: 'positive',
          title: 'Verified identity',
          text: 'A Dina linked to a real person or business has a lot to lose by lying, so its reviews carry more weight.',
        },
        {
          icon: 'card-outline',
          tone: 'positive',
          title: 'Actually bought it',
          text: 'A review backed by a real purchase or receipt counts for more than one with nothing behind it.',
        },
        {
          icon: 'time-outline',
          tone: 'positive',
          title: 'History and time',
          text: 'An established account with a track record outweighs a brand new one, and older reviews gently fade so the picture stays current.',
        },
        {
          icon: 'people-outline',
          tone: 'positive',
          title: 'Vouched for',
          text: 'People you trust can vouch for others.',
        },
      ],
    },
    {
      icon: 'funnel-outline',
      title: 'What Dina filters out',
      paragraphs: [`Dina turns down the volume on anything that looks untrustworthy.`],
      bullets: [
        {
          icon: 'alert-circle-outline',
          tone: 'negative',
          title: 'Looks like a bot',
          text: 'Brand new accounts with no history carry almost no weight.',
        },
        {
          icon: 'cash-outline',
          tone: 'negative',
          title: 'Paid or coordinated reviews',
          text: 'When a burst of reviews looks bought or organised, Dina spots the pattern and discounts them.',
        },
        {
          icon: 'help-circle-outline',
          tone: 'negative',
          title: 'Never really used it',
          text: 'A glowing review from someone with no purchase or experience behind it counts for less.',
        },
      ],
    },
    {
      icon: 'create-outline',
      title: 'How a review is created',
      paragraphs: [
        `When you write a review, Dina signs it with your key and keeps it in your own personal space, which you control. You stay the owner. You can edit it or take it down later, and no one else can modify it.`,
      ],
    },
    {
      icon: 'sparkles-outline',
      title: 'Future',
      paragraphs: [
        `Today people write the reviews by hand, so you hear from the extremes (the very happy and the very unhappy). The future idea is for your Dina (all Dinas) to write them for you (with permission).`,
      ],
      bullets: [
        {
          icon: 'checkmark-done-outline',
          tone: 'neutral',
          title: 'Reviews from real life',
          text: 'You bought something and used it, so Dina can draft the review and simply ask you to approve it.',
        },
        {
          icon: 'repeat-outline',
          tone: 'neutral',
          title: 'Follow ups over time',
          text: 'Dina can check back later, for example you bought that chair six months ago, how is it holding up, so reviews reflect the long run and not just the first week.',
        },
        {
          icon: 'bar-chart-outline',
          tone: 'neutral',
          title: 'The full picture',
          text: 'With many small honest reviews, you get a more reliable sense of what something is really like.',
        },
      ],
    },
    {
      icon: 'layers-outline',
      title: 'Publishing under different pseudonyms',
      paragraphs: [
        `You can publish reviews under separate pseudonyms. They keep your reviews in separate compartments.`,
      ],
    },
    {
      icon: 'lock-closed-outline',
      title: 'You stay in control',
      paragraphs: [
        `You decide what to publish and who can see it. A review can be public, shared only with a link, or kept to the people you have already connected with. Nothing is ever posted on your behalf, and the private contents of your vault are never part of a review.`,
      ],
    },
  ],
});
