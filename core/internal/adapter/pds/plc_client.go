// Package pds implements AT Protocol record signing and publishing.
// This file adds a PLC directory client that registers did:plc identities via a PDS's XRPC API.
package pds

import (
	"context"
	"fmt"

	"github.com/bluesky-social/indigo/api/atproto"
	"github.com/bluesky-social/indigo/xrpc"
)

// CreateDIDOptions holds parameters for DID creation via PDS.
type CreateDIDOptions struct {
	Handle      string // e.g., "dina.localhost" or custom handle
	Password    string // PDS account password
	Email       string // optional email
	RecoveryKey string // did:key for user's own k256 rotation key (optional)
}

// CreateDIDResult holds the output of DID creation.
type CreateDIDResult struct {
	DID        string
	Handle     string
	AccessJwt  string
	RefreshJwt string
}

// PLCClient registers and manages did:plc identities via a PDS XRPC endpoint.
type PLCClient struct {
	pdsURL string
	plcURL string
	client *xrpc.Client
}

// NewPLCClient creates a client for PLC operations via a PDS.
// pdsURL is the PDS XRPC endpoint (e.g., "http://localhost:2583").
// plcURL is the PLC directory (e.g., "https://plc.directory").
func NewPLCClient(pdsURL, plcURL string) *PLCClient {
	ua := "dina-core/1.0"
	return &PLCClient{
		pdsURL: pdsURL,
		plcURL: plcURL,
		client: &xrpc.Client{
			Host:      pdsURL,
			UserAgent: &ua,
		},
	}
}

// PDSURL returns the configured PDS endpoint URL.
func (c *PLCClient) PDSURL() string {
	return c.pdsURL
}

// CreateAccountAndDID creates a PDS account which registers the did:plc
// on the PLC directory. Returns the DID and auth tokens.
// When the PDS requires invite codes and an admin token is configured,
// an invite code is created automatically before account creation.
func (c *PLCClient) CreateAccountAndDID(ctx context.Context, opts CreateDIDOptions) (*CreateDIDResult, error) {
	if opts.Handle == "" {
		return nil, fmt.Errorf("plc client: handle is required")
	}
	if opts.Password == "" {
		return nil, fmt.Errorf("plc client: password is required")
	}

	input := &atproto.ServerCreateAccount_Input{
		Handle:   opts.Handle,
		Password: &opts.Password,
	}

	if opts.Email != "" {
		input.Email = &opts.Email
	}
	if opts.RecoveryKey != "" {
		input.RecoveryKey = &opts.RecoveryKey
	}

	// If admin token is configured, create an invite code for account creation.
	// This handles PDS instances with PDS_INVITE_REQUIRED=true.
	if c.client.AdminToken != nil && *c.client.AdminToken != "" {
		inviteOut, err := atproto.ServerCreateInviteCode(ctx, c.client, &atproto.ServerCreateInviteCode_Input{
			UseCount: 1,
		})
		if err == nil {
			input.InviteCode = &inviteOut.Code
		}
		// Non-fatal: if PDS doesn't require invites, the code is simply unused.
	}

	out, err := atproto.ServerCreateAccount(ctx, c.client, input)
	if err != nil {
		return nil, fmt.Errorf("plc client: create account failed: %w", err)
	}

	// Store auth tokens on the internal client for subsequent calls.
	c.client.Auth = &xrpc.AuthInfo{
		AccessJwt:  out.AccessJwt,
		RefreshJwt: out.RefreshJwt,
		Handle:     out.Handle,
		Did:        out.Did,
	}

	return &CreateDIDResult{
		DID:        out.Did,
		Handle:     out.Handle,
		AccessJwt:  out.AccessJwt,
		RefreshJwt: out.RefreshJwt,
	}, nil
}

// Authenticate creates a session for an existing account.
// Sets auth tokens on the internal xrpc.Client for subsequent calls.
func (c *PLCClient) Authenticate(ctx context.Context, identifier, password string) error {
	if identifier == "" {
		return fmt.Errorf("plc client: identifier is required")
	}
	if password == "" {
		return fmt.Errorf("plc client: password is required")
	}

	input := &atproto.ServerCreateSession_Input{
		Identifier: identifier,
		Password:   password,
	}

	out, err := atproto.ServerCreateSession(ctx, c.client, input)
	if err != nil {
		return fmt.Errorf("plc client: create session failed: %w", err)
	}

	c.client.Auth = &xrpc.AuthInfo{
		AccessJwt:  out.AccessJwt,
		RefreshJwt: out.RefreshJwt,
		Handle:     out.Handle,
		Did:        out.Did,
	}

	return nil
}

// Client returns the underlying xrpc.Client (for use by XRPCPublisher).
func (c *PLCClient) Client() *xrpc.Client {
	return c.client
}

// SetAdminToken sets the admin token for admin-level XRPC calls.
func (c *PLCClient) SetAdminToken(token string) {
	c.client.AdminToken = &token
}
