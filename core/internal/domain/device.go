package domain

// Device holds device registry data stored in identity.sqlite.
type Device struct {
	ID        string
	Name      string
	TokenHash []byte // SHA-256 hash of the CLIENT_TOKEN (nil for signature-auth devices)
	PublicKey []byte // Raw 32-byte Ed25519 public key (nil for legacy token devices)
	DID       string // did:key:z6Mk... (empty for legacy token devices)
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
	DID       string // did:key:z6Mk... for Ed25519 devices, empty for legacy
	AuthType  string // "ed25519" or "token"
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
