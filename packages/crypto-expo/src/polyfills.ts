/**
 * AI SDK + crypto polyfills for React Native / Expo.
 *
 * Must be imported **first** at mobile-app startup (before any
 * `@dina/core` module evaluates). Effects installed:
 *
 *   1. `react-native-get-random-values` — installs `globalThis.crypto.getRandomValues`
 *      so `@noble/ciphers`, `@noble/ed25519`, `@noble/hashes`, etc. can
 *      generate random bytes. RN doesn't ship a native WebCrypto.
 *   2. Native Argon2id KDF override — swaps the pure-JS Noble fallback
 *      for the platform's native Argon2 binding (Argon2Swift / argon2kt).
 *      Pure-JS Argon2id at the server-matching 64 MiB / t=3 / p=4 profile
 *      takes ~60 s on Hermes; native runs in ~200 ms.
 *   3. `structuredClone` polyfill (via `@ungap/structured-clone`) for the
 *      Vercel AI SDK, which assumes it globally.
 *   4. `TextEncoderStream` / `TextDecoderStream` polyfills for streaming
 *      LLM responses on platforms where RN hasn't shipped them yet.
 *
 * Each effect is idempotent — the module is safe to import multiple times.
 *
 * Extracted from apps/mobile/src/polyfills.ts per docs/HOME_NODE_LITE_TASKS.md
 * task 1.14.3b.
 */

/* eslint-disable @typescript-eslint/no-require-imports */

import { Platform } from 'react-native';
import argon2 from 'react-native-argon2';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { setKDFOverride } from '@dina/core';

// 1. crypto.getRandomValues. MUST run first — step 2 below uses the noble
// hex helpers which themselves hit crypto lazily; step 3/4 don't, but
// consistency matters. The side-effectful require is intentional and
// must not be folded into a named import or tree-shaken away.
require('react-native-get-random-values');

// 2. Argon2id native binding.
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

// 3 + 4. Non-crypto polyfills (kept here for import-order reasons — the
// consumer wants one entrypoint to cover every global the app depends on).
if (Platform.OS !== 'web') {
  if (typeof globalThis.structuredClone === 'undefined') {
    const sc = require('@ungap/structured-clone');
    globalThis.structuredClone = sc.default ?? sc;
  }

  if (typeof globalThis.TextEncoderStream === 'undefined') {
    const streams = require('@stardazed/streams-text-encoding');
    globalThis.TextEncoderStream = streams.TextEncoderStream;
    globalThis.TextDecoderStream = streams.TextDecoderStream;
  }
}
