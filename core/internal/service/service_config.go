// service_config.go — Service configuration for public service discovery.
//
// The service config determines whether this Home Node operates as a public
// service. It is the single local authority — Brain reads it to route MCP
// tool calls, and publishes it as an AT Protocol record for AppView indexing.
package service

import (
	"encoding/json"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ServiceConfig is the parsed service configuration.
type ServiceConfig struct {
	IsPublic     bool                          `json:"is_public"`
	Capabilities map[string]CapabilityConfig   `json:"capabilities"`
	ServiceArea  *ServiceArea                  `json:"service_area,omitempty"`
	Name         string                        `json:"name"`
	Description  string                        `json:"description"`
}

// CapabilityConfig defines a single service capability.
type CapabilityConfig struct {
	ResponsePolicy string `json:"response_policy"` // "auto" (Phase 1 only)
	MCPServer      string `json:"mcp_server"`
	MCPTool        string `json:"mcp_tool"`
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

// Put stores a service config. Validates before storing.
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
	// Phase 1: only "auto" response policy is accepted.
	for name, cap := range cfg.Capabilities {
		if cap.ResponsePolicy != "auto" {
			return fmt.Errorf("service_config: capability %q has response_policy %q, only \"auto\" is supported in Phase 1",
				name, cap.ResponsePolicy)
		}
		if cap.MCPServer == "" || cap.MCPTool == "" {
			return fmt.Errorf("service_config: capability %q must have mcp_server and mcp_tool", name)
		}
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("service_config: marshal: %w", err)
	}
	return s.store.Put(string(data))
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
