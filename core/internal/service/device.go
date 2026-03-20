package service

import (
	"context"
	"fmt"

	"github.com/mr-tron/base58"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// DeviceService manages the device pairing lifecycle. It coordinates the
// 6-digit pairing ceremony, device registration, listing, and revocation.
type DeviceService struct {
	pairer         port.DevicePairer
	registry       port.DeviceRegistry
	keyRegistrar   port.DeviceKeyRegistrar
	tokenRegistrar port.ClientTokenRegistrar
	tokenRevoker   port.TokenRevoker
	clock          port.Clock
}

// NewDeviceService constructs a DeviceService with all required dependencies.
func NewDeviceService(
	pairer port.DevicePairer,
	registry port.DeviceRegistry,
	clock port.Clock,
) *DeviceService {
	return &DeviceService{
		pairer:   pairer,
		registry: registry,
		clock:    clock,
	}
}

// SetKeyRegistrar wires the auth key registrar so that pairing can register
// Ed25519 device keys for signature-based authentication.
func (s *DeviceService) SetKeyRegistrar(kr port.DeviceKeyRegistrar) {
	s.keyRegistrar = kr
}

// SetTokenRegistrar wires the auth token registrar for CLIENT_TOKEN
// registration when token-based pairing is explicitly used.
func (s *DeviceService) SetTokenRegistrar(tr port.ClientTokenRegistrar) {
	s.tokenRegistrar = tr
}

// SetTokenRevoker sets the token revoker for device revocation.
func (s *DeviceService) SetTokenRevoker(r port.TokenRevoker) {
	s.tokenRevoker = r
}

// InitiatePairing generates a new 6-digit pairing code for a device to use.
// The code is short-lived and must be presented by the device during
// CompletePairing. Returns the code and a shared secret for key derivation.
func (s *DeviceService) InitiatePairing(ctx context.Context) (code string, secret []byte, err error) {
	code, secret, err = s.pairer.GenerateCode(ctx)
	if err != nil {
		return "", nil, fmt.Errorf("device: generate pairing code: %w", err)
	}

	return code, secret, nil
}

// CompletePairing validates the pairing code and registers the device. On
// success the device is added to the registry and a client token is returned
// for future authentication.
func (s *DeviceService) CompletePairing(ctx context.Context, code, deviceName string) (*domain.PairResponse, error) {
	if code == "" {
		return nil, fmt.Errorf("device: %w: pairing code is required", domain.ErrInvalidInput)
	}
	if deviceName == "" {
		return nil, fmt.Errorf("device: %w: device name is required", domain.ErrInvalidInput)
	}

	resp, err := s.pairer.CompletePairingFull(ctx, code, deviceName)
	if err != nil {
		return nil, fmt.Errorf("device: complete pairing: %w", err)
	}

	// Register the CLIENT_TOKEN in the auth validator so future
	// bearer-based requests from this device are accepted.
	// Use the immutable token ID (not the mutable device name) as the
	// device identity so that revocation remains reliable if the name changes.
	if s.tokenRegistrar != nil && resp.ClientToken != "" {
		s.tokenRegistrar.RegisterClientToken(resp.ClientToken, resp.TokenID)
	}

	return resp, nil
}

// CompletePairingWithKey validates the pairing code and registers the device
// using an Ed25519 public key for signature-based authentication.
// No CLIENT_TOKEN is generated. Returns (deviceID, nodeDID, error).
func (s *DeviceService) CompletePairingWithKey(ctx context.Context, code, deviceName, publicKeyMultibase string, role ...string) (string, string, error) {
	if code == "" {
		return "", "", fmt.Errorf("device: %w: pairing code is required", domain.ErrInvalidInput)
	}
	if deviceName == "" {
		return "", "", fmt.Errorf("device: %w: device name is required", domain.ErrInvalidInput)
	}
	if publicKeyMultibase == "" {
		return "", "", fmt.Errorf("device: %w: public key is required", domain.ErrInvalidInput)
	}

	deviceID, nodeDID, err := s.pairer.CompletePairingWithKey(ctx, code, deviceName, publicKeyMultibase, role...)
	if err != nil {
		return "", "", fmt.Errorf("device: complete pairing with key: %w", err)
	}

	// SV2: Register the Ed25519 public key with the auth validator.
	// Fail loudly if registration cannot complete — a device that appears
	// paired but can't authenticate is worse than a failed pairing.
	if s.keyRegistrar == nil {
		return "", "", fmt.Errorf("device: %w: key registrar not configured", domain.ErrInvalidInput)
	}
	if len(publicKeyMultibase) < 2 || publicKeyMultibase[0] != 'z' {
		return "", "", fmt.Errorf("device: %w: invalid multibase prefix", domain.ErrInvalidInput)
	}
	raw, decErr := base58.Decode(publicKeyMultibase[1:])
	if decErr != nil {
		return "", "", fmt.Errorf("device: %w: base58 decode failed: %v", domain.ErrInvalidInput, decErr)
	}
	if len(raw) != 34 || raw[0] != 0xed || raw[1] != 0x01 {
		return "", "", fmt.Errorf("device: %w: invalid Ed25519 multicodec prefix", domain.ErrInvalidInput)
	}
	did := "did:key:" + publicKeyMultibase
	s.keyRegistrar.RegisterDeviceKey(did, raw[2:], deviceID)

	return deviceID, nodeDID, nil
}

// ListDevices returns all paired devices, including revoked ones.
func (s *DeviceService) ListDevices(ctx context.Context) ([]domain.PairedDevice, error) {
	devices, err := s.pairer.ListDevices(ctx)
	if err != nil {
		return nil, fmt.Errorf("device: list devices: %w", err)
	}

	return devices, nil
}

// GetDeviceByDID returns the device record for the given DID, or nil if not found.
func (s *DeviceService) GetDeviceByDID(ctx context.Context, did string) (*domain.PairedDevice, error) {
	return s.pairer.GetDeviceByDID(ctx, did)
}

// RevokeDevice revokes a paired device's access token, preventing future
// authentication. The device record is retained for audit purposes.
func (s *DeviceService) RevokeDevice(ctx context.Context, tokenID string) error {
	if tokenID == "" {
		return fmt.Errorf("device: %w: token ID is required", domain.ErrInvalidInput)
	}

	// SV3: Revoke ALL auth paths (Ed25519 key + bearer token + pairing record)
	// regardless of individual failures. A partial revocation where one auth
	// method still works is worse than a clean error.
	//
	// Order: revoke auth credentials FIRST, then mark device revoked.
	// If credential revocation fails, the device stays unrevoked (safe).
	if s.keyRegistrar != nil || s.tokenRevoker != nil {
		devices, listErr := s.pairer.ListDevices(ctx)
		if listErr != nil {
			return fmt.Errorf("device: revoke: list devices: %w", listErr)
		}
		for _, d := range devices {
			if d.TokenID == tokenID {
				// Always attempt both — don't short-circuit on first failure.
				if s.keyRegistrar != nil && d.DID != "" {
					s.keyRegistrar.RevokeDeviceKey(d.DID)
				}
				if s.tokenRevoker != nil && d.TokenID != "" {
					s.tokenRevoker.RevokeClientTokenByDevice(d.TokenID)
				}
				break
			}
		}
	}

	if err := s.pairer.RevokeDevice(ctx, tokenID); err != nil {
		return fmt.Errorf("device: revoke: %w", err)
	}

	return nil
}
