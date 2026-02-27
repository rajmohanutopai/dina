package ingress

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// DeadDrop stores encrypted blobs received while the vault is locked.
// Blobs are written as opaque files to a spool directory. They cannot be
// read or decrypted until the vault is unlocked and the Sweeper runs.
//
// Design constraints (per §7):
//   - Blobs are opaque: no metadata, no sender DID visible while locked
//   - Spool directory is append-only while locked
//   - Spool capacity is capped (Valve 2) to prevent disk exhaustion
type DeadDrop struct {
	mu       sync.Mutex
	dir      string
	maxBlobs int
	maxBytes int64
}

// NewDeadDrop creates a dead drop spool in the given directory.
// maxBlobs caps the number of stored blobs. maxBytes caps total spool size.
func NewDeadDrop(dir string, maxBlobs int, maxBytes int64) *DeadDrop {
	return &DeadDrop{
		dir:      dir,
		maxBlobs: maxBlobs,
		maxBytes: maxBytes,
	}
}

// Store writes an opaque encrypted blob to the spool directory.
// Returns an error if the spool is full or the write fails.
func (d *DeadDrop) Store(ctx context.Context, blob []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	// Check capacity.
	count, totalSize, err := d.stats()
	if err != nil {
		return fmt.Errorf("dead drop: check capacity: %w", err)
	}
	if count >= d.maxBlobs {
		return fmt.Errorf("dead drop: %w: blob limit reached (%d)", ErrSpoolFull, d.maxBlobs)
	}
	if totalSize+int64(len(blob)) > d.maxBytes {
		return fmt.Errorf("dead drop: %w: size limit reached", ErrSpoolFull)
	}

	// Generate a random filename to prevent enumeration.
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return fmt.Errorf("dead drop: generate id: %w", err)
	}
	filename := hex.EncodeToString(id) + ".blob"

	// Write atomically: write to temp, then rename.
	tmpPath := filepath.Join(d.dir, ".tmp-"+filename)
	finalPath := filepath.Join(d.dir, filename)

	if err := os.MkdirAll(d.dir, 0700); err != nil {
		return fmt.Errorf("dead drop: create dir: %w", err)
	}

	if err := os.WriteFile(tmpPath, blob, 0600); err != nil {
		return fmt.Errorf("dead drop: write blob: %w", err)
	}

	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("dead drop: rename blob: %w", err)
	}

	return nil
}

// List returns all blob filenames in the spool directory.
func (d *DeadDrop) List() ([]string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	entries, err := os.ReadDir(d.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("dead drop: list: %w", err)
	}

	var blobs []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".blob" {
			blobs = append(blobs, e.Name())
		}
	}
	return blobs, nil
}

// Read returns the contents of a specific blob and removes it from the spool.
func (d *DeadDrop) Read(name string) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	path := filepath.Join(d.dir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("dead drop: read %s: %w", name, err)
	}

	// Remove the blob after reading (consume-once semantics).
	if err := os.Remove(path); err != nil {
		return nil, fmt.Errorf("dead drop: remove %s: %w", name, err)
	}

	return data, nil
}

// Peek returns the contents of a specific blob WITHOUT removing it.
// Use Ack to remove the blob after successful processing.
func (d *DeadDrop) Peek(name string) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	path := filepath.Join(d.dir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("dead drop: peek %s: %w", name, err)
	}

	return data, nil
}

// Ack removes a blob from the spool after successful processing.
func (d *DeadDrop) Ack(name string) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	path := filepath.Join(d.dir, name)
	if err := os.Remove(path); err != nil {
		return fmt.Errorf("dead drop: ack %s: %w", name, err)
	}

	return nil
}

// Count returns the number of blobs in the spool.
func (d *DeadDrop) Count() (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	count, _, err := d.stats()
	return count, err
}

// stats returns blob count and total size (must hold mu).
func (d *DeadDrop) stats() (int, int64, error) {
	entries, err := os.ReadDir(d.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, 0, nil
		}
		return 0, 0, err
	}

	count := 0
	var totalSize int64
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".blob" {
			info, err := e.Info()
			if err != nil {
				continue
			}
			count++
			totalSize += info.Size()
		}
	}
	return count, totalSize, nil
}

// Dir returns the spool directory path (used by Sweeper for GC).
func (d *DeadDrop) Dir() string {
	return d.dir
}

// Sentinel errors for the dead drop spool.
var ErrSpoolFull = fmt.Errorf("spool full")
