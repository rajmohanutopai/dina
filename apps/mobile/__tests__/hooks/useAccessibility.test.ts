/**
 * T10.13 — Accessibility: helper tests.
 *
 * Source: ARCHITECTURE.md Task 10.13
 */

import {
  a11yButton,
  a11yHeader,
  a11yText,
  a11yTab,
  a11ySearch,
  a11yAlert,
  a11yListItem,
  a11yLiveRegion,
  chatLabels,
  settingsLabels,
  vaultLabels,
  contactLabels,
  reminderLabels,
} from '../../src/hooks/useAccessibility';

describe('Accessibility Helpers (10.13)', () => {
  describe('element builders', () => {
    it('a11yButton builds correct props', () => {
      const props = a11yButton('Save', 'Save your changes');
      expect(props.accessible).toBe(true);
      expect(props.accessibilityLabel).toBe('Save');
      expect(props.accessibilityHint).toBe('Save your changes');
      expect(props.accessibilityRole).toBe('button');
    });

    it('a11yButton handles disabled state', () => {
      const props = a11yButton('Save', undefined, true);
      expect(props.accessibilityState?.disabled).toBe(true);
    });

    it('a11yHeader builds header role', () => {
      const props = a11yHeader('Settings');
      expect(props.accessibilityRole).toBe('header');
      expect(props.accessibilityLabel).toBe('Settings');
    });

    it('a11yText builds text role', () => {
      const props = a11yText('Hello world');
      expect(props.accessibilityRole).toBe('text');
    });

    it('a11yTab builds with selected state', () => {
      const selected = a11yTab('Chat', true);
      expect(selected.accessibilityState?.selected).toBe(true);

      const unselected = a11yTab('Vault', false);
      expect(unselected.accessibilityState?.selected).toBe(false);
    });

    it('a11ySearch builds search role', () => {
      const props = a11ySearch('Search contacts');
      expect(props.accessibilityRole).toBe('search');
      expect(props.accessibilityHint).toBe('Search contacts');
    });

    it('a11yAlert builds alert role', () => {
      const props = a11yAlert('Error: connection lost');
      expect(props.accessibilityRole).toBe('alert');
    });

    it('a11yListItem builds with hint', () => {
      const props = a11yListItem('Alice (Trusted)', 'View contact details');
      expect(props.accessibilityLabel).toBe('Alice (Trusted)');
      expect(props.accessibilityHint).toBe('View contact details');
    });

    it('a11yLiveRegion builds polite by default', () => {
      const props = a11yLiveRegion('New message received');
      expect(props.accessibilityLiveRegion).toBe('polite');
    });

    it('a11yLiveRegion builds assertive when requested', () => {
      const props = a11yLiveRegion('Security alert', true);
      expect(props.accessibilityLiveRegion).toBe('assertive');
    });
  });

  describe('chat screen labels', () => {
    it('messageInput adapts to typing state', () => {
      const idle = chatLabels.messageInput(false);
      expect(idle.accessibilityHint).toBe('Type a message');

      const typing = chatLabels.messageInput(true);
      expect(typing.accessibilityHint).toContain('typing');
    });

    it('sendButton reflects empty state', () => {
      const empty = chatLabels.sendButton(true);
      expect(empty.accessibilityState?.disabled).toBe(true);

      const ready = chatLabels.sendButton(false);
      expect(ready.accessibilityState?.disabled).toBeUndefined();
    });

    it('userMessage prefixes with "You said"', () => {
      const props = chatLabels.userMessage('Hello Dina');
      expect(props.accessibilityLabel).toBe('You said: Hello Dina');
    });

    it('dinaMessage prefixes with "Dina"', () => {
      const props = chatLabels.dinaMessage('The answer is 42');
      expect(props.accessibilityLabel).toBe('Dina: The answer is 42');
    });

    it('approvalCard includes action', () => {
      const props = chatLabels.approvalCard('unlock health vault');
      expect(props.accessibilityLabel).toContain('unlock health vault');
    });
  });

  describe('settings screen labels', () => {
    it('section headers', () => {
      expect(settingsLabels.identitySection().accessibilityRole).toBe('header');
      expect(settingsLabels.securitySection().accessibilityLabel).toBe('Security');
    });

    it('biometric toggle reflects state', () => {
      const on = settingsLabels.biometricToggle(true);
      expect(on.accessibilityLabel).toContain('enabled');

      const off = settingsLabels.biometricToggle(false);
      expect(off.accessibilityLabel).toContain('disabled');
    });
  });

  describe('vault labels', () => {
    it('persona item shows lock state', () => {
      const open = vaultLabels.personaItem('general', true);
      expect(open.accessibilityLabel).toContain('open');

      const locked = vaultLabels.personaItem('health', false);
      expect(locked.accessibilityLabel).toContain('locked');
    });
  });

  describe('contact labels', () => {
    it('contact item includes trust level', () => {
      const props = contactLabels.contactItem('Alice', 'trusted');
      expect(props.accessibilityLabel).toBe('Alice, trusted');
    });
  });

  describe('reminder labels', () => {
    it('reminder item includes due label', () => {
      const props = reminderLabels.reminderItem('Call dentist', 'tomorrow');
      expect(props.accessibilityLabel).toBe('Call dentist, due tomorrow');
    });
  });
});
