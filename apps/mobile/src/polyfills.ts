/**
 * Mobile-only platform polyfills.
 *
 * Everything inside the `Platform.OS !== 'web'` block runs on iOS +
 * Android only. The web build skips the whole block because browsers
 * ship all the relevant primitives natively:
 *
 *   - `crypto.getRandomValues`  → built-in Web Crypto API.
 *   - `structuredClone`         → built-in (Chrome 98+, Safari 15.4+).
 *   - `TextEncoderStream` etc.  → built-in (Encoding Streams API).
 *   - Argon2id KDF              → falls through to `@dina/core`'s
 *     `hash-wasm`-backed default in `packages/core/src/crypto/argon2id.ts`.
 *     `hash-wasm` uses WebAssembly directly; no override needed.
 *
 * Must be imported before any AI SDK usage on mobile.
 */

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Platform } from 'react-native';

import { setKDFOverride } from '@dina/core';

if (Platform.OS !== 'web') {
  // `crypto.getRandomValues` is used by `@noble/ciphers/utils.js::randomBytes`
  // and every other noble/scure helper our crypto stack (aesgcm, ed25519,
  // secp256k1 sign) leans on. React Native doesn't ship a native
  // implementation, so without this import every call would throw
  // `crypto.getRandomValues must be defined`. The polyfill installs a
  // syscall-backed `globalThis.crypto` the first time it's loaded — the
  // side-effectful import is the whole point, don't fold it into a named
  // symbol or tree-shake it away.
  //
  // This MUST be the first polyfill installed; other polyfills below may
  // themselves lean on `crypto` at module-eval time.
  //
  // Web doesn't need this — browsers ship `crypto.getRandomValues` natively.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-get-random-values');

  // Native Argon2id binding — swaps the pure-JS Noble fallback for a
  // native C impl (Argon2Swift on iOS, argon2kt on Android). At the
  // server-matching 64 MiB / t=3 / p=4 profile this runs in ~200 ms
  // on-device versus ~60 s with Noble in Hermes. The gate/unlock path
  // becomes usable; without this registration the UnlockGate spins for
  // minutes on a fresh vault or a returning unlock.
  //
  // Web KDF override is installed by `polyfills.web.ts` peer using
  // argon2-browser (WASM). The two peers register at the same shape so
  // downstream code never branches on platform.
  //
  // Dynamic require keeps `react-native-argon2`'s native bindings out
  // of the web bundle entirely — Metro tree-shakes the branch.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const argon2Module = require('react-native-argon2');
  const argon2 = argon2Module.default ?? argon2Module;
  setKDFOverride(async (passphrase, salt, params) => {
    const res = await argon2(passphrase, bytesToHex(salt), {
      iterations: params.iterations,
      memory: params.memory,
      parallelism: params.parallelism,
      hashLength: 32,
      mode: 'argon2id',
      saltEncoding: 'hex',
    });
    return hexToBytes(res.rawHash);
  });

  // structuredClone polyfill — needed on RN < 0.72 and on Hermes builds
  // that don't ship the global. Browsers ship it natively, skip on web.
  if (typeof globalThis.structuredClone === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sc = require('@ungap/structured-clone');
    globalThis.structuredClone = sc.default ?? sc;
  }

  // TextEncoderStream / TextDecoderStream polyfills — same reasoning,
  // browsers ship both natively.
  if (typeof globalThis.TextEncoderStream === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const streams = require('@stardazed/streams-text-encoding');
    globalThis.TextEncoderStream = streams.TextEncoderStream;
    globalThis.TextDecoderStream = streams.TextDecoderStream;
  }
}
