/**
 * Tell the owner something (a result or an error) — WEB.
 *
 * RN-Web's `Alert.alert` does nothing, so the browser's own alert is used. It
 * blocks until read, so `onClose` runs right after. With no window (a test
 * environment) there is no one to tell, and `onClose` still runs so the
 * screen moves on.
 */

export function showMessage(title: string, message?: string, onClose?: () => void): void {
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message === undefined || message === '' ? title : `${title}\n\n${message}`);
  }
  onClose?.();
}
