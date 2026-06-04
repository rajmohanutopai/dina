/**
 * Dina Design System — warm, elegant, minimal.
 *
 * Colour palette sourced from dina.html visualization.
 * Typography: system fonts matching Figtree / Plus Jakarta Sans feel.
 */

import { Platform } from 'react-native';

export const colors = {
  // Backgrounds
  bgPrimary: '#FAF8F5',
  bgSecondary: '#FFFFFF',
  bgTertiary: '#F0EDE8',
  bgCard: '#FFFFFF',

  // Text
  textPrimary: '#1C1917',
  textSecondary: '#57534E',
  textMuted: '#A8A29E',

  // Accent (dark, elegant)
  accent: '#1C1917',
  accentHover: '#44403C',

  // Border
  border: 'rgba(0,0,0,0.07)',
  borderLight: 'rgba(0,0,0,0.04)',

  // System colours (for layer indicators)
  core: '#2563EB',
  brain: '#059669',
  pds: '#7C3AED',
  llama: '#D97706',

  // Semantic — line / icon / accent
  success: '#059669',
  warning: '#D97706',
  error: '#DC2626',

  // Semantic — soft backgrounds (banners, badges, error panels)
  successBgSoft: '#ECFDF5',
  warningBgSoft: '#FFF4DB',
  errorBgSoft: '#FEF2F2',
  errorBgSofter: '#FDE8E8',

  // Semantic — deep text (foreground on a soft-bg banner)
  successTextDeep: '#065F46',
  warningTextDeep: '#8A5A00',
  warningTextDeepest: '#5A3A00',
  warningTextMid: '#92400E',
  errorTextDeep: '#991B1B',
  errorTextDeepest: '#7A1F1F',

  // Risk-band palette (policy / approvals)
  riskLow: '#059669',
  riskMed: '#D97706',
  riskHigh: '#DC2626',
  riskAdmin: '#7C3AED',

  // Status badges (people: paired / suggested)
  badgePairedBg: '#E6F0FE',
  badgePairedText: '#1F5BB8',
  badgeSuggestedBg: '#FFF4D6',
  badgeSuggestedText: '#8A6300',

  // Chat bubbles
  userBubble: '#1C1917',
  userBubbleText: '#FFFFFF',
  dinaBubble: '#F0EDE8',
  dinaBubbleText: '#1C1917',
  systemBubble: '#FAF8F5',

  // Tab bar
  tabActive: '#1C1917',
  tabInactive: '#A8A29E',

  // White for overlays
  white: '#FFFFFF',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  full: 9999,
} as const;

/**
 * Typography matches the dinakernel.com brand system. Loaded via
 * `useFonts` in `app/_layout.tsx` so the names below resolve to
 * registered font families at runtime; styles that ship before the
 * font finishes loading fall back to the platform's system font.
 *
 *   - sans  → Figtree (body copy, inputs, lists)
 *   - heading → Plus Jakarta Sans (titles, labels, navbar)
 *   - display → Cormorant Garamond italic (hero / quotes only)
 *   - mono → JetBrains Mono (DIDs, hashes, code)
 *
 * Always pair `fontFamily` with the matching weight name so RN
 * picks the right registered face — e.g. `Figtree_500Medium`.
 * `fontWeight` alone won't synthesize a weight on RN.
 */
