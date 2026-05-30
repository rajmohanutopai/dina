/**
 * `SafeCardRenderer` — renders a validated `CardSpec` using ONLY the fixed,
 * safe block vocabulary.
 *
 * The client half of "card as DATA, not code" (see
 * `docs/CARD_SPEC_DESIGN.md`). Replaces the old hard-coded per-capability
 * eta result body: the brain maps any provider result to a `CardSpec`, and
 * this one component draws every capability's card.
 *
 * Safety:
 *   - Renders ONLY the known block kinds; unknown kinds are skipped
 *     (forward-compat).
 *   - `link` opens via `Linking.openURL` on an explicit user tap and ALWAYS
 *     shows the real destination host (a misleading label can't hide where
 *     the tap goes). The URL was https-hardened by `validateCardSpec`; we
 *     re-check `https://` before opening.
 *   - `map` builds the maps deep-link CLIENT-SIDE from structured
 *     coords/query — the provider never supplies a URL.
 *   - `media` is NOT rendered yet (image proxy pending) — skipped, with the
 *     `alt` shown so the card still says what the image was.
 *   - `badge` only reaches here when the brain built the spec as trusted.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  linkDisplayHost,
  type CardBlock,
  type CardIcon,
  type CardSpec,
  type CardTone,
} from '@dina/protocol';

import { colors, radius, spacing, textStyles } from '../theme';

interface SafeCardRendererProps {
  spec: CardSpec;
}

/** Semantic icon → Ionicons glyph. Unknown icons fall back to a dot. */
const ICON_GLYPH: Record<CardIcon, keyof typeof Ionicons.glyphMap> = {
  transit: 'bus-outline',
  calendar: 'calendar-outline',
  price: 'pricetag-outline',
  store: 'storefront-outline',
  location: 'location-outline',
  map: 'map-outline',
  package: 'cube-outline',
  flight: 'airplane-outline',
  weather: 'partly-sunny-outline',
  food: 'restaurant-outline',
  star: 'star-outline',
  clock: 'time-outline',
  info: 'information-circle-outline',
  check: 'checkmark-circle-outline',
  warning: 'warning-outline',
  person: 'person-outline',
  document: 'document-text-outline',
  link: 'link-outline',
};

/** Tone → foreground/accent color. */
function toneColor(tone: CardTone | undefined): string {
  switch (tone) {
    case 'positive':
      return colors.success;
    case 'caution':
      return colors.warning;
    case 'critical':
      return colors.error;
    case 'info':
      return colors.core;
    case 'accent':
      return colors.accent;
    case 'neutral':
    default:
      return colors.textPrimary;
  }
}

/** Tone → soft background tint for chips/badges. */
function toneTint(tone: CardTone | undefined): string {
  switch (tone) {
    case 'positive':
      return colors.successBgSoft;
    case 'caution':
      return colors.warningBgSoft;
    case 'critical':
      return colors.errorBgSoft;
    case 'info':
      return colors.badgePairedBg;
    case 'accent':
      return colors.bgTertiary;
    case 'neutral':
    default:
      return colors.bgTertiary;
  }
}

