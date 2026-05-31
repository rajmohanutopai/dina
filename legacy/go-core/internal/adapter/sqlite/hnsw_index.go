//go:build cgo

package sqlite

import (
	"database/sql"
	"log/slog"
	"runtime"
	"sync"

	"github.com/coder/hnsw"
)

// HNSWManager holds per-persona HNSW indices. Indices are created on persona
// unlock (Hydrate) and destroyed on persona lock (Destroy). Embeddings live
// in RAM only while the persona is unlocked — at rest they are encrypted
// BLOBs inside SQLCipher.
type HNSWManager struct {
	mu      sync.RWMutex
	indices map[string]*hnswState
}

type hnswState struct {
	graph *hnsw.Graph[string]
	ids   map[string]bool // track indexed IDs to prevent duplicates
}

// NewHNSWManager returns a new manager with no indices loaded.
func NewHNSWManager() *HNSWManager {
	return &HNSWManager{indices: make(map[string]*hnswState)}
}

// Hydrate loads all embeddings from the persona's vault_items table into a
// new HNSW graph. Called after Pool.Open succeeds. If no embeddings exist
// the graph is created empty (ready for Add calls during Store).
func (m *HNSWManager) Hydrate(persona string, db *sql.DB) error {
	graph := hnsw.NewGraph[string]()
	graph.M = 16
	graph.Ml = 0.25
	graph.EfSearch = 20
	graph.Distance = hnsw.CosineDistance

	ids := make(map[string]bool)

	rows, err := db.Query(
		`SELECT id, embedding FROM vault_items WHERE embedding IS NOT NULL AND deleted = 0`,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	var count int
	for rows.Next() {
		var id string
		var blob []byte
		if err := rows.Scan(&id, &blob); err != nil {
			slog.Warn("hnsw: skip row scan error", "persona", persona, "error", err)
			continue
		}
		vec, err := DecodeEmbedding(blob)
		if err != nil {
			slog.Warn("hnsw: skip bad embedding", "persona", persona, "id", id, "error", err)
			continue
		}
		graph.Add(hnsw.MakeNode(id, vec))
		ids[id] = true
		count++
	}
	if err := rows.Err(); err != nil {
		return err
	}

	m.mu.Lock()
	m.indices[persona] = &hnswState{graph: graph, ids: ids}
	m.mu.Unlock()

	slog.Info("hnsw: hydrated", "persona", persona, "vectors", count)
	return nil
}

// Destroy removes the HNSW index for a persona, freeing all RAM. Called
// from VaultAdapter.Close when a persona is locked.
func (m *HNSWManager) Destroy(persona string) {
	m.mu.Lock()
	delete(m.indices, persona)
	m.mu.Unlock()

	// Hint to GC that a potentially large allocation was freed.
	runtime.GC()
	slog.Info("hnsw: destroyed", "persona", persona)
}

// Search returns the IDs of the top-K nearest items by cosine distance.
// Returns nil if the persona has no index or the index is empty.
func (m *HNSWManager) Search(persona string, query []float32, topK int) []string {
	m.mu.RLock()
	state, ok := m.indices[persona]
	m.mu.RUnlock()
	if !ok || state.graph.Len() == 0 {
		return nil
	}

	results := state.graph.Search(query, topK)
	ids := make([]string, len(results))
	for i, node := range results {
		ids[i] = node.Key
	}
	return ids
}

// Add inserts a single embedding into the live index. Called during Store
// when an item has an embedding. No-op if the persona has no index.
func (m *HNSWManager) Add(persona string, itemID string, embedding []float32) {
	m.mu.RLock()
	state, ok := m.indices[persona]
	m.mu.RUnlock()
	if !ok {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if state.ids[itemID] {
		// Already indexed — delete and re-add to update the embedding.
		state.graph.Delete(itemID)
	}
	state.graph.Add(hnsw.MakeNode(itemID, embedding))
	state.ids[itemID] = true
}

// HasIndex returns true if the persona has a hydrated HNSW index.
func (m *HNSWManager) HasIndex(persona string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	_, ok := m.indices[persona]
	return ok
}
