/**
 * Hand a setup code to the owner: the share sheet where there is one, the
 * clipboard where there is not.
 *
 * React Native Web's `Share.share` rejects when the browser has no
 * `navigator.share` (most desktop browsers), and a dismissed sheet resolves
 * without sharing. A screen says "Shared!" only for a real share and
 * "Copied" only for a real copy, so the owner is never told a code went
 * somewhere it did not.
 */

import { Share } from 'react-native';

export type ShareOutcome = 'shared' | 'copied' | 'dismissed' | 'failed';

export async function shareOrCopy(text: string): Promise<ShareOutcome> {
  try {
    const result = await Share.share({ message: text });
    // Android reports no action for a completed share; iOS and web report
    // `sharedAction`, and `dismissedAction` when the sheet was closed.
    return result.action === Share.dismissedAction ? 'dismissed' : 'shared';
  } catch {
    // No share sheet here: fall through to the clipboard.
  }
  try {
    // Loaded on use: an older native build without the module makes this a
    // clean failure instead of a crash at screen load.
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** The button's label for a moment after a tap. */
export function shareOutcomeLabel(outcome: ShareOutcome | null, idle: string): string {
  if (outcome === 'shared') return 'Shared!';
  if (outcome === 'copied') return 'Copied';
  if (outcome === 'failed') return 'Could not share. Select the code above.';
  return idle;
}
