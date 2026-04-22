/**
 * Accessibility hook — helpers for VoiceOver (iOS) and TalkBack (Android).
 *
 * Provides:
 *   - Screen-specific accessibility labels and hints
 *   - Role mapping for interactive elements
 *   - Live region announcements for dynamic content
 *   - Focus management helpers
 *
 * All screens should import from this module to ensure consistent
 * accessibility across the app.
 *
 * Source: ARCHITECTURE.md Task 10.13
 */

export type A11yRole =
  | 'button'
  | 'link'
  | 'header'
  | 'text'
  | 'image'
  | 'search'
  | 'tab'
  | 'list'
  | 'alert'
  | 'none';

export interface A11yProps {
  accessible: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  accessibilityRole?: A11yRole;
  accessibilityState?: {
    disabled?: boolean;
    selected?: boolean;
    checked?: boolean;
    expanded?: boolean;
    busy?: boolean;
  };
}

/**
 * Build accessibility props for a button.
 */
export function a11yButton(label: string, hint?: string, disabled?: boolean): A11yProps {
  return {
    accessible: true,
    accessibilityLabel: label,
    accessibilityHint: hint,
    accessibilityRole: 'button',
    accessibilityState: disabled ? { disabled: true } : undefined,
  };
}

/**
 * Build accessibility props for a header.
 */
export function a11yHeader(label: string): A11yProps {
  return {
    accessible: true,
    accessibilityLabel: label,
    accessibilityRole: 'header',
  };
}

/**
 * Build accessibility props for a text element.
 */
export function a11yText(label: string): A11yProps {
  return {
    accessible: true,
    accessibilityLabel: label,
    accessibilityRole: 'text',
  };
}

/**
 * Build accessibility props for a tab.
 */
export function a11yTab(label: string, selected: boolean): A11yProps {
  return {
    accessible: true,
    accessibilityLabel: label,
    accessibilityRole: 'tab',
    accessibilityState: { selected },
  };
}

/**
 * Build accessibility props for a search input.
 */
export function a11ySearch(hint?: string): A11yProps {
  return {
    accessible: true,
    accessibilityLabel: 'Search',
    accessibilityHint: hint ?? 'Search for items',
    accessibilityRole: 'search',
  };
}

/**
 * Build accessibility props for an alert/notification.
 */
export function a11yAlert(message: string): A11yProps {
  return {
    accessible: true,
    accessibilityLabel: message,
    accessibilityRole: 'alert',
  };
}

/**
 * Build accessibility props for a list item.
 */
export function a11yListItem(label: string, hint?: string): A11yProps {
  return {
    accessible: true,
    accessibilityLabel: label,
    accessibilityHint: hint ?? 'Double-tap to view details',
    accessibilityRole: 'button',
  };
}

/**
 * Build a live-region announcement (for dynamic content updates).
 * Returns props that make the screen reader announce the text.
 */
export function a11yLiveRegion(
  text: string,
  assertive?: boolean,
): {
  accessible: boolean;
  accessibilityLabel: string;
  accessibilityLiveRegion: 'polite' | 'assertive';
} {
  return {
    accessible: true,
    accessibilityLabel: text,
    accessibilityLiveRegion: assertive ? 'assertive' : 'polite',
  };
}

// ---------------------------------------------------------------
// Screen-specific label generators
// ---------------------------------------------------------------

/** Chat screen labels. */
export const chatLabels = {
  messageInput: (typing: boolean) => a11ySearch(typing ? 'Dina is typing...' : 'Type a message'),
  sendButton: (empty: boolean) => a11yButton('Send message', 'Send your message to Dina', empty),
  userMessage: (text: string) => a11yText(`You said: ${text}`),
  dinaMessage: (text: string) => a11yText(`Dina: ${text}`),
  approvalCard: (action: string) =>
    a11yListItem(`Approval needed: ${action}`, 'Double-tap to review'),
  nudgeCard: (title: string) => a11yListItem(`Suggestion: ${title}`, 'Double-tap to act'),
  systemMessage: (text: string) => a11yText(`System: ${text}`),
};

/** Settings screen labels. */
export const settingsLabels = {
  identitySection: () => a11yHeader('Identity'),
  securitySection: () => a11yHeader('Security'),
  llmSection: () => a11yHeader('LLM Providers'),
  personaSection: () => a11yHeader('Personas'),
  didDisplay: (shortDID: string) => a11yText(`Your DID: ${shortDID}`),
  backupButton: () => a11yButton('Backup mnemonic', 'Show your 24-word recovery phrase'),
  changePassphrase: () => a11yButton('Change passphrase', 'Update your unlock passphrase'),
  biometricToggle: (enabled: boolean) =>
    a11yButton(
      `Biometric unlock: ${enabled ? 'enabled' : 'disabled'}`,
      'Toggle Face ID or Touch ID for unlock',
    ),
};

/** Vault browser labels. */
export const vaultLabels = {
  personaItem: (name: string, isOpen: boolean) =>
    a11yListItem(`${name} vault, ${isOpen ? 'open' : 'locked'}`, 'Double-tap to browse'),
  searchInput: () => a11ySearch('Search within this vault'),
  itemDetail: (type: string, summary: string) => a11yText(`${type}: ${summary}`),
};

/** Contacts screen labels. */
export const contactLabels = {
  contactItem: (name: string, trust: string) =>
    a11yListItem(`${name}, ${trust}`, 'Double-tap for details'),
  addButton: () => a11yButton('Add contact', 'Add a new contact by DID'),
  searchInput: () => a11ySearch('Search contacts by name'),
};

/** Reminders screen labels. */
export const reminderLabels = {
  reminderItem: (message: string, dueLabel: string) =>
    a11yListItem(`${message}, due ${dueLabel}`, 'Double-tap for options'),
  dismissButton: () => a11yButton('Dismiss', 'Mark this reminder as done'),
  snoozeButton: () => a11yButton('Snooze', 'Postpone this reminder'),
};
