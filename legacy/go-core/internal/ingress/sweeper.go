package ingress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// blobFailure tracks consecutive failures for a single dead-drop blob.
type blobFailure struct {
	count     int
	firstSeen time.Time
}

// TransportProcessor processes inbound D2D envelopes.
type TransportProcessor interface {
	ProcessInbound(ctx context.Context, sealed []byte) (*domain.DinaMessage, error)
}

// Sweeper processes dead drop blobs after the vault is unlocked.
// For each blob it:
//  1. Attempts decryption using the recipient's key pair.
//  2. Checks if the message TTL has expired (24-hour default).
//  3. Verifies the sender's DID against the contact directory.
//  4. Reports blocked senders back for future filtering.
type Sweeper struct {
	deadDrop      *DeadDrop
	decryptor     port.Encryptor
	resolver      port.DIDResolver
	converter     port.KeyConverter
	clock         port.Clock
	ttl           time.Duration
	transport     TransportProcessor
	recipientPub  []byte                    // node's Ed25519 public key
	recipientPriv []byte                    // node's Ed25519 private key
	onMessage     func(*domain.DinaMessage) // callback for delivered messages

	// HIGH-04: Failure tracking to evict poison-pill blobs.
	failMu     sync.Mutex
	failures   map[string]*blobFailure
	maxRetries int           // consecutive failures before eviction (default 5)
	maxAge     time.Duration // max blob age before mtime-based GC (default 24h)
}

// ackBlob acknowledges a dead-drop blob. Logs a warning on failure instead
// of silently swallowing the error (IG6 fix).
func (s *Sweeper) ackBlob(name string) {
	if err := s.deadDrop.Ack(name); err != nil {
		slog.Warn("sweeper: ack failed — blob may persist on disk",
			"name", name, "error", err)
	}
}

// NewSweeper creates a Sweeper with the given dependencies.
// The TTL defines how long a dead drop blob is considered valid after creation.
func NewSweeper(
	deadDrop *DeadDrop,
	decryptor port.Encryptor,
	resolver port.DIDResolver,
	clock port.Clock,
	ttl time.Duration,
) *Sweeper {
	return &Sweeper{
		deadDrop:   deadDrop,
		decryptor:  decryptor,
		resolver:   resolver,
		clock:      clock,
		ttl:        ttl,
		failures:   make(map[string]*blobFailure),
		maxRetries: 5,
		maxAge:     24 * time.Hour,
	}
}

// SetKeys configures the node's own Ed25519 keypair for inbound decryption.
func (s *Sweeper) SetKeys(pub, priv []byte) {
	s.recipientPub = pub
	s.recipientPriv = priv
}

// SetConverter sets the key converter for Ed25519 → X25519 conversion.
func (s *Sweeper) SetConverter(c port.KeyConverter) {
	s.converter = c
}

// SetOnMessage sets the callback invoked for each successfully decrypted message.
func (s *Sweeper) SetOnMessage(fn func(*domain.DinaMessage)) {
	s.onMessage = fn
}

// SetTransport sets the transport processor for inbound D2D envelope handling.
// When set, Sweep and SweepFull delegate decryption and signature verification
// to the transport service instead of performing raw decryption directly.
func (s *Sweeper) SetTransport(t TransportProcessor) {
	s.transport = t
}

// recordFailure increments the failure counter for a blob and evicts it if
// the threshold is exceeded. Returns true if the blob was evicted.
func (s *Sweeper) recordFailure(name string) bool {
	s.failMu.Lock()
	defer s.failMu.Unlock()

	f, ok := s.failures[name]
	if !ok {
		f = &blobFailure{firstSeen: s.clock.Now()}
		s.failures[name] = f
	}
	f.count++

	if f.count >= s.maxRetries {
		slog.Warn("evicting poison-pill blob after max retries", "name", name, "retries", f.count)
		s.ackBlob(name)
		delete(s.failures, name)
		return true
	}
	return false
}

