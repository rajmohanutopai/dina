# Per-feature docs (task 10.3)

Shortcut reference for the five wire-format features an external
Dina implementation must reproduce. Each doc points at:

1. The exact wire rules.
2. The source-of-truth file under `packages/protocol/src/`.
3. The frozen vector(s) covering it.
4. The conformance level (L1-L4) per `../conformance.md` §3.

| Feature            | File                                        | Level       |
|--------------------|---------------------------------------------|-------------|
| Canonical signing  | [canonical-signing.md](./canonical-signing.md) | L2          |
| D2D envelope       | [d2d-envelope.md](./d2d-envelope.md)        | L2          |
| Auth handshake     | [auth.md](./auth.md)                        | L3          |
| Sealed-box         | [sealed-box.md](./sealed-box.md)            | L2 / L3     |
| PLC DID document   | [plc-document.md](./plc-document.md)        | L1          |

Start with whichever feature you're implementing. Each doc is
self-contained — you shouldn't need to cross-reference the others
just to understand one feature. They cross-link only where a
feature depends on another (e.g. the auth handshake uses the
signing key published in the PLC document).

For the full spec + level definitions + test-vector format, see
`../conformance.md`.