function buildMapUrl(block: { lat?: number; lng?: number; query?: string }): string | null {
  if (typeof block.lat === 'number' && typeof block.lng === 'number') {
    return `https://www.google.com/maps/search/?api=1&query=${block.lat},${block.lng}`;
  }
  if (block.query !== undefined && block.query.length > 0) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(block.query)}`;
  }
  return null;
}

function openSafe(url: string): void {
  if (/^https:\/\//i.test(url)) {
    void Linking.openURL(url).catch(() => {
      /* opening is best-effort */
    });
  }
}

/** A short "as of …" / source line from the card's staleness fields. */
function staleLabel(spec: CardSpec): string | null {
  if (spec.sourceLabel !== undefined) return spec.sourceLabel;
  if (spec.generatedAt !== undefined) {
    const t = Date.parse(spec.generatedAt);
    if (!Number.isNaN(t)) {
      const d = new Date(t);
      const hh = d.getHours() % 12 || 12;
      const mm = d.getMinutes().toString().padStart(2, '0');
      const ap = d.getHours() < 12 ? 'AM' : 'PM';
      return `as of ${hh}:${mm} ${ap}`;
    }
  }
  return null;
}

export function SafeCardRenderer({ spec }: SafeCardRendererProps): React.JSX.Element {
  const stale = staleLabel(spec);
  return (
    <View style={styles.container}>
      {spec.blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
      {stale !== null && <Text style={styles.staleLabel}>{stale}</Text>}
    </View>
  );
}

function BlockView({ block }: { block: CardBlock }): React.JSX.Element | null {
  switch (block.kind) {
    case 'title':
      return (
        <View style={styles.titleRow}>
          {block.icon !== undefined && (
            <Ionicons
              name={ICON_GLYPH[block.icon] ?? 'ellipse'}
              size={20}
              color={toneColor(block.tone)}
              style={styles.titleIcon}
            />
          )}
          <Text style={[styles.title, block.tone !== undefined && { color: toneColor(block.tone) }]}>
            {block.text}
          </Text>
        </View>
      );

    case 'section':
      return <Text style={styles.section}>{block.label.toUpperCase()}</Text>;

    case 'divider':
      return <View style={styles.divider} />;

    case 'stat':
      return (
        <View style={styles.statRow}>
          <Text style={[styles.statValue, { color: toneColor(block.tone) }]}>{block.value}</Text>
          {block.unit !== undefined && <Text style={styles.statUnit}>{block.unit}</Text>}
          {block.caption !== undefined && <Text style={styles.statCaption}>{block.caption}</Text>}
        </View>
      );

    case 'keyValue':
      return (
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>{block.label}</Text>
          <Text style={[styles.kvValue, block.tone !== undefined && { color: toneColor(block.tone) }]}>
            {block.value}
          </Text>
        </View>
      );

    case 'body':
      return <Text style={styles.body}>{block.text}</Text>;

    case 'badge':
      return (
        <View style={styles.badgeRow}>
          <View style={[styles.badge, { backgroundColor: toneTint(block.tone) }]}>
            <Text style={[styles.badgeText, { color: toneColor(block.tone) }]}>{block.text}</Text>
          </View>
        </View>
      );

    case 'bar':
      return (
        <View style={styles.barBlock}>
          {(block.label !== undefined || block.valueLabel !== undefined) && (
            <View style={styles.barHeader}>
              {block.label !== undefined && <Text style={styles.barLabel}>{block.label}</Text>}
              {block.valueLabel !== undefined && (
                <Text style={[styles.barValue, { color: toneColor(block.tone) }]}>{block.valueLabel}</Text>
              )}
            </View>
          )}
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.round(block.ratio * 100)}%`, backgroundColor: toneColor(block.tone) },
              ]}
            />
          </View>
        </View>
      );

    case 'rating':
      return (
        <View style={styles.ratingRow}>
          <Stars value={block.value} color={toneColor(block.tone)} />
          <Text style={styles.ratingValue}>{block.value.toFixed(1)}</Text>
          {block.count !== undefined && <Text style={styles.ratingCount}>({block.count})</Text>}
        </View>
      );

    case 'chips':
      return (
        <View style={styles.chipsRow}>
          {block.items.map((chip, i) => (
            <View key={i} style={[styles.chip, { backgroundColor: toneTint(chip.tone) }]}>
              <Text style={[styles.chipText, { color: toneColor(chip.tone) }]}>{chip.text}</Text>
            </View>
          ))}
        </View>
      );

    case 'list':
      return (
        <View style={styles.list}>
          {block.rows.map((row, i) => (
            <View key={i} style={styles.listRow}>
              <View style={styles.listMain}>
                <Text style={styles.listText}>{row.text}</Text>
                {row.sub !== undefined && <Text style={styles.listSub}>{row.sub}</Text>}
              </View>
              {row.trailing !== undefined && (
                <Text style={[styles.listTrailing, row.tone !== undefined && { color: toneColor(row.tone) }]}>
                  {row.trailing}
                </Text>
              )}
            </View>
          ))}
        </View>
      );

    case 'timeline':
      return (
        <View style={styles.timeline}>
          {block.steps.map((step, i) => {
            const done = step.state === 'done';
            const active = step.state === 'active';
            const dotColor = done ? colors.success : active ? colors.accent : colors.border;
            return (
              <View key={i} style={styles.timelineStep}>
                <View style={styles.timelineDotCol}>
                  <View style={[styles.timelineDot, { backgroundColor: dotColor }]} />
                  {i < block.steps.length - 1 && <View style={styles.timelineLine} />}
                </View>
                <Text
                  style={[
                    styles.timelineLabel,
                    active && styles.timelineLabelActive,
                    !done && !active && styles.timelineLabelUpcoming,
                  ]}
                >
                  {step.label}
                </Text>
              </View>
            );
          })}
        </View>
      );

    case 'map': {
      const url = buildMapUrl(block);
      if (url === null) return null;
      return (
        <TouchableOpacity style={styles.mapButton} onPress={() => openSafe(url)} accessibilityRole="button">
          <Ionicons name="map-outline" size={16} color={colors.white} />
          <Text style={styles.mapButtonText}>{block.label}</Text>
        </TouchableOpacity>
      );
    }

    case 'link': {
      const host = linkDisplayHost(block.url);
      return (
        <TouchableOpacity style={styles.linkButton} onPress={() => openSafe(block.url)} accessibilityRole="link">
          <View style={styles.linkTextCol}>
            <Text style={styles.linkLabel}>{block.label}</Text>
            {host !== '' && <Text style={styles.linkHost}>{host}</Text>}
          </View>
          <Ionicons name="open-outline" size={16} color={colors.accent} />
        </TouchableOpacity>
      );
    }

    case 'media':
      // Render deferred until the Dina image proxy exists. Show the alt text.
      return <Text style={styles.mediaAlt}>🖼 {block.alt}</Text>;

    default:
      return null; // unknown kind — forward-compat
  }
}

