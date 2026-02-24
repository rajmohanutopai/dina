package port

import (
	"context"

	"github.com/anthropics/dina/core/internal/domain"
)

// DevicePairer handles the 6-digit pairing ceremony.
type DevicePairer interface {
	GenerateCode(ctx context.Context) (code string, secret []byte, err error)
	CompletePairing(ctx context.Context, code, deviceName string) (clientToken string, err error)
	CompletePairingFull(ctx context.Context, code, deviceName string) (*domain.PairResponse, error)
	CompletePairingWithKey(ctx context.Context, code, deviceName, publicKeyMultibase string) (deviceID string, nodeDID string, err error)
	ListDevices(ctx context.Context) ([]domain.PairedDevice, error)
	RevokeDevice(ctx context.Context, tokenID string) error
}
