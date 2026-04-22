/**
 * Dina Design System — warm, elegant, minimal.
 *
 * Colour palette sourced from dina.html visualization.
 * Typography: system fonts matching Figtree / Plus Jakarta Sans feel.
 */

import { Platform } from 'react-native';

export const colors = {
  // Backgrounds
  bgPrimary: '#FAF8F5',
  bgSecondary: '#FFFFFF',
  bgTertiary: '#F0EDE8',
  bgCard: '#FFFFFF',

  // Text
  textPrimary: '#1C1917',
  textSecondary: '#57534E',
  textMuted: '#A8A29E',

  // Accent (dark, elegant)
  accent: '#1C1917',
  accentHover: '#44403C',

  // Border
  border: 'rgba(0,0,0,0.07)',
  borderLight: 'rgba(0,0,0,0.04)',

  // System colours (for layer indicators)
  core: '#2563EB',
  brain: '#059669',
  pds: '#7C3AED',
  llama: '#D97706',

  // Semantic
  success: '#059669',
  warning: '#D97706',
  error: '#DC2626',

  // Chat bubbles
  userBubble: '#1C1917',
  userBubbleText: '#FFFFFF',
  dinaBubble: '#F0EDE8',
  dinaBubbleText: '#1C1917',
  systemBubble: '#FAF8F5',

  // Tab bar
  tabActive: '#1C1917',
  tabInactive: '#A8A29E',

  // White for overlays
  white: '#FFFFFF',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  full: 9999,
} as const;

export const fonts = {
  sans: Platform.select({
    ios: 'System',
    android: 'Roboto',
    default: 'System',
  }),
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'monospace',
  }),
  // Serif for hero / brand text
  serif: Platform.select({
    ios: 'Georgia',
    android: 'serif',
    default: 'serif',
  }),
} as const;

export const shadows = {
  sm: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 6,
    },
    android: { elevation: 1 },
    default: {},
  }),
  md: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.07,
      shadowRadius: 16,
    },
    android: { elevation: 3 },
    default: {},
  }),
  lg: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.1,
      shadowRadius: 28,
    },
    android: { elevation: 6 },
    default: {},
  }),
} as const;
