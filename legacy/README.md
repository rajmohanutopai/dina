# Legacy Runtime References

These directories contain the original Go Core and Python Brain runtimes.

They are kept as behavior references for parity and audit work while the active
product direction moves to the shared TypeScript Home Node in `packages/` and
`apps/`.

- `go-core/`: old Go `dina-core` runtime.
- `python-brain/`: old Python `dina-brain` runtime.

Do not add new product behavior here unless you are explicitly maintaining the
legacy reference or a parity test. New Home Node work should normally happen in
the TypeScript packages and apps.
