/**
 * Mobile feature registry — icons, labels, and routes for every Dina feature.
 *
 * Canonical names come from @dina/core's FEATURE_NAMES (shared across mobile,
 * server, CLI, and logs). This file adds the mobile-only layer: icon definitions,
 * short labels for pills / tabs / menus, and Expo Router routes.
 *
 * To rename a feature everywhere: edit FEATURE_NAMES in packages/core/src/feature-names.ts.
 * To change an icon or route: edit FEATURES below.
 */

import { Ionicons , MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';

import { FEATURE_NAMES, type FeatureKey } from '@dina/core';

export type { FeatureKey };

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
type MCIName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

type IconDef =
  | { lib: 'Ionicons'; outline: IoniconName; filled: IoniconName }
  | { lib: 'MaterialCommunityIcons'; outline: MCIName; filled: MCIName };

export interface FeatureDef {
  /** Canonical display name — sourced from FEATURE_NAMES in @dina/core. */
  name: string;
  /** Shorter label for the welcome screen pills row. Defaults to name. */
  pillLabel?: string;
  /** Shorter label for the bottom tab bar. Defaults to name. */
  tabLabel?: string;
  /** Shorter label for the hamburger menu. Defaults to name. */
  menuLabel?: string;
  icon: IconDef;
  /** Expo Router path, if this feature has a dedicated screen. */
  route?: string;
}

export const FEATURES: Record<FeatureKey, FeatureDef> = {
  // ── Core features ──────────────────────────────────────────────────────────
  identity: {
    name: FEATURE_NAMES.identity,
    icon: { lib: 'Ionicons', outline: 'finger-print', filled: 'finger-print' },
  },
  vault: {
    name: FEATURE_NAMES.vault,
    pillLabel: 'Data Security',
    tabLabel: 'Vaults',
    menuLabel: 'Vault',
    icon: { lib: 'Ionicons', outline: 'lock-closed-outline', filled: 'lock-closed' },
    route: '/vault',
  },
  reminders: {
    name: FEATURE_NAMES.reminders,
    icon: { lib: 'Ionicons', outline: 'alarm-outline', filled: 'alarm' },
    route: '/reminders',
  },
  talk: {
    name: FEATURE_NAMES.talk,
    icon: { lib: 'Ionicons', outline: 'chatbubbles-outline', filled: 'chatbubbles' },
  },
  agentTasks: {
    name: FEATURE_NAMES.agentTasks,
    icon: { lib: 'MaterialCommunityIcons', outline: 'robot-outline', filled: 'robot' },
  },
  security: {
    name: FEATURE_NAMES.security,
    tabLabel: 'Approvals',
    pillLabel: 'Approvals',
    icon: { lib: 'Ionicons', outline: 'shield-checkmark-outline', filled: 'shield-checkmark' },
    route: '/approvals',
  },
  peerlens: {
    name: FEATURE_NAMES.peerlens,
    // First-impression copy stays name-light: the welcome pill reads
    // "Ranked Reviews" (the in-app results label; see review_source_label),
    // not the brand "PeerLens" — which is taught later in help / the demo.
    pillLabel: 'Ranked Reviews',
    // Bottom-tab surface label. The canonical feature name stays
    // "PeerLens" (the trust subsystem); "Network" is the top-level
    // surface that contains PeerLens + Services. NOTE: the bottom-tab
    // renderer reads Expo Router's `title` (set in app/_layout.tsx),
    // which is the source of truth — this field documents the intent.
    tabLabel: 'Network',
    icon: { lib: 'Ionicons', outline: 'glasses-outline', filled: 'glasses' },
    route: '/peerlens',
  },
  services: {
    name: FEATURE_NAMES.services,
    icon: { lib: 'Ionicons', outline: 'compass-outline', filled: 'compass' },
  },
  // ── Navigation items ────────────────────────────────────────────────────────
  chat: {
    name: FEATURE_NAMES.chat,
    icon: { lib: 'Ionicons', outline: 'chatbubble-outline', filled: 'chatbubble' },
    route: '/',
  },
  people: {
    name: FEATURE_NAMES.people,
    icon: { lib: 'Ionicons', outline: 'people-outline', filled: 'people' },
    route: '/people',
  },
  notifications: {
    name: FEATURE_NAMES.notifications,
    // Bottom-tab surface label "Activity" (event/action/safety surface).
    // Canonical feature name stays "Notifications" (the inbox concept).
    // Authoritative label is the Tabs.Screen `title` in app/_layout.tsx.
    tabLabel: 'Activity',
    icon: { lib: 'Ionicons', outline: 'notifications-outline', filled: 'notifications' },
    route: '/notifications',
  },
  settings: {
    name: FEATURE_NAMES.settings,
    icon: { lib: 'Ionicons', outline: 'settings-outline', filled: 'settings' },
    route: '/settings',
  },
  help: {
    name: FEATURE_NAMES.help,
    icon: { lib: 'Ionicons', outline: 'help-circle-outline', filled: 'help-circle' },
    route: '/help',
  },
  signOut: {
    name: FEATURE_NAMES.signOut,
    icon: { lib: 'Ionicons', outline: 'log-out-outline', filled: 'log-out-outline' },
  },
};

/** Renders the correct icon for a feature, switching between outline and filled. */
export function FeatureIcon({
  feature,
  size,
  color,
  focused = false,
}: {
  feature: FeatureKey;
  size: number;
  color: string;
  focused?: boolean;
}): React.ReactElement {
  const { icon } = FEATURES[feature];
  const name = focused ? icon.filled : icon.outline;
  if (icon.lib === 'Ionicons') {
    return <Ionicons name={name as IoniconName} size={size} color={color} />;
  }
  return <MaterialCommunityIcons name={name as MCIName} size={size} color={color} />;
}
