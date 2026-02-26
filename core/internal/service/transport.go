// Package service contains domain services that compose port interfaces.
// Services import ONLY port/ and domain/ packages, NEVER adapter/.
package service

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// d2dPayload is the JSON wrapper sent over the wire containing both
// the NaCl-encrypted ciphertext and the Ed25519 signature over the plaintext.
// This allows the receiver to verify the sender's signature after decryption.
type d2dPayload struct {
	Ciphertext string `json:"c"` // base64-encoded NaCl sealed box
	Sig        string `json:"s"` // hex-encoded Ed25519 signature over plaintext
}

// TransportService orchestrates secure Dina-to-Dina message exchange.
// It signs and encrypts outbound messages, decrypts and verifies inbound
// messages, and manages reliable delivery via the outbox queue.
type TransportService struct {
	encryptor port.Encryptor
	signer    port.IdentitySigner
	verifier  port.Signer // for signature verification on receive
	converter port.KeyConverter
	resolver  port.DIDResolver
	outbox    port.OutboxManager
	inbox     port.InboxManager
	clock     port.Clock
	deliverer port.Deliverer // optional: immediate delivery to remote endpoint

	recipientPub  []byte
	recipientPriv []byte
	senderDID     string // this node's own DID for the From field
	mu            sync.Mutex
	inboundMsgs   []domain.DinaMessage
}

// NewTransportService constructs a TransportService with all required dependencies.
func NewTransportService(
	encryptor port.Encryptor,
	signer port.IdentitySigner,
	converter port.KeyConverter,
	resolver port.DIDResolver,
	outbox port.OutboxManager,
	inbox port.InboxManager,
	clock port.Clock,
) *TransportService {
	return &TransportService{
		encryptor: encryptor,
		signer:    signer,
		converter: converter,
		resolver:  resolver,
		outbox:    outbox,
		inbox:     inbox,
		clock:     clock,
	}
}

// SetDeliverer sets an optional Deliverer for immediate message delivery.
// When set, SendMessage will attempt to deliver the encrypted payload
// to the recipient's service endpoint after outbox enqueue.
func (s *TransportService) SetDeliverer(d port.Deliverer) {
	s.deliverer = d
}

// SetVerifier sets the Ed25519 signer used to verify inbound message signatures.
func (s *TransportService) SetVerifier(v port.Signer) {
	s.verifier = v
}

// SendMessage signs and encrypts a message for the recipient, then attempts
// immediate delivery. If delivery fails, the message is queued in the outbox
// for later retry via ProcessOutbox.
func (s *TransportService) SendMessage(ctx context.Context, to domain.DID, msg domain.DinaMessage) error {
	// Resolve the recipient's DID document to obtain their public key.
	doc, err := s.resolver.Resolve(ctx, to)
	if err != nil {
		return fmt.Errorf("transport: resolve recipient DID: %w", err)
	}

	if len(doc.VerificationMethod) == 0 {
		return fmt.Errorf("transport: %w: no verification methods in DID document", domain.ErrDIDNotFound)
	}

	// Set the sender's DID on the message so the recipient can verify the signature.
	if s.senderDID != "" && msg.From == "" {
		msg.From = s.senderDID
	}

	// Serialize the plaintext message for signing.
	plaintext, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("transport: marshal message: %w", err)
	}

	// Sign the plaintext with our Ed25519 key.
	sig, err := s.signer.Sign(ctx, plaintext)
	if err != nil {
		return fmt.Errorf("transport: sign message: %w", err)
	}

	// Decode the recipient's multibase-encoded Ed25519 public key.
	// Format: single-char prefix (e.g. "z") + hex-encoded 32-byte key.
	multibaseKey := doc.VerificationMethod[0].PublicKeyMultibase
	if len(multibaseKey) < 2 {
		return fmt.Errorf("transport: invalid public key multibase encoding")
	}
	recipientEd25519Pub, err := hex.DecodeString(multibaseKey[1:]) // strip prefix
	if err != nil {
		return fmt.Errorf("transport: decode recipient public key: %w", err)
	}

	// Convert the recipient's Ed25519 public key to X25519 for encryption.
	recipientX25519Pub, err := s.converter.Ed25519ToX25519Public(recipientEd25519Pub)
	if err != nil {
		return fmt.Errorf("transport: convert recipient key: %w", err)
	}

	// Encrypt the signed payload using NaCl sealed box.
	ciphertext, err := s.encryptor.SealAnonymous(plaintext, recipientX25519Pub)
	if err != nil {
		return fmt.Errorf("transport: encrypt message: %w", err)
	}

	// Build the outbox message for reliable delivery.
	now := s.clock.Now().Unix()
	outboxMsg := domain.OutboxMessage{
		ID:        msg.ID,
		ToDID:     string(to),
		Payload:   ciphertext,
		Sig:       sig,
		CreatedAt: now,
		NextRetry: now,
		Retries:   0,
		Status:    string(domain.OutboxPending),
	}

	// Queue the message. The outbox handles retry scheduling.
	msgID, err := s.outbox.Enqueue(ctx, outboxMsg)
	if err != nil {
		return fmt.Errorf("transport: enqueue message: %w", err)
	}

	// Build the JSON delivery payload containing both ciphertext and signature.
	// This ensures the signature is transmitted alongside the encrypted message,
	// allowing the receiver to verify the sender's identity after decryption.
	deliveryPayload, err := marshalD2DPayload(ciphertext, sig)
	if err != nil {
		return fmt.Errorf("transport: marshal delivery payload: %w", err)
	}

	// Attempt immediate delivery if a Deliverer is configured.
	// On failure, the message stays in the outbox for retry via ProcessOutbox.
	if s.deliverer != nil && len(doc.Service) > 0 {
		endpoint := doc.Service[0].ServiceEndpoint
		if endpoint != "" {
			if deliverErr := s.deliverer.Deliver(ctx, endpoint, deliveryPayload); deliverErr == nil {
				_ = s.outbox.MarkDelivered(ctx, msgID)
			}
			// Delivery failure is not an error — outbox will retry.
		}
	}

	return nil
}

