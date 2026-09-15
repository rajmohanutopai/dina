/**
 * What the owner wants to do with a contact — NATIVE / default.
 *
 * A long-press on a contact row asks, rather than meaning "delete" alone: an
 * owner reaches for the same gesture to state the trade details a filing needs
 * (§5.D). Resolves `null` when they dismiss.
 *
 * The web variant overrides this, because RN-Web's `Alert.alert` is a no-op —
 * the sheet would never appear and neither action could be chosen.
 */

import { Alert } from 'react-native';

export type ContactAction = 'trade' | 'remove' | null;

export function chooseContactAction(displayName: string): Promise<ContactAction> {
  return new Promise((resolve) => {
    Alert.alert(
      displayName,
      'What would you like to do?',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
        { text: 'Trade details', onPress: () => resolve('trade') },
        { text: 'Remove contact', style: 'destructive', onPress: () => resolve('remove') },
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}
