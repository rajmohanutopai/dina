/**
 * PeerLens — "About Ranked Reviews" explainer.
 *
 * A read-only, scrollable plain-language page reached from the reviewer
 * dashboard's About row. Owns no state: it renders the `PEERLENS_EXPLAINER`
 * content bundle (single source of truth for the copy). Each section shows
 * an icon + title, optional paragraphs, and optional trust-signal "bullets"
 * whose icon is colour-coded by tone (positive lifts trust, negative lowers
 * it, neutral is informational) so the page scans instead of reading as a
 * wall of text. The nav header supplies the title ("About Ranked Reviews").
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';

import { PEERLENS_EXPLAINER, type ExplainerBullet } from '../../src/peerlens/explainer_content';
import { colors, spacing, textStyles } from '../../src/theme';

type IoniconName = keyof typeof Ionicons.glyphMap;

function bulletColor(tone: ExplainerBullet['tone']): string {
  switch (tone) {
    case 'positive':
      return colors.success;
    case 'negative':
      return colors.warning;
    default:
      return colors.textSecondary;
  }
}

export default function AboutPeerLensScreen(): React.JSX.Element {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      testID="peerlens-about-screen"
    >
      <Text style={styles.intro} testID="peerlens-about-intro">
        {PEERLENS_EXPLAINER.intro}
      </Text>

      {PEERLENS_EXPLAINER.sections.map((section, i) => (
        <View key={section.title} style={styles.section} testID={`peerlens-about-section-${i}`}>
          <View style={styles.sectionHeader}>
            <Ionicons name={section.icon as IoniconName} size={20} color={colors.accent} />
            <Text style={styles.sectionTitle}>{section.title}</Text>
          </View>

          {section.paragraphs?.map((paragraph) => (
            <Text key={paragraph} style={styles.paragraph}>
              {paragraph}
            </Text>
          ))}

          {section.bullets?.map((bullet) => (
            <View key={bullet.title} style={styles.bullet}>
              <Ionicons
                name={bullet.icon as IoniconName}
                size={18}
                color={bulletColor(bullet.tone)}
                style={styles.bulletIcon}
              />
              <View style={styles.bulletBody}>
                <Text style={styles.bulletTitle}>{bullet.title}</Text>
                <Text style={styles.bulletText}>{bullet.text}</Text>
              </View>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.md, paddingBottom: spacing.xxl, gap: spacing.lg },
  intro: { ...textStyles.bodyLarge, color: colors.textSecondary },
  section: { gap: spacing.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionTitle: { ...textStyles.h3, flexShrink: 1 },
  paragraph: { ...textStyles.body, color: colors.textSecondary },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  bulletIcon: { marginTop: 2 },
  bulletBody: { flex: 1, gap: 2 },
  bulletTitle: { ...textStyles.bodyStrong },
  bulletText: { ...textStyles.bodySmall, color: colors.textSecondary },
});
