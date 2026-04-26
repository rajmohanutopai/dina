/**
 * react-native mock for Jest tests. Two surfaces:
 *
 *   - Headless tests that import `Platform` only — keep working.
 *   - RTL-driven render tests — get host components (View, Text,
 *     Pressable, FlatList, RefreshControl, StyleSheet, Alert) that
 *     `@testing-library/react-native`'s `render()` traverses.
 *
 * Implementation: each component is a tiny passthrough functional
 * component that returns `React.createElement(<host string>, props,
 * children)`. RTL recognises the lower-case host string as a leaf
 * and wires the testID / accessibility queries through it.
 */

import React from 'react';

export const Platform = {
  OS: 'ios',
  select: (obj: any) => obj.ios ?? obj.default ?? {},
};

function passthrough(hostName: string) {
  const Component: React.FC<any> = (props) =>
    React.createElement(hostName, props, props.children);
  Component.displayName = hostName;
  return Component;
}

export const View = passthrough('View');
export const Text = passthrough('Text');
export const ScrollView = passthrough('ScrollView');
export const TextInput = passthrough('TextInput');
export const TouchableOpacity = passthrough('TouchableOpacity');
export const TouchableWithoutFeedback = passthrough('TouchableWithoutFeedback');
export const RefreshControl = passthrough('RefreshControl');
export const Image = passthrough('Image');
export const SafeAreaView = passthrough('SafeAreaView');
export const KeyboardAvoidingView = passthrough('KeyboardAvoidingView');
export const ActivityIndicator = passthrough('ActivityIndicator');
export const Switch = passthrough('Switch');

export const Pressable: React.FC<any> = ({ onPress, children, ...rest }) =>
  React.createElement('Pressable', { ...rest, onPress }, children);
Pressable.displayName = 'Pressable';

/**
 * FlatList minimal — we render `data.map(renderItem)`. Good enough for
 * RTL render tests; the real FlatList does virtualization which jest
 * doesn't need to simulate.
 */
export const FlatList: React.FC<any> = ({
  data,
  renderItem,
  keyExtractor,
  ListEmptyComponent,
  refreshControl,
  contentContainerStyle,
  ...rest
}) => {
  const items = Array.isArray(data) ? data : [];
  if (items.length === 0) {
    const empty = typeof ListEmptyComponent === 'function'
      ? React.createElement(ListEmptyComponent)
      : (ListEmptyComponent ?? null);
    return React.createElement('FlatList', { ...rest, style: contentContainerStyle }, empty);
  }
  return React.createElement(
    'FlatList',
    { ...rest, style: contentContainerStyle },
    refreshControl,
    ...items.map((item: any, index: number) => {
      const key = keyExtractor ? keyExtractor(item, index) : String(index);
      return React.createElement(
        React.Fragment,
        { key },
        renderItem({ item, index, separators: undefined as never }),
      );
    }),
  );
};
FlatList.displayName = 'FlatList';

/**
 * SectionList minimal — flatten + render. Same trade-off as FlatList.
 */
export const SectionList: React.FC<any> = ({
  sections,
  renderItem,
  renderSectionHeader,
  keyExtractor,
  ListEmptyComponent,
  ...rest
}) => {
  const list = Array.isArray(sections) ? sections : [];
  if (list.length === 0) {
    const empty = typeof ListEmptyComponent === 'function'
      ? React.createElement(ListEmptyComponent)
      : (ListEmptyComponent ?? null);
    return React.createElement('SectionList', rest, empty);
  }
  return React.createElement(
    'SectionList',
    rest,
    ...list.flatMap((section: any, sectionIndex: number) => {
      const header = renderSectionHeader
        ? renderSectionHeader({ section })
        : null;
      const rows = (section.data ?? []).map((item: any, index: number) => {
        const key = keyExtractor ? keyExtractor(item, index) : `${sectionIndex}-${index}`;
        return React.createElement(
          React.Fragment,
          { key },
          renderItem({ item, index, section, separators: undefined as never }),
        );
      });
      return [
        React.createElement(
          React.Fragment,
          { key: `s-${sectionIndex}` },
          header,
          ...rows,
        ),
      ];
    }),
  );
};
SectionList.displayName = 'SectionList';

export const StyleSheet = {
  create: <T extends Record<string, unknown>>(styles: T): T => styles,
  flatten: (style: unknown) => style,
  hairlineWidth: 1,
  absoluteFill: {} as Record<string, unknown>,
  absoluteFillObject: {} as Record<string, unknown>,
};

export const Alert = {
  alert: (..._args: unknown[]): void => {
    /* swallowed in tests; assertions go through spy patterns when
     * tests need to observe Alert */
  },
};

export const Linking = {
  openURL: async (_url: string): Promise<void> => {
    /* no-op in tests */
  },
  canOpenURL: async (_url: string): Promise<boolean> => true,
};

export const Dimensions = {
  get: (_window: 'window' | 'screen') => ({ width: 375, height: 812, scale: 2, fontScale: 1 }),
  addEventListener: (_event: string, _handler: unknown) => ({ remove: () => undefined }),
};

export const NativeModules: Record<string, unknown> = {};

export const useWindowDimensions = () => ({
  width: 375,
  height: 812,
  scale: 2,
  fontScale: 1,
});

const noop = (): void => undefined;
export const Keyboard = {
  dismiss: noop,
  addListener: () => ({ remove: noop }),
  removeAllListeners: noop,
};

export const AppState = {
  currentState: 'active' as 'active' | 'background' | 'inactive',
  addEventListener: () => ({ remove: noop }),
};
