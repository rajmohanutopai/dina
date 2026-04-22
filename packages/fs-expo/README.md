# @dina/fs-expo

Filesystem adapter for the Expo mobile build target. Wraps `expo-file-system` for the use-cases the mobile app actually has today — full `FsPort` interface lands in Phase 2.

## Install

`expo-file-system` must be installed **in the consuming Expo app** — it ships a native iOS/Android module that requires an Expo prebuild. Declared as a `peerDependency`.

```bash
# In apps/mobile
npm install expo-file-system
```

## Usage

```ts
import { documentDirectoryUri, cacheDirectoryUri } from '@dina/fs-expo';

const vaultDir = documentDirectoryUri(); // file:///.../Documents/
const tmpDir = cacheDirectoryUri(); // file:///.../Library/Caches/
```

## Roadmap

Phase 2 expands this to full `FsPort` conformance from `@dina/core` — `readFile`, `writeFile` (tmp + atomic rename), `stat`, `exists`, `chmod`, `readdir`, `mkdir`. Pair with `@dina/fs-node` which implements the same port for the Node build target.

## See also

- [`@dina/storage-expo`](../storage-expo/) — SQLCipher adapter that consumes the document URI from this package
- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md) Phase 1a' task 1.14.3c
