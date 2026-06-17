/**
 * MessageActionMenu — the deep-press (long-press) context menu for chat
 * bubbles, in the style of the Claude app: a small floating rounded card that
 * pops up near the pressed message with one tap-target per action (label left,
 * icon right).
 *
 * Dina V1 offers a single action — Copy. There is no "Edit" (a sent message /
 * Dina reply is immutable here), so the menu stays a one-row card; more actions
 * can be added by extending the `actions` array without touching layout.
 *
 * Positioning: anchored to the long-press point. It opens ABOVE the press by
 * default and flips below when there isn't room near the top; horizontally it
 * is centered on the press point and clamped to the screen so it never spills
 * off-edge. Rendered in a transparent Modal so it floats above the chat list and
 * a full-screen backdrop tap dismisses it.
 */

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Dimensions, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, shadows, textStyles } from '../theme';

export interface MessageAction {
  /** Stable key (also the testID suffix: `message-action-<key>`). */
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Renders the row in the error colour (e.g. a future "Delete"). */
  destructive?: boolean;
  onPress: () => void;
}

export interface MessageActionMenuProps {
  /** Screen-space long-press point; `null` keeps the menu closed. */
  anchor: { x: number; y: number } | null;
  actions: MessageAction[];
  onDismiss: () => void;
}

const MENU_WIDTH = 184;
const ROW_HEIGHT = 46;
const GAP = 10;
const EDGE = 12;

export function MessageActionMenu({
  anchor,
  actions,
  onDismiss,
}: MessageActionMenuProps): React.JSX.Element | null {
  if (anchor === null || actions.length === 0) return null;

  const screen = Dimensions.get('window');
  const menuHeight = actions.length * ROW_HEIGHT + 8;
  // Open above the press by default; flip below when the top is too tight.
  const openUp = anchor.y - menuHeight - GAP > 56;
  const top = openUp ? anchor.y - menuHeight - GAP : anchor.y + GAP;
  const left = Math.max(
    EDGE,
    Math.min(anchor.x - MENU_WIDTH / 2, screen.width - MENU_WIDTH - EDGE),
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onDismiss} testID="message-action-backdrop">
        <View style={[styles.menu, { top, left, width: MENU_WIDTH }]} testID="message-action-menu">
          {actions.map((a, i) => (
            <Pressable
              key={a.key}
              style={({ pressed }) => [
                styles.row,
                i > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
              onPress={a.onPress}
              testID={`message-action-${a.key}`}
              accessibilityRole="button"
              accessibilityLabel={a.label}
            >
              <Text style={[styles.label, a.destructive && styles.labelDestructive]}>
                {a.label}
              </Text>
              <Ionicons
                name={a.icon}
                size={18}
                color={a.destructive ? colors.error : colors.textPrimary}
              />
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  menu: {
    position: 'absolute',
    backgroundColor: colors.bgSecondary,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 4,
    ...shadows.lg,
  },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  rowPressed: {
    backgroundColor: colors.bgPrimary,
  },
  label: {
    ...textStyles.body,
    color: colors.textPrimary,
  },
  labelDestructive: {
    color: colors.error,
  },
});
