/**
 * Owner-decision confirm — WEB.
 *
 * RN-Web's `Alert.alert` is a no-op, so a confirmation dialog never appears
 * and the approve/deny onPress never fires. Use the browser's native
 * `window.confirm` instead — a real, blocking confirm that returns a boolean.
 * This is the interaction half of the F4 web-parity fix (the data half is the
 * brain workflow proxy + web inbox client).
 */

export function confirmDecision(
  title: string,
  message: string,
  _confirmLabel: string,
  _destructive = false,
): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    // No confirm available (SSR / node test env without a window). This backs
    // an agent-safety approval gate, so FAIL CLOSED — never auto-confirm an
    // approve/deny when we can't actually ask the owner. Real browsers always
    // have window.confirm, so production web is unaffected.
    return Promise.resolve(false);
  }
  return Promise.resolve(window.confirm(`${title}\n\n${message}`));
}
