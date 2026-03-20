//go:build cgo

package sqlite

import (
	"encoding/binary"
	"fmt"
	"math"
)

// EmbeddingDim is the number of float32 dimensions in each embedding vector.
const EmbeddingDim = 768

// EmbeddingBlobSize is the byte length of a serialized embedding (768 × 4 bytes).
const EmbeddingBlobSize = EmbeddingDim * 4 // 3072 bytes

// EncodeEmbedding converts a 768-dim float32 slice to a little-endian byte slice
// suitable for storing as a BLOB in SQLCipher.
func EncodeEmbedding(vec []float32) ([]byte, error) {
	if len(vec) != EmbeddingDim {
		return nil, fmt.Errorf("embedding: expected %d dims, got %d", EmbeddingDim, len(vec))
	}
	buf := make([]byte, EmbeddingBlobSize)
	for i, v := range vec {
		// VT3: Reject NaN/Inf — these corrupt HNSW distance calculations.
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil, fmt.Errorf("embedding: NaN or Inf at index %d", i)
		}
		binary.LittleEndian.PutUint32(buf[i*4:], math.Float32bits(v))
	}
	return buf, nil
}

// DecodeEmbedding converts a little-endian byte slice back to a 768-dim float32 slice.
func DecodeEmbedding(blob []byte) ([]float32, error) {
	if len(blob) != EmbeddingBlobSize {
		return nil, fmt.Errorf("embedding: expected %d bytes, got %d", EmbeddingBlobSize, len(blob))
	}
	vec := make([]float32, EmbeddingDim)
	for i := range vec {
		vec[i] = math.Float32frombits(binary.LittleEndian.Uint32(blob[i*4:]))
	}
	return vec, nil
}
