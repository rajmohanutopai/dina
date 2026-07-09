/**
 * Owner-decision confirm — NATIVE / default.
 *
 * A promise-returning wrapper over React Native's `Alert.alert` two-button
 * confirm. Resolves `true` when the owner confirms, `false` on cancel or
 * dismiss. The web variant (`confirm_decision.web.ts`) overrides this with a
 * browser confirm, because RN-Web's `Alert.alert` is a no-op — so on the web
 * thin-client an approval/deny confirmation would never appear and the
 * decision could never complete (part of the F4 web-parity fix).
 */

import { Alert } from 'react-native';

export function confirmDecision(
  title: string,
  message: string,
  confirmLabel: string,
  destructive = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        {
          text: confirmLabel,
          style: destructive ? 'destructive' : 'default',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
