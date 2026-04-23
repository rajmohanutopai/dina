/**
 * Security settings hook — data layer for Settings → Security screen.
 *
 * Provides:
 *   - Passphrase change (old → new, with validation)
 *   - Background timeout configuration
 *   - Biometric toggle state
 *   - Active DEK count (how many personas are unlocked)
 *   - Security status summary
 *
 * Source: ARCHITECTURE.md Task 4.15
 */

import { changePassphrase, type WrappedSeed } from '@dina/core/src/crypto/aesgcm';
import {
  setBackgroundTimeout,
  getBackgroundTimeout,
  areSecretsZeroed,
  getAppState,
} from '@dina/core/src/lifecycle/sleep_wake';
import { listPersonas } from '@dina/core/src/persona/service';

export interface SecurityStatus {
  passphraseSet: boolean;
  biometricEnabled: boolean;
  backgroundTimeoutS: number;
  activePersonas: number;
  totalPersonas: number;
  secretsZeroed: boolean;
  appState: string;
}

export interface PassphraseValidation {
  valid: boolean;
  errors: string[];
}

/** In-memory biometric toggle state. */
let biometricEnabled = false;

/** In-memory wrapped seed reference (for passphrase change). */
let currentWrappedSeed: WrappedSeed | null = null;

import { PASSPHRASE_MIN_LENGTH, PASSPHRASE_MAX_LENGTH } from '@dina/core/src/constants';
const MIN_PASSPHRASE_LENGTH = PASSPHRASE_MIN_LENGTH;
const MAX_PASSPHRASE_LENGTH = PASSPHRASE_MAX_LENGTH;

/**
 * Initialize security state after unlock.
 */
export function initSecurity(wrappedSeed: WrappedSeed, biometric?: boolean): void {
  currentWrappedSeed = wrappedSeed;
  biometricEnabled = biometric ?? false;
}

/**
 * Get the current security status for display.
 */
export function getSecurityStatus(): SecurityStatus {
  const personas = listPersonas();
  const open = personas.filter((p) => p.isOpen).length;

  return {
    passphraseSet: currentWrappedSeed !== null,
    biometricEnabled,
    backgroundTimeoutS: getBackgroundTimeout(),
    activePersonas: open,
    totalPersonas: personas.length,
    secretsZeroed: areSecretsZeroed(),
    appState: getAppState(),
  };
}

/**
 * Validate a new passphrase before setting it.
 */
export function validatePassphrase(passphrase: string): PassphraseValidation {
  const errors: string[] = [];

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    errors.push(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  if (passphrase.length > MAX_PASSPHRASE_LENGTH) {
    errors.push(`Passphrase must be at most ${MAX_PASSPHRASE_LENGTH} characters`);
  }
  if (!/[A-Z]/.test(passphrase)) {
    errors.push('Include at least one uppercase letter');
  }
  if (!/[a-z]/.test(passphrase)) {
    errors.push('Include at least one lowercase letter');
  }
  if (!/[0-9]/.test(passphrase)) {
    errors.push('Include at least one number');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Change the passphrase.
 *
 * Unwraps the seed with old passphrase, re-wraps with new.
 * Returns the new wrapped seed on success, or an error message on failure.
 */
export async function doChangePassphrase(
  oldPassphrase: string,
  newPassphrase: string,
): Promise<{ success: boolean; error?: string }> {
  if (!currentWrappedSeed) {
    return { success: false, error: 'No wrapped seed available — unlock first' };
  }

  // Validate new passphrase
  const validation = validatePassphrase(newPassphrase);
  if (!validation.valid) {
    return { success: false, error: validation.errors.join('. ') };
  }

  if (oldPassphrase === newPassphrase) {
    return { success: false, error: 'New passphrase must be different from old' };
  }

  try {
    const newWrapped = await changePassphrase(oldPassphrase, newPassphrase, currentWrappedSeed);
    currentWrappedSeed = newWrapped;
    return { success: true };
  } catch (err) {
    return { success: false, error: 'Wrong old passphrase' };
  }
}

/**
 * Set the background timeout (in seconds).
 * The app will zero all DEKs + seed after this duration in background.
 */
export function setBackgroundTimeoutS(seconds: number): string | null {
  if (seconds < 30) return 'Timeout must be at least 30 seconds';
  if (seconds > 3600) return 'Timeout must be at most 1 hour';

  setBackgroundTimeout(seconds);
  return null;
}

/**
 * Toggle biometric unlock.
 */
export function setBiometric(enabled: boolean): void {
  biometricEnabled = enabled;
}

/**
 * Check if biometric is enabled.
 */
export function isBiometricEnabled(): boolean {
  return biometricEnabled;
}

/**
 * Get the passphrase strength label for a given passphrase.
 */
export function getPassphraseStrength(
  passphrase: string,
): 'weak' | 'fair' | 'strong' | 'very_strong' {
  let score = 0;

  if (passphrase.length >= 8) score++;
  if (passphrase.length >= 12) score++;
  if (passphrase.length >= 16) score++;
  if (/[A-Z]/.test(passphrase)) score++;
  if (/[a-z]/.test(passphrase)) score++;
  if (/[0-9]/.test(passphrase)) score++;
  if (/[^A-Za-z0-9]/.test(passphrase)) score++;

  if (score <= 2) return 'weak';
  if (score <= 4) return 'fair';
  if (score <= 5) return 'strong';
  return 'very_strong';
}

/**
 * Get available background timeout presets for the picker.
 */
export function getTimeoutPresets(): Array<{ value: number; label: string }> {
  return [
    { value: 60, label: '1 minute' },
    { value: 300, label: '5 minutes' },
    { value: 600, label: '10 minutes' },
    { value: 1800, label: '30 minutes' },
    { value: 3600, label: '1 hour' },
  ];
}

/**
 * Reset security state (for testing).
 */
export function resetSecurityHook(): void {
  currentWrappedSeed = null;
  biometricEnabled = false;
}
