// Package watchdog monitors brain process health.
// Sends periodic heartbeats, restarts brain on failure,
// and switches to degraded mode if brain is unavailable.
package watchdog
