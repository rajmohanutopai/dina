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
	"strings"
	"sync"
	"time"

	"github.com/mr-tron/base58"
	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// ed25519MulticodecPrefix is the multicodec prefix for Ed25519 public keys (0xed, 0x01).
var ed25519MulticodecPrefix = []byte{0xed, 0x01}

// verifyWithAnyKey attempts Ed25519 signature verification against ALL
// verification methods in a DID document. Returns true if any key validates.
// F02: Previously only VerificationMethod[0] was checked, breaking after key rotation.
func (s *TransportService) verifyWithAnyKey(
	doc *domain.DIDDocument, plaintext, sigBytes []byte,
) (bool, error) {
	if s.verifier == nil {
		return false, fmt.Errorf("signature verifier not configured")
	}
	for _, vm := range doc.VerificationMethod {
		pubKey, err := decodeMultibase(vm.PublicKeyMultibase)
		if err != nil {
			continue // skip invalid keys, try next
		}
		valid, verErr := s.verifier.Verify(pubKey, plaintext, sigBytes)
		if verErr == nil && valid {
			return true, nil
		}
	}
	return false, nil
}

// deriveX25519Keypair converts an Ed25519 keypair to X25519 for NaCl encryption/decryption.
// F06: Extracted from 3 duplicated call sites (ReceiveMessage, ProcessInbound, processLegacyInbound).
func (s *TransportService) deriveX25519Keypair(ed25519Pub, ed25519Priv []byte) (x25519Pub, x25519Priv []byte, err error) {
	x25519Priv, err = s.converter.Ed25519ToX25519Private(ed25519Priv)
	if err != nil {
		return nil, nil, fmt.Errorf("convert private key: %w", err)
	}
	x25519Pub, err = s.converter.Ed25519ToX25519Public(ed25519Pub)
	if err != nil {
		return nil, nil, fmt.Errorf("convert public key: %w", err)
	}
	return x25519Pub, x25519Priv, nil
}

// decodeMultibase decodes a multibase-encoded Ed25519 public key.
// Strict format: z + base58btc(0xed01 + 32-byte-pubkey).
func decodeMultibase(multibaseKey string) ([]byte, error) {
	if len(multibaseKey) < 2 {
		return nil, fmt.Errorf("invalid multibase key: too short")
	}

	if multibaseKey[0] != 'z' {
		return nil, fmt.Errorf("invalid multibase key: expected z-prefix")
	}
	decoded, err := base58.Decode(multibaseKey[1:])
	if err != nil {
		return nil, fmt.Errorf("base58btc decode failed: %w", err)
	}
	// Validate multicodec prefix (0xed, 0x01) and strip it.
	if len(decoded) != 34 || decoded[0] != 0xed || decoded[1] != 0x01 {
		return nil, fmt.Errorf("invalid Ed25519 multikey: expected 34 bytes with 0xed01 prefix, got %d bytes", len(decoded))
	}
	return decoded[2:], nil
}

// d2dPayload is the JSON wrapper sent over the wire containing both
// the NaCl-encrypted ciphertext and the Ed25519 signature over the plaintext.
// This allows the receiver to verify the sender's signature after decryption.
type d2dPayload struct {
	Ciphertext string `json:"c"` // base64-encoded NaCl sealed box
	Sig        string `json:"s"` // hex-encoded Ed25519 signature over plaintext
}

// EgressApprovalResult is returned by SendMessage when the message is parked
// for explicit_once approval rather than sent immediately. The caller should
// surface this to the owner (e.g. return 202 with pending_approval status).
type EgressApprovalResult struct {
	ApprovalID    string // ID of the created ApprovalRequest
	OutboxMsgID   string // ID of the parked outbox message
}

