# @dina/adapters-expo

Convenience meta-package. Re-exports every value from the 5 granular Expo adapter packages so apps inside this repo get one-dep ergonomics.

Apps inside this monorepo should depend on **this** package. External consumers (third-party builders, protocol implementers) should depend on the **granular** packages (`@dina/storage-expo`, etc.) directly for finer-grained control.

## Packages re-exported

| Granular              | Role                                       | Side-effect only? |
| --------------------- | ------------------------------------------ | ----------------- |
| `@dina/storage-expo`  | SQLCipher + op-sqlite DB adapter           | no                |
| `@dina/crypto-expo`   | crypto.getRandomValues + native Argon2 KDF | **yes**           |
| `@dina/fs-expo`       | expo-file-system URI helpers               | no                |
| `@dina/net-expo`      | RN WebSocket factory + MsgBox URL helper   | no                |
| `@dina/keystore-expo` | react-native-keychain wrapper              | no                |

## Install

Every native peerDep lives in the consuming Expo app (they ship iOS/Android modules that require an Expo prebuild):

```bash
# In apps/mobile
npm install \
  @op-engineering/op-sqlite \
  react-native-argon2 react-native-get-random-values \
  @ungap/structured-clone @stardazed/streams-text-encoding \
  expo-file-system \
  react-native-keychain
```

## Usage

```ts
// apps/mobile/app/_layout.tsx (expo-router entry) — MUST run before any
// other @dina/* module so the crypto globals are installed.
import '@dina/adapters-expo/polyfills';

// Everywhere else:
import {
  ProductionDBProvider,
  makeWSFactory,
  resolveMsgBoxURL,
  documentDirectoryUri,
  getSecret,
} from '@dina/adapters-expo';
```

## Design notes

- **Flat re-export.** All symbols from storage/fs/net/keystore are lifted into the meta's top-level namespace. Crypto is **not** re-exported here because it's side-effect-only; keep it off the main entrypoint so `import { … } from '@dina/adapters-expo'` is side-effect-free.
- **Polyfill subpath** (`./polyfills`) for the single `import '@dina/adapters-expo/polyfills'` side-effect call.
- **`workspace:*` dep on each granular package** via npm's `*` specifier (see [decision #9](../../docs/HOME_NODE_LITE_TASKS.md)). Meta tracks whatever HEAD is.

## See also

- [`@dina/adapters-node`](../adapters-node/) — future Node-side mirror with the same flat + polyfill subpath convention
- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md) Phase 1a' task 1.14.4
