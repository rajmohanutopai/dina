package port

import "time"

// Clock enables deterministic time in tests. Production uses RealClock.
// Tests use FixedClock or SteppingClock.
// This is the single most impactful testability decision in the codebase.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
	NewTicker(d time.Duration) *time.Ticker
}