// marshalD2DPayload creates a JSON delivery payload with base64-encoded ciphertext
// and hex-encoded signature.
func marshalD2DPayload(ciphertext, sig []byte) ([]byte, error) {
	wrapper := d2dPayload{
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
		Sig:        hex.EncodeToString(sig),
	}
	return json.Marshal(wrapper)
}

// ReceiveMessage decrypts an inbound envelope and verifies the sender's signature.
// It resolves the sender's DID to obtain their public key for verification.
func (s *TransportService) ReceiveMessage(ctx context.Context, envelope domain.DinaEnvelope, recipientPub, recipientPriv []byte) (*domain.DinaMessage, error) {
	// Convert recipient Ed25519 keys to X25519 for decryption.
	x25519Priv, err := s.converter.Ed25519ToX25519Private(recipientPriv)
	if err != nil {
		return nil, fmt.Errorf("transport: convert recipient private key: %w", err)
	}
	x25519Pub, err := s.converter.Ed25519ToX25519Public(recipientPub)
	if err != nil {
		return nil, fmt.Errorf("transport: convert recipient public key: %w", err)
	}

	// Decrypt the ciphertext.
	plaintext, err := s.encryptor.OpenAnonymous([]byte(envelope.Ciphertext), x25519Pub, x25519Priv)
	if err != nil {
		return nil, fmt.Errorf("transport: decrypt message: %w", err)
	}

	// Deserialize the plaintext into a DinaMessage.
	var msg domain.DinaMessage
	if err := json.Unmarshal(plaintext, &msg); err != nil {
		return nil, fmt.Errorf("transport: unmarshal message: %w", err)
	}

	// Resolve the sender's DID to verify their signature.
	senderDID, err := domain.NewDID(msg.From)
	if err != nil {
		return nil, fmt.Errorf("transport: invalid sender DID: %w", err)
	}

	senderDoc, err := s.resolver.Resolve(ctx, senderDID)
	if err != nil {
		return nil, fmt.Errorf("transport: resolve sender DID: %w", err)
	}

	if len(senderDoc.VerificationMethod) == 0 {
		return nil, fmt.Errorf("transport: %w: sender has no verification methods", domain.ErrInvalidSignature)
	}

	// Verify the sender's Ed25519 signature over the plaintext.
	if s.verifier != nil && envelope.Sig != "" {
		senderMultibase := senderDoc.VerificationMethod[0].PublicKeyMultibase
		if len(senderMultibase) >= 2 {
			senderPubKey, decErr := hex.DecodeString(senderMultibase[1:])
			if decErr == nil {
				sigBytes, sigErr := hex.DecodeString(envelope.Sig)
				if sigErr == nil {
					valid, verErr := s.verifier.Verify(senderPubKey, plaintext, sigBytes)
					if verErr != nil || !valid {
						return nil, fmt.Errorf("transport: %w", domain.ErrInvalidSignature)
					}
				}
			}
		}
	}

	return &msg, nil
}

