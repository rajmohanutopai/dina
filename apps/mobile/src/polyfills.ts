/**
 * AI SDK polyfills for React Native.
 *
 * Must be imported before any AI SDK usage.
 * Required: structuredClone, TextEncoderStream, TextDecoderStream.
 */

import { Platform } from 'react-native';
import argon2 from 'react-native-argon2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { setKDFOverride } from '../../core/src/crypto/argon2id';

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
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('react-native-get-random-values');

// Native Argon2id binding — swaps the pure-JS Noble fallback for a
// native C impl (Argon2Swift on iOS, argon2kt on Android). At the
// server-matching 64 MiB / t=3 / p=4 profile this runs in ~200 ms
// on-device versus ~60 s with Noble in Hermes. The gate/unlock path
// becomes usable; without this registration the UnlockGate spins for
// minutes on a fresh vault or a returning unlock.
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

if (Platform.OS !== 'web') {
  // structuredClone polyfill
  if (typeof globalThis.structuredClone === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sc = require('@ungap/structured-clone');
    globalThis.structuredClone = sc.default ?? sc;
  }

  // TextEncoderStream / TextDecoderStream polyfills
  if (typeof globalThis.TextEncoderStream === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const streams = require('@stardazed/streams-text-encoding');
    globalThis.TextEncoderStream = streams.TextEncoderStream;
    globalThis.TextDecoderStream = streams.TextDecoderStream;
  }
}
