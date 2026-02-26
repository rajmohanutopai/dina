package ingress

import (
	"context"
	"fmt"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Router directs inbound NaCl-encrypted envelopes to either the dead drop
// (when the vault is locked) or the fast path (when unlocked). This ensures
// messages are never lost even when the user hasn't unlocked their Home Node.
type Router struct {
	vault      port.VaultManager
	inbox      port.InboxManager
	deadDrop   *DeadDrop
	sweeper    *Sweeper
	limiter    *RateLimiter
	onEnvelope func(context.Context, []byte) // decrypt+deliver callback for fast-path envelopes
}

// NewRouter constructs an ingress Router.
func NewRouter(
	vault port.VaultManager,
	inbox port.InboxManager,
	deadDrop *DeadDrop,
	sweeper *Sweeper,
	limiter *RateLimiter,
) *Router {
	return &Router{
		vault:    vault,
		inbox:    inbox,
		deadDrop: deadDrop,
		sweeper:  sweeper,
		limiter:  limiter,
	}
}

// Ingest processes an inbound encrypted envelope. The IP is used for rate limiting.
// Returns nil on success. The message is either stored in the dead drop (locked)
// or decrypted and forwarded to the inbox (unlocked).
func (r *Router) Ingest(ctx context.Context, ip string, envelope []byte) error {
	// Valve 1: IP rate limit.
	if !r.limiter.AllowIP(ip) {
		return fmt.Errorf("ingress: %w", domain.ErrRateLimited)
	}

	// Valve 2: Global spool capacity check.
	if !r.limiter.AllowGlobal() {
		return fmt.Errorf("ingress: %w: spool full", domain.ErrSpoolFull)
	}

	// Check payload size.
	if !r.inbox.CheckPayloadSize(envelope) {
		return fmt.Errorf("ingress: payload exceeds maximum size")
	}

	// Route based on vault state.
	// When the vault is locked, we cannot decrypt — store as opaque blob.
	// When unlocked, decrypt and process immediately.
	defaultPersona, _ := domain.NewPersonaName("personal")
	if !r.vault.IsOpen(defaultPersona) {
		// Dead drop path: store the encrypted blob for later processing.
		return r.deadDrop.Store(ctx, envelope)
	}

	// Fast path: vault is unlocked — decrypt and deliver immediately.
	if r.onEnvelope != nil {
		r.onEnvelope(ctx, envelope)
		return nil
	}

	// Fallback: spool for later processing (no callback configured).
	_, err := r.inbox.Spool(ctx, envelope)
	if err != nil {
		return fmt.Errorf("ingress: fast path spool: %w", err)
	}

	return nil
}

// SetOnEnvelope registers the callback invoked for each fast-path spool
// envelope during ProcessPending. The callback should decrypt and store
// the envelope (e.g. TransportService.ProcessInbound + StoreInbound).
func (r *Router) SetOnEnvelope(fn func(context.Context, []byte)) {
	r.onEnvelope = fn
}

// ProcessPending drains all spooled messages through the inbox pipeline.
// Called after vault unlock to process any accumulated dead drop blobs,
// then drains the fast-path spool and decrypts each envelope via onEnvelope.
func (r *Router) ProcessPending(ctx context.Context) (int, error) {
	// First sweep the dead drop (decrypt, verify, deliver).
	sweptCount, err := r.sweeper.Sweep(ctx)
	if err != nil {
		return 0, fmt.Errorf("ingress: sweep dead drop: %w", err)
	}

	// Then drain and process the fast-path inbox spool.
	payloads, err := r.inbox.DrainSpool(ctx)
	if err != nil {
		return sweptCount, fmt.Errorf("ingress: drain spool: %w", err)
	}

	inboxCount := 0
	for _, envelope := range payloads {
		if r.onEnvelope != nil {
			r.onEnvelope(ctx, envelope)
		}
		inboxCount++
	}

	return sweptCount + inboxCount, nil
}
