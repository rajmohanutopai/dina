package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
