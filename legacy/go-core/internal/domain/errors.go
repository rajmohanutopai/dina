package domain

import "errors"

var (
	ErrPersonaLocked    = errors.New("persona locked")
	ErrPersonaNotFound  = errors.New("persona not found")
	ErrUnauthorized     = errors.New("unauthorized")
	ErrForbidden        = errors.New("forbidden")
	ErrRateLimited      = errors.New("rate limited")
	ErrSpoolFull        = errors.New("spool full")
	ErrMessageExpired   = errors.New("message expired")
	ErrDIDNotFound      = errors.New("DID not found")
	ErrInvalidSignature = errors.New("invalid signature")
	ErrVaultCorrupted   = errors.New("vault corrupted")
	ErrInvalidPersona   = errors.New("invalid persona name")
	ErrInvalidDID       = errors.New("invalid DID")
	ErrNotFound         = errors.New("not found")
	ErrItemNotFound     = errors.New("item not found")
	ErrInvalidInput     = errors.New("invalid input")
	ErrInvalidPath      = errors.New("invalid derivation path")
	ErrInvalidMnemonic    = errors.New("invalid mnemonic")
	ErrInvalidPassphrase = errors.New("invalid passphrase")
	ErrEgressBlocked     = errors.New("egress blocked by policy")
	ErrReplayDetected    = errors.New("replay detected")
	ErrPersonaExists        = errors.New("persona already exists")
	ErrAppViewNotConfigured = errors.New("appview not configured")
	ErrUnknownMessageType   = errors.New("unknown D2D message type")
	ErrInvalidD2DBody       = errors.New("invalid D2D message body")
	ErrNotAContact          = errors.New("recipient is not a contact")

	// Pairing errors (used by handler for HTTP status mapping).
	ErrPairingInvalidCode     = errors.New("pairing: invalid or expired pairing code")
	ErrPairingCodeUsed        = errors.New("pairing: pairing code already used")
	ErrPairingTooManyCodes    = errors.New("pairing: too many pending codes")
)
