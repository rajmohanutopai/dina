# `@dina/net-node`

Network adapter for the Node build target (Fastify Core + Fastify
Brain). Implements `HttpClient` from `@dina/core` and provides the
canonical-request signer Brain's `HttpCoreTransport` consumes.

## Status

**Phase 3d in progress** — see `docs/HOME_NODE_LITE_TASKS.md` 3.34-3.39:

| Task | Status | Details |
|---|---|---|
| 3.34 | ✅ | Scaffold (this package) |
| 3.35 | ✅ | HTTP client + signed-request builder |
| 3.36 | pending | Retry with exponential backoff |
| 3.37 | pending | WebSocket client (`ws` peer dep) |
| 3.38 | pending | Reconnect helper |
| 3.39 | pending | Unit tests |

## Contents (today)

### `NodeHttpClient`

Implements `HttpClient` from `@dina/core` using the global `fetch`
that Node 22+ ships (`undici` under the hood). Suitable as the
`httpClient` DI point for `HttpCoreTransport`.

```ts
import { NodeHttpClient } from '@dina/net-node';
import { HttpCoreTransport } from '@dina/core';

const transport = new HttpCoreTransport({
  baseUrl: 'http://localhost:8100',
  httpClient: new NodeHttpClient({ timeoutMs: 30_000 }),
  signer: /* see createCanonicalRequestSigner below */,
});
```

### `createCanonicalRequestSigner(config)`

Produces a `CanonicalRequestSigner` implementation. Signs each
request with Brain's Ed25519 key using Dina's canonical payload
recipe — `METHOD\nPATH\nQUERY\nTIMESTAMP\nNONCE\nSHA256_HEX(BODY)`
(via `@dina/protocol.buildCanonicalPayload`).

```ts
import { createCanonicalRequestSigner } from '@dina/net-node';
import { NodeCryptoAdapter } from '@dina/crypto-node';

const crypto = new NodeCryptoAdapter();
const signer = createCanonicalRequestSigner({
  did: 'did:plc:brain-01',
  privateKey: brainSigningKey,   // 32-byte Ed25519 seed
  sign: (priv, msg) => crypto.ed25519Sign(priv, msg),
  // nonce + now default to node:crypto.randomBytes + Date.now
});
```

Tests inject deterministic `nonce` + `now` for reproducible signatures.

## What's NOT in this package

- Retry logic — lands as a separate helper in task 3.36 so callers
  opt-in per request (some endpoints shouldn't be retried).
- WebSocket client — task 3.37, uses `ws` as an optional peer dep.
  Dynamic-import pattern so the package still installs on machines
  without `ws`.
- Fastify route handlers — those belong in `apps/home-node-lite/`.

## Runtime dependencies

- **`@noble/hashes`** (direct) — SHA-256 for body hashing in the
  canonical signing path.
- **`ws`** (peer, optional) — WebSocket client binding. Not used by
  HTTP client + signed-request builder (tasks 3.34-3.35); lands when
  3.37 does.
- **Node 22+** built-in `globalThis.fetch` — no `undici` npm dep needed.

## See also

- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md)
  Phase 3d.
- [packages/core/src/client/http-transport.ts](../core/src/client/http-transport.ts) —
  the `HttpCoreTransport` that consumes this package's `NodeHttpClient`.
