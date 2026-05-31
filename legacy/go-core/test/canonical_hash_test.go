//go:build cgo

package test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/service"
)

// Python's compute_schema_hash produces SHA-256 over
// ``json.dumps(obj, sort_keys=True, separators=(",", ":"))``. Any drift
// in the Go side's canonicalizer would produce a different digest and
// cause every schema-hash check to fail with
// schema_version_mismatch — requesters could never complete a query.
// These tests lock in both the canonicalisation output AND its SHA-256.

// pythonCanonicalHash mirrors Brain's compute_schema_hash for test
// purposes: sorts map keys and emits separator-less JSON, then SHA-256.
// Uses json.Encoder with SetEscapeHTML(false) so < > & pass through
// like Python's json.dumps default.
func pythonCanonicalHash(t *testing.T, obj map[string]interface{}) string {
	t.Helper()
	// Canonicalise the same way the Service layer does: Marshal, then
	// Unmarshal-Marshal through encoder with SetEscapeHTML(false).
	raw, err := json.Marshal(obj)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var normalised interface{}
	if err := json.Unmarshal(raw, &normalised); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	var buf strings.Builder
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(normalised); err != nil {
		t.Fatalf("encode: %v", err)
	}
	digest := sha256.Sum256([]byte(strings.TrimRight(buf.String(), "\n")))
	return hex.EncodeToString(digest[:])
}

// TestCanonicalHash_MatchesPythonReferenceForEtaQuery asserts the exact
// hex digest for the eta_query schema. The literal is the value Python
// produced with json.dumps(sort_keys=True, separators=(",", ":")) at
// the time this protocol was specified. Any change in the canonicaliser
// that moves this constant means Brain and Core would stop agreeing.
func TestCanonicalHash_MatchesPythonReferenceForEtaQuery(t *testing.T) {
	// Mirrors the canonical eta_query capability schema that BusDriver
	// publishes — status required, eta_minutes only present when on_route.
	// The Python reference for this exact object is computed in
	// tests/release/test_rel_029_service_query.py.
	schema := service.CapabilitySchema{
		Description: "Query estimated time of arrival for a transit service.",
		Params: map[string]interface{}{
			"type":     "object",
			"required": []string{"route_id"},
			"properties": map[string]interface{}{
				"route_id": map[string]interface{}{"type": "string"},
				"location": map[string]interface{}{
					"type":     "object",
					"required": []string{"lat", "lng"},
					"properties": map[string]interface{}{
						"lat": map[string]interface{}{"type": "number"},
						"lng": map[string]interface{}{"type": "number"},
					},
				},
			},
		},
		Result: map[string]interface{}{
			"type":     "object",
			"required": []string{"status"},
			"properties": map[string]interface{}{
				"status": map[string]interface{}{
					"type": "string",
					"enum": []string{"on_route", "not_on_route", "out_of_service", "not_found"},
				},
				"eta_minutes":     map[string]interface{}{"type": "integer"},
				"route_name":      map[string]interface{}{"type": "string"},
				"vehicle_type":    map[string]interface{}{"type": "string"},
				"stop_name":       map[string]interface{}{"type": "string"},
				"stop_distance_m": map[string]interface{}{"type": "number"},
				"map_url":         map[string]interface{}{"type": "string"},
				"message":         map[string]interface{}{"type": "string"},
			},
		},
	}
	const want = "2886d1f82453b418f4e620219681b897cdfa536c2d9ee9b0f524605107117a71"

	store := &inMemServiceConfigStore{}
	svc := service.NewServiceConfigService(store)
	schema.SchemaHash = want
	cfg := &service.ServiceConfig{
		IsDiscoverable: true,
		Name:     "Test Transit",
		Capabilities: map[string]service.CapabilityConfig{
			"eta_query": {ResponsePolicy: "auto"},
		},
		CapabilitySchemas: map[string]service.CapabilitySchema{"eta_query": schema},
		ServiceArea:       &service.ServiceArea{Lat: 37.77, Lng: -122.43, RadiusKm: 10},
	}
	// Put accepts iff the supplied hash matches what Go canonicalises to.
	if err := svc.Put(cfg); err != nil {
		t.Fatalf("Go canonicalisation disagrees with Python reference: %v", err)
	}
}

// TestCanonicalHash_StableAcrossKeyOrder proves the hash doesn't depend
// on map-literal ordering — Go's json.Marshal sorts map keys, which is
// the property Python's sort_keys=True relies on.
func TestCanonicalHash_StableAcrossKeyOrder(t *testing.T) {
	// Two semantically identical schemas built with different key
	// ordering in the Go source. Their canonical hashes must agree.
	a := service.CapabilitySchema{
		Description: "x",
		Params:      map[string]interface{}{"a": 1, "b": 2, "c": 3},
		Result:      map[string]interface{}{"z": 9, "y": 8},
	}
	b := service.CapabilitySchema{
		Description: "x",
		Params:      map[string]interface{}{"c": 3, "b": 2, "a": 1},
		Result:      map[string]interface{}{"y": 8, "z": 9},
	}

	hashA := pythonCanonicalHash(t, map[string]interface{}{
		"description": a.Description, "params": a.Params, "result": a.Result,
	})
	hashB := pythonCanonicalHash(t, map[string]interface{}{
		"description": b.Description, "params": b.Params, "result": b.Result,
	})
	if hashA != hashB {
		t.Fatalf("canonical hash depends on map key order: %s vs %s", hashA, hashB)
	}
}

// TestCanonicalHash_DifferentSchemasProduceDifferentHashes is the
// anti-trivial check: if the canonicalizer ever starts producing the
// same hash for distinct inputs, this lights up.
func TestCanonicalHash_DifferentSchemasProduceDifferentHashes(t *testing.T) {
	h1 := pythonCanonicalHash(t, map[string]interface{}{
		"description": "one",
		"params":      map[string]interface{}{"type": "object"},
		"result":      map[string]interface{}{"type": "object"},
	})
	h2 := pythonCanonicalHash(t, map[string]interface{}{
		"description": "two",
		"params":      map[string]interface{}{"type": "object"},
		"result":      map[string]interface{}{"type": "object"},
	})
	if h1 == h2 {
		t.Fatalf("hashes collide for distinct schemas: %s", h1)
	}
}
