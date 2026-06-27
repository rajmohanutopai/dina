/**
 * react-native-keyboard-controller mock for Jest.
 *
 * The real package is a native module that can't load in the test runtime
 * (its `index` pulls in native-bridge code via `animated.tsx`, which throws
 * on import). Render tests only need these wrappers to render their children,
 * so each is a passthrough host component — same pattern as
 * `__mocks__/react-native.ts`. Mapped in `jest.config.js` moduleNameMapper.
 */

import React from 'react';

function passthrough(hostName: string) {
  const Component: React.FC<any> = (props) =>
    React.createElement(hostName, props, props.children);
  Component.displayName = hostName;
  return Component;
}

export const KeyboardProvider = passthrough('KeyboardProvider');
export const KeyboardAvoidingView = passthrough('KeyboardAvoidingView');
export const KeyboardAwareScrollView = passthrough('KeyboardAwareScrollView');
