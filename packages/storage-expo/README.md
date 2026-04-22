# @dina/storage-expo

SQLCipher-encrypted SQLite storage adapter for the Expo mobile build target. Implements the `DatabaseAdapter` and `DBProvider` ports from `@dina/core`.

Paired with `@dina/storage-node` (Node build target). Both implement the same ports; consumers pick one based on runtime.

## Install

`@op-engineering/op-sqlite` must be installed **in the consuming Expo app** (it ships native iOS/Android modules that require an Expo prebuild). This package declares it as a `peerDependency`.

```bash
# In the app's own package.json
npm install @op-engineering/op-sqlite
```

## Usage

```ts
import { openSync } from '@op-engineering/op-sqlite';
import { ProductionDBProvider } from '@dina/storage-expo';
import { setDBProvider } from '@dina/core';

const provider = new ProductionDBProvider({
  dbDir: `${FileSystem.documentDirectory}vaults/`,
  masterSeed, // 32-byte seed from identity unlock
  userSalt, // 32-byte per-user salt
  openFn: openSync,
});
setDBProvider(provider);
```

After `setDBProvider`, every `@dina/core` subsystem (vault, kv, staging, contacts, reminders, audit, devices) transparently persists to SQLCipher.

## Contract

- Implements `DatabaseAdapter` (single-connection synchronous API) and `DBProvider` (identity + per-persona fanout) from `@dina/core`.
- Per-persona DEK derived via HKDF from master seed + user salt; SQLCipher gets the hex-encoded DEK via `PRAGMA key`.
- WAL journal + NORMAL synchronous on open for concurrent-read safety.
- `closeAll()` WAL-checkpoints each DB before release.

## See also

- `@dina/storage-node` — same ports, Node/SQLCipher build target
- `@dina/core` exports the `DatabaseAdapter` / `DBProvider` interfaces this package implements
- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md) Phase 1a' task 1.14.3a
