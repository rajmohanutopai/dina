/**
 * Bare side-effect import — installs every Expo-runtime polyfill the
 * Dina stack needs (crypto.getRandomValues, native Argon2id KDF,
 * structuredClone, TextEncoder/DecoderStream).
 *
 * Must be imported **once**, **first**, before any other `@dina/*` module
 * evaluates:
 *
 * ```ts
 * // apps/mobile/app/_layout.tsx or wherever expo-router boots
 * import '@dina/adapters-expo/polyfills';
 * // ...rest of the app
 * ```
 *
 * Delegates entirely to `@dina/crypto-expo`'s evaluation side-effects.
 * Separate subpath so `import '@dina/adapters-expo'` doesn't unexpectedly
 * install globals.
 */
import '@dina/crypto-expo';
