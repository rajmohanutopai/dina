/**
 * What the owner wants to do with a contact — WEB.
 *
 * RN-Web's `Alert.alert` is a no-op, so the native sheet never appears. The
 * browser has no multi-choice prompt, so ask the one question that is not
 * destructive first: trade details, or (declined) fall through to remove,
 * which has its own confirm behind it.
 */

export type ContactAction = 'trade' | 'remove' | null;

export function chooseContactAction(displayName: string): Promise<ContactAction> {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    // No way to ask. Choose NOTHING — a silent default here would either open
    // a screen the owner did not ask for or start a removal they did not.
    return Promise.resolve(null);
  }
  return Promise.resolve(
    window.confirm(`${displayName}\n\nOpen trade details? (Cancel to remove the contact instead.)`)
      ? 'trade'
      : 'remove',
  );
}