// ProcessOutbox retries all pending messages in the outbox. For each pending
// message whose retry time has elapsed, it resolves the recipient's endpoint
// and attempts redelivery. Messages that fail are marked failed with
// exponential backoff; successful deliveries are marked delivered.
// Messages with Retries >= maxRetries are skipped (dead-letter).
func (s *TransportService) ProcessOutbox(ctx context.Context) (processed int, err error) {
	const maxRetries = 5

	pending, err := s.outbox.ListPending(ctx)
	if err != nil {
		return 0, fmt.Errorf("transport: list pending: %w", err)
	}

	for _, msg := range pending {
		select {
		case <-ctx.Done():
			return processed, ctx.Err()
		default:
		}

		// Skip permanently failed messages (dead-letter).
		// Don't introduce a new status — use Retries count as dead-letter signal.
		// The message will eventually expire or be cleaned up by DeleteExpired.
		if msg.Retries >= maxRetries {
			processed++
			continue
		}

		// Resolve recipient endpoint.
		recipientDID, didErr := domain.NewDID(msg.ToDID)
		if didErr != nil {
			_ = s.outbox.MarkFailed(ctx, msg.ID)
			processed++
			continue
		}

		doc, resolveErr := s.resolver.Resolve(ctx, recipientDID)
		if resolveErr != nil || len(doc.Service) == 0 {
			_ = s.outbox.MarkFailed(ctx, msg.ID)
			processed++
			continue
		}

		endpoint := doc.Service[0].ServiceEndpoint
		if endpoint == "" {
			_ = s.outbox.MarkFailed(ctx, msg.ID)
			processed++
			continue
		}

		// Build the JSON delivery payload with ciphertext + signature.
		deliveryPayload, marshalErr := marshalD2DPayload(msg.Payload, msg.Sig)
		if marshalErr != nil {
			_ = s.outbox.MarkFailed(ctx, msg.ID)
			processed++
			continue
		}

		// Attempt delivery.
		if s.deliverer != nil {
			if deliverErr := s.deliverer.Deliver(ctx, endpoint, deliveryPayload); deliverErr != nil {
				_ = s.outbox.MarkFailed(ctx, msg.ID)
			} else {
				_ = s.outbox.MarkDelivered(ctx, msg.ID)
			}
		} else {
			_ = s.outbox.MarkFailed(ctx, msg.ID)
		}
		processed++
	}

	return processed, nil
}

// SetRecipientKeys configures the node's own Ed25519 keypair for inbound decryption.
func (s *TransportService) SetRecipientKeys(pub, priv []byte) {
	s.recipientPub = pub
	s.recipientPriv = priv
}

// SetSenderDID configures this node's own DID for outbound messages.
// The DID is set as the From field on all sent messages so recipients
// can resolve the sender's public key for signature verification.
func (s *TransportService) SetSenderDID(did string) {
	s.senderDID = did
}

