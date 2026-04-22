# Feature: PLC DID document

**What it is.** Every Dina publishes a W3C-compliant DID document
to its AT Protocol PLC entry. The document declares the Ed25519
signing key other peers use to verify messages from that Dina, and
the MsgBox relay endpoint (or direct HTTPS endpoint) where
envelopes can be delivered.

Dina's PLC document is standard W3C DID core with two Dina-
specific conventions.

## Required shape

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1"
  ],
  "id": "did:plc:<24+ lowercase alphanumeric>",
  "verificationMethod": [
    {
      "id": "did:plc:...#dina_signing",
      "type": "Multikey",
      "controller": "did:plc:...",
      "publicKeyMultibase": "z..."
    }
  ],
  "authentication": [
    "did:plc:...#dina_signing"
  ],
  "service": [
    {
      "id": "did:plc:...#dina_messaging",
      "type": "DinaMsgBox",
      "serviceEndpoint": "wss://msgbox.dinakernel.com/ws"
    }
  ]
}
```

## Dina-specific conventions

| What            | Value                                                       |
|-----------------|-------------------------------------------------------------|
| Signing-key fragment | `#dina_signing` (underscore form — AT Protocol convention) |
| Messaging-service fragment | `#dina_messaging`                                   |
| Verification-method type | `Multikey` (NOT `Ed25519VerificationKey2020`)         |
| Public-key encoding | Multibase base58btc (leading `z`)                        |
| Multicodec for Ed25519-pub | 0xed 0x01 varint (same as the did:key encoding)    |
| Service types | `DinaMsgBox` (relay) or `DinaDirectHTTPS` (direct delivery) |

**Backward-compat readers MUST also accept** the hyphenated forms
`#dina-signing` and `#dina-messaging` — pre-0.14 Dina builds emitted
the hyphen form; it's still in the wild.

## How to use the document

For outbound D2D delivery:
1. Resolve the recipient's `did:plc:...` against your PLC directory.
2. Extract `service[0].serviceEndpoint` (or look up by `#dina_messaging`
   fragment if `service[0]` doesn't match).
3. Extract the verification method with `#dina_signing` fragment.
4. Decode `publicKeyMultibase` → raw 32-byte Ed25519 public key.
5. Verify every inbound envelope's Ed25519 signature against that key.

For inbound auth handshake:
1. The `auth_response.pub` field MUST match the decoded multikey
   from the sender's `#dina_signing` verification method. A relay
   that sees a mismatch rejects the session.

## Source of truth

- Types: [`types/plc_document.ts`](../../src/types/plc_document.ts)
  — `DIDDocument`, `VerificationMethod`, `ServiceEndpoint`.
- Constants: `DINA_SIGNING_FRAGMENT`, `DINA_MESSAGING_FRAGMENT`,
  `DID_V1_CONTEXT`, `MULTIKEY_CONTEXT`, `SERVICE_TYPE_MSGBOX`,
  `SERVICE_TYPE_DIRECT_HTTPS` in [`constants.ts`](../../src/constants.ts).

## Vectors

- [`plc_document_verification.json`](../../conformance/vectors/plc_document_verification.json)
  — canonical shape with every Dina-specific convention pinned.
  L1 (shape only — no crypto).
- [`did_key_from_ed25519_pub.json`](../../conformance/vectors/did_key_from_ed25519_pub.json)
  — the `publicKeyMultibase` encoding algorithm (same bytes as
  `did:key:z...`).

## Conformance level

**L1** — shape conformance. Third-party implementations emit the
right fields with the right types; an Ed25519-signed round-trip
against the published key lands at L3 through the auth handshake
vector.

## See also

- Spec: [`../conformance.md`](../conformance.md) §8.
- did:key derivation (the same multicodec + multibase layer used
  for `publicKeyMultibase`): reference
  [`did_key_from_ed25519_pub.json`](../../conformance/vectors/did_key_from_ed25519_pub.json).
- Auth handshake (where `pub` must match this document's signing
  key): [`auth.md`](./auth.md).
