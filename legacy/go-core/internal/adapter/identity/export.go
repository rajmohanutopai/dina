// Package identity — identity export/import for DID recovery.
//
// IdentityExport bundles the minimum artifacts needed to restore a DID
// on a new device:
//   - did_metadata.json (DID string, key paths, PLC registration status)
//   - wrapped_seed.bin (AES-256-GCM encrypted master seed)
//   - master_seed.salt (Argon2id salt for KEK derivation)
//   - HMAC-SHA256 over metadata (keyed by master seed, verified after unwrap)
//
// The wrapped seed is already encrypted with the user's passphrase
// (Argon2id + AES-256-GCM), so the bundle itself does not need additional
// encryption. The HMAC provides integrity protection: any tampering with
// the metadata (DID, key paths, PDS URL) is detected after seed unwrapping.
//
// Recovery flow:
//  1. Load bundle → parse IdentityBundle JSON
//  2. User provides passphrase → derive KEK → unwrap seed
//  3. Verify bundle integrity: VerifyBundleIntegrity(bundle, seed)
//  4. Re-derive signing key at metadata.SigningKeyPath
//  5. Re-derive rotation key at metadata.RotationKeyPath (if PLC-registered)
//  6. Call DIDManager.RestoreDID(metadata, publicKey)
//  7. For PLC DIDs: use rotation key to update the PLC directory
package identity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"golang.org/x/crypto/hkdf"
)

// IdentityBundle is the portable identity recovery package.
// It contains everything needed to reclaim a DID on a new device,
// given the user's passphrase.
type IdentityBundle struct {
	Version      int          `json:"version"`       // bundle format version (1)
	Metadata     *DIDMetadata `json:"metadata"`       // DID + derivation paths
	WrappedSeed  []byte       `json:"wrapped_seed"`   // AES-256-GCM encrypted master seed
	Salt         []byte       `json:"salt"`            // Argon2id salt for KEK derivation
	MetadataHMAC []byte       `json:"metadata_hmac"`  // HMAC-SHA256 over canonical metadata JSON
}

// bundleHMACInfo is the HKDF info string for deriving the bundle HMAC key.
const bundleHMACInfo = "dina:identity:bundle:hmac:v1"

// computeBundleHMAC derives an HMAC key from the master seed via HKDF-SHA256
// and computes HMAC-SHA256 over the canonical metadata JSON.
func computeBundleHMAC(masterSeed []byte, meta *DIDMetadata) ([]byte, error) {
	// Derive a dedicated HMAC key from the master seed.
	salt := sha256.Sum256([]byte("dina:bundle:hmac:salt"))
	reader := hkdf.New(sha256.New, masterSeed, salt[:], []byte(bundleHMACInfo))
	hmacKey := make([]byte, 32)
	if _, err := io.ReadFull(reader, hmacKey); err != nil {
		return nil, fmt.Errorf("derive HMAC key: %w", err)
	}

	// Canonical JSON of metadata (sorted keys, no extra whitespace).
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return nil, fmt.Errorf("marshal metadata: %w", err)
	}

	mac := hmac.New(sha256.New, hmacKey)
	mac.Write(metaJSON)
	return mac.Sum(nil), nil
}

