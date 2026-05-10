/**
 * Canonical Dina product feature names.
 *
 * Single source of truth for every feature name used across the codebase —
 * mobile UI, server error messages, CLI output, logs, popups. Import from
 * here instead of hardcoding strings in individual files.
 *
 * The icon layer, routes, and pill/tab/menu labels live in
 * apps/mobile/src/features.tsx which builds on top of this.
 */

export const FEATURE_NAMES = {
  // Core product features
  identity:   'Sovereign Identity',
  vault:      'Your Vault',
  reminders:  'Reminders',
  talk:       'Dina-to-Dina Talk',
  agentTasks: 'Agent Tasks',
  security:   'Approvals & Security',
  peerlens:   'PeerLens',
  services:   'Services',
  // Navigation / utility
  chat:          'Chat',
  people:        'People',
  notifications: 'Notifications',
  settings:      'Settings',
  help:          'Help',
  signOut:       'Sign out',
} as const;

export type FeatureKey = keyof typeof FEATURE_NAMES;
export type FeatureName = (typeof FEATURE_NAMES)[FeatureKey];
