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
	ErrInvalidInput     = errors.New("invalid input")
	ErrInvalidPath      = errors.New("invalid derivation path")
	ErrInvalidMnemonic    = errors.New("invalid mnemonic")
	ErrInvalidPassphrase = errors.New("invalid passphrase")
	ErrEgressBlocked     = errors.New("egress blocked by policy")
	ErrReplayDetected    = errors.New("replay detected")
	ErrPersonaExists        = errors.New("persona already exists")
	ErrAppViewNotConfigured = errors.New("appview not configured")
)
