/**
 * Secure store abstraction — interface for platform keychain.
 *
 * Two backends:
 *   - InMemorySecureStore: for testing (this file)
 *   - NativeSecureStore: react-native-keychain (plugged in after native build)
 *
 * The store manages:
 *   - Passphrase storage (encrypted by platform keychain)
 *   - Biometric access gating (Face ID / Touch ID / fingerprint)
 *   - Wrapped seed storage
 *   - Auto-clear on too many failed biometric attempts
 *
 * Security model:
 *   - Passphrase is NEVER stored in plaintext — the keychain encrypts it
 *   - Biometric gates access to the passphrase (optional shortcut)
 *   - The wrapped seed is stored separately (AES-256-GCM encrypted)
 *   - On 5 failed biometric attempts, the biometric entry is cleared
 *
 * Source: ARCHITECTURE.md Task 1.51
 */

export interface SecureStore {
  /**
   * Store the passphrase in the keychain.
   * @param passphrase — the raw passphrase (keychain encrypts it)
   * @param biometricEnabled — gate with biometric authentication
   */
  setPassphrase(passphrase: string, biometricEnabled: boolean): Promise<void>;

  /**
   * Retrieve the passphrase from the keychain.
   * If biometric is enabled, requires biometric verification first.
   * @throws if no passphrase stored or biometric fails
   */
  getPassphrase(): Promise<string>;

  /**
   * Check if a passphrase is stored.
   */
  hasPassphrase(): Promise<boolean>;

  /**
   * Clear the stored passphrase (on identity reset or logout).
   */
  clearPassphrase(): Promise<void>;

  /**
   * Store the wrapped seed blob.
   */
  setWrappedSeed(data: Uint8Array): Promise<void>;

  /**
   * Retrieve the wrapped seed blob.
   */
  getWrappedSeed(): Promise<Uint8Array | null>;

  /**
   * Clear the wrapped seed.
   */
  clearWrappedSeed(): Promise<void>;

  /**
   * Check if biometric is available on this device.
   */
  isBiometricAvailable(): Promise<boolean>;

  /**
   * Check if biometric is enabled for passphrase access.
   */
  isBiometricEnabled(): Promise<boolean>;

  /**
   * Enable or disable biometric gating.
   */
  setBiometricEnabled(enabled: boolean): Promise<void>;

  /**
   * Clear all secure storage (factory reset).
   */
  clearAll(): Promise<void>;
}

/**
 * In-memory SecureStore backend — for testing.
 *
 * Simulates keychain behavior without native modules.
 * Biometric "available" can be toggled for testing different device configs.
 */
import { BIOMETRIC_MAX_FAILURES } from '../constants';

export class InMemorySecureStore implements SecureStore {
  private passphrase: string | null = null;
  private wrappedSeed: Uint8Array | null = null;
  private biometricEnabled = false;
  private biometricAvailable = true;
  private failedBiometricAttempts = 0;

  /** Set whether biometric is "available" on this simulated device. */
  simulateBiometricAvailable(available: boolean): void {
    this.biometricAvailable = available;
  }

  /** Simulate a failed biometric attempt. */
  simulateBiometricFailure(): void {
    this.failedBiometricAttempts++;
    if (this.failedBiometricAttempts >= BIOMETRIC_MAX_FAILURES) {
      // Auto-clear on too many failures (security measure)
      this.biometricEnabled = false;
      this.failedBiometricAttempts = 0;
    }
  }

  /** Reset failure counter (on successful biometric). */
  resetBiometricFailures(): void {
    this.failedBiometricAttempts = 0;
  }

  async setPassphrase(passphrase: string, biometricEnabled: boolean): Promise<void> {
    if (!passphrase) throw new Error('secure_store: passphrase cannot be empty');
    this.passphrase = passphrase;
    this.biometricEnabled = biometricEnabled && this.biometricAvailable;
  }

  async getPassphrase(): Promise<string> {
    if (this.passphrase === null) {
      throw new Error('secure_store: no passphrase stored');
    }
    // In production, biometric verification happens here via react-native-keychain
    this.resetBiometricFailures();
    return this.passphrase;
  }

  async hasPassphrase(): Promise<boolean> {
    return this.passphrase !== null;
  }

  async clearPassphrase(): Promise<void> {
    this.passphrase = null;
    this.biometricEnabled = false;
  }

  async setWrappedSeed(data: Uint8Array): Promise<void> {
    this.wrappedSeed = new Uint8Array(data);
  }

  async getWrappedSeed(): Promise<Uint8Array | null> {
    return this.wrappedSeed ? new Uint8Array(this.wrappedSeed) : null;
  }

  async clearWrappedSeed(): Promise<void> {
    if (this.wrappedSeed) {
      // Zero the data before clearing (security)
      this.wrappedSeed.fill(0);
    }
    this.wrappedSeed = null;
  }

  async isBiometricAvailable(): Promise<boolean> {
    return this.biometricAvailable;
  }

  async isBiometricEnabled(): Promise<boolean> {
    return this.biometricEnabled;
  }

  async setBiometricEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.biometricAvailable) {
      throw new Error('secure_store: biometric not available on this device');
    }
    this.biometricEnabled = enabled;
  }

  async clearAll(): Promise<void> {
    await this.clearPassphrase();
    await this.clearWrappedSeed();
    this.failedBiometricAttempts = 0;
  }
}

/** Singleton store instance. */
let store: SecureStore = new InMemorySecureStore();

/**
 * Set the secure store implementation (for production: NativeSecureStore).
 */
export function setSecureStore(impl: SecureStore): void {
  store = impl;
}

/**
 * Get the current secure store instance.
 */
export function getSecureStore(): SecureStore {
  return store;
}

/**
 * Reset to in-memory store (for testing).
 */
export function resetSecureStore(): void {
  store = new InMemorySecureStore();
}
