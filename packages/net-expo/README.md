# @dina/net-expo

React Native / Expo network adapter. Thin wrappers over RN's global `WebSocket` and Expo's `process.env.EXPO_PUBLIC_*` convention.

## Install

Relies on React Native's built-in `WebSocket` global — no install beyond having React Native in the consuming app. Declared as a `peerDependency`.

## Usage

```ts
import { makeWSFactory, resolveMsgBoxURL, DEFAULT_MSGBOX_URL } from '@dina/net-expo';
import { setWSFactory, connectToMsgBox } from '@dina/core';

// At app startup:
setWSFactory(makeWSFactory());
await connectToMsgBox(resolveMsgBoxURL());
```

## Env var

Endpoint selection is delegated to `@dina/home-node`. `EXPO_PUBLIC_DINA_ENDPOINT_MODE=test|release` chooses the hosted fleet and `EXPO_PUBLIC_DINA_MSGBOX_URL` can override the MsgBox URL for custom infra.

## Roadmap

Phase 2 expands this to full `HttpClientPort` + `WebSocketClientPort` conformance from `@dina/core` — signed-request builder, retry/backoff, reconnect helper. Pair with `@dina/net-node` which implements the same ports via undici + the `ws` npm package for the Node build target.

## See also

- [`@dina/core`](../core/) — `WSFactory` / `WSLike` types this package implements
- [docs/HOME_NODE_LITE_TASKS.md](../../docs/HOME_NODE_LITE_TASKS.md) Phase 1a' task 1.14.3d
