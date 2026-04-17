// service_config.go — Service configuration for public service discovery.
//
// The service config determines whether this Home Node operates as a public
// service. It is the single local authority — Brain reads it to dispatch
// queries to the execution plane, and publishes it as an AT Protocol record
// for AppView indexing. Put() is the protocol gate: a public capability
// without a valid params+result JSON Schema is rejected at config write time
// so discovery / validation paths never have to paper over missing schemas.
package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/rajmohanutopai/dina/core/internal/port"
	"github.com/santhosh-tekuri/jsonschema/v5"
)

// ServiceConfig is the parsed service configuration.
// SchemaHash at the top level is deprecated — schema hashes live per
// capability inside CapabilitySchemas. The field is kept only so legacy
// configs parse without error.
type ServiceConfig struct {
	IsPublic          bool                        `json:"is_public"`
	Capabilities      map[string]CapabilityConfig `json:"capabilities"`
	CapabilitySchemas map[string]CapabilitySchema `json:"capability_schemas,omitempty"`
	ServiceArea       *ServiceArea                `json:"service_area,omitempty"`
	Name              string                      `json:"name"`
	Description       string                      `json:"description"`
}

// CapabilityConfig defines a single service capability's MCP routing.
type CapabilityConfig struct {
	ResponsePolicy string `json:"response_policy"` // "auto" or "review"
	MCPServer      string `json:"mcp_server"`
	MCPTool        string `json:"mcp_tool"`
}

// CapabilitySchema is the provider-published JSON Schema for a capability.
// Used for param validation (Brain) and result validation (Core bridge).
type CapabilitySchema struct {
	Description string                 `json:"description,omitempty"`
	Params      map[string]interface{} `json:"params,omitempty"`
	Result      map[string]interface{} `json:"result,omitempty"`
	SchemaHash  string                 `json:"schema_hash,omitempty"`
}

// ServiceArea defines the geographic area served.
type ServiceArea struct {
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	RadiusKm float64 `json:"radius_km"`
}

// ServiceConfigService provides parsed access to the local service config.
type ServiceConfigService struct {
	store port.ServiceConfigStore
}

// NewServiceConfigService creates a service config accessor.
func NewServiceConfigService(store port.ServiceConfigStore) *ServiceConfigService {
	return &ServiceConfigService{store: store}
}

// Get returns the parsed service config, or nil if not configured.
func (s *ServiceConfigService) Get() (*ServiceConfig, error) {
	raw, err := s.store.Get()
	if err != nil {
		return nil, fmt.Errorf("service_config: read: %w", err)
	}
	if raw == "" {
		return nil, nil
	}
	var cfg ServiceConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return nil, fmt.Errorf("service_config: parse: %w", err)
	}
	return &cfg, nil
}

