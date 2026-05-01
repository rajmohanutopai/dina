/**
 * JS-rendered header for per-tab Stack INDEX screens (CR-3 fix).
 *
 * Background: per-tab Stack screens (`app/trust/_layout.tsx`,
 * `app/vault/_layout.tsx`) use `react-native-screens` native-stack on
 * iOS, which renders the header via UINavigationBar +
 * UIBarButtonItem. Custom `headerLeft` / `headerRight` JSX —
 * `<Pressable>` or `<HeaderButton>` — gets wrapped by that native
 * chrome in a way that does NOT propagate React Native a11y traits
 * to VoiceOver. The result: the entire nav-bar shows up as an
 * unlabeled `Group` element in the AX tree, with the buttons
 * unreachable for assistive tech users. Verified empirically via
 * `idb ui describe-all` on /vault + /trust (2026-05-01).
 *
 * The reliable fix is to replace the native header chrome with a
 * fully JS-rendered View (the same render path the global Tabs root
 * header uses, where Pressable's a11y traits work correctly). This
 * module provides that JS header, parameterised so both the Vault
 * and Trust per-tab Stacks can share it.
 *
 * Drill-down screens within those Stacks (e.g. `/trust/[subjectId]`,
 * `/vault/[name]`) keep the native header — their auto-back chevron
 * uses iOS's system back-button trait and is exposed to VoiceOver
 * correctly. Only the index-screen hamburger + help needed
 * intervention.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { colors, fonts } from '../theme';

/**
 * Visual height of the header content row (excluding safe-area
 * insets). Matches the native iOS nav-bar height so the JS header
 * doesn't shift the layout vs the per-screen native headers used by
 * drill-downs.
 */
const HEADER_CONTENT_HEIGHT = 44;

export interface StackIndexHeaderProps {
  /** The title to render centred. e.g. `'Trust'`, `'Vaults'`. */
  title: string;
  /** Tap handler for the left hamburger. Typically `openMenu`. */
  onMenuPress: () => void;
  /** Tap handler for the right help icon. */
  onHelpPress: () => void;
  /**
   * Optional override for the help-icon a11y label. Defaults to
   * `'Open help'`. The two callsites (Vault + Trust) currently use
   * the same label so the default is fine; the prop exists so a
   * third caller can disambiguate without forking the component.
   */
  helpAccessibilityLabel?: string;
  /**
   * Optional override for the menu-icon a11y label. Defaults to
   * `'Open menu'` for the same reason as `helpAccessibilityLabel`.
   */
  menuAccessibilityLabel?: string;
}

/**
 * The shared JS-rendered header. Renders into a single View with
 * top safe-area padding (so it sits below the iOS status bar /
 * Dynamic Island the same way the native nav bar would).
 */
export function StackIndexHeader({
  title,
  onMenuPress,
  onHelpPress,
  helpAccessibilityLabel = 'Open help',
  menuAccessibilityLabel = 'Open menu',
}: StackIndexHeaderProps): React.ReactElement {
  // Safe-area insets give us the same top padding the native nav-bar
  // gets — matters for notched/Dynamic-Island devices where the
  // status bar height varies.
  const insets = useSafeAreaInsets();
  const wrapStyle: ViewStyle = {
    paddingTop: insets.top,
    backgroundColor: colors.bgPrimary,
  };

  return (
    <View style={wrapStyle}>
      <View style={styles.row}>
        <Pressable
          onPress={onMenuPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={menuAccessibilityLabel}
          style={styles.iconButton}
        >
          <Ionicons name="menu-outline" size={26} color={colors.textPrimary} />
        </Pressable>

        <View style={styles.titleWrap} accessible={false}>
          <Text
            style={styles.title}
            numberOfLines={1}
            accessibilityRole="header"
          >
            {title}
          </Text>
        </View>

        <Pressable
          onPress={onHelpPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={helpAccessibilityLabel}
          style={styles.iconButton}
        >
          <Ionicons name="help-circle-outline" size={24} color={colors.textPrimary} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: HEADER_CONTENT_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  iconButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleWrap: {
    position: 'absolute',
    // Centre the title between the side buttons. Absolute-positioning
    // is the only layout that lines up with how iOS native nav bars
    // centre the title regardless of side-button widths — flex
    // alignments would shift the title with the side widths.
    left: 60,
    right: 60,
    alignItems: 'center',
  },
  title: {
    fontFamily: fonts.heading,
    fontWeight: '600',
    fontSize: 17,
    color: colors.textPrimary,
  },
});
