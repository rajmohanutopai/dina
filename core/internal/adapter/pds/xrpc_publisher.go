// Package pds implements AT Protocol record signing and publishing.
// This file adds a real XRPC-based publisher that talks to an AT Protocol PDS.
package pds

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/anthropics/dina/core/internal/domain"
	"github.com/anthropics/dina/core/internal/port"
	lexutil "github.com/bluesky-social/indigo/lex/util"
	"github.com/bluesky-social/indigo/xrpc"
	cbg "github.com/whyrusleeping/cbor-gen"
)

// Compile-time interface check.
var _ port.PDSPublisher = (*XRPCPublisher)(nil)

// XRPCPublisher publishes AT Protocol records to a real PDS via XRPC.
type XRPCPublisher struct {
	mu        sync.Mutex
	client    *xrpc.Client
	authorDID string
	retryQ    []domain.PDSRecord
	validator *PDSPublisher // reuse existing lexicon validation from pds.go
}

// NewXRPCPublisher creates a publisher connected to a PDS.
// The client should already have Auth set (via session creation or token).
func NewXRPCPublisher(client *xrpc.Client, authorDID string) *XRPCPublisher {
	return &XRPCPublisher{
		client:    client,
		authorDID: authorDID,
		validator: &PDSPublisher{},
	}
}

// mapRecord wraps an arbitrary map[string]interface{} so it can be used as
// the Val inside a LexiconTypeDecoder. Since XRPC calls are JSON-only in
// practice, we implement MarshalJSON to emit the map and stub out the CBOR
// methods (the PDS HTTP API never uses CBOR for createRecord).
type mapRecord struct {
	data map[string]interface{}
}

var _ cbg.CBORMarshaler = (*mapRecord)(nil)

func (m *mapRecord) MarshalCBOR(w io.Writer) error {
	return fmt.Errorf("CBOR serialization not supported for mapRecord")
}

func (m *mapRecord) MarshalJSON() ([]byte, error) {
	return json.Marshal(m.data)
}

// createRecordInput mirrors atproto.RepoCreateRecord_Input but uses
// json.RawMessage for the record field so we can embed arbitrary map payloads
// without hitting LexiconTypeDecoder's reflection-based MarshalJSON (which
// requires a LexiconTypeID struct field). We call client.LexDo directly
// instead of the generated atproto.RepoCreateRecord wrapper.
type createRecordInput struct {
	Collection string           `json:"collection"`
	Record     json.RawMessage  `json:"record"`
	Repo       string           `json:"repo"`
	Rkey       *string          `json:"rkey,omitempty"`
	SwapCommit *string          `json:"swapCommit,omitempty"`
	Validate   *bool            `json:"validate,omitempty"`
}

// createRecordOutput mirrors atproto.RepoCreateRecord_Output.
type createRecordOutput struct {
	Cid              string  `json:"cid"`
	Uri              string  `json:"uri"`
	ValidationStatus *string `json:"validationStatus,omitempty"`
}

// deleteRecordInput mirrors atproto.RepoDeleteRecord_Input.
type deleteRecordInput struct {
	Collection string  `json:"collection"`
	Repo       string  `json:"repo"`
	Rkey       string  `json:"rkey"`
	SwapCommit *string `json:"swapCommit,omitempty"`
	SwapRecord *string `json:"swapRecord,omitempty"`
}

// SignAndPublish publishes a record to the PDS via com.atproto.repo.createRecord.
// The PDS handles actual commit signing — we submit the record content over XRPC.
// Returns the AT URI of the created record (e.g. at://did:plc:xxx/collection/rkey).
func (p *XRPCPublisher) SignAndPublish(ctx context.Context, record domain.PDSRecord) (string, error) {
	if err := p.ValidateLexicon(record); err != nil {
		return "", fmt.Errorf("xrpc publisher: lexicon validation failed: %w", err)
	}

	// Serialize the payload map to JSON for the record field.
	recordJSON, err := json.Marshal(record.Payload)
	if err != nil {
		return "", fmt.Errorf("xrpc publisher: failed to marshal record payload: %w", err)
	}

	// Determine the repo DID: prefer the record's AuthorDID, fall back to publisher default.
	repo := record.AuthorDID
	if repo == "" {
		repo = p.authorDID
	}

	input := &createRecordInput{
		Collection: record.Collection,
		Record:     recordJSON,
		Repo:       repo,
	}
	if record.RecordKey != "" {
		input.Rkey = &record.RecordKey
	}

	var out createRecordOutput
	err = p.client.LexDo(
		ctx,
		lexutil.Procedure,
		"application/json",
		"com.atproto.repo.createRecord",
		nil,
		input,
		&out,
	)
	if err != nil {
		return "", fmt.Errorf("xrpc publisher: com.atproto.repo.createRecord failed for DID %s collection %s: %w",
			repo, record.Collection, err)
	}

	return out.Uri, nil
}