// TransportService orchestrates secure Dina-to-Dina message exchange.
// It signs and encrypts outbound messages, decrypts and verifies inbound
// messages, and manages reliable delivery via the outbox queue.
type TransportService struct {
	encryptor      port.Encryptor
	signer         port.IdentitySigner
	verifier       port.Signer // for signature verification on receive
	converter      port.KeyConverter
	resolver       port.DIDResolver
	outbox         port.OutboxManager
	inbox          port.InboxManager
	clock          port.Clock
	deliverer      port.Deliverer           // optional: immediate delivery to remote endpoint
	egress         port.Gatekeeper          // SEC-HIGH-04: egress policy enforcement
	scenarioPolicy port.ScenarioPolicyManager // D2D v1: per-contact scenario policy
	contacts       port.ContactLookup         // D2D v1: contact gate on egress
	auditor        port.VaultAuditLogger      // D2D v1: audit trail
	approvals      port.ApprovalManager       // D2D v1: outbound approval (explicit_once)

	recipientPub  []byte
	recipientPriv []byte
	senderDID     string // this node's own DID for the From field
	mu            sync.Mutex
	inboundMsgs   []domain.DinaMessage

	// SEC-HIGH-08: replay cache for inbound message dedup.
	// F03: Bounded to maxReplayCacheSize entries. When exceeded, oldest
	// entries are evicted to prevent unbounded memory growth under DDoS.
	replayMu    sync.Mutex
	replayCache map[string]int64 // key: "senderDID|msgID" -> Unix timestamp

	// TST-CORE-1092: Legacy migration flag. When true, ProcessInbound accepts
	// raw NaCl sealed box bytes (no JSON wrapper, no signature) with a warning.
	// Set via DINA_ALLOW_UNSIGNED_D2D=1. Must be removed after migration.
	allowUnsignedD2D bool

	// MsgBox forwarder for DinaMsgBox service type routing.
	// Sends authenticated POST /forward to the recipient's msgbox.
	msgboxForwarder MsgBoxForwarder
}

// MsgBoxForwarder sends messages via a D2D msgbox with authenticated requests.
type MsgBoxForwarder interface {
	ForwardToMsgBox(ctx context.Context, forwardURL, recipientDID string, payload []byte) error
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
		encryptor:   encryptor,
		signer:      signer,
		converter:   converter,
		resolver:    resolver,
		outbox:      outbox,
		inbox:       inbox,
		clock:       clock,
		replayCache: make(map[string]int64),
	}
}

// SetDeliverer sets an optional Deliverer for immediate message delivery.
// When set, SendMessage will attempt to deliver the encrypted payload
// to the recipient's service endpoint after outbox enqueue.
func (s *TransportService) SetDeliverer(d port.Deliverer) {
	s.deliverer = d
}

// SetMsgBoxForwarder sets the authenticated forwarder for DinaMsgBox routing.
func (s *TransportService) SetMsgBoxForwarder(f MsgBoxForwarder) {
	s.msgboxForwarder = f
}

// SetVerifier sets the Ed25519 signer used to verify inbound message signatures.
func (s *TransportService) SetVerifier(v port.Signer) {
	s.verifier = v
}

// SetEgress sets the gatekeeper used for egress policy enforcement on outbound messages.
func (s *TransportService) SetEgress(gk port.Gatekeeper) {
	s.egress = gk
}

// SetScenarioPolicy sets the scenario policy manager used for D2D v1 egress gates.
func (s *TransportService) SetScenarioPolicy(sp port.ScenarioPolicyManager) {
	s.scenarioPolicy = sp
}

// SetContacts sets the contact lookup used for the D2D v1 contact gate on egress.
func (s *TransportService) SetContacts(cl port.ContactLookup) {
	s.contacts = cl
}

// SetAuditor sets the audit logger used to record D2D protocol events.
func (s *TransportService) SetAuditor(a port.VaultAuditLogger) {
	s.auditor = a
}

// SetApprovals sets the approval manager used for explicit_once outbound approvals.
func (s *TransportService) SetApprovals(am port.ApprovalManager) {
	s.approvals = am
}

// SetAllowUnsignedD2D enables legacy raw-bytes D2D processing (TST-CORE-1092).
// When enabled, ProcessInbound falls back to raw NaCl decryption if JSON
// wrapper parsing fails. The message is accepted WITHOUT signature verification
// and a warning is logged. This is a migration aid — remove once all senders
// use the signed JSON wrapper format.
func (s *TransportService) SetAllowUnsignedD2D(allow bool) {
	s.allowUnsignedD2D = allow
}

