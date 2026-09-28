/**
 * Jest mock for `expo`.
 *
 * `expo`'s entry is TypeScript source that Jest does not transform, so any
 * test importing a module that reaches the native bridge through it (e.g.
 * `src/ai/attestation.ts`) would fail to load. The app uses only the
 * native-module helpers `expo` re-exports from `expo-modules-core`; this
 * mock gives the same "no native module present" defaults as that mock.
 * Tests that exercise native behaviour override with `jest.mock('expo', …)`.
 */

export {
  EventEmitter,
  NativeModule,
  requireNativeModule,
  requireOptionalNativeModule,
  SharedObject,
} from './expo-modules-core';
