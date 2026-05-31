package reminder

import (
	"context"
	"log/slog"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Loop is a channel-woken sleep loop that fires reminders on schedule.
// It queries the ReminderScheduler for the next pending reminder and
// sleeps until its trigger time. When a reminder fires, it is passed
// to the onFire callback for processing by the brain.
//
// Design (per §8.4):
//   - No cron library — uses time.Sleep(time.Until(triggerAt))
//   - Channel-woken: a wake channel can interrupt the sleep to recompute
//   - Missed reminders (triggerAt in the past) fire immediately on startup
type Loop struct {
	scheduler port.ReminderScheduler
	clock     port.Clock
	wake      chan struct{} // poke to recompute next reminder
}

// NewLoop creates a reminder Loop with the given scheduler and clock.
func NewLoop(scheduler port.ReminderScheduler, clock port.Clock) *Loop {
	return &Loop{
		scheduler: scheduler,
		clock:     clock,
		wake:      make(chan struct{}, 1),
	}
}

// Run starts the reminder loop. It blocks until ctx is cancelled.
// The onFire callback receives the full Reminder when it fires,
// including Kind, SourceItemID, Source, and Persona for contextual notifications.
func (l *Loop) Run(ctx context.Context, onFire func(ctx context.Context, r domain.Reminder)) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Query the next pending reminder.
		next, err := l.scheduler.NextPending(ctx)
		if err != nil {
			slog.Error("reminder: query next pending", "error", err)
			// Back off on error.
			select {
			case <-ctx.Done():
				return
			case <-l.clock.After(10 * time.Second):
				continue
			}
		}

		if next == nil {
			// No pending reminders — wait for a wake signal or poll.
			select {
			case <-ctx.Done():
				return
			case <-l.wake:
				continue
			case <-l.clock.After(60 * time.Second):
				continue
			}
		}

		// Calculate sleep duration until the reminder fires.
		now := l.clock.Now()
		triggerAt := time.Unix(next.TriggerAt, 0)
		sleepDuration := triggerAt.Sub(now)

		if sleepDuration <= 0 {
			// Missed reminder (triggerAt in the past) — fire immediately.
			l.fire(ctx, *next, onFire)
			continue
		}

		// Sleep until the trigger time, but wake if poked.
		select {
		case <-ctx.Done():
			return
		case <-l.wake:
			// Recompute — a new reminder may have been added that fires sooner.
			continue
		case <-l.clock.After(sleepDuration):
			l.fire(ctx, *next, onFire)
		}
	}
}

// fire processes a single reminder.
func (l *Loop) fire(ctx context.Context, r domain.Reminder, onFire func(context.Context, domain.Reminder)) {
	slog.Info("reminder: firing", "id", r.ID, "kind", r.Kind, "type", r.Type)

	// Mark as fired before invoking callback to prevent re-firing.
	if err := l.scheduler.MarkFired(ctx, r.ID); err != nil {
		slog.Error("reminder: mark fired", "id", r.ID, "error", err)
		return
	}

	// Invoke the callback with the full reminder (includes lineage).
	if onFire != nil {
		onFire(ctx, r)
	}
}

// Wake interrupts the sleep loop to recompute the next reminder.
// This should be called whenever a new reminder is added or an
// existing one is modified, to ensure timely firing.
func (l *Loop) Wake() {
	select {
	case l.wake <- struct{}{}:
	default:
		// Channel already has a pending wake — no need to send again.
	}
}
