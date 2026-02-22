package domain

// CrashEntry holds a crash log row from the crash_log table.
type CrashEntry struct {
	ID        int64
	Timestamp string
	Error     string
	Traceback string
	TaskID    string
}

// LogEntry holds a structured log line (JSON format).
type LogEntry struct {
	Time   string
	Level  string
	Msg    string
	Module string
	Fields map[string]string
}

// WatchdogReport holds the results of a system health check tick.
type WatchdogReport struct {
	Timestamp          int64
	ConnectorAlive     bool
	DiskUsageBytes     int64
	DiskUsagePercent   float64
	BrainHealthy       bool
	AuditEntriesPurged int64
	CrashEntriesPurged int64
}
