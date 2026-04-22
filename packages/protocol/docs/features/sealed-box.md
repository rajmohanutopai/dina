# Feature: NaCl sealed-box

**What it is.** libsodium's `crypto_box_seal` — the scheme Dina
uses for encrypting a D2D envelope's ciphertext so only the
recipient's X25519 private key can decrypt it. Anonymous (no
sender authentication by the cipher; sender authentication comes
from the Ed25519 signature around it).

## The scheme, in pieces

1. Sender generates a fresh ephemeral X25519 keypair `(eph_priv, eph_pub)`.
2. Shared secret: `X25519(eph_priv, recipient_pub)`.
3. **Nonce** — deterministic so the recipient can recompute it:
   ```
   nonce = BLAKE2b-24(eph_pub || recipient_pub)
   ```
4. Ciphertext: `XSalsa20-Poly1305(shared_secret, nonce, plaintext)`.
5. On the wire: `eph_pub (32 bytes) || ciphertext_with_mac`.

The recipient decrypts by:
1. Reading the first 32 bytes as `eph_pub`.
2. Computing `shared_secret = X25519(recipient_priv, eph_pub)`.
3. Recomputing `nonce = BLAKE2b-24(eph_pub || recipient_pub)`.
4. Decrypting the remainder with `XSalsa20-Poly1305`.

## Why the nonce is pinned

Historical note (and the reason this section exists): Dina's Go
implementation pre-#9 derived the nonce as `SHA-512(input)[:24]`
instead of BLAKE2b-24. That produced different bytes than every
libsodium binding (Python PyNaCl, mobile native sodium, JS
tweetnacl), so sealed-boxes crossed between Go and anything else
failed to decrypt. The fix (#9) aligned Dina with the libsodium
formula. The BLAKE2b(24) vector is the regression gate.

## Libsodium reference function

`crypto_box_seal(message, recipient_pub)` — libsodium's public API
implements the algorithm above exactly. Any binding that calls the
underlying libsodium is compatible by construction:

- Rust `sodiumoxide`
- Python `PyNaCl`
- JS `libsodium-wrappers` / `libsodium-wrappers-sumo` / `sodium-native`
- Go `golang.org/x/crypto/nacl/box` (via `SealAnonymous`)
- C `libsodium` (reference)

Hand-rolled implementations that don't use BLAKE2b-24 for the nonce
are non-conforming regardless of what the sender thinks they're
implementing.

## Source of truth

- Reference implementation on the Dina Go side:
  `core/internal/adapter/crypto/nacl.go:sealNonce`.
- Reference implementation on the Dina TS side: consumers import
  `libsodium-wrappers` or `tweetnacl-sealedbox-js` from their
  platform adapter (`@dina/crypto-node` / `@dina/crypto-expo`);
  `@dina/protocol` itself ships no crypto backend.

## Vectors

- [`blake2b_24_sealed_nonce.json`](../../conformance/vectors/blake2b_24_sealed_nonce.json)
  — 3 cases pinning the nonce formula. Includes a regression guard
  asserting `BLAKE2b(24) != SHA-512(input)[:24]`.
- [`nacl_sealed_box.json`](../../conformance/vectors/nacl_sealed_box.json)
  — 3 full encrypt/decrypt cases (hello_dina, empty, json_body)
  with a shipped recipient keypair. The conformance suite imports
  `libsodium-wrappers` lazily for this vector; external ports
  decrypt with their own libsodium binding.

## Conformance level

- **L2** for the nonce formula (hash re-derivation — task 10.9).
- **L3** for full encrypt/decrypt round-trip (task 10.10): decrypt
  the frozen ciphertexts with the shipped recipient private key,
  match plaintexts byte-exactly, verify that tampering any byte
  of a ciphertext causes the Poly1305 MAC to fail.

## See also

- Spec: [`../conformance.md`](../conformance.md) §11 (sealed-box).
- D2D envelope (the layer the sealed-box ciphertext lives inside):
  [`d2d-envelope.md`](./d2d-envelope.md).
