# @dina/keystore-expo

Keystore adapter for the Expo mobile build target. Thin wrapper over `react-native-keychain` that exposes a single-string-value API keyed by `service`.

## Install

`react-native-keychain` must be installed **in the consuming Expo app** — ships native iOS Keychain / Android Keystore modules that require a prebuild. Declared as a `peerDependency`.

```bash
# In apps/mobile
npm install react-native-keychain
```

## Usage

```ts
import { getSecret, setSecret, deleteSecret } from '@dina/keystore-expo';

await setSecret('dina.identity', 'did:plc:abc123');
const did = await getSecret('dina.identity'); // 'did:plc:abc123' | null
await deleteSecret('dina.identity');
```

Per-service conventions Dina uses today:

| service                  | content                                |
| ------------------------ | -------------------------------------- |
| `dina.identity`          | current `did:plc:…`                    |
| `dina.identity.signing`  | SLIP-0010 signing-key seed (hex)       |
| `dina.identity.rotation` | secp256k1 rotation-key seed (hex)      |
| `dina.seed.wrapped`      | AES-256-GCM wrapped master seed (JSON) |
| `dina.role`              | user's role preference                 |
| `dina.ai.provider`       | active AI provider config              |

## Why not `expo-secure-store`?

The donor mobile app uses `react-native-keychain` for its richer iOS Keychain access-control options (biometric prompts, access groups for app extensions). `expo-secure-store` is simpler but lacks those controls. When `KeystorePort` is defined in `@dina/core` (Phase 2), this package will conform to it; a hypothetical `@dina/keystore-expo-securestore` could offer the lighter alternative.

## Roadmap

Phase 2 adds `KeystorePort` conformance from `@dina/core` and pairs with `@dina/keystore-node` (file at mode 600 + optional keytar). Shared interface across platforms.

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md) Phase 1a' task 1.14.3e
