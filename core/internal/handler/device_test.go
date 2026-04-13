package handler

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/adapter/pairing"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// TRACE: {"suite": "CORE", "case": "2087", "section": "10", "sectionName": "Device Pairing", "subsection": "01", "scenario": "01", "title": "Pairing_10_RevokeDeviceMethodNotAllowed"}
func TestPairing_10_RevokeDeviceMethodNotAllowed(t *testing.T) {
	// The method guard must reject non-DELETE requests before touching the
	// service layer, so a nil Device service is fine here.
	h := &DeviceHandler{Device: nil}

	req := httptest.NewRequest(http.MethodGet, "/v1/devices/test-device-id", nil)
	rec := httptest.NewRecorder()

	h.HandleRevokeDevice(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected status %d, got %d", http.StatusMethodNotAllowed, rec.Code)
	}
}

// --- Helper: create a DeviceHandler backed by real PairingManager ---
type mockClock struct{}

func (c *mockClock) Now() time.Time                          { return time.Now() }
func (c *mockClock) After(d time.Duration) <-chan time.Time   { return time.After(d) }
func (c *mockClock) NewTicker(d time.Duration) *time.Ticker   { return time.NewTicker(d) }

type mockKeyRegistrar struct{}

func (r *mockKeyRegistrar) RegisterDeviceKey(did string, pub []byte, deviceID string) {}
func (r *mockKeyRegistrar) RevokeDeviceKey(did string)                                {}

// mockDeviceRegistry satisfies port.DeviceRegistry (not used by pairing path).
type mockDeviceRegistry struct{}

func (r *mockDeviceRegistry) Register(_ context.Context, _ string, _ []byte) (string, error) {
	return "", nil
}
func (r *mockDeviceRegistry) List(_ context.Context) ([]domain.Device, error) { return nil, nil }
func (r *mockDeviceRegistry) Revoke(_ context.Context, _ string) error        { return nil }

func newTestDeviceHandler(t *testing.T) (*DeviceHandler, *pairing.PairingManager) {
	t.Helper()
	pm := pairing.NewManager(pairing.Config{
		CodeTTL: 5 * time.Minute,
		NodeDID: "did:plc:testnode",
		WsURL:   "wss://test.local/ws",
	})
	svc := service.NewDeviceService(pm, &mockDeviceRegistry{}, &mockClock{})
	svc.SetKeyRegistrar(&mockKeyRegistrar{})
	return &DeviceHandler{Device: svc}, pm
}

func validMultibase(t *testing.T) string {
	t.Helper()
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	// Multibase: z + base58btc(0xed01 + 32-byte-pubkey)
	raw := append([]byte{0xed, 0x01}, pub...)
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	zeros := 0
	for _, b := range raw {
		if b != 0 {
			break
		}
		zeros++
	}
	result := make([]byte, 0, len(raw)*138/100+1)
	for _, b := range raw {
		carry := int(b)
		for i := range result {
			carry += int(result[i]) << 8
			result[i] = byte(carry % 58)
			carry /= 58
		}
		for carry > 0 {
			result = append(result, byte(carry%58))
			carry /= 58
		}
	}
	out := make([]byte, 0, zeros+len(result))
	for i := 0; i < zeros; i++ {
		out = append(out, '1')
	}
	for i := len(result) - 1; i >= 0; i-- {
		out = append(out, alphabet[result[i]])
	}
	return "z" + string(out)
}

// --- Wrong code → 401 Unauthorized ---
func TestCompletePairing_WrongCode_401(t *testing.T) {
	h, _ := newTestDeviceHandler(t)

	body := `{"code":"999999","device_name":"test","public_key_multibase":"` + validMultibase(t) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/pair/complete", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleCompletePairing(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong code: status = %d, want 401 (body: %s)", rec.Code, rec.Body.String())
	}
}

// --- Used code (deleted after first use) → 401 Unauthorized ---
// Note: The pairing manager deletes the code immediately after successful use,
// so a second attempt sees "invalid code" (not found), not "code used".
func TestCompletePairing_UsedCode_401(t *testing.T) {
	h, pm := newTestDeviceHandler(t)

	code, _, err := pm.GenerateCode(nil)
	if err != nil {
		t.Fatal(err)
	}

	// Use the code once (success).
	mb := validMultibase(t)
	body := `{"code":"` + code + `","device_name":"first","public_key_multibase":"` + mb + `"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/pair/complete", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleCompletePairing(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("first pairing: status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	// Try the same code again (used) — should get 401 (code deleted after use,
	// so it's "invalid or expired" not "already used").
	mb2 := validMultibase(t)
	body2 := `{"code":"` + code + `","device_name":"second","public_key_multibase":"` + mb2 + `"}`
	req2 := httptest.NewRequest(http.MethodPost, "/v1/pair/complete", strings.NewReader(body2))
	rec2 := httptest.NewRecorder()
	h.HandleCompletePairing(rec2, req2)

	// Code was deleted after first use, so it's now "invalid" (not found).
	if rec2.Code != http.StatusUnauthorized {
		t.Errorf("used code: status = %d, want 401 (body: %s)", rec2.Code, rec2.Body.String())
	}
}

// --- Missing public_key_multibase → 400 Bad Request ---
func TestCompletePairing_MissingKey_400(t *testing.T) {
	h, _ := newTestDeviceHandler(t)

	body := `{"code":"123456","device_name":"test"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/pair/complete", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleCompletePairing(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing key: status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}

// --- Empty code → 400 Bad Request (from ErrInvalidInput in service) ---
func TestCompletePairing_EmptyCode_400(t *testing.T) {
	h, _ := newTestDeviceHandler(t)

	body := `{"code":"","device_name":"test","public_key_multibase":"` + validMultibase(t) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/v1/pair/complete", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.HandleCompletePairing(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("empty code: status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}
