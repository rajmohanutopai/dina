// keystore.go — Secure key storage. Master seed wrapped by passphrase-derived
// KEK (Argon2id → AES-256-GCM) in Security mode, or plaintext keyfile in
// Convenience mode. DEKs derived on demand via HKDF.
package identity