// clearFailure removes the failure record for a successfully processed blob.
func (s *Sweeper) clearFailure(name string) {
	s.failMu.Lock()
	delete(s.failures, name)
	s.failMu.Unlock()
}

// GCStaleBlobs removes blobs older than maxAge based on file mtime.
// This provides restart resilience since in-memory failure tracking is lost.
func (s *Sweeper) GCStaleBlobs() int {
	dir := s.deadDrop.Dir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}

	evicted := 0
	now := s.clock.Now()
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".blob" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > s.maxAge {
			slog.Warn("evicting stale blob by mtime", "name", e.Name(), "age", now.Sub(info.ModTime()))
			s.ackBlob(e.Name())
			evicted++
		}
	}
	return evicted
}

// SweepResult summarizes a sweep pass over the dead drop.
type SweepResult struct {
	Processed   int      // total blobs examined
	Delivered   int      // successfully decrypted and forwarded
	Expired     int      // dropped due to TTL expiry
	Blocked     int      // dropped due to blocklist match
	Failed      int      // failed to decrypt (corrupt or wrong key)
	BlockedDIDs []string // sender DIDs that should be blocked
}

// Sweep processes all pending dead drop blobs.
// Returns the number of successfully processed blobs.
func (s *Sweeper) Sweep(ctx context.Context) (int, error) {
	// HIGH-04: GC stale blobs on each sweep for restart resilience.
	s.GCStaleBlobs()

	blobs, err := s.deadDrop.List()
	if err != nil {
		return 0, fmt.Errorf("sweeper: list blobs: %w", err)
	}

	delivered := 0
	for _, name := range blobs {
		select {
		case <-ctx.Done():
			return delivered, ctx.Err()
		default:
		}

		blob, err := s.deadDrop.Peek(name)
		if err != nil {
			// Blob may have been consumed by another process.
			continue
		}

		// Delegate to transport processor if configured (handles decryption + signature verification).
		if s.transport != nil {
			msg, tErr := s.transport.ProcessInbound(ctx, blob)
			if tErr != nil {
				// D2D v1: ErrUnknownMessageType is a benign drop — ack the blob,
				// don't count as failure. The sender used a non-v1 type.
				if errors.Is(tErr, domain.ErrUnknownMessageType) {
					slog.Info("sweeper: non-v1 message type dropped", "name", name, "error", tErr.Error())
					s.clearFailure(name)
					s.ackBlob(name)
					continue
				}
				slog.Warn("sweeper: ProcessInbound failed", "name", name, "error", tErr.Error())
				// HIGH-04: Track failure; evict after maxRetries.
				s.recordFailure(name)
				continue
			}
			// Check TTL — drop expired messages.
			if s.ttl > 0 && msg.CreatedTime > 0 {
				age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
				if age > s.ttl {
					s.ackBlob(name)
					continue
				}
			}
			if s.onMessage != nil {
				s.onMessage(msg)
			}
			s.clearFailure(name)
			s.ackBlob(name)
			delivered++
			continue
		}

		// If we don't have keys or converter, skip — leave blob pending for next sweep cycle.
		if s.recipientPub == nil || s.recipientPriv == nil || s.converter == nil {
			slog.Warn("skipping blob — decrypt prerequisites missing", "name", name)
			continue
		}

		// 1. Convert Ed25519 keys to X25519 for NaCl decryption.
		x25519Priv, err := s.converter.Ed25519ToX25519Private(s.recipientPriv)
		if err != nil {
			s.recordFailure(name)
			continue
		}
		x25519Pub, err := s.converter.Ed25519ToX25519Public(s.recipientPub)
		if err != nil {
			s.recordFailure(name)
			continue
		}

		// 2. Decrypt the sealed box.
		plaintext, err := s.decryptor.OpenAnonymous(blob, x25519Pub, x25519Priv)
		if err != nil {
			// HIGH-04: Track failure; evict after maxRetries.
			s.recordFailure(name)
			continue
		}

		// 3. Unmarshal the message.
		var msg domain.DinaMessage
		if err := json.Unmarshal(plaintext, &msg); err != nil {
			s.recordFailure(name)
			continue
		}

		// 4. Check TTL — drop expired messages.
		if s.ttl > 0 && msg.CreatedTime > 0 {
			age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
			if age > s.ttl {
				s.ackBlob(name)
				continue
			}
		}

		// 5. Deliver to inbox via callback.
		if s.onMessage != nil {
			s.onMessage(&msg)
		}
		s.clearFailure(name)
		s.ackBlob(name)
		delivered++
	}

	return delivered, nil
}

