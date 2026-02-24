package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/anthropics/dina/core/internal/service"
)

// DeviceHandler exposes device pairing and management endpoints.
type DeviceHandler struct {
	Device *service.DeviceService
}

// HandleInitiatePairing handles POST /v1/pair/initiate. It generates a new
// 6-digit pairing code and returns it with an expiry duration.
func (h *DeviceHandler) HandleInitiatePairing(w http.ResponseWriter, r *http.Request) {
	code, _, err := h.Device.InitiatePairing(r.Context())
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"code":       code,
		"expires_in": 300,
	})
}

// completePairingRequest is the JSON body for POST /v1/pair/complete.
type completePairingRequest struct {
	Code               string `json:"code"`
	DeviceName         string `json:"device_name"`
	PublicKeyMultibase string `json:"public_key_multibase,omitempty"`
}

// HandleCompletePairing handles POST /v1/pair/complete. It validates the
// pairing code and registers the device. When public_key_multibase is provided,
// the device uses Ed25519 signature auth (no client token generated).
// Otherwise falls back to legacy token auth.
func (h *DeviceHandler) HandleCompletePairing(w http.ResponseWriter, r *http.Request) {
	var req completePairingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	// Ed25519 signature-based pairing (new path).
	if req.PublicKeyMultibase != "" {
		deviceID, nodeDID, err := h.Device.CompletePairingWithKey(
			r.Context(), req.Code, req.DeviceName, req.PublicKeyMultibase,
		)
		if err != nil {
			http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"device_id": deviceID,
			"node_did":  nodeDID,
		})
		return
	}

	// Legacy token-based pairing.
	resp, err := h.Device.CompletePairing(r.Context(), req.Code, req.DeviceName)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// HandleListDevices handles GET /v1/devices. It returns all paired devices,
// including revoked ones.
func (h *DeviceHandler) HandleListDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := h.Device.ListDevices(r.Context())
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"devices": devices})
}

// HandleRevokeDevice handles DELETE /v1/devices/{id}. It revokes a paired
// device's access token and returns 204 No Content.
func (h *DeviceHandler) HandleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	id := path[strings.LastIndex(path, "/")+1:]
	if id == "" {
		http.Error(w, `{"error":"missing device id"}`, http.StatusBadRequest)
		return
	}

	if err := h.Device.RevokeDevice(r.Context(), id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