function Stars({ value, color }: { value: number; color: string }): React.JSX.Element {
  const stars: React.JSX.Element[] = [];
  for (let i = 0; i < 5; i++) {
    const name = value >= i + 1 ? 'star' : value >= i + 0.5 ? 'star-half' : 'star-outline';
    stars.push(<Ionicons key={i} name={name} size={16} color={color} />);
  }
  return <View style={styles.stars}>{stars}</View>;
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  titleIcon: {
    marginRight: spacing.xs,
  },
  title: {
    ...textStyles.bodyStrong,
    flexShrink: 1,
  },
  section: {
    ...textStyles.label,
    marginTop: spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
  },
  statValue: {
    ...textStyles.h2,
  },
  statUnit: {
    ...textStyles.bodyLarge,
    color: colors.textSecondary,
    marginLeft: spacing.xs,
  },
  statCaption: {
    ...textStyles.bodyLarge,
    color: colors.textSecondary,
    marginLeft: spacing.sm,
  },
  kvRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  kvLabel: {
    ...textStyles.bodySmall,
    color: colors.textMuted,
  },
  kvValue: {
    ...textStyles.bodySmallStrong,
    flexShrink: 1,
    textAlign: 'right',
  },
  body: {
    ...textStyles.body,
    color: colors.textSecondary,
  },
  badgeRow: {
    flexDirection: 'row',
  },
  badge: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  badgeText: {
    ...textStyles.bodySmallStrong,
  },
  barBlock: {
    gap: 2,
  },
  barHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  barLabel: {
    ...textStyles.bodySmall,
    color: colors.textSecondary,
  },
  barValue: {
    ...textStyles.bodySmallStrong,
  },
  barTrack: {
    height: 6,
    borderRadius: radius.full,
    backgroundColor: colors.bgTertiary,
    overflow: 'hidden',
  },
  barFill: {
    height: 6,
    borderRadius: radius.full,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  stars: {
    flexDirection: 'row',
  },
  ratingValue: {
    ...textStyles.bodyStrong,
  },
  ratingCount: {
    ...textStyles.caption,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: {
    ...textStyles.bodySmall,
  },
  list: {
    gap: spacing.xs,
  },
  listRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  listMain: {
    flexShrink: 1,
  },
  listText: {
    ...textStyles.body,
  },
  listSub: {
    ...textStyles.caption,
  },
  listTrailing: {
    ...textStyles.bodyStrong,
    color: colors.textSecondary,
  },
  timeline: {
    marginTop: spacing.xs,
  },
  timelineStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  timelineDotCol: {
    alignItems: 'center',
    marginRight: spacing.sm,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: radius.full,
    marginTop: 4,
  },
  timelineLine: {
    width: 2,
    flex: 1,
    minHeight: 16,
    backgroundColor: colors.border,
    marginTop: 2,
  },
  timelineLabel: {
    ...textStyles.body,
    paddingBottom: spacing.sm,
  },
  timelineLabelActive: {
    ...textStyles.bodyStrong,
    color: colors.accent,
    paddingBottom: spacing.sm,
  },
  timelineLabelUpcoming: {
    color: colors.textMuted,
  },
  mapButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  mapButtonText: {
    ...textStyles.buttonSmall,
    color: colors.white,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  linkTextCol: {
    flexShrink: 1,
  },
  linkLabel: {
    ...textStyles.bodyStrong,
  },
  linkHost: {
    ...textStyles.caption,
  },
  mediaAlt: {
    ...textStyles.caption,
    fontStyle: 'italic',
  },
  staleLabel: {
    ...textStyles.caption,
    marginTop: spacing.xs,
  },
});