// ExportIdentity creates an IdentityBundle from the current node's secrets
// and DID metadata. The bundle is written to the specified path.
//
// masterSeed is required to compute the integrity HMAC over the metadata.
// secretsDir is the path containing wrapped_seed.bin and master_seed.salt.
// The DID metadata is loaded from the DIDManager's data directory.
func (dm *DIDManager) ExportIdentity(destPath string, secretsDir string, masterSeed []byte) error {
	if dm.dataDir == "" {
		return fmt.Errorf("identity export: data directory not configured")
	}
	if len(masterSeed) == 0 {
		return fmt.Errorf("identity export: master seed is required for integrity HMAC")
	}

	// Load DID metadata.
	meta, err := dm.LoadDIDMetadata()
	if err != nil {
		return fmt.Errorf("identity export: %w", err)
	}
	if meta == nil {
		return fmt.Errorf("identity export: no DID metadata found — create a DID first")
	}

	// Read wrapped seed.
	wrappedSeed, err := os.ReadFile(filepath.Join(secretsDir, "wrapped_seed.bin"))
	if err != nil {
		return fmt.Errorf("identity export: read wrapped seed: %w", err)
	}

	// Read salt.
	salt, err := os.ReadFile(filepath.Join(secretsDir, "master_seed.salt"))
	if err != nil {
		return fmt.Errorf("identity export: read salt: %w", err)
	}

	// Compute integrity HMAC over metadata.
	metaHMAC, err := computeBundleHMAC(masterSeed, meta)
	if err != nil {
		return fmt.Errorf("identity export: compute HMAC: %w", err)
	}

	bundle := &IdentityBundle{
		Version:      1,
		Metadata:     meta,
		WrappedSeed:  wrappedSeed,
		Salt:         salt,
		MetadataHMAC: metaHMAC,
	}

	data, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return fmt.Errorf("identity export: marshal bundle: %w", err)
	}

	// Ensure destination directory exists.
	if err := os.MkdirAll(filepath.Dir(destPath), 0700); err != nil {
		return fmt.Errorf("identity export: create dest dir: %w", err)
	}

	if err := os.WriteFile(destPath, data, 0600); err != nil {
		return fmt.Errorf("identity export: write bundle: %w", err)
	}

	return nil
}

// VerifyBundleIntegrity checks the HMAC over the bundle's metadata using
// the unwrapped master seed. Must be called after seed unwrapping and
// before using the metadata for recovery.
//
// Returns nil if the HMAC is valid, or an error if the metadata has been
// tampered with or the seed does not match.
func VerifyBundleIntegrity(bundle *IdentityBundle, masterSeed []byte) error {
	if len(bundle.MetadataHMAC) == 0 {
		return fmt.Errorf("identity import: bundle has no integrity HMAC")
	}

	expected, err := computeBundleHMAC(masterSeed, bundle.Metadata)
	if err != nil {
		return fmt.Errorf("identity import: compute HMAC: %w", err)
	}

	if !hmac.Equal(bundle.MetadataHMAC, expected) {
		return fmt.Errorf("identity import: integrity check failed — metadata may have been tampered with")
	}

	return nil
}

// LoadIdentityBundle reads an IdentityBundle from disk.
func LoadIdentityBundle(path string) (*IdentityBundle, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("identity import: read bundle: %w", err)
	}

	var bundle IdentityBundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		return nil, fmt.Errorf("identity import: parse bundle: %w", err)
	}

	if bundle.Version != 1 {
		return nil, fmt.Errorf("identity import: unsupported bundle version %d", bundle.Version)
	}
	if bundle.Metadata == nil {
		return nil, fmt.Errorf("identity import: bundle missing metadata")
	}
	if len(bundle.WrappedSeed) == 0 {
		return nil, fmt.Errorf("identity import: bundle missing wrapped seed")
	}
	if len(bundle.Salt) == 0 {
		return nil, fmt.Errorf("identity import: bundle missing salt")
	}

	return &bundle, nil
}

// ImportIdentitySecrets writes the wrapped seed and salt from a bundle
// to the target secrets directory, preparing for seed unwrapping.
func ImportIdentitySecrets(bundle *IdentityBundle, secretsDir string) error {
	if err := os.MkdirAll(secretsDir, 0700); err != nil {
		return fmt.Errorf("identity import: create secrets dir: %w", err)
	}

	wrappedPath := filepath.Join(secretsDir, "wrapped_seed.bin")
	saltPath := filepath.Join(secretsDir, "master_seed.salt")

	// Refuse to overwrite existing secrets.
	if _, err := os.Stat(wrappedPath); err == nil {
		return fmt.Errorf("identity import: wrapped_seed.bin already exists — refusing to overwrite")
	}
	if _, err := os.Stat(saltPath); err == nil {
		return fmt.Errorf("identity import: master_seed.salt already exists — refusing to overwrite")
	}

	if err := os.WriteFile(wrappedPath, bundle.WrappedSeed, 0600); err != nil {
		return fmt.Errorf("identity import: write wrapped seed: %w", err)
	}
	if err := os.WriteFile(saltPath, bundle.Salt, 0600); err != nil {
		return fmt.Errorf("identity import: write salt: %w", err)
	}

	return nil
}
