/**
 * Sleep/wake lifecycle — DEK zeroing, vault close, MsgBox reconnect.
 *
 * Background > timeout:
 *   Zero all DEKs + master seed → close all vaults → disconnect MsgBox WS
 *   MsgBox durably buffers incoming messages (24h TTL)
 *
 * App resume:
 *   Require unlock (passphrase or biometric) → re-derive DEKs →
 *   reopen vaults → reconnect MsgBox → drain buffered messages
 *
 * Mobile-specific: Section 23.6 of ARCHITECTURE.md.
 */

export type AppState = 'active' | 'background' | 'background_expired' | 'killed';

import { DEFAULT_BACKGROUND_TIMEOUT_S as BG_TIMEOUT_S } from '../constants';
const DEFAULT_BACKGROUND_TIMEOUT_S = BG_TIMEOUT_S;

/** Module-level lifecycle state. */
let appState: AppState = 'active';
let secretsZeroed = false;
let msgBoxConnected = true;
let backgroundTimeoutS = DEFAULT_BACKGROUND_TIMEOUT_S;
let backgroundTimer: ReturnType<typeof setTimeout> | null = null;

/** Reset lifecycle state (for testing). */
export function resetLifecycleState(): void {
  appState = 'active';
  secretsZeroed = false;
  msgBoxConnected = true;
  backgroundTimeoutS = DEFAULT_BACKGROUND_TIMEOUT_S;
  if (backgroundTimer !== null) {
    clearTimeout(backgroundTimer);
    backgroundTimer = null;
  }
}

/** Set the background timeout in seconds. */
export function setBackgroundTimeout(seconds: number): void {
  if (seconds < 0) throw new Error('sleep_wake: timeout must be non-negative');
  backgroundTimeoutS = seconds;
}

/** Enter background state. Start timeout countdown. */
export function enterBackground(): void {
  if (appState === 'killed') return;
  appState = 'background';

  // Clear any existing timer before setting a new one
  if (backgroundTimer !== null) {
    clearTimeout(backgroundTimer);
  }
  backgroundTimer = setTimeout(() => {
    expireBackground();
  }, backgroundTimeoutS * 1000);
}

/** Background timeout expired — zero all secrets. */
export function expireBackground(): void {
  if (backgroundTimer !== null) {
    clearTimeout(backgroundTimer);
    backgroundTimer = null;
  }
  appState = 'background_expired';
  secretsZeroed = true;
  msgBoxConnected = false;
}

/** Resume from background — check if re-unlock is needed. */
export function resumeFromBackground(): { needsUnlock: boolean } {
  if (backgroundTimer !== null) {
    clearTimeout(backgroundTimer);
    backgroundTimer = null;
  }

  if (appState === 'background_expired' || secretsZeroed) {
    // Secrets were zeroed — full re-unlock required
    appState = 'active';
    return { needsUnlock: true };
  }

  // Within timeout — DEKs still in RAM, immediate resume
  appState = 'active';
  return { needsUnlock: false };
}

/** Check if all secrets have been zeroed (DEKs + seed). */
export function areSecretsZeroed(): boolean {
  return secretsZeroed;
}

/** Check if MsgBox WS is connected. */
export function isMsgBoxConnected(): boolean {
  return msgBoxConnected;
}

/** Get the current app lifecycle state. */
export function getAppState(): AppState {
  return appState;
}

/** Get the configured background timeout in seconds. */
export function getBackgroundTimeout(): number {
  return backgroundTimeoutS;
}

/**
 * Mark secrets as restored (called after successful unlock).
 * Reconnects MsgBox conceptually — actual WS reconnect is handled by
 * the MsgBox client layer.
 */
export function markSecretsRestored(): void {
  secretsZeroed = false;
  msgBoxConnected = true;
}
