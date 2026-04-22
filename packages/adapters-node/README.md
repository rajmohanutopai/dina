# `@dina/adapters-node`

Meta package that re-exports every Node-target adapter under
capability-named aliases. Thin convenience wrapper — no logic,
no runtime code of its own.

## Who should use this vs the granular packages

| Consumer | Import from |
|---|---|
| `apps/home-node-lite/*` (Fastify Core + Brain server inside this repo) | `@dina/adapters-node` |
| External TS consumers who want a specific capability | the granular package (`@dina/fs-node`, `@dina/keystore-node`, `@dina/crypto-node`, `@dina/net-node`) |

Apps get one stable import line. External consumers get minimal
dependency graphs — no pull of libraries they don't need (native
`argon2` etc. stay out of their tree).

## Capability aliases

```ts
// Filesystem (@dina/fs-node)
import { FileSystem, type FileSystemAdapter, type FileStat } from '@dina/adapters-node';
const fs = new FileSystem();
await fs.writeFile('/tmp/x', 'hello');

// Keystore (@dina/keystore-node)
import { FileKeystore, createKeytarKeystore, type Keystore } from '@dina/adapters-node';
const ks: Keystore = createKeytarKeystore() ?? new FileKeystore({ rootDir: '~/.dina' });

// Crypto (@dina/crypto-node)
import { Crypto, type CryptoAdapter } from '@dina/adapters-node';
const crypto: CryptoAdapter = new Crypto();

// Network (@dina/net-node)
import {
  HttpClient,
  HttpClientWithRetry,
  createCanonicalRequestSigner,
} from '@dina/adapters-node';
const http = new HttpClientWithRetry(new HttpClient(), { maxRetries: 3 });
```

## What's NOT here yet

- **Storage** — `@dina/storage-node` is scaffolded (README picked
  `better-sqlite3-multiple-ciphers`) but the concrete adapter lands
  in Phase 3 tasks 3.6–3.19. When it does, this meta package will
  re-export `NodeSQLiteAdapter` + `NodeDBProvider`.

## Package layout

```
packages/adapters-node/
├── package.json       # workspace deps on the 4 granular packages
├── tsconfig.json
├── src/
│   └── index.ts       # re-exports only (no runtime code)
└── README.md
```

## Treeshaking

TypeScript + a modern bundler (esbuild / tsup / vite) will tree-shake
unused exports from `@dina/adapters-node`. Only the capabilities you
actually import pull their transitive deps. Task 3.50 adds an
automated treeshaking verification step.

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md)
  Phase 3f.
- [packages/adapters-expo/README.md](../adapters-expo/README.md) —
  mobile counterpart.
