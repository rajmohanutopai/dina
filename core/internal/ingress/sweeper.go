package ingress

import (
	"context"
	"fmt"
	"time"

	"github.com/anthropics/dina/core/internal/port"
)

// Sweeper processes dead drop blobs after the vault is unlocked.
// For each blob it:
//  1. Attempts decryption using the recipient's key pair.
//  2. Checks if the message TTL has expired (24-hour default).
//  3. Verifies the sender's DID against the contact directory.
//  4. Reports blocked senders back for future filtering.
type Sweeper struct {
	deadDrop  *DeadDrop
	decryptor port.Encryptor
	resolver  port.DIDResolver
	clock     port.Clock
	ttl       time.Duration
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
		deadDrop:  deadDrop,
		decryptor: decryptor,
		resolver:  resolver,
		clock:     clock,
		ttl:       ttl,
	}
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

		blob, err := s.deadDrop.Read(name)
		if err != nil {
			// Blob may have been consumed by another process.
			continue
		}

		// Attempt to process the blob.
		// In a full implementation, this would:
		// 1. Decrypt with the recipient's X25519 key pair
		// 2. Verify the sender's signature
		// 3. Check TTL
		// 4. Forward to inbox
		//
		// For now, we count it as processed if we can read it.
		_ = blob
		delivered++
	}

	return delivered, nil
}

// SweepFull processes all dead drop blobs with detailed results.
func (s *Sweeper) SweepFull(ctx context.Context) (*SweepResult, error) {
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

		blob, err := s.deadDrop.Read(name)
		if err != nil {
			continue
		}
		result.Processed++

		// Check blob size as a minimal sanity check.
		if len(blob) == 0 {
			result.Failed++
			continue
		}

		// In a full implementation, the blob would be decrypted and the
		// message TTL checked against the current time. For now, we
		// consider all readable blobs as delivered.
		result.Delivered++
	}

	return result, nil
}
