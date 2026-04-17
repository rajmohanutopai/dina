//go:build cgo

package test

import (
	"sync"
	"testing"

	"github.com/rajmohanutopai/dina/core/internal/service"
	"github.com/rajmohanutopai/dina/core/test/testutil"
)

// memServiceConfigStore is an in-memory port.ServiceConfigStore. It does
// not persist across instances and is only safe inside a single test.
type memServiceConfigStore struct {
	mu   sync.Mutex
	data string
}

func (s *memServiceConfigStore) Get() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data, nil
}
func (s *memServiceConfigStore) Put(cfg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data = cfg
	return nil
}

// Build a minimally-valid public config for tests. Callers mutate the
// returned struct to create specific failure modes.
//
// The schema_hash is the canonical SHA-256 produced by Brain's
// compute_schema_hash() for this exact schema; kept hardcoded so a
// drift in the canonicalizer implementation surfaces as a test
// failure rather than silently recomputing against itself.
func validPublicConfig() *service.ServiceConfig {
	return &service.ServiceConfig{
		IsPublic: true,
		Name:     "Test Transit",
		Capabilities: map[string]service.CapabilityConfig{
			"eta_query": {ResponsePolicy: "auto"},
		},
		CapabilitySchemas: map[string]service.CapabilitySchema{
			"eta_query": {
				Description: "Query ETA",
				Params: map[string]interface{}{
					"type":     "object",
					"required": []string{"route_id"},
					"properties": map[string]interface{}{
						"route_id": map[string]interface{}{"type": "string"},
					},
				},
				Result: map[string]interface{}{
					"type":     "object",
					"required": []string{"eta_minutes"},
					"properties": map[string]interface{}{
						"eta_minutes": map[string]interface{}{"type": "integer"},
					},
				},
				SchemaHash: "c48434dfc06a33520eb7543f29ef3a0aba7582d9ace25f5b9a838f84d27172ce",
			},
		},
		ServiceArea: &service.ServiceArea{Lat: 37.77, Lng: -122.43, RadiusKm: 10},
	}
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1150", "title": "Config_Put_AcceptsValidPublicConfig"}
func TestWS2_C01_ConfigPut_AcceptsValidPublicConfig(t *testing.T) {
	store := &memServiceConfigStore{}
	svc := service.NewServiceConfigService(store)
	err := svc.Put(validPublicConfig())
	testutil.RequireNoError(t, err)
	got, err := svc.Get()
	testutil.RequireNoError(t, err)
	if got == nil {
		t.Fatalf("expected stored config, got nil")
	}
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1151", "title": "Config_Put_RejectsPublicCapabilityWithoutSchema"}
func TestWS2_C02_ConfigPut_RejectsPublicCapabilityWithoutSchema(t *testing.T) {
	store := &memServiceConfigStore{}
	svc := service.NewServiceConfigService(store)
	cfg := validPublicConfig()
	delete(cfg.CapabilitySchemas, "eta_query")
	err := svc.Put(cfg)
	if err == nil {
		t.Fatal("expected Put to reject public capability with no schema")
	}
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1152", "title": "Config_Put_RejectsMissingSchemaHash"}
func TestWS2_C03_ConfigPut_RejectsMissingSchemaHash(t *testing.T) {
	store := &memServiceConfigStore{}
	svc := service.NewServiceConfigService(store)
	cfg := validPublicConfig()
	entry := cfg.CapabilitySchemas["eta_query"]
	entry.SchemaHash = ""
	cfg.CapabilitySchemas["eta_query"] = entry
	err := svc.Put(cfg)
	if err == nil {
		t.Fatal("expected Put to reject missing schema_hash")
	}
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1153", "title": "Config_Put_RejectsMalformedJSONSchema"}
func TestWS2_C04_ConfigPut_RejectsMalformedJSONSchema(t *testing.T) {
	store := &memServiceConfigStore{}
	svc := service.NewServiceConfigService(store)
	cfg := validPublicConfig()
	entry := cfg.CapabilitySchemas["eta_query"]
	// "type" must be a string or array, not an integer — compiler rejects.
	entry.Params = map[string]interface{}{"type": 42}
	cfg.CapabilitySchemas["eta_query"] = entry
	err := svc.Put(cfg)
	if err == nil {
		t.Fatal("expected Put to reject malformed JSON Schema")
	}
}

// TRACE: {"suite": "CORE", "case": "TST-CORE-1154", "title": "Config_Put_DropsMcpRoutingRequirement"}
func TestWS2_C05_ConfigPut_DropsMcpRoutingRequirement(t *testing.T) {
	// Auto capabilities used to require mcp_server + mcp_tool. The new
	// provider architecture delegates execution to OpenClaw so that gate
	// has been removed. A config without those fields must now succeed.
	store := &memServiceConfigStore{}
	svc := service.NewServiceConfigService(store)
	cfg := validPublicConfig()
	c := cfg.Capabilities["eta_query"]
	c.MCPServer = ""
	c.MCPTool = ""
	cfg.Capabilities["eta_query"] = c
	err := svc.Put(cfg)
	testutil.RequireNoError(t, err)
}