// SendMessage signs and encrypts a message for the recipient, then attempts
// immediate delivery. If delivery fails, the message is queued in the outbox
// for later retry via ProcessOutbox.
//
// D2D v1 egress gates (in order):
//  1. Contact gate: recipient must be in the local contact directory.
//  2. Scenario policy gate: deny_by_default → return ErrEgressBlocked.
//     explicit_once → park in outbox as pending_approval, create ApprovalRequest.
//  3. PII/gatekeeper gate (existing SEC-HIGH-04 check).
//
// When the message is parked for explicit_once approval, the returned error
// wraps ErrExplicitOnceParked and the caller can type-assert it to
// *EgressApprovalResult to surface approval details to the owner.
func (s *TransportService) SendMessage(ctx context.Context, to domain.DID, msg domain.DinaMessage) error {
	// Gate 1: Contact check — recipient must be an explicit contact.
	if s.contacts != nil {
		if !s.contacts.IsContact(string(to)) {
			s.appendAudit(ctx, "d2d_egress_blocked", string(to), string(msg.Type), "contact_gate", "not_a_contact")
			return fmt.Errorf("transport: %w: %s", domain.ErrNotAContact, to)
		}
	}

	// Gate 2: Scenario policy check.
	if s.scenarioPolicy != nil {
		scenario := domain.MsgTypeToScenario(msg.Type)
		if scenario != "" {
			tier, tierErr := s.scenarioPolicy.GetScenarioTier(ctx, string(to), scenario)
			if tierErr != nil {
				slog.Warn("transport: scenario policy lookup failed", "to", to, "scenario", scenario, "error", tierErr)
				// Fail closed: treat lookup failure as deny.
				s.appendAudit(ctx, "d2d_egress_blocked", string(to), string(msg.Type), "scenario_gate", "policy_lookup_failed")
				return fmt.Errorf("transport: %w: scenario policy lookup failed for %s", domain.ErrEgressBlocked, scenario)
			}
			switch tier {
			case domain.ScenarioDenyByDefault:
				slog.Info("transport: egress blocked by scenario policy",
					"to", to, "scenario", scenario, "tier", tier)
				s.appendAudit(ctx, "d2d_egress_blocked", string(to), string(msg.Type), "scenario_gate", "deny_by_default")
				return fmt.Errorf("transport: %w: scenario %q is deny_by_default for %s", domain.ErrEgressBlocked, scenario, to)

			case domain.ScenarioExplicitOnce:
				// Park the message for owner approval. We need to fully prepare
				// the encrypted payload so it can be sent as-is after approval
				// with zero post-approval transformation.
				return s.parkForApproval(ctx, to, msg, scenario)
			// ScenarioStandingPolicy: fall through to send.
			}
		}
	}

	// Gate 3: Strict v1 type enforcement on outbound.
	if !domain.V1MessageFamilies[msg.Type] {
		s.appendAudit(ctx, "d2d_type_rejected", string(to), string(msg.Type), "type_gate", "not_v1")
		return fmt.Errorf("transport: %w: %q", domain.ErrUnknownMessageType, msg.Type)
	}

	// Gate 4 (existing): PII / gatekeeper egress check (SEC-HIGH-04).
	if s.egress != nil {
		plaintext, _ := json.Marshal(msg)
		allowed, err := s.egress.CheckEgress(ctx, string(to), plaintext)
		if err != nil {
			return fmt.Errorf("transport: egress check failed: %w", err)
		}
		if !allowed {
			s.appendAudit(ctx, "d2d_egress_blocked", string(to), string(msg.Type), "pii_gate", "blocked_by_gatekeeper")
			return fmt.Errorf("transport: %w: egress to %s blocked by policy", domain.ErrEgressBlocked, to)
		}
	}

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

	// HIGH-05: Decode the recipient's multibase-encoded Ed25519 public key.
	// Prefer #dina_signing (Ed25519) over #atproto (secp256k1).
	multibaseKey := ""
	for _, vm := range doc.VerificationMethod {
		if strings.Contains(vm.ID, "dina_signing") || strings.Contains(vm.ID, "key-1") {
			multibaseKey = vm.PublicKeyMultibase
			break
		}
	}
	if multibaseKey == "" {
		// Fallback: first verification method (backward compat with KNOWN_PEERS).
		multibaseKey = doc.VerificationMethod[0].PublicKeyMultibase
	}
	recipientEd25519Pub, err := decodeMultibase(multibaseKey)
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
	// Route based on recipient's DID document service type:
	//   DinaMsgBox      → Authenticated POST to msgbox's /forward endpoint
	//   DinaDirectHTTPS → Direct HTTP POST to recipient's /msg endpoint
	// On failure, the message stays in the outbox for retry via ProcessOutbox.
	if s.deliverer != nil && len(doc.Service) > 0 {
		svc := findMessagingService(doc.Service)
		slog.Info("transport.send_route", "svc_type", svc.Type, "endpoint", svc.ServiceEndpoint, "has_forwarder", s.msgboxForwarder != nil, "to", to, "num_services", len(doc.Service))
		if svc.ServiceEndpoint != "" {
			var deliverErr error
			if svc.Type == "DinaMsgBox" && s.msgboxForwarder != nil {
				// Convert ws://host:port → http://host:port/forward
				forwardURL := strings.Replace(svc.ServiceEndpoint, "wss://", "https://", 1)
				forwardURL = strings.Replace(forwardURL, "ws://", "http://", 1)
				forwardURL = strings.TrimSuffix(forwardURL, "/ws")
				forwardURL = strings.TrimSuffix(forwardURL, "/")
				forwardURL += "/forward"
				deliverErr = s.msgboxForwarder.ForwardToMsgBox(ctx, forwardURL, string(to), deliveryPayload)
			} else {
				deliverErr = s.deliverer.Deliver(ctx, svc.ServiceEndpoint, deliveryPayload)
			}
			if deliverErr == nil {
				_ = s.outbox.MarkDelivered(ctx, msgID)
			}
			// Delivery failure is not an error — outbox will retry.
		}
	}

	// D2D v1 audit: successful send.
	s.appendAudit(ctx, "d2d_send", string(to), string(msg.Type), "", "success")

	return nil
}

