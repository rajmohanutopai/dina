// Package taskqueue provides a persistent, priority-aware task queue.
// Used by brain to schedule work (sync cycles, nudge delivery, agent tasks).
// Backed by SQLite for crash recovery.
package taskqueue
