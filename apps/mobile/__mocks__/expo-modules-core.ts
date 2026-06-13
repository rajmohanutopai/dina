/**
 * Jest mock for `expo-modules-core`.
 *
 * The real package ships ESM that ts-jest can't parse (it's excluded by
 * transformIgnorePatterns), so ANY test that transitively imports a module
 * touching the native bridge — e.g. `src/ai/attestation.ts`, and through it
 * the onboarding `AiProviderSet` — fails to even load. This global default
 * returns "no native module present", which is the correct shape for the
 * simulator/Jest anyway.
 *
 * Tests that exercise native behaviour directly (see
 * `__tests__/ai/attestation.test.ts`) override this with a local
 * `jest.mock('expo-modules-core', …)`, which takes precedence.
 */

export const requireOptionalNativeModule = (): null => null;

export function requireNativeModule(): never {
  throw new Error('requireNativeModule is unavailable under Jest');
}

export class NativeModule {}
export class EventEmitter {}
export class SharedObject {}