// Put stores a service config. Validates (including full JSON Schema
// compile) before storing, and normalises each capability's schema_hash
// so downstream consumers can trust it. Fails closed on any problem: an
// invalid schema never lands in the store.
func (s *ServiceConfigService) Put(cfg *ServiceConfig) error {
	if cfg.IsPublic {
		if cfg.Name == "" {
			return fmt.Errorf("service_config: public service must have a name")
		}
		if len(cfg.Capabilities) == 0 {
			return fmt.Errorf("service_config: public service must have at least one capability")
		}
		if cfg.ServiceArea == nil {
			return fmt.Errorf("service_config: public service must have a service_area (lat/lng/radius)")
		}
	}

	// WS2: both "auto" and "review" response policies are supported.
	// Execution is performed by the provider's local execution plane
	// (OpenClaw) based on the structured payload — mcp_server / mcp_tool
	// are no longer required and are kept as optional annotations only.
	for name, cap := range cfg.Capabilities {
		if cap.ResponsePolicy != "auto" && cap.ResponsePolicy != "review" {
			return fmt.Errorf("service_config: capability %q has response_policy %q, must be \"auto\" or \"review\"",
				name, cap.ResponsePolicy)
		}
	}

	// Public services must ship a valid JSON Schema contract for every
	// capability, and every schema must compile. This is the protocol
	// gate — discovery and validation paths downstream rely on it.
	if cfg.IsPublic {
		if cfg.CapabilitySchemas == nil {
			cfg.CapabilitySchemas = map[string]CapabilitySchema{}
		}
		for name := range cfg.Capabilities {
			schema, ok := cfg.CapabilitySchemas[name]
			if !ok {
				return fmt.Errorf("service_config: public capability %q missing capability_schemas entry", name)
			}
			if len(schema.Params) == 0 {
				return fmt.Errorf("service_config: capability %q missing params schema", name)
			}
			if len(schema.Result) == 0 {
				return fmt.Errorf("service_config: capability %q missing result schema", name)
			}
			if err := compileJSONSchema(schema.Params); err != nil {
				return fmt.Errorf("service_config: capability %q params schema invalid: %w", name, err)
			}
			if err := compileJSONSchema(schema.Result); err != nil {
				return fmt.Errorf("service_config: capability %q result schema invalid: %w", name, err)
			}
			// The Brain-side admin API is the only writer of this config and
			// it always sets schema_hash via compute_schema_hash(). A missing
			// or mismatched hash here means the writer is broken; fail closed
			// so we never publish a capability whose version contract we
			// can't enforce.
			if schema.SchemaHash == "" {
				return fmt.Errorf("service_config: capability %q missing schema_hash", name)
			}
			expected, err := canonicalSchemaHash(schema)
			if err != nil {
				return fmt.Errorf("service_config: capability %q schema hash canonicalisation failed: %w", name, err)
			}
			if schema.SchemaHash != expected {
				return fmt.Errorf(
					"service_config: capability %q schema_hash mismatch (stored=%s canonical=%s) — publisher and enforcer would disagree",
					name, schema.SchemaHash, expected,
				)
			}
			cfg.CapabilitySchemas[name] = schema
		}
		// Strip any orphan schema entries that don't correspond to a
		// declared capability so published records stay tidy.
		for name := range cfg.CapabilitySchemas {
			if _, ok := cfg.Capabilities[name]; !ok {
				delete(cfg.CapabilitySchemas, name)
			}
		}
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("service_config: marshal: %w", err)
	}
	return s.store.Put(string(data))
}

// compileJSONSchema verifies that the supplied JSON Schema object compiles
// under the compiler defaults. The compiled schema is discarded — we only
// care that it's well-formed, so a broken schema is rejected here rather
// than at runtime when a request arrives.
func compileJSONSchema(schema map[string]interface{}) error {
	raw, err := json.Marshal(schema)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	c := jsonschema.NewCompiler()
	if err := c.AddResource("schema.json", bytes.NewReader(raw)); err != nil {
		return fmt.Errorf("add: %w", err)
	}
	if _, err := c.Compile("schema.json"); err != nil {
		return fmt.Errorf("compile: %w", err)
	}
	return nil
}

// canonicalSchemaHash computes SHA-256 of the canonical form of a
// capability schema. Must produce the exact same digest as Brain's
// capabilities.registry.compute_schema_hash() so the provider enforces
// exactly what AppView serves — otherwise a valid request from a correct
// requester would permanently fail with schema_version_mismatch.
//
// Canonical form: JSON with sorted keys, no whitespace, HTML-safe
// escaping disabled (so < > & pass through unchanged, matching Python's
// json.dumps default).
func canonicalSchemaHash(schema CapabilitySchema) (string, error) {
	canonical := map[string]interface{}{
		"description": schema.Description,
		"params":      schema.Params,
		"result":      schema.Result,
	}
	// Round-trip through Unmarshal so nested values are normalised to the
	// same Go types Brain's Python canonicaliser sees (numbers as
	// float64, not json.Number; nested maps/slices from interface{}).
	bytes0, err := json.Marshal(canonical)
	if err != nil {
		return "", err
	}
	var normalised interface{}
	if err := json.Unmarshal(bytes0, &normalised); err != nil {
		return "", err
	}
	buf := &bytes.Buffer{}
	encoder := json.NewEncoder(buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(normalised); err != nil {
		return "", err
	}
	// json.Encoder.Encode appends a trailing '\n' — strip it.
	digestInput := strings.TrimRight(buf.String(), "\n")
	sum := sha256.Sum256([]byte(digestInput))
	return hex.EncodeToString(sum[:]), nil
}

// IsPublic returns whether this node is a public service.
func (s *ServiceConfigService) IsPublic() bool {
	cfg, err := s.Get()
	if err != nil || cfg == nil {
		return false
	}
	return cfg.IsPublic
}

// HasCapability returns whether this node supports the given capability.
func (s *ServiceConfigService) HasCapability(capability string) bool {
	cfg, err := s.Get()
	if err != nil || cfg == nil {
		return false
	}
	_, ok := cfg.Capabilities[capability]
	return ok
}
