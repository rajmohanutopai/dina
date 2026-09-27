/**
 * Tell the owner something (a result or an error) — NATIVE / default.
 *
 * A thin wrapper over React Native's `Alert.alert`. The web variant
 * (`show_message.web.ts`) uses the browser's own alert, because RN-Web's
 * `Alert.alert` does nothing: on the web an error would never be seen. Pair
 * with `confirm_decision.ts` for yes/no questions and `choose_action.ts` for
 * a choice among several.
 *
 * `onClose` runs once the person has read it (a screen navigates there).
 */

import { Alert } from 'react-native';

export function showMessage(title: string, message?: string, onClose?: () => void): void {
  if (onClose === undefined) {
    Alert.alert(title, message);
    return;
  }
  Alert.alert(title, message, [{ text: 'OK', onPress: onClose }], {
    cancelable: true,
    onDismiss: onClose,
  });
}
