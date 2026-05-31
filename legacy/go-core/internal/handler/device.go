package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/service"
)

// DeviceHandler exposes device pairing and management endpoints.
type DeviceHandler struct {
	Device *service.DeviceService
}

// HandleInitiatePairing handles POST /v1/pair/initiate. It generates a new
// 6-digit pairing code and returns it with an expiry duration.
func (h *DeviceHandler) HandleInitiatePairing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	code, _, err := h.Device.InitiatePairing(r.Context())
	if err != nil {
		if errors.Is(err, domain.ErrPairingTooManyCodes) {
			clientError(w, "too many pending pairing codes", http.StatusTooManyRequests, err)
		} else {
			clientError(w, "failed to initiate pairing", http.StatusInternalServerError, err)
		}
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
	Role               string `json:"role,omitempty"` // "user" (default) or "agent"
}

// HandleCompletePairing handles POST /v1/pair/complete. It validates the
// pairing code and registers the device. When public_key_multibase is provided,
// the device uses Ed25519 signature auth (no client token generated).
func (h *DeviceHandler) HandleCompletePairing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req completePairingRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.PublicKeyMultibase == "" {
		http.Error(w, `{"error":"public_key_multibase is required"}`, http.StatusBadRequest)
		return
	}

	deviceID, nodeDID, err := h.Device.CompletePairingWithKey(
		r.Context(), req.Code, req.DeviceName, req.PublicKeyMultibase, req.Role,
	)
	if err != nil {
		// Map sentinel errors to appropriate HTTP status codes.
		// No burn counter — Crockford Base32 8-char codes (32^8 = 1.1 trillion)
		// make brute-force mathematically infeasible.
		switch {
		case errors.Is(err, domain.ErrPairingInvalidCode):
			clientError(w, "invalid or expired pairing code", http.StatusUnauthorized, err)
		case errors.Is(err, domain.ErrPairingCodeUsed):
			clientError(w, "pairing code already used", http.StatusConflict, err)
		case errors.Is(err, domain.ErrPairingTooManyCodes):
			clientError(w, "too many pending pairing codes", http.StatusTooManyRequests, err)
		case errors.Is(err, domain.ErrInvalidInput):
			clientError(w, "invalid pairing request", http.StatusBadRequest, err)
		default:
			clientError(w, "pairing failed", http.StatusInternalServerError, err)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"device_id": deviceID,
		"node_did":  nodeDID,
	})
}

// HandleListDevices handles GET /v1/devices. It returns all paired devices,
// including revoked ones.
func (h *DeviceHandler) HandleListDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	devices, err := h.Device.ListDevices(r.Context())
	if err != nil {
		clientError(w, "failed to list devices", http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"devices": devices})
}

// HandleListAgents handles GET /v1/service/agents. Narrow read-only
// surface for Brain's service-discovery path: returns just the identity
// (name + did) of paired agent-role devices, with revoked entries
// filtered out. Exists so the provider-side ServiceHandler can render
// notifications like "Dispatching to busdriver-openclaw" without being
// given full /v1/devices access, which would also let Brain revoke
// devices.
func (h *DeviceHandler) HandleListAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	devices, err := h.Device.ListDevices(r.Context())
	if err != nil {
		clientError(w, "failed to list agents", http.StatusInternalServerError, err)
		return
	}

	agents := make([]map[string]string, 0, len(devices))
	for _, d := range devices {
		if d.Revoked {
			continue
		}
		if d.Role != "agent" {
			continue
		}
		agents = append(agents, map[string]string{
			"name": d.Name,
			"did":  d.DID,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"agents": agents})
}

// HandleRevokeDevice handles DELETE /v1/devices/{id}. It revokes a paired
// device's access token and returns 204 No Content.
func (h *DeviceHandler) HandleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	path := r.URL.Path
	id := path[strings.LastIndex(path, "/")+1:]
	if id == "" {
		http.Error(w, `{"error":"missing device id"}`, http.StatusBadRequest)
		return
	}

	if err := h.Device.RevokeDevice(r.Context(), id); err != nil {
		clientError(w, "failed to revoke device", http.StatusInternalServerError, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}


