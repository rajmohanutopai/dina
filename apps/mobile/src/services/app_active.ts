/**
 * Whether the app is in the foreground. Kept in its own module so the boot
 * code (which never imports React Native) can take it as a plain function.
 */

import { AppState } from 'react-native';

export function isAppActive(): boolean {
  return AppState.currentState === 'active';
}
