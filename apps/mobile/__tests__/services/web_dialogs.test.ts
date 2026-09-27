/**
 * The browser halves of the dialog helpers. React Native Web's `Alert.alert`
 * does nothing, so these use the browser's own alert and confirm.
 *
 *   - `showMessage` shows the text and then runs `onClose` (a screen that
 *     navigates after "Saved" still moves on in a browser).
 *   - `chooseAction` offers each action as its own confirm; the first yes
 *     wins, and declining every one chooses nothing.
 *   - With no window (no one to ask), nothing is chosen.
 */

import { chooseAction } from '../../src/services/choose_action.web';
import { showMessage } from '../../src/services/show_message.web';

const ACTIONS = [
  { key: 'unlisted', label: 'Make Unlisted' },
  { key: 'known_only', label: 'Make Private' },
] as const;

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

function withWindow(answers: boolean[]): { alerts: string[]; confirms: string[] } {
  const alerts: string[] = [];
  const confirms: string[] = [];
  (globalThis as { window?: unknown }).window = {
    alert: (text: string) => void alerts.push(text),
    confirm: (text: string) => {
      confirms.push(text);
      return answers.shift() ?? false;
    },
  };
  return { alerts, confirms };
}

it('showMessage shows the text, then runs onClose', () => {
  const seen = withWindow([]);
  const onClose = jest.fn();
  showMessage('Saved', 'Listing created.', onClose);
  expect(seen.alerts).toEqual(['Saved\n\nListing created.']);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('showMessage with no window still lets the screen move on', () => {
  const onClose = jest.fn();
  showMessage('Saved', undefined, onClose);
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('chooseAction: the first yes wins', async () => {
  const seen = withWindow([false, true]);
  expect(await chooseAction('Too sensitive', 'Pick one.', ACTIONS)).toBe('known_only');
  expect(seen.confirms).toHaveLength(2);
  expect(seen.confirms[1]).toContain('Make Private?');
});

it('chooseAction: declining every action chooses nothing', async () => {
  withWindow([false, false]);
  expect(await chooseAction('Too sensitive', 'Pick one.', ACTIONS)).toBeNull();
});

it('chooseAction with no window chooses nothing', async () => {
  expect(await chooseAction('Too sensitive', 'Pick one.', ACTIONS)).toBeNull();
});
