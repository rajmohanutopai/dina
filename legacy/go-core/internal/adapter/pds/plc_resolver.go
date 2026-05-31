// Package pds implements AT Protocol record signing and publishing.
// This file adds PLC directory DID resolution using the bluesky-social/indigo library.
package pds

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/bluesky-social/indigo/atproto/identity"
	"github.com/bluesky-social/indigo/atproto/syntax"
)

const defaultPLCURL = "https://plc.directory"

// PLCDocument holds a parsed DID document returned by PLC directory resolution.
type PLCDocument struct {
	ID                  string            `json:"id"`
	AlsoKnownAs         []string          `json:"alsoKnownAs"`
	VerificationMethods map[string]string `json:"verificationMethods"`
	Services            map[string]string `json:"services"`
}

// PLCResolver resolves did:plc:* and did:web:* DIDs via the indigo identity directory.
type PLCResolver struct {
	dir *identity.BaseDirectory
}

// NewPLCResolver returns a new PLCResolver. If plcURL is empty, the default
// PLC directory (https://plc.directory) is used.
func NewPLCResolver(plcURL string) *PLCResolver {
	if plcURL == "" {
		plcURL = defaultPLCURL
	}
	return &PLCResolver{
		dir: &identity.BaseDirectory{
			PLCURL: plcURL,
		},
	}
}

// ResolveDID resolves a DID string and returns the raw DID document JSON.
// The DID must be a valid did:plc or did:web identifier.
func (r *PLCResolver) ResolveDID(ctx context.Context, did string) (json.RawMessage, error) {
	if err := validateDIDMethod(did); err != nil {
		return nil, err
	}

	parsed, err := syntax.ParseDID(did)
	if err != nil {
		return nil, fmt.Errorf("plc resolver: invalid DID syntax %q: %w", did, err)
	}

	raw, err := r.dir.ResolveDIDRaw(ctx, parsed)
	if err != nil {
		return nil, fmt.Errorf("plc resolver: resolution failed for %q: %w", did, err)
	}

	return raw, nil
}

// ResolvePLC resolves a DID string and returns a parsed PLCDocument.
// The DID must be a valid did:plc or did:web identifier.
func (r *PLCResolver) ResolvePLC(ctx context.Context, did string) (*PLCDocument, error) {
	if err := validateDIDMethod(did); err != nil {
		return nil, err
	}

	parsed, err := syntax.ParseDID(did)
	if err != nil {
		return nil, fmt.Errorf("plc resolver: invalid DID syntax %q: %w", did, err)
	}

	doc, err := r.dir.ResolveDID(ctx, parsed)
	if err != nil {
		return nil, fmt.Errorf("plc resolver: resolution failed for %q: %w", did, err)
	}

	return toPLCDocument(doc), nil
}

// validateDIDMethod checks that the DID uses a supported method (plc or web).
func validateDIDMethod(did string) error {
	if !strings.HasPrefix(did, "did:plc:") && !strings.HasPrefix(did, "did:web:") {
		return fmt.Errorf("plc resolver: unsupported DID method in %q (expected did:plc or did:web)", did)
	}
	return nil
}

// toPLCDocument converts an indigo DIDDocument to our PLCDocument type.
func toPLCDocument(doc *identity.DIDDocument) *PLCDocument {
	plcDoc := &PLCDocument{
		ID:                  doc.DID.String(),
		AlsoKnownAs:         doc.AlsoKnownAs,
		VerificationMethods: make(map[string]string),
		Services:            make(map[string]string),
	}

	if plcDoc.AlsoKnownAs == nil {
		plcDoc.AlsoKnownAs = []string{}
	}

	for _, vm := range doc.VerificationMethod {
		plcDoc.VerificationMethods[vm.ID] = vm.PublicKeyMultibase
	}

	for _, svc := range doc.Service {
		plcDoc.Services[svc.ID] = svc.ServiceEndpoint
	}

	return plcDoc
}
