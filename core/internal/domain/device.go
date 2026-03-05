package domain

// Device holds device registry data stored in identity.sqlite.
type Device struct {
	ID        string
	Name      string
	TokenHash []byte // SHA-256 hash of CLIENT_TOKEN (admin/bootstrap path only)
	PublicKey []byte // Raw 32-byte Ed25519 public key for paired devices
	DID       string // did:key:z6Mk... for paired devices
	Revoked   bool
	LastSeen  int64 // Unix timestamp
}

// DeviceToken holds the raw token and its hash for a paired device.
type DeviceToken struct {
	Raw  string // plaintext CLIENT_TOKEN (never stored)
	Hash []byte // SHA-256 hash (stored in device registry)
}

// PairedDevice holds metadata for a paired device.
type PairedDevice struct {
	TokenID   string
	Name      string
	DID       string // did:key:z6Mk... for Ed25519 devices
	AuthType  string // "ed25519" (primary). "token" may exist only in older records.
	LastSeen  int64
	CreatedAt int64
	Revoked   bool
}

// PairResponse is the full response from a successful pairing.
type PairResponse struct {
	ClientToken string
	TokenID     string
	NodeDID     string
	WsURL       string
}
