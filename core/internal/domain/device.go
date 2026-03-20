package domain

// Device holds device registry data stored in identity.sqlite.
type Device struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	TokenHash []byte `json:"token_hash,omitempty"` // SHA-256 hash of CLIENT_TOKEN (admin/bootstrap path only)
	PublicKey []byte `json:"public_key,omitempty"` // Raw 32-byte Ed25519 public key for paired devices
	DID       string `json:"did,omitempty"`        // did:key:z6Mk... for paired devices
	Revoked   bool   `json:"revoked"`
	LastSeen  int64  `json:"last_seen"` // Unix timestamp
}

// DeviceToken holds the raw token and its hash for a paired device.
type DeviceToken struct {
	Raw  string `json:"raw,omitempty"` // plaintext CLIENT_TOKEN (never stored)
	Hash []byte `json:"hash"`         // SHA-256 hash (stored in device registry)
}

// PairedDevice holds metadata for a paired device.
type PairedDevice struct {
	TokenID   string `json:"token_id"`
	Name      string `json:"name"`
	DID       string `json:"did,omitempty"`  // did:key:z6Mk... for Ed25519 devices
	AuthType  string `json:"auth_type"`      // "ed25519" (primary). "token" may exist only in older records.
	Role      string `json:"role"`           // "user" (personal CLI) or "agent" (OpenClaw/bot)
	LastSeen  int64  `json:"last_seen"`
	CreatedAt int64  `json:"created_at"`
	Revoked   bool   `json:"revoked"`
}

// Device role constants.
const (
	DeviceRoleUser  = "user"
	DeviceRoleAgent = "agent"
)

// PairResponse is the full response from a successful pairing.
type PairResponse struct {
	ClientToken string `json:"client_token,omitempty"`
	TokenID     string `json:"token_id"`
	NodeDID     string `json:"node_did"`
	WsURL       string `json:"ws_url,omitempty"`
}
