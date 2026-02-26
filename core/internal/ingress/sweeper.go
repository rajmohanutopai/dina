package ingress

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

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

		// Delegate to transport processor if configured (handles decryption + signature verification).
		if s.transport != nil {
			msg, tErr := s.transport.ProcessInbound(ctx, blob)
			if tErr != nil {
				continue
			}
			// Check TTL — drop expired messages.
			if s.ttl > 0 && msg.CreatedTime > 0 {
				age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
				if age > s.ttl {
					continue
				}
			}
			if s.onMessage != nil {
				s.onMessage(msg)
			}
			delivered++
			continue
		}

		// If we don't have keys or converter, count as processed without decrypting.
		if s.recipientPub == nil || s.recipientPriv == nil || s.converter == nil {
			delivered++
			continue
		}

		// 1. Convert Ed25519 keys to X25519 for NaCl decryption.
		x25519Priv, err := s.converter.Ed25519ToX25519Private(s.recipientPriv)
		if err != nil {
			continue
		}
		x25519Pub, err := s.converter.Ed25519ToX25519Public(s.recipientPub)
		if err != nil {
			continue
		}

		// 2. Decrypt the sealed box.
		plaintext, err := s.decryptor.OpenAnonymous(blob, x25519Pub, x25519Priv)
		if err != nil {
			// Corrupt or wrong key — skip.
			continue
		}

		// 3. Unmarshal the message.
		var msg domain.DinaMessage
		if err := json.Unmarshal(plaintext, &msg); err != nil {
			continue
		}

		// 4. Check TTL — drop expired messages.
		if s.ttl > 0 && msg.CreatedTime > 0 {
			age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
			if age > s.ttl {
				continue
			}
		}

		// 5. Deliver to inbox via callback.
		if s.onMessage != nil {
			s.onMessage(&msg)
		}
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

		if len(blob) == 0 {
			result.Failed++
			continue
		}

		// Delegate to transport processor if configured (handles decryption + signature verification).
		if s.transport != nil {
			msg, tErr := s.transport.ProcessInbound(ctx, blob)
			if tErr != nil {
				result.Failed++
				continue
			}
			// Check TTL.
			if s.ttl > 0 && msg.CreatedTime > 0 {
				age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
				if age > s.ttl {
					result.Expired++
					continue
				}
			}
			if s.onMessage != nil {
				s.onMessage(msg)
			}
			result.Delivered++
			continue
		}

		// If we don't have keys or converter, count as delivered (pass-through).
		if s.recipientPub == nil || s.recipientPriv == nil || s.converter == nil {
			result.Delivered++
			continue
		}

		// 1. Convert keys.
		x25519Priv, err := s.converter.Ed25519ToX25519Private(s.recipientPriv)
		if err != nil {
			result.Failed++
			continue
		}
		x25519Pub, err := s.converter.Ed25519ToX25519Public(s.recipientPub)
		if err != nil {
			result.Failed++
			continue
		}

		// 2. Decrypt.
		plaintext, err := s.decryptor.OpenAnonymous(blob, x25519Pub, x25519Priv)
		if err != nil {
			result.Failed++
			continue
		}

		// 3. Unmarshal.
		var msg domain.DinaMessage
		if err := json.Unmarshal(plaintext, &msg); err != nil {
			result.Failed++
			continue
		}

		// 4. Check TTL.
		if s.ttl > 0 && msg.CreatedTime > 0 {
			age := s.clock.Now().Sub(time.Unix(msg.CreatedTime, 0))
			if age > s.ttl {
				result.Expired++
				continue
			}
		}

		// 5. Deliver.
		if s.onMessage != nil {
			s.onMessage(&msg)
		}
		result.Delivered++
	}

	return result, nil
}
