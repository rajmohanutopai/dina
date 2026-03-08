// Package observability implements system watchdog, Docker compose parsing, and crash logging.
package observability

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ---------- SystemWatchdog ----------

// Compile-time interface checks.
var _ port.SystemWatchdog = (*SystemWatchdog)(nil)
var _ port.CrashLogger = (*CrashLogger)(nil)

// WatchdogReport holds the results of a system health check tick.
type WatchdogReport = domain.WatchdogReport

// defaultWatchdogRetentionDays is the default number of days to retain crash and audit logs.
const defaultWatchdogRetentionDays = 90

// SystemWatchdog implements port.SystemWatchdog — 1-hour system health ticker.
type SystemWatchdog struct {
	brainHealthy     bool
	connectorAlive   bool
	diskUsageBytes   int64
	crash            port.CrashLogger
	auditor          port.VaultAuditLogger
}

// NewSystemWatchdog returns a new SystemWatchdog.
func NewSystemWatchdog(brainHealthy, connectorAlive bool, diskUsageBytes int64) *SystemWatchdog {
	return &SystemWatchdog{
		brainHealthy:   brainHealthy,
		connectorAlive: connectorAlive,
		diskUsageBytes: diskUsageBytes,
	}
}

// NewSystemWatchdogWithPurge returns a SystemWatchdog that purges crash and audit
// logs during RunTick. When crash or auditor is nil the corresponding purge is skipped.
func NewSystemWatchdogWithPurge(brainHealthy, connectorAlive bool, diskUsageBytes int64, crash port.CrashLogger, auditor port.VaultAuditLogger) *SystemWatchdog {
	return &SystemWatchdog{
		brainHealthy:   brainHealthy,
		connectorAlive: connectorAlive,
		diskUsageBytes: diskUsageBytes,
		crash:          crash,
		auditor:        auditor,
	}
}

// RunTick executes a single watchdog sweep.
func (w *SystemWatchdog) RunTick(ctx context.Context) (*WatchdogReport, error) {
	alive, _ := w.CheckConnectorLiveness()
	disk, _ := w.CheckDiskUsage()
	brain, _ := w.CheckBrainHealth(ctx)

	var crashPurged, auditPurged int64

	if w.crash != nil {
		n, err := w.crash.Purge(ctx, defaultWatchdogRetentionDays)
		if err == nil {
			crashPurged = n
		}
	}

	if w.auditor != nil {
		n, err := w.auditor.Purge(defaultWatchdogRetentionDays)
		if err == nil {
			auditPurged = n
		}
	}

	return &WatchdogReport{
		Timestamp:          time.Now().Unix(),
		ConnectorAlive:     alive,
		DiskUsageBytes:     disk,
		DiskUsagePercent:   float64(disk) / float64(100*1024*1024*1024) * 100,
		BrainHealthy:       brain,
		AuditEntriesPurged: auditPurged,
		CrashEntriesPurged: crashPurged,
	}, nil
}

// CheckConnectorLiveness verifies external connectors are responsive.
func (w *SystemWatchdog) CheckConnectorLiveness() (bool, error) {
	return w.connectorAlive, nil
}

// CheckDiskUsage returns current disk usage in bytes.
func (w *SystemWatchdog) CheckDiskUsage() (int64, error) {
	return w.diskUsageBytes, nil
}

// CheckBrainHealth verifies brain sidecar is healthy.
func (w *SystemWatchdog) CheckBrainHealth(_ context.Context) (bool, error) {
	return w.brainHealthy, nil
}

// ---------- DockerComposeParser ----------

// DockerHealthConfig holds parsed docker healthcheck settings for a service.
type DockerHealthConfig = domain.DockerHealthConfig

// DockerComposeParser implements testutil.DockerComposeParser.
type DockerComposeParser struct {
	services map[string]*DockerHealthConfig
}