// ValidateLexicon delegates to the existing PDSPublisher lexicon validator.
func (p *XRPCPublisher) ValidateLexicon(record domain.PDSRecord) error {
	return p.validator.ValidateLexicon(record)
}

// DeleteRecord publishes a record deletion via com.atproto.repo.deleteRecord.
// The tombstone's Target field must be an AT URI (at://did/collection/rkey).
func (p *XRPCPublisher) DeleteRecord(ctx context.Context, tombstone domain.Tombstone) error {
	collection, rkey, err := parseATURI(tombstone.Target)
	if err != nil {
		return fmt.Errorf("xrpc publisher: cannot parse deletion target: %w", err)
	}

	// Determine the repo DID: prefer the tombstone's AuthorDID, fall back to publisher default.
	repo := tombstone.AuthorDID
	if repo == "" {
		repo = p.authorDID
	}

	input := &deleteRecordInput{
		Collection: collection,
		Repo:       repo,
		Rkey:       rkey,
	}

	err = p.client.LexDo(
		ctx,
		lexutil.Procedure,
		"application/json",
		"com.atproto.repo.deleteRecord",
		nil,
		input,
		nil, // deleteRecord returns optional commit metadata we don't need
	)
	if err != nil {
		return fmt.Errorf("xrpc publisher: com.atproto.repo.deleteRecord failed for DID %s target %s: %w",
			repo, tombstone.Target, err)
	}

	return nil
}

// QueueForRetry queues a failed record for later retry. Thread-safe.
func (p *XRPCPublisher) QueueForRetry(_ context.Context, record domain.PDSRecord) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.retryQ = append(p.retryQ, record)
	return nil
}

// FlushRetryQueue attempts to publish all queued records. Returns the number
// of successfully published records. Records that fail again remain in the queue.
func (p *XRPCPublisher) FlushRetryQueue(ctx context.Context) (int, error) {
	p.mu.Lock()
	pending := make([]domain.PDSRecord, len(p.retryQ))
	copy(pending, p.retryQ)
	p.retryQ = p.retryQ[:0]
	p.mu.Unlock()

	var (
		succeeded int
		failed    []domain.PDSRecord
		lastErr   error
	)

	for _, record := range pending {
		if _, err := p.SignAndPublish(ctx, record); err != nil {
			failed = append(failed, record)
			lastErr = err
		} else {
			succeeded++
		}
	}

	// Re-queue failures.
	if len(failed) > 0 {
		p.mu.Lock()
		// Prepend failed records so they are retried first next time.
		p.retryQ = append(failed, p.retryQ...)
		p.mu.Unlock()
	}

	if lastErr != nil {
		return succeeded, fmt.Errorf("xrpc publisher: %d of %d records failed to flush (last error: %w)",
			len(failed), len(pending), lastErr)
	}

	return succeeded, nil
}

// RetryQueueLen returns the current number of records in the retry queue.
func (p *XRPCPublisher) RetryQueueLen() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.retryQ)
}

// parseATURI extracts the collection and rkey from an AT URI.
// Expected format: at://{did}/{collection}/{rkey}
func parseATURI(uri string) (collection, rkey string, err error) {
	if !strings.HasPrefix(uri, "at://") {
		return "", "", fmt.Errorf("invalid AT URI %q: must start with at://", uri)
	}

	// Strip "at://" prefix and split the remainder.
	parts := strings.SplitN(uri[5:], "/", 3)
	if len(parts) != 3 {
		return "", "", fmt.Errorf("invalid AT URI %q: expected at://{did}/{collection}/{rkey}", uri)
	}

	// parts[0] = DID, parts[1] = collection, parts[2] = rkey
	collection = parts[1]
	rkey = parts[2]

	if collection == "" {
		return "", "", fmt.Errorf("invalid AT URI %q: empty collection", uri)
	}
	if rkey == "" {
		return "", "", fmt.Errorf("invalid AT URI %q: empty rkey", uri)
	}

	return collection, rkey, nil
}

// Ensure xrpc.Client satisfies the LexClient interface at compile time.
// This is a documentation aid — the generated atproto functions accept LexClient,
// and xrpc.Client implements it via its LexDo method.
var _ lexutil.LexClient = (*xrpc.Client)(nil)
