/**
 * Offer a choice among a few actions — NATIVE / default.
 *
 * One `Alert.alert` with a Cancel button and one button per action. Resolves
 * the chosen action's key, or null when the person cancels or dismisses. The
 * web variant (`choose_action.web.ts`) asks in the browser, where RN-Web's
 * Alert does nothing. For a single yes/no, use `confirm_decision.ts`.
 */

import { Alert } from 'react-native';

export interface ActionChoice<K extends string> {
  key: K;
  label: string;
  destructive?: boolean;
}

export function chooseAction<K extends string>(
  title: string,
  message: string,
  actions: readonly ActionChoice<K>[],
  cancelLabel = 'Cancel',
): Promise<K | null> {
  return new Promise((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: cancelLabel, style: 'cancel', onPress: () => resolve(null) },
        ...actions.map((action) => ({
          text: action.label,
          style: action.destructive === true ? ('destructive' as const) : ('default' as const),
          onPress: () => resolve(action.key),
        })),
      ],
      { cancelable: true, onDismiss: () => resolve(null) },
    );
  });
}
