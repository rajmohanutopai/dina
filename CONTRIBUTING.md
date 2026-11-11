# Contributing to Dina

Thank you for helping. Dina is a personal AI that serves one person, the one
who holds its keys. Read [README.md](README.md) for the Four Laws and
[ARCHITECTURE.md](ARCHITECTURE.md) for how the parts fit, before you change
behaviour.

## What lives where

| Path | What it is |
|---|---|
| `packages/protocol/` | `@dina/protocol`, the wire contract. No runtime dependencies. |
| `packages/core/` | `@dina/core`, the vault keeper: storage, keys, signing, persona gates, D2D. |
| `packages/brain/` | `@dina/brain`, the analyst: ask and remember loops, model routing, PII scrubbing. Holds no keys. |
| `packages/home-node/` | Shared composition helpers for both hosts. |
| `packages/*-node`, `packages/*-expo` | Platform adapters for the server and the phone. |
| `apps/mobile/` | The Expo / React Native app. A full Home Node on the phone. |
| `apps/home-node-lite/` | The server Home Node: Core and Brain as two Fastify processes, plus the web app. |
| `appview/` | PeerLens AppView (Postgres). |
| `msgbox/` | The Go relay for nodes behind NAT. |
| `cli/` | The Python `dina-agent` CLI and coding-agent plugins. |

## Set up

You need Node 22 or later (`nvm use` reads `.nvmrc`).

```bash
npm install           # at the repo root; SQLCipher binaries come prebuilt
npm run typecheck
npm run lint
npm run format        # Prettier check; `npm run format:fix` rewrites
```

Run the server Home Node from source with `npm start` in
`apps/home-node-lite/core-server` and `apps/home-node-lite/brain-server`. Run
the phone app with `npm start` in `apps/mobile`.

## Tests

Jest covers every package and app. Run one package at a time, in band, with the
rate limit raised:

```bash
cd packages/core
DINA_RATE_LIMIT=100000 npx jest --runInBand
```

Running every suite at once in parallel uses more memory than most laptops
have. Other suites:

- `appview/`: Vitest; the integration suites need a migrated Postgres (see
  `appview/INTEGRATION_TEST_PLAN.md`).
- `apps/home-node-lite/web/__e2e__/`: Playwright runs against real Lite nodes
  (see `docs/E2E_TESTING.md`).
- `apps/mobile/maestro/`: phone flows on the iOS simulator.
- `cli/`: `pytest` from the `cli/` directory.

When a bug gets past the tests, add the test that would have caught it, and
prefer a contract test that closes the whole class of bug over a single
scenario.

## Rules that reviews hold you to

- **Core keeps the keys; Brain thinks.** Brain never touches SQLite or a key.
  Every vault read goes through Core's routes (`packages/core/src/server/routes/`).
- **No personal data in logs.** Log metadata only: persona, type, count,
  latency. Never vault content, queries, names or message text.
- **Every model call goes through `LLMRouter`,** which removes personal data
  on the way out and puts it back on the way in.
- **Personas are the owner's to configure.** Never hard-code a persona name;
  read the list at run time.
- **Wire changes are protocol changes.** JSON on the wire is `snake_case`. A
  change to an envelope or signed payload goes through
  `packages/protocol/docs/conformance.md` and its frozen vectors.
- **Silence First.** A new notification needs a reason in the Four Laws:
  silence would cause harm, or the owner asked.
- **No untrusted code inside the trust boundary.** Plugins are signed manifests
  run as data or out of process; agents talk to Dina over D2D or the CLI.

## Sending a change

1. Open an issue first for anything larger than a small fix, so we can agree
   on the approach.
2. Keep a pull request to one change. Include its tests and update the doc
   that describes the behaviour.
3. Make sure `npm run typecheck`, `npm run lint`, `npm run format` and the
   Jest suites of the packages you touched pass.

## Reporting a security problem

Please do not open a public issue. Use GitHub's private vulnerability
reporting (the repository's **Security** tab → **Report a vulnerability**).
[SECURITY.md](SECURITY.md) describes the threat model.

## Licence

Dina is MIT licensed ([LICENSE](LICENSE)). By contributing you agree that your
work is released under the same licence.
