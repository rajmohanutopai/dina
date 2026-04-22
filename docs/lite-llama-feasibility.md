# Local LLM on Home Node Lite — `node-llama-cpp` feasibility (task 5.29)

**Decision: INCLUDE (optional profile).** Detailed findings below.

## Library surveyed

[`node-llama-cpp`](https://node-llama-cpp.withcat.ai) — Node.js
bindings for `llama.cpp`, exposed as a high-level JS API (chat
sessions, embeddings, grammar, streaming). Maintained by the
WithCat team.

## Maturity signals (verified 2026-04-22)

| Signal                        | Value                                      |
|-------------------------------|--------------------------------------------|
| Latest version                | `3.18.1`                                   |
| Last npm publish              | 2026-03-17                                 |
| Last GitHub push              | 2026-04-12 (10 days ago)                   |
| Total versions published      | 135 (active release cadence)               |
| GitHub stars                  | 2,008                                      |
| Open issues                   | 27 (manageable — not abandoned)            |
| Archived?                     | No                                         |
| License                       | MIT                                        |
| Node engine                   | `>=20.0.0` (covers our `>=22` requirement) |

## Prebuilt binary matrix

`node-llama-cpp` ships binaries via `optionalDependencies` on
platform packages — `@node-llama-cpp/<platform>-<arch>[-<accel>]`.
Current v3.18.1 coverage:

| Platform / Arch       | CPU | GPU accel variants                 |
|-----------------------|-----|------------------------------------|
| linux-x64             | ✅  | `-cuda`, `-cuda-ext`, `-vulkan`    |
| linux-arm64           | ✅  | —                                  |
| linux-armv7l          | ✅  | —                                  |
| mac-arm64             | ✅  | Metal (default)                    |
| mac-x64               | ✅  | —                                  |
| win-x64               | ✅  | `-cuda`, `-cuda-ext`, `-vulkan`    |
| win-arm64             | ✅  | —                                  |

**All of Dina's target arches are covered** (task 3.2's matrix:
`linux-arm64`, `linux-amd64`, `darwin-arm64`, `darwin-x64`). Bonus:
Raspberry Pi 5 (linux-arm64) gets CPU inference out of the box;
NVIDIA boxes get CUDA; Apple Silicon gets Metal; Windows gets CUDA
or Vulkan.

No native build toolchain required on end-user machines — the same
install-time prebuild-fetch pattern as `better-sqlite3-multiple-
ciphers` (see `packages/storage-node/README.md`).

## API fit

Dina's Brain needs:

| Need                               | `node-llama-cpp` API                              |
|------------------------------------|---------------------------------------------------|
| Chat completion (streaming)        | `LlamaChatSession.prompt` (AsyncIterable stream)  |
| Function calling / JSON mode       | Grammar constraints + JSON schema                 |
| Embeddings (768-dim for Dina)      | `LlamaEmbeddingContext.getEmbeddingFor`           |
| Multi-turn context                 | `LlamaChatSession` holds history                  |
| Model load / unload (hot swap)     | `LlamaModel` lifecycle — explicit dispose         |
| Per-request seed / temperature     | Supported                                         |
| Token counting                     | `model.tokenize` / `model.detokenize`             |

Model format: GGUF (the current `llama.cpp` standard). Compatible
with Gemma 3n, Llama 3, Mistral, Phi-4, Qwen — everything Dina's
Go/Python stack can run via its own `llama.cpp` path.

## Parity with Go/Python `local-llm` profile

The Go/Python stack's optional `local-llm` Docker profile runs
`llama.cpp` in its own container (see root `docker-compose.yml`
`llama` service). The Lite equivalent is **in-process**:
`@dina/brain` (via `@dina/adapters-node`'s LLM port adapter) imports
`node-llama-cpp` and loads models from a path under `DINA_MODEL_DIR`.

- **Perf parity expected** — both stacks use the same underlying
  `llama.cpp` C++ engine; the JS binding is a thin wrapper around
  the native handle. Throughput is bounded by the backend, not the
  binding.
- **Deployment simpler** — no sidecar container on the Lite stack;
  Brain talks to the model directly via FFI.
- **Trade-off** — model memory sits in the Brain process's address
  space. Restarting Brain frees model memory; no cross-process
  sharing with other consumers. For a single-tenant Home Node this
  is fine.

## Recommendation

**Include as an optional LLM provider in `@dina/brain`** (Phase 5d —
LLM routing). Gate via:

- Env flag `DINA_LOCAL_LLM_ENABLED=true` (default off; keeps Brain
  lightweight when running against cloud providers only)
- `DINA_LOCAL_LLM_MODEL_PATH=/var/lib/dina/models/<name>.gguf`
- `DINA_LOCAL_LLM_CONTEXT_SIZE=<tokens>` (tuning)

Treat `node-llama-cpp` as a **peer dependency**, not a regular dep,
so consumers who don't need local inference don't pay the prebuild
download cost (~40–400 MB depending on acceleration).

## Not a blocker for M1

M1 ("pair + ask + remember + D2D delivery") ships with cloud
providers only. Local LLM slots into M2/M3 when the matching
feature-flag work lands. No infrastructure decisions need to be
locked now — the peer-dep arrangement keeps the option open.

## References

- Home page: https://node-llama-cpp.withcat.ai
- GitHub: https://github.com/withcatai/node-llama-cpp
- HOME_NODE_LITE_TASKS.md Phase 5d (task 5.29) — this feasibility check
- `ARCHITECTURE.md` — LLM provider abstraction