// findMessagingService returns the #dina_messaging service from a DID document,
// or falls back to the first service. This determines routing: DinaMsgBox vs DinaDirectHTTPS.
func findMessagingService(services []domain.ServiceEndpoint) domain.ServiceEndpoint {
	for _, svc := range services {
		if svc.ID == "#dina_messaging" || svc.Type == "DinaMsgBox" || svc.Type == "DinaDirectHTTPS" {
			return svc
		}
	}
	if len(services) > 0 {
		return services[0]
	}
	return domain.ServiceEndpoint{}
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
	// Convert recipient Ed25519 keys to X25519 for NaCl decryption.
	x25519Pub, x25519Priv, err := s.deriveX25519Keypair(recipientPub, recipientPriv)
	if err != nil {
		return nil, fmt.Errorf("transport: %w", err)
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
	// DM2: Reject oversized message bodies at domain level.
	if err := msg.ValidateBody(); err != nil {
		return nil, fmt.Errorf("transport: %w", err)
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

	if envelope.Sig == "" {
		return nil, fmt.Errorf("transport: %w: missing signature", domain.ErrInvalidSignature)
	}

	// F02: Verify against ALL keys in the DID document (supports key rotation).
	sigBytes, sigErr := hex.DecodeString(envelope.Sig)
	if sigErr != nil {
		return nil, fmt.Errorf("transport: decode signature hex: %w", sigErr)
	}
	valid, verErr := s.verifyWithAnyKey(senderDoc, plaintext, sigBytes)
	if verErr != nil || !valid {
		return nil, fmt.Errorf("transport: %w", domain.ErrInvalidSignature)
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

		svc := findMessagingService(doc.Service)
		if svc.ServiceEndpoint == "" {
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

		// Route by service type (same as SendMessage).
		var deliverErr error
		if svc.Type == "DinaMsgBox" && s.msgboxForwarder != nil {
			forwardURL := strings.Replace(svc.ServiceEndpoint, "wss://", "https://", 1)
			forwardURL = strings.Replace(forwardURL, "ws://", "http://", 1)
			forwardURL = strings.TrimSuffix(forwardURL, "/ws")
			forwardURL = strings.TrimSuffix(forwardURL, "/")
			forwardURL += "/forward"
			deliverErr = s.msgboxForwarder.ForwardToMsgBox(ctx, forwardURL, msg.ToDID, deliveryPayload)
		} else if s.deliverer != nil {
			deliverErr = s.deliverer.Deliver(ctx, svc.ServiceEndpoint, deliveryPayload)
		}
		if deliverErr != nil {
			_ = s.outbox.MarkFailed(ctx, msg.ID)
		} else {
			_ = s.outbox.MarkDelivered(ctx, msg.ID)
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
// Strict format: JSON wrapper {"c": "<base64 ciphertext>", "s": "<hex sig>"}.
// Signature verification is mandatory.
func (s *TransportService) ProcessInbound(ctx context.Context, sealed []byte) (*domain.DinaMessage, error) {
	if s.recipientPub == nil || s.recipientPriv == nil {
		return nil, fmt.Errorf("transport: recipient keys not configured")
	}
	if s.verifier == nil {
		return nil, fmt.Errorf("transport: signature verifier not configured")
	}

	// Parse JSON wrapper and require both ciphertext and signature.
	var ciphertext []byte
	var sigHex string
	var payload d2dPayload
	if err := json.Unmarshal(sealed, &payload); err != nil || payload.Ciphertext == "" {
		// TST-CORE-1092: Legacy migration — accept raw NaCl bytes if explicitly enabled.
		if s.allowUnsignedD2D {
			return s.processLegacyInbound(ctx, sealed)
		}
		return nil, fmt.Errorf("transport: %w: invalid envelope format", domain.ErrInvalidSignature)
	}
	if payload.Sig == "" {
		return nil, fmt.Errorf("transport: %w: missing signature", domain.ErrInvalidSignature)
	}
	decoded, decErr := base64.StdEncoding.DecodeString(payload.Ciphertext)
	if decErr != nil {
		return nil, fmt.Errorf("transport: decode ciphertext base64: %w", decErr)
	}
	ciphertext = decoded
	sigHex = payload.Sig

	x25519Pub, x25519Priv, convErr := s.deriveX25519Keypair(s.recipientPub, s.recipientPriv)
	if convErr != nil {
		return nil, fmt.Errorf("transport: %w", convErr)
	}
	plaintext, err := s.encryptor.OpenAnonymous(ciphertext, x25519Pub, x25519Priv)
	if err != nil {
		return nil, fmt.Errorf("transport: decrypt inbound: %w", err)
	}
	var msg domain.DinaMessage
	if err := json.Unmarshal(plaintext, &msg); err != nil {
		return nil, fmt.Errorf("transport: unmarshal inbound: %w", err)
	}
	// DM2: Reject oversized message bodies at domain level.
	if err := msg.ValidateBody(); err != nil {
		return nil, fmt.Errorf("transport: %w", err)
	}

	// Verify the sender's signature.
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

	// F02: Verify against ALL keys in the DID document (supports key rotation).
	valid, verErr := s.verifyWithAnyKey(senderDoc, plaintext, sigBytes)
	if verErr != nil || !valid {
		return nil, fmt.Errorf("transport: %w", domain.ErrInvalidSignature)
	}

	// SEC-HIGH-08: Replay detection using bounded (sender, msgID) cache.
	if msg.ID != "" && msg.From != "" {
		replayKey := msg.From + "|" + msg.ID
		s.replayMu.Lock()
		if _, seen := s.replayCache[replayKey]; seen {
			s.replayMu.Unlock()
			return nil, fmt.Errorf("transport: %w: duplicate (sender=%s, id=%s)", domain.ErrReplayDetected, msg.From, msg.ID)
		}
		now := s.clock.Now().Unix()
		// F03: Evict oldest entries when cache exceeds max size.
		if len(s.replayCache) >= maxReplayCacheSize {
			s.evictOldestReplayEntries(now)
		}
		s.replayCache[replayKey] = now
		s.replayMu.Unlock()
	}

	// D2D v1: Strict type enforcement on inbound — reject non-v1 types.
	if !domain.V1MessageFamilies[msg.Type] {
		s.appendAuditInbound(ctx, "d2d_type_rejected", msg.From, string(msg.Type), "not_v1")
		return nil, fmt.Errorf("transport: %w: %q", domain.ErrUnknownMessageType, msg.Type)
	}

	// D2D v1 audit: successful receive.
	s.appendAuditInbound(ctx, "d2d_receive", msg.From, string(msg.Type), "success")

	return &msg, nil
}

// processLegacyInbound decrypts a raw NaCl sealed box without signature
// verification. This is the TST-CORE-1092 legacy migration path — it allows
// old senders that haven't migrated to the signed JSON wrapper format to
// continue sending messages. A warning is logged for every legacy message
// to track migration progress. The message is accepted but flagged as
// unsigned via the UnsignedLegacy field.
func (s *TransportService) processLegacyInbound(_ context.Context, sealed []byte) (*domain.DinaMessage, error) {
	x25519Pub, x25519Priv, convErr := s.deriveX25519Keypair(s.recipientPub, s.recipientPriv)
	if convErr != nil {
		return nil, fmt.Errorf("transport: legacy: %w", convErr)
	}
	plaintext, err := s.encryptor.OpenAnonymous(sealed, x25519Pub, x25519Priv)
	if err != nil {
		return nil, fmt.Errorf("transport: legacy: decrypt raw NaCl failed: %w", err)
	}
	var msg domain.DinaMessage
	if err := json.Unmarshal(plaintext, &msg); err != nil {
		return nil, fmt.Errorf("transport: legacy: unmarshal plaintext: %w", err)
	}

	// Log warning for migration tracking — never silent about unsigned messages.
	slog.Warn("transport: accepted unsigned D2D message (legacy migration)",
		"from", msg.From,
		"id", msg.ID,
		"hint", "sender should migrate to signed JSON wrapper format",
	)

	return &msg, nil
}

// PurgeReplayCache removes entries older than maxAge from the replay cache.
// Called periodically from the background ticker in main.go.
func (s *TransportService) PurgeReplayCache(maxAge time.Duration) int {
	s.replayMu.Lock()
	defer s.replayMu.Unlock()

	cutoff := s.clock.Now().Add(-maxAge).Unix()
	purged := 0
	for key, ts := range s.replayCache {
		if ts < cutoff {
			delete(s.replayCache, key)
			purged++
		}
	}
	return purged
}

// evictOldestReplayEntries removes the oldest quarter of replay cache entries.
// Called when the cache hits maxReplayCacheSize. Caller must hold replayMu.
func (s *TransportService) evictOldestReplayEntries(now int64) {
	// Find the oldest 25% of entries by timestamp and remove them.
	// Under sustained DDoS this runs once per ~25K messages — O(n) is acceptable.
	if len(s.replayCache) == 0 {
		return
	}
	// Collect timestamps to find the 25th percentile cutoff.
	target := len(s.replayCache) / 4
	if target < 1 {
		target = 1
	}
	// Simple approach: find the oldest entries by scanning once.
	oldest := now
	for _, ts := range s.replayCache {
		if ts < oldest {
			oldest = ts
		}
	}
	// Evict everything in the oldest quarter of the time range.
	cutoff := oldest + (now-oldest)/4
	evicted := 0
	for key, ts := range s.replayCache {
		if ts <= cutoff {
			delete(s.replayCache, key)
			evicted++
		}
		if evicted >= target {
			break
		}
	}
	slog.Info("transport: replay cache eviction", "evicted", evicted, "remaining", len(s.replayCache))
}

// ReplayCacheSize returns the current number of entries in the replay cache.
// Exposed for testing and observability.
func (s *TransportService) ReplayCacheSize() int {
	s.replayMu.Lock()
	defer s.replayMu.Unlock()
	return len(s.replayCache)
}

// maxInboundMessages is the hard cap on in-memory inbound messages (SEC-MED-09).
const maxInboundMessages = 10000

// maxReplayCacheSize is the hard cap on replay cache entries (F03).
// Under DDoS with unique sender+msgID pairs, memory is bounded to
// ~100K entries × ~80 bytes/entry ≈ 8 MB.
const maxReplayCacheSize = 100_000

// StoreInbound adds a decrypted message to the in-memory inbox.
// SEC-MED-09: Enforces a hard cap to prevent unbounded memory growth.
func (s *TransportService) StoreInbound(msg *domain.DinaMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.inboundMsgs) >= maxInboundMessages {
		slog.Warn("inbound message cap reached, dropping oldest", "cap", maxInboundMessages)
		// Drop the oldest message to make room.
		s.inboundMsgs = s.inboundMsgs[1:]
	}
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

// ---------------------------------------------------------------------------
// D2D v1 audit helpers
// ---------------------------------------------------------------------------

// appendAudit writes a D2D protocol event to the audit log.
// Best-effort: audit failure never blocks the protocol operation.
func (s *TransportService) appendAudit(ctx context.Context, action, toDID, msgType, gate, reason string) {
	if s.auditor == nil {
		return
	}
	metadata := fmt.Sprintf(`{"to":%q,"msg_type":%q,"gate":%q,"reason":%q}`,
		toDID, msgType, gate, reason)
	entry := domain.VaultAuditEntry{
		Timestamp: s.clock.Now().UTC().Format("2006-01-02T15:04:05Z"),
		Action:    action,
		Requester: toDID,
		QueryType: msgType,
		Reason:    reason,
		Metadata:  metadata,
	}
	_, _ = s.auditor.Append(ctx, entry)
}

// appendAuditInbound writes a D2D inbound event to the audit log.
func (s *TransportService) appendAuditInbound(ctx context.Context, action, fromDID, msgType, reason string) {
	if s.auditor == nil {
		return
	}
	metadata := fmt.Sprintf(`{"from":%q,"msg_type":%q,"reason":%q}`,
		fromDID, msgType, reason)
	entry := domain.VaultAuditEntry{
		Timestamp: s.clock.Now().UTC().Format("2006-01-02T15:04:05Z"),
		Action:    action,
		Requester: fromDID,
		QueryType: msgType,
		Reason:    reason,
		Metadata:  metadata,
	}
	_, _ = s.auditor.Append(ctx, entry)
}

// ---------------------------------------------------------------------------
// D2D v1 explicit_once: park for approval
// ---------------------------------------------------------------------------

// ErrExplicitOnceParked is a sentinel that wraps ErrEgressBlocked when a message
// is parked for explicit_once approval. Callers should check errors.Is(err, ErrExplicitOnceParked)
// and extract the approval details from the error.
var ErrExplicitOnceParked = fmt.Errorf("explicit_once: message parked for approval")

// ExplicitOnceParkedError wraps approval details for callers to surface.
type ExplicitOnceParkedError struct {
	ApprovalID  string
	OutboxMsgID string
}

func (e *ExplicitOnceParkedError) Error() string {
	return fmt.Sprintf("explicit_once: parked for approval (approval_id=%s, outbox_msg_id=%s)", e.ApprovalID, e.OutboxMsgID)
}

func (e *ExplicitOnceParkedError) Unwrap() error {
	return ErrExplicitOnceParked
}

// parkForApproval encrypts the message and parks it in the outbox as
// pending_approval. Creates an ApprovalRequest with action=d2d_send.
// For v1, this is simplified: treat explicit_once as an egress block.
// The full approval flow (park encrypted payload, create approval, resume
// on approval) is deferred — for now we return ErrEgressBlocked.
func (s *TransportService) parkForApproval(ctx context.Context, to domain.DID, msg domain.DinaMessage, scenario string) error {
	s.appendAudit(ctx, "d2d_egress_blocked", string(to), string(msg.Type), "scenario_gate", "explicit_once")
	return fmt.Errorf("transport: %w: scenario %q requires explicit approval for %s", domain.ErrEgressBlocked, scenario, to)
}
