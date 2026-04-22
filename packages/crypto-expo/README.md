# @dina/crypto-expo

Runtime polyfills + native KDF override for the Expo mobile build target. Side-effect import that **must run first** at app startup.

## What it installs

1. **`crypto.getRandomValues`** — via `react-native-get-random-values`. React Native doesn't ship a native WebCrypto, and `@noble/ciphers`, `@noble/ed25519`, `@noble/hashes`, etc. all need secure random bytes.
2. **Native Argon2id KDF override** — swaps the pure-JS Noble fallback for `react-native-argon2` (`Argon2Swift` on iOS, `argon2kt` on Android). Without this, passphrase unlock takes ~60 s on Hermes at the server-matching 64 MiB / t=3 / p=4 profile. With it, ~200 ms.
3. **`structuredClone`** polyfill (via `@ungap/structured-clone`) — required by the Vercel AI SDK.
4. **`TextEncoderStream` / `TextDecoderStream`** polyfills (via `@stardazed/streams-text-encoding`) — for streaming LLM responses.

## Install

All native dependencies must be installed **in the consuming Expo app** (they ship native iOS/Android modules that require a prebuild). This package declares them as `peerDependencies`:

```bash
# In apps/mobile
npm install react-native-argon2 react-native-get-random-values \
  @ungap/structured-clone @stardazed/streams-text-encoding
```

## Usage

```ts
// apps/mobile/app/_layout.tsx (or expo-router entry)
import '@dina/crypto-expo';
// ...rest of app
```

A bare side-effect import. No named exports — the module installs globals as a side effect of evaluation. Don't re-order it after other `@dina/*` imports.

## Paired with

- `@dina/crypto-node` (future) — Node build target equivalent, using `node:crypto` + `argon2` npm package instead of the RN ports.

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md) Phase 1a' task 1.14.3b
- [packages/storage-expo/README.md](../storage-expo/README.md) — the Expo storage counterpart
