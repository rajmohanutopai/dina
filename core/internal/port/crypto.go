package port

// MnemonicGenerator creates BIP-39 mnemonic phrases and derives seeds.
type MnemonicGenerator interface {
	Generate() (mnemonic string, seed []byte, err error)
	Validate(mnemonic string) error
	ToSeed(mnemonic, passphrase string) ([]byte, error)
}

// HDKeyDeriver derives hierarchical deterministic keys per SLIP-0010.
type HDKeyDeriver interface {
	DerivePath(seed []byte, path string) (pub, priv []byte, err error)
}

// KeyConverter converts between Ed25519 and X25519 key formats.
type KeyConverter interface {
	Ed25519ToX25519Private(ed25519Priv []byte) ([]byte, error)
	Ed25519ToX25519Public(ed25519Pub []byte) ([]byte, error)
}

// Encryptor provides NaCl crypto_box_seal encryption.
type Encryptor interface {
	SealAnonymous(plaintext, recipientPub []byte) ([]byte, error)
	OpenAnonymous(ciphertext, recipientPub, recipientPriv []byte) ([]byte, error)
}

// KeyWrapper provides AES-256-GCM master seed wrapping.
type KeyWrapper interface {
	Wrap(dek, kek []byte) ([]byte, error)
	Unwrap(wrapped, kek []byte) ([]byte, error)
}

// KEKDeriver derives Key Encryption Keys from passphrases using Argon2id.
type KEKDeriver interface {
	DeriveKEK(passphrase string, salt []byte) ([]byte, error)
}

// VaultDEKDeriver derives per-persona Data Encryption Keys via HKDF-SHA256.
type VaultDEKDeriver interface {
	DeriveVaultDEK(masterSeed []byte, personaID string, userSalt []byte) ([]byte, error)
}

// Signer provides Ed25519 signing and verification.
type Signer interface {
	GenerateFromSeed(seed []byte) (pub, priv []byte, err error)
	Sign(privateKey, message []byte) ([]byte, error)
	Verify(publicKey, message, signature []byte) (bool, error)
}
