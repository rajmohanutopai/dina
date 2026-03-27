// plc_update.go — Update a did:plc document on the PLC directory.
//
// After PDS creates the DID (with only #atproto_pds), Core calls
// UpdatePLCServices to add the #dina_messaging service so other nodes
// can discover the MsgBox endpoint for D2D delivery.
//
// PLC operations are signed DAG-CBOR blobs submitted to the PLC directory.
// The rotation key (secp256k1/k256) authorizes updates.
package pds

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/bluesky-social/indigo/atproto/atcrypto"
	cbor "github.com/fxamacker/cbor/v2"
)

// PLCService describes a service entry in a PLC operation.
type PLCService struct {
	Type     string `json:"type"`
	Endpoint string `json:"endpoint"`
}

// plcAuditEntry is one entry from the PLC audit log.
type plcAuditEntry struct {
	DID       string          `json:"did"`
	Operation json.RawMessage `json:"operation"`
	CID       string          `json:"cid"`
}

// plcOperationJSON is the JSON representation for parsing/submitting.
type plcOperationJSON struct {
	Type                string                `json:"type"`
	RotationKeys        []string              `json:"rotationKeys"`
	VerificationMethods map[string]string     `json:"verificationMethods"`
	AlsoKnownAs         []string              `json:"alsoKnownAs"`
	Services            map[string]PLCService `json:"services"`
	Prev                *string               `json:"prev"`
	Sig                 string                `json:"sig,omitempty"`
}

// dagCBOREncMode uses deterministic encoding (sorted map keys by key length
// then lexicographic — DAG-CBOR requirement for PLC operations).
var dagCBOREncMode cbor.EncMode

func init() {
	opts := cbor.CanonicalEncOptions()
	var err error
	dagCBOREncMode, err = opts.EncMode()
	if err != nil {
		panic("plc_update: failed to init CBOR encoder: " + err.Error())
	}
}

// UpdatePLCDocument fetches the current PLC document, adds the given
// services and verification methods, signs with the rotation key, and
// submits the update. Pass nil for addVerificationMethods to skip.
func UpdatePLCDocument(ctx context.Context, plcURL, did string, rotationKey *atcrypto.PrivateKeyK256, addServices map[string]PLCService, addVerificationMethods map[string]string) error {
	if plcURL == "" {
		plcURL = defaultPLCURL
	}

	// 1. Fetch the audit log to get the latest operation and its CID.
	auditURL := fmt.Sprintf("%s/%s/log/audit", plcURL, did)
	resp, err := http.Get(auditURL)
	if err != nil {
		return fmt.Errorf("plc update: fetch audit log: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("plc update: read audit log: %w", err)
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("plc update: audit log returned %d: %s", resp.StatusCode, truncate(string(body), 200))
	}

	var entries []plcAuditEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return fmt.Errorf("plc update: parse audit log: %w", err)
	}
	if len(entries) == 0 {
		return fmt.Errorf("plc update: no audit entries for %s", did)
	}

	latest := entries[len(entries)-1]

	// Parse the latest operation.
	var latestOp plcOperationJSON
	if err := json.Unmarshal(latest.Operation, &latestOp); err != nil {
		return fmt.Errorf("plc update: parse latest operation: %w", err)
	}

	// 2. Check if everything already exists.
	needsUpdate := false
	for key := range addServices {
		if _, exists := latestOp.Services[key]; !exists {
			needsUpdate = true
			break
		}
	}
	for key := range addVerificationMethods {
		if _, exists := latestOp.VerificationMethods[key]; !exists {
			needsUpdate = true
			break
		}
	}
	if !needsUpdate {
		slog.Info("plc update: already up to date, skipping", "did", did)
		return nil
	}

	// 3. Build the new operation — copy everything, add services + verification methods.
	newOp := plcOperationJSON{
		Type:                "plc_operation",
		RotationKeys:        latestOp.RotationKeys,
		VerificationMethods: make(map[string]string),
		AlsoKnownAs:         latestOp.AlsoKnownAs,
		Services:            make(map[string]PLCService),
		Prev:                &latest.CID,
	}
	for k, v := range latestOp.Services {
		newOp.Services[k] = v
	}
	for k, v := range addServices {
		newOp.Services[k] = v
	}
	for k, v := range latestOp.VerificationMethods {
		newOp.VerificationMethods[k] = v
	}
	for k, v := range addVerificationMethods {
		newOp.VerificationMethods[k] = v
	}

	// 4. Sign: encode unsigned op as DAG-CBOR → SHA-256 → sign with rotation key.
	//    The "sig" field must be absent (not empty string) in the unsigned blob.
	unsignedMap := map[string]interface{}{
		"type":                "plc_operation",
		"rotationKeys":        newOp.RotationKeys,
		"verificationMethods": newOp.VerificationMethods,
		"alsoKnownAs":         newOp.AlsoKnownAs,
		"services":            newOp.Services,
		"prev":                newOp.Prev,
	}

	cborBytes, err := dagCBOREncMode.Marshal(unsignedMap)
	if err != nil {
		return fmt.Errorf("plc update: cbor encode: %w", err)
	}

	// HashAndSign does SHA-256 internally, so pass raw CBOR bytes.
	sigBytes, err := rotationKey.HashAndSign(cborBytes)
	if err != nil {
		return fmt.Errorf("plc update: sign: %w", err)
	}

	// base64url-no-pad encoding (AT Protocol convention).
	newOp.Sig = strings.TrimRight(base64.URLEncoding.EncodeToString(sigBytes), "=")

	// 5. Submit to PLC directory.
	submitURL := fmt.Sprintf("%s/%s", plcURL, did)
	submitBody, err := json.Marshal(newOp)
	if err != nil {
		return fmt.Errorf("plc update: marshal: %w", err)
	}

	slog.Info("plc update: submitting", "did", did, "url", submitURL)

	req, err := http.NewRequestWithContext(ctx, "POST", submitURL, bytes.NewReader(submitBody))
	if err != nil {
		return fmt.Errorf("plc update: create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	submitResp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("plc update: submit: %w", err)
	}
	defer submitResp.Body.Close()

	submitRespBody, _ := io.ReadAll(submitResp.Body)
	if submitResp.StatusCode != 200 {
		return fmt.Errorf("plc update: PLC returned %d: %s", submitResp.StatusCode, truncate(string(submitRespBody), 300))
	}

	slog.Info("plc update: DID document updated on PLC", "did", did, "services_added", len(addServices))
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
