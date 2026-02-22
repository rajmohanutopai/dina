package service

import (
	"context"
	"fmt"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// DeviceService manages the device pairing lifecycle. It coordinates the
// 6-digit pairing ceremony, device registration, listing, and revocation.
type DeviceService struct {
	pairer   port.DevicePairer
	registry port.DeviceRegistry
	clock    port.Clock
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

	return resp, nil
}

// ListDevices returns all paired devices, including revoked ones.
func (s *DeviceService) ListDevices(ctx context.Context) ([]domain.PairedDevice, error) {
	devices, err := s.pairer.ListDevices(ctx)
	if err != nil {
		return nil, fmt.Errorf("device: list devices: %w", err)
	}

	return devices, nil
}

// RevokeDevice revokes a paired device's access token, preventing future
// authentication. The device record is retained for audit purposes.
func (s *DeviceService) RevokeDevice(ctx context.Context, tokenID string) error {
	if tokenID == "" {
		return fmt.Errorf("device: %w: token ID is required", domain.ErrInvalidInput)
	}

	if err := s.pairer.RevokeDevice(ctx, tokenID); err != nil {
		return fmt.Errorf("device: revoke: %w", err)
	}

	return nil
}