// ProcessInbound decrypts an inbound message using the node's own X25519 keys.
// It accepts two formats:
//   - JSON wrapper: {"c": "<base64 ciphertext>", "s": "<hex sig>"} — new format with signature
//   - Raw bytes: NaCl sealed box ciphertext — legacy format (no signature verification)
//
// When a signature is present, it is verified against the sender's public key
// resolved from their DID document.
func (s *TransportService) ProcessInbound(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
	if s.recipientPub == nil || s.recipientPriv == nil {
		return nil, fmt.Errorf("transport: recipient keys not configured")
	}

	// Try to parse as JSON wrapper (new format with signature).
	var ciphertext []byte
	var sigHex string
	var payload d2dPayload
	if json.Unmarshal(sealed, &payload) == nil && payload.Ciphertext != "" {
		// New JSON wrapper format — decode base64 ciphertext and extract sig.
		decoded, decErr := base64.StdEncoding.DecodeString(payload.Ciphertext)
		if decErr != nil {
			return nil, fmt.Errorf("transport: decode ciphertext base64: %w", decErr)
		}
		ciphertext = decoded
		sigHex = payload.Sig

		// Reject unsigned JSON-wrapped messages unless migration mode is enabled.
		if payload.Sig == "" {
			if os.Getenv("DINA_ALLOW_UNSIGNED_D2D") != "1" {
				return nil, fmt.Errorf("transport: %w: unsigned inbound messages rejected", domain.ErrInvalidSignature)
			}
			slog.Warn("transport: accepting unsigned D2D message (migration mode)")
		}
	} else {
		// Legacy format — raw NaCl sealed box bytes (no signature).
		if os.Getenv("DINA_ALLOW_UNSIGNED_D2D") != "1" {
			return nil, fmt.Errorf("transport: %w: unsigned legacy payload rejected", domain.ErrInvalidSignature)
		}
		slog.Warn("transport: accepting unsigned legacy D2D (migration mode)")
		ciphertext = sealed
	}

	x25519Priv, err := s.converter.Ed25519ToX25519Private(s.recipientPriv)
	if err != nil {
		return nil, fmt.Errorf("transport: convert private key: %w", err)
	}
	x25519Pub, err := s.converter.Ed25519ToX25519Public(s.recipientPub)
	if err != nil {
		return nil, fmt.Errorf("transport: convert public key: %w", err)
	}
	plaintext, err := s.encryptor.OpenAnonymous(ciphertext, x25519Pub, x25519Priv)
	if err != nil {
		return nil, fmt.Errorf("transport: decrypt inbound: %w", err)
	}
	var msg domain.DinaMessage
	if err := json.Unmarshal(plaintext, &msg); err != nil {
		return nil, fmt.Errorf("transport: unmarshal inbound: %w", err)
	}

	// Verify the sender's signature if present (new format only).
	if sigHex != "" && s.verifier != nil {
		sigBytes, sigErr := hex.DecodeString(sigHex)
		if sigErr != nil {
			return nil, fmt.Errorf("transport: decode signature hex: %w", sigErr)
		}

		// Resolve the sender's DID document to get their public key.
		senderDID, didErr := domain.NewDID(msg.From)
		if didErr != nil {
			return nil, fmt.Errorf("transport: invalid sender DID: %w", didErr)
		}

		senderDoc, resolveErr := s.resolver.Resolve(ctx, senderDID)
		if resolveErr != nil {
			return nil, fmt.Errorf("transport: resolve sender DID for sig verification: %w", resolveErr)
		}

		if len(senderDoc.VerificationMethod) == 0 {
			return nil, fmt.Errorf("transport: %w: sender has no verification methods", domain.ErrInvalidSignature)
		}

		// Decode the sender's public key from the DID document.
		senderMultibase := senderDoc.VerificationMethod[0].PublicKeyMultibase
		if len(senderMultibase) < 2 {
			return nil, fmt.Errorf("transport: %w: invalid sender public key multibase", domain.ErrInvalidSignature)
		}
		senderPubKey, decErr := hex.DecodeString(senderMultibase[1:]) // strip "z" prefix
		if decErr != nil {
			return nil, fmt.Errorf("transport: decode sender public key: %w", decErr)
		}

		valid, verErr := s.verifier.Verify(senderPubKey, plaintext, sigBytes)
		if verErr != nil || !valid {
			return nil, fmt.Errorf("transport: %w", domain.ErrInvalidSignature)
		}
	}

	return &msg, nil
}

// StoreInbound adds a decrypted message to the in-memory inbox.
func (s *TransportService) StoreInbound(msg *domain.DinaMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inboundMsgs = append(s.inboundMsgs, *msg)
}

// GetInbound returns all received messages.
func (s *TransportService) GetInbound() []domain.DinaMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]domain.DinaMessage, len(s.inboundMsgs))
	copy(result, s.inboundMsgs)
	return result
}

// ClearInbound removes all received messages (for test reset).
func (s *TransportService) ClearInbound() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inboundMsgs = nil
}