export const fonts = {
  sans: 'Figtree_400Regular',
  sansMedium: 'Figtree_500Medium',
  sansSemibold: 'Figtree_600SemiBold',

  heading: 'PlusJakartaSans_600SemiBold',
  headingBold: 'PlusJakartaSans_700Bold',
  headingExtraBold: 'PlusJakartaSans_800ExtraBold',

  display: 'CormorantGaramond_600SemiBold_Italic',
  // Upright serif — same Cormorant Garamond face, no italic. Used for
  // functional step titles where italic reads as decorative; hero
  // copy keeps the italic `display`.
  displayUpright: 'CormorantGaramond_600SemiBold',
  // `serif` is the legacy name for the display face. Existing call
  // sites (hero copy in onboarding, admin glyphs, unlock-gate
  // tagline) read this; the dinakernel.com site uses Cormorant
  // Garamond italic for the same role, so the name swap is
  // intentional — not a back-compat shim.
  serif: 'CormorantGaramond_600SemiBold_Italic',

  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

/**
 * Shared text styles for screen-level headings, eyebrows, and body copy.
 *
 * Spread these into `StyleSheet.create` objects and add
 * context-specific overrides (fontSize, textAlign, marginTop, …):
 *
 *   headline: { ...textStyles.screenHeadline, fontSize: 36 },
 *
 * This keeps the display font, colour, and letter-spacing consistent
 * across welcome, help, unlock_gate, and any future informational
 * screen without repeating the Platform.OS conditional.
 */
import type { TextStyle } from 'react-native';

/**
 * Canonical type scale — the ONLY place fontFamily / fontSize /
 * fontWeight / lineHeight / letterSpacing should be declared for
 * text in the mobile app. Components spread a named token, not raw
 * numbers:
 *
 *     <Text style={textStyles.h2}>Set your passphrase</Text>
 *     <Text style={[textStyles.body, { color: colors.textMuted }]}>…</Text>
 *
 * Add a new entry here only when a genuinely new ROLE appears
 * (e.g. a new functional surface), not when a new size appears.
 * If you find yourself reaching for an inline `fontSize: 17` to nudge
 * a heading, the type scale is wrong — fix it here.
 *
 * Colour is intentionally NOT baked into the styles (except where it
 * is semantically inseparable like the muted `eyebrow`/`caption`).
 * Callers add `color: colors.X` at the use site so the same scale
 * works for primary, secondary, and muted surfaces.
 */
export const textStyles = {
  // ─── Display: Cormorant Garamond italic ─────────────────────────
  // Brand-continuation only — welcome / choose / splash. Hero copy.
  // Don't use on task-focused functional screens; those want h1/h2.
  display: {
    fontFamily: fonts.display,
    fontSize: 40,
    lineHeight: 48,
    color: colors.textPrimary,
    letterSpacing: -0.4,
  } as TextStyle,
  displaySmall: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 40,
    color: colors.textPrimary,
    letterSpacing: -0.4,
  } as TextStyle,
  // Brand tagline — Cormorant italic at a secondary scale. Used as a
  // smaller echo of the display face (e.g. "Your sovereign personal
  // AI" above the chat greeting) so the brand statement carries
  // through without out-shouting an actionable heading.
  tagline: {
    fontFamily: fonts.display,
    fontSize: 18,
    lineHeight: 24,
    color: colors.textSecondary,
    letterSpacing: -0.2,
  } as TextStyle,

  // Brand logotype — the spaced small-caps "D I N A" wordmark. This is
  // the ONE way to render "DINA" as a LOGO/brand mark (chat header,
  // welcome, unlock). It is NOT for "Dina" as a noun/verb in running
  // copy. The domino-D glyph is reserved for the app icon alone — never
  // inline. Use the `<DinaWordmark>` component rather than re-deriving
  // this style at each site.
  wordmark: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 6,
    color: colors.textMuted,
    textTransform: 'uppercase' as TextStyle['textTransform'],
  } as TextStyle,

  // ─── Headlines: Cormorant Garamond SemiBold (upright serif) ─────
  // The app-wide heading voice — every screen/section title. Upright
  // (not italic) so functional titles read crisply; the italic
  // `display`/`displaySmall`/`tagline` faces stay reserved for hero
  // and brand lines. letterSpacing is near-zero: serif faces don't
  // want the negative tracking a bold sans needs at these sizes.
  h1: {
    fontFamily: fonts.displayUpright,
    fontSize: 32,
    lineHeight: 38,
    color: colors.textPrimary,
    letterSpacing: -0.2,
  } as TextStyle,
  h2: {
    fontFamily: fonts.displayUpright,
    fontSize: 28,
    lineHeight: 34,
    color: colors.textPrimary,
    letterSpacing: -0.1,
  } as TextStyle,
  h3: {
    fontFamily: fonts.displayUpright,
    fontSize: 24,
    lineHeight: 30,
    color: colors.textPrimary,
    letterSpacing: 0,
  } as TextStyle,

  // ─── Body: Figtree 400/500/600 ──────────────────────────────────
  bodyLarge: {
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 24,
    color: colors.textPrimary,
  } as TextStyle,
  body: {
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textPrimary,
  } as TextStyle,
  bodySmall: {
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
  } as TextStyle,
  // Emphasised variants (same metrics, semibold weight)
  bodyLargeStrong: {
    fontFamily: fonts.sansSemibold,
    fontSize: 16,
    lineHeight: 24,
    color: colors.textPrimary,
  } as TextStyle,
  bodyStrong: {
    fontFamily: fonts.sansSemibold,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textPrimary,
  } as TextStyle,
  bodySmallStrong: {
    fontFamily: fonts.sansSemibold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
  } as TextStyle,

  // ─── Functional roles ───────────────────────────────────────────
  // Small-caps eyebrow above a headline ("DINA", "STEP 2 OF 5").
  eyebrow: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 3,
    color: colors.textMuted,
    textTransform: 'uppercase' as TextStyle['textTransform'],
  } as TextStyle,
  // Form-label / section-divider style.
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1,
    color: colors.textSecondary,
    textTransform: 'uppercase' as TextStyle['textTransform'],
  } as TextStyle,
  // Helper text below an input, timestamp, footnote.
  caption: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textMuted,
  } as TextStyle,
  // The smallest readable text — chat-bubble timestamps, micro-meta.
  // Use sparingly; sits below iOS's recommended minimum so reserve
  // it for non-essential affordances the user can ignore.
  tiny: {
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 14,
    color: colors.textMuted,
  } as TextStyle,
  // Primary CTA button text.
  button: {
    fontFamily: fonts.sansSemibold,
    fontSize: 16,
    lineHeight: 20,
    letterSpacing: 0.2,
    color: colors.white,
  } as TextStyle,
  buttonSmall: {
    fontFamily: fonts.sansSemibold,
    fontSize: 14,
    lineHeight: 18,
    color: colors.white,
  } as TextStyle,
  // Inline tappable secondary link text.
  link: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  } as TextStyle,
  // Monospace — DIDs, hashes, codes, raw values.
  mono: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textPrimary,
  } as TextStyle,
  monoSmall: {
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 14,
    color: colors.textMuted,
  } as TextStyle,
} as const;

/**
 * Native nav-bar title. 17pt is the platform HIG default; isolated from
 * `textStyles` because Expo Router's `headerTitleStyle` expects a
 * narrower TextStyle subset (`color: string`, not `ColorValue`).
 */
export const navTitle: {
  fontFamily: string;
  fontSize: number;
  fontWeight: '600';
  color: string;
} = {
  fontFamily: fonts.displayUpright,
  fontSize: 23,
  fontWeight: '600',
  color: colors.textPrimary,
};

export const shadows = {
  sm: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 6,
    },
    android: { elevation: 1 },
    default: {},
  }),
  md: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.07,
      shadowRadius: 16,
    },
    android: { elevation: 3 },
    default: {},
  }),
  lg: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 28,
    },
    android: { elevation: 6 },
    default: {},
  }),
} as const;
