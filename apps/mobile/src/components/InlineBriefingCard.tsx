/**
 * `InlineBriefingCard` — chat-thread inline renderer for the Tier-3
 * daily-briefing aggregate (5.63). Defensive: the briefing producer
 * lives in `apps/home-node-lite/core-server/src/brain/briefing_*` —
 * it isn't yet wired mobile-side, so this component renders against a
 * shape it will eventually receive.
 *
 * Expected metadata:
 *   {
 *     kind: 'briefing',
 *     briefingId: string,
 *     periodStart: number,    // ms
 *     periodEnd: number,
 *     sections: Array<{
 *       title: string,
 *       items: Array<{ id: string, label: string, deepLink?: string }>
 *     }>
 *   }
 *
 * Initial state: collapsed (header + section count). Tap to expand
 * and see each section's items. Tapping an item with a `deepLink`
 * routes via expo-router; without one it stays inert. Falls through
 * to a plain `system`-style bubble if the metadata is missing or
 * malformed — never throws.
 */

import React, { useCallback, useState } from 'react';
import { Text, TouchableOpacity, View, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { ChatMessage } from '@dina/brain/src/chat/thread';
import { colors, fonts, radius, spacing } from '../theme';
import { MessageTimestamp } from './MessageTimestamp';

export interface InlineBriefingCardProps {
  message: ChatMessage;
}

interface BriefingItem {
  id: string;
  label: string;
  deepLink?: string;
}

interface BriefingSection {
  title: string;
  items: BriefingItem[];
}

interface BriefingMetadata {
  kind: 'briefing';
  briefingId: string;
  periodStart: number;
  periodEnd: number;
  sections: BriefingSection[];
}

function readMetadata(m: ChatMessage): BriefingMetadata | null {
  const md = m.metadata;
  if (!md || md.kind !== 'briefing') return null;
  if (typeof md.briefingId !== 'string' || md.briefingId === '') return null;
  if (!Array.isArray(md.sections)) return null;
  const sections: BriefingSection[] = [];
  for (const raw of md.sections) {
    if (typeof raw !== 'object' || raw === null) continue;
    const s = raw as { title?: unknown; items?: unknown };
    if (typeof s.title !== 'string' || !Array.isArray(s.items)) continue;
    const items: BriefingItem[] = [];
    for (const ri of s.items) {
      if (typeof ri !== 'object' || ri === null) continue;
      const it = ri as { id?: unknown; label?: unknown; deepLink?: unknown };
      if (typeof it.id !== 'string' || typeof it.label !== 'string') continue;
      const item: BriefingItem = { id: it.id, label: it.label };
      if (typeof it.deepLink === 'string' && it.deepLink !== '') {
        item.deepLink = it.deepLink;
      }
      items.push(item);
    }
    sections.push({ title: s.title, items });
  }
  return {
    kind: 'briefing',
    briefingId: md.briefingId,
    periodStart: typeof md.periodStart === 'number' ? md.periodStart : 0,
    periodEnd: typeof md.periodEnd === 'number' ? md.periodEnd : 0,
    sections,
  };
}

export function InlineBriefingCard({
  message,
}: InlineBriefingCardProps): React.JSX.Element | null {
  const router = useRouter();
  const meta = readMetadata(message);
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  const onItemPress = useCallback(
    (item: BriefingItem) => {
      if (item.deepLink === undefined) return;
      router.push(item.deepLink as never);
    },
    [router],
  );

  if (meta === null) return null;

  const totalItems = meta.sections.reduce((sum, s) => sum + s.items.length, 0);
  const periodLabel = formatPeriod(meta.periodStart, meta.periodEnd);

  return (
    <View style={styles.card}>
      <TouchableOpacity
        testID={`briefing-toggle-${meta.briefingId}`}
        onPress={toggle}
        activeOpacity={0.7}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <Text style={styles.label}>BRIEFING</Text>
          {periodLabel !== '' && <Text style={styles.period}>{periodLabel}</Text>}
        </View>
        <Text style={styles.summary}>
          {totalItems} {totalItems === 1 ? 'item' : 'items'} {expanded ? '∨' : '∧'}
        </Text>
      </TouchableOpacity>
      {!expanded && message.content !== '' && (
        <Text style={styles.preview} numberOfLines={2}>
          {message.content}
        </Text>
      )}
      {expanded && (
        <View style={styles.sections}>
          {meta.sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.items.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  testID={`briefing-item-${item.id}`}
                  onPress={() => onItemPress(item)}
                  activeOpacity={item.deepLink === undefined ? 1 : 0.7}
                  disabled={item.deepLink === undefined}
                  style={styles.item}
                >
                  <Text
                    style={[styles.itemText, item.deepLink !== undefined && styles.itemLink]}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
              {section.items.length === 0 && <Text style={styles.empty}>(empty)</Text>}
            </View>
          ))}
        </View>
      )}
      <MessageTimestamp timestamp={message.timestamp} />
    </View>
  );
}

function formatPeriod(start: number, end: number): string {
  if (start === 0 || end === 0) return '';
  const fmt = (ms: number): string =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.sm,
  },
  label: {
    fontFamily: fonts.sansSemibold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: colors.textMuted,
  },
  period: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
  },
  summary: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  preview: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
    marginTop: spacing.sm,
  },
  sections: {
    marginTop: spacing.sm,
  },
  section: {
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    fontFamily: fonts.heading,
    fontSize: 13,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  item: {
    paddingVertical: 4,
  },
  itemText: {
    fontFamily: fonts.sans,
    fontSize: 14,
    color: colors.textPrimary,
    lineHeight: 20,
  },
  itemLink: {
    color: colors.accent,
    textDecorationLine: 'underline',
  },
  empty: {
    fontFamily: fonts.sans,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
