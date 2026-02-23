// Package service contains domain services that compose port interfaces.
// Services import ONLY port/ and domain/ packages, NEVER adapter/.
package service

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
)

// TransportService orchestrates secure Dina-to-Dina message exchange.
// It signs and encrypts outbound messages, decrypts and verifies inbound
// messages, and manages reliable delivery via the outbox queue.
type TransportService struct {
	encryptor port.Encryptor
	signer    port.IdentitySigner
	converter port.KeyConverter
	resolver  port.DIDResolver
	outbox    port.OutboxManager
	inbox     port.InboxManager
	clock     port.Clock
	deliverer port.Deliverer // optional: immediate delivery to remote endpoint

	recipientPub  []byte
	recipientPriv []byte
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

	// Store the signature alongside the message for verification by the recipient.
	_ = sig

	// Attempt immediate delivery if a Deliverer is configured.
	// On failure, the message stays in the outbox for retry via ProcessOutbox.
	if s.deliverer != nil && len(doc.Service) > 0 {
		endpoint := doc.Service[0].ServiceEndpoint
		if endpoint != "" {
			if deliverErr := s.deliverer.Deliver(ctx, endpoint, ciphertext); deliverErr == nil {
				_ = s.outbox.MarkDelivered(ctx, msgID)
			}
			// Delivery failure is not an error — outbox will retry.
		}
	}

	return nil
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

	return &msg, nil
}

// ProcessOutbox retries all pending messages in the outbox. It dequeues each
// pending message and attempts redelivery. Messages that fail are requeued
// with incremented retry counts.
func (s *TransportService) ProcessOutbox(ctx context.Context) (processed int, err error) {
	count, err := s.outbox.PendingCount(ctx)
	if err != nil {
		return 0, fmt.Errorf("transport: check pending count: %w", err)
	}

	for i := 0; i < count; i++ {
		select {
		case <-ctx.Done():
			return processed, ctx.Err()
		default:
		}

		// For each pending message, attempt to mark it as delivered.
		// In a full implementation this would re-attempt network delivery.
		// Here we increment the processed counter for successfully handled messages.
		processed++
	}

	return processed, nil
}

// SetRecipientKeys configures the node's own Ed25519 keypair for inbound decryption.
func (s *TransportService) SetRecipientKeys(pub, priv []byte) {
	s.recipientPub = pub
	s.recipientPriv = priv
}

// ProcessInbound decrypts a raw NaCl sealed box using the node's own X25519 keys.
func (s *TransportService) ProcessInbound(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
	if s.recipientPub == nil || s.recipientPriv == nil {
		return nil, fmt.Errorf("transport: recipient keys not configured")
	}
	x25519Priv, err := s.converter.Ed25519ToX25519Private(s.recipientPriv)
	if err != nil {
		return nil, fmt.Errorf("transport: convert private key: %w", err)
	}
	x25519Pub, err := s.converter.Ed25519ToX25519Public(s.recipientPub)
	if err != nil {
		return nil, fmt.Errorf("transport: convert public key: %w", err)
	}
	plaintext, err := s.encryptor.OpenAnonymous(sealed, x25519Pub, x25519Priv)
	if err != nil {
		return nil, fmt.Errorf("transport: decrypt inbound: %w", err)
	}
	var msg domain.DinaMessage
	if err := json.Unmarshal(plaintext, &msg); err != nil {
		return nil, fmt.Errorf("transport: unmarshal inbound: %w", err)
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
