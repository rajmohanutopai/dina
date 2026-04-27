/**
 * Tiny shared "8:34 AM"-style timestamp footer used by every inline
 * chat card (approval, briefing, nudge, reminder, service-approval,
 * service-query). Plain dina + user bubbles render the same format
 * inline in `app/index.tsx`; this component centralizes the format
 * for cards so they stay visually consistent.
 */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors, fonts, spacing } from '../theme';

export interface MessageTimestampProps {
  /** Epoch milliseconds — typically `ChatMessage.timestamp`. */
  timestamp: number;
}

export function MessageTimestamp({ timestamp }: MessageTimestampProps): React.JSX.Element {
  const formatted = new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return <Text style={styles.timestamp}>{formatted}</Text>;
}

const styles = StyleSheet.create({
  timestamp: {
    fontFamily: fonts.sans,
    fontSize: 10,
    color: colors.textMuted,
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
});