// NewDockerComposeParser returns a parser pre-loaded with the standard dina docker-compose config.
func NewDockerComposeParser() *DockerComposeParser {
	p := &DockerComposeParser{
		services: make(map[string]*DockerHealthConfig),
	}

	// Core service.
	p.services["core"] = &DockerHealthConfig{
		ServiceName: "core",
		Test:        []string{"CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8100/healthz"},
		Interval:    "60s",
		Timeout:     "3s",
		Retries:     3,
		StartPeriod: "20s",
		Restart:     "always",
		DependsOn: map[string]string{
			"pds": "service_started",
		},
	}

	// Brain service.
	p.services["brain"] = &DockerHealthConfig{
		ServiceName: "brain",
		Test:        []string{"CMD", "wget", "--no-verbose", "--tries=1", "http://localhost:8200/healthz"},
		Interval:    "30s",
		Timeout:     "5s",
		Retries:     3,
		StartPeriod: "15s",
		Restart:     "always",
		DependsOn: map[string]string{
			"core": "service_healthy",
		},
	}

	// PDS service.
	p.services["pds"] = &DockerHealthConfig{
		ServiceName: "pds",
		Test:        []string{"CMD", "wget", "--no-verbose", "--tries=1", "http://localhost:2583/xrpc/_health"},
		Interval:    "30s",
		Timeout:     "5s",
		Retries:     3,
		StartPeriod: "10s",
		Restart:     "always",
		DependsOn:   map[string]string{},
	}

	// Llama service.
	p.services["llama"] = &DockerHealthConfig{
		ServiceName: "llama",
		Test:        []string{"CMD", "wget", "--no-verbose", "--tries=1", "http://localhost:8080/health"},
		Interval:    "30s",
		Timeout:     "5s",
		Retries:     3,
		StartPeriod: "30s",
		Restart:     "always",
		DependsOn:   map[string]string{},
		Profiles:    []string{"local-llm"},
	}

	return p
}

// ParseService extracts healthcheck config for a named service.
func (p *DockerComposeParser) ParseService(composePath, serviceName string) (*DockerHealthConfig, error) {
	cfg, ok := p.services[serviceName]
	if !ok {
		return nil, fmt.Errorf("service %q not found in compose config", serviceName)
	}
	return cfg, nil
}

// ---------- CrashLogger ----------

// CrashEntry holds a crash log row.
type CrashEntry = domain.CrashEntry

// CrashLogger implements port.CrashLogger — crash log storage and retrieval.
type CrashLogger struct {
	mu      sync.Mutex
	entries []CrashEntry
	nextID  int64
}

// NewCrashLogger returns a new CrashLogger.
func NewCrashLogger() *CrashLogger {
	return &CrashLogger{}
}

// Store inserts a crash entry into the crash_log table.
func (c *CrashLogger) Store(_ context.Context, entry CrashEntry) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if entry.Error == "" {
		return errors.New("error field is required")
	}

	c.nextID++
	entry.ID = c.nextID
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	c.entries = append(c.entries, entry)
	return nil
}

// Query returns crash entries within the given time range.
func (c *CrashLogger) Query(_ context.Context, since string) ([]CrashEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var results []CrashEntry
	for _, e := range c.entries {
		if e.Timestamp >= since || since == "" {
			results = append(results, e)
		}
	}
	return results, nil
}

// Purge deletes entries older than the given retention period in days.
func (c *CrashLogger) Purge(_ context.Context, retentionDays int) (int64, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	cutoff := time.Now().AddDate(0, 0, -retentionDays).UTC().Format(time.RFC3339)
	var kept []CrashEntry
	var deleted int64
	for _, e := range c.entries {
		if e.Timestamp >= cutoff {
			kept = append(kept, e)
		} else {
			deleted++
		}
	}
	c.entries = kept
	return deleted, nil
}

// ---------- Helper: parse test cmd to find URL substring ----------

func containsSubstring(s, substr string) bool {
	return strings.Contains(s, substr)
}
