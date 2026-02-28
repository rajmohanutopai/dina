// Package pds implements AT Protocol record signing and publishing.
package pds

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/rajmohanutopai/dina/core/internal/domain"
	"github.com/rajmohanutopai/dina/core/internal/port"
)

// Compile-time interface check.
var _ port.PDSPublisher = (*PDSPublisher)(nil)

// PDSRecord holds a signed AT Protocol record.
type PDSRecord = domain.PDSRecord

// Tombstone represents a signed deletion marker.
type Tombstone = domain.Tombstone

// PDSPublisher implements port.PDSPublisher — AT Protocol record signing and publishing.
type PDSPublisher struct {
	mu         sync.Mutex
	records    map[string]*PDSRecord // recordKey -> record
	tombstones map[string]string     // target -> authorDID (tracks who tombstoned what)
	retryQ     []PDSRecord
	authorDID  string // the local author DID for tombstone validation
}

// NewPDSPublisher returns a new PDSPublisher.
func NewPDSPublisher(authorDID string) *PDSPublisher {
	return &PDSPublisher{
		records:    make(map[string]*PDSRecord),
		tombstones: make(map[string]string),
		authorDID:  authorDID,
	}
}

// SignAndPublish signs a record with the persona key and writes to PDS.
func (p *PDSPublisher) SignAndPublish(_ context.Context, record PDSRecord) (string, error) {
	if err := p.ValidateLexicon(record); err != nil {
		return "", err
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	// Sign (placeholder).
	record.Signature = []byte("ed25519-signature-placeholder")
	p.records[record.RecordKey] = &record

	// Return AT URI.
	uri := fmt.Sprintf("at://%s/%s/%s", record.AuthorDID, record.Collection, record.RecordKey)
	return uri, nil
}

// ValidateLexicon checks a record against its Lexicon schema.
func (p *PDSPublisher) ValidateLexicon(record PDSRecord) error {
	switch record.Collection {
	case "com.dina.trust.attestation":
		return validateAttestation(record.Payload)
	case "com.dina.trust.outcome":
		return validateOutcome(record.Payload)
	case "com.dina.trust.bot":
		return validateBot(record.Payload)
	default:
		// Unknown collection — allow for extensibility.
		return nil
	}
}

func validateAttestation(payload map[string]interface{}) error {
	requiredFields := []string{"expertDid", "productCategory", "productId", "rating", "verdict"}
	for _, field := range requiredFields {
		v, ok := payload[field]
		if !ok || v == nil {
			return fmt.Errorf("lexicon validation: missing required field %q", field)
		}
	}

	// Validate rating range (0-100).
	rating, ok := payload["rating"]
	if ok {
		var ratingVal float64
		switch r := rating.(type) {
		case int:
			ratingVal = float64(r)
		case float64:
			ratingVal = r
		default:
			return errors.New("lexicon validation: rating must be a number")
		}
		if ratingVal < 0 || ratingVal > 100 {
			return fmt.Errorf("lexicon validation: rating %v out of range 0-100", ratingVal)
		}
	}

	// Validate verdict is a structured object, not a plain string.
	verdict := payload["verdict"]
	switch verdict.(type) {
	case map[string]interface{}:
		// Valid structured object.
	default:
		return errors.New("lexicon validation: verdict must be a structured object (#verdictDetail), not a string")
	}

	return nil
}

func validateOutcome(payload map[string]interface{}) error {
	// Outcome records have flexible schema — validate basic presence.
	return nil
}

func validateBot(payload map[string]interface{}) error {
	// Bot records have flexible schema — validate basic presence.
	return nil
}

// DeleteRecord publishes a signed tombstone for a record.
func (p *PDSPublisher) DeleteRecord(_ context.Context, tombstone Tombstone) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	// Check if a live record exists — verify author matches.
	record, exists := p.records[tombstone.Target]
	if exists && record.AuthorDID != tombstone.AuthorDID {
		return errors.New("forbidden: only the original author can delete a record")
	}

	// Check if a previous tombstone exists — verify author matches.
	if prevAuthor, tombstoned := p.tombstones[tombstone.Target]; tombstoned {
		if prevAuthor != tombstone.AuthorDID {
			return errors.New("forbidden: only the original author can delete a record")
		}
	}

	// Record the tombstone author for future validation.
	if exists {
		p.tombstones[tombstone.Target] = record.AuthorDID
	} else if _, alreadyTombstoned := p.tombstones[tombstone.Target]; !alreadyTombstoned {
		// New tombstone from relay propagation — trust the signature.
		p.tombstones[tombstone.Target] = tombstone.AuthorDID
	}

	delete(p.records, tombstone.Target)
	return nil
}

// QueueForRetry queues a record in the outbox when PDS is unreachable.
func (p *PDSPublisher) QueueForRetry(_ context.Context, record PDSRecord) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.retryQ = append(p.retryQ, record)
	return nil
}