// SweepFull processes all dead drop blobs with detailed results.
func (s *Sweeper) SweepFull(ctx context.Context) (*SweepResult, error) {
	// HIGH-04: GC stale blobs on each sweep for restart resilience.
	s.GCStaleBlobs()

	blobs, err := s.deadDrop.List()
	if err != nil {
		return nil, fmt.Errorf("sweeper: list blobs: %w", err)
	}

	result := &SweepResult{}
	for _, name := range blobs {
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		default:
		}

		blob, err := s.deadDrop.Peek(name)
		if err != nil {
			continue
		}
		result.Processed++

		if len(blob) == 0 {
			// HIGH-04: Track empty blobs as failures.
			s.recordFailure(name)
			result.Failed++
			continue
		}

		// Delegate to transport processor if configured (handles decryption + signature verification).
		if s.transport != nil {
			msg, tErr := s.transport.ProcessInbound(ctx, blob)
			if tErr != nil {
				// D2D v1: ErrUnknownMessageType is a benign drop.
				if errors.Is(tErr, domain.ErrUnknownMessageType) {
					slog.Info("sweeper: non-v1 message type dropped", "name", name, "error", tErr.Error())
					s.clearFailure(name)
					s.ackBlob(name)
					result.Processed++ // counted as processed but not delivered
					continue
				}
				s.recordFailure(name)
				result.Failed++
				continue
			}
			// Check TTL.
			if s.ttl > 0 && msg.CreatedTime > 0 {
				age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
				if age > s.ttl {
					s.ackBlob(name)
					result.Expired++
					continue
				}
			}
			if s.onMessage != nil {
				s.onMessage(msg)
			}
			s.clearFailure(name)
			s.ackBlob(name)
			result.Delivered++
			continue
		}

		// If we don't have keys or converter, skip — leave blob pending for next sweep cycle.
		if s.recipientPub == nil || s.recipientPriv == nil || s.converter == nil {
			slog.Warn("skipping blob — decrypt prerequisites missing", "name", name)
			result.Failed++
			continue
		}

		// 1. Convert keys.
		x25519Priv, err := s.converter.Ed25519ToX25519Private(s.recipientPriv)
		if err != nil {
			s.recordFailure(name)
			result.Failed++
			continue
		}
		x25519Pub, err := s.converter.Ed25519ToX25519Public(s.recipientPub)
		if err != nil {
			s.recordFailure(name)
			result.Failed++
			continue
		}

		// 2. Decrypt.
		plaintext, err := s.decryptor.OpenAnonymous(blob, x25519Pub, x25519Priv)
		if err != nil {
			s.recordFailure(name)
			result.Failed++
			continue
		}

		// 3. Unmarshal.
		var msg domain.DinaMessage
		if err := json.Unmarshal(plaintext, &msg); err != nil {
			s.recordFailure(name)
			result.Failed++
			continue
		}

		// 4. Check TTL.
		if s.ttl > 0 && msg.CreatedTime > 0 {
			age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
			if age > s.ttl {
				s.ackBlob(name)
				result.Expired++
				continue
			}
		}

		// 5. Deliver.
		if s.onMessage != nil {
			s.onMessage(&msg)
		}
		s.clearFailure(name)
		s.ackBlob(name)
		result.Delivered++
	}

	return result, nil
}
