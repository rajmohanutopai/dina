// Package outbox provides reliable outbound message delivery.
// Messages are persisted to disk before sending, retried with exponential
// backoff, and removed only after confirmed delivery.
package outbox
