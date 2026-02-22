// Package clock provides a real-time Clock adapter for production use.
package clock

import (
	"time"

	"github.com/anthropics/dina/core/internal/port"
)

var _ port.Clock = (*RealClock)(nil)

// RealClock delegates to the standard library time package.
type RealClock struct{}

// NewRealClock returns a new RealClock.
func NewRealClock() *RealClock { return &RealClock{} }

func (c *RealClock) Now() time.Time                         { return time.Now() }
func (c *RealClock) After(d time.Duration) <-chan time.Time  { return time.After(d) }
func (c *RealClock) NewTicker(d time.Duration) *time.Ticker  { return time.NewTicker(d) }
