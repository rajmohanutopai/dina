/**
 * Offer a choice among a few actions — WEB.
 *
 * The browser has no multi-button dialog, so each action is offered in turn
 * as its own confirm ("Make Unlisted?", then "Make Private?"); the first yes
 * wins and cancelling every one resolves null. With no window (a test
 * environment) nothing is chosen: an unasked question never picks an action.
 */

import type { ActionChoice } from './choose_action';

export type { ActionChoice };

export function chooseAction<K extends string>(
  title: string,
  message: string,
  actions: readonly ActionChoice<K>[],
  _cancelLabel = 'Cancel',
): Promise<K | null> {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return Promise.resolve(null);
  }
  for (const action of actions) {
    if (window.confirm(`${title}\n\n${message}\n\n${action.label}?`)) {
      return Promise.resolve(action.key);
    }
  }
  return Promise.resolve(null);
}
