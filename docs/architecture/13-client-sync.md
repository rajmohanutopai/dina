> **Source of truth:** [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — keep this file in sync with the primary document.

## Home Node ↔ Client Sync

The Home Node is the single source of truth. Devices are clients.

### The Model

```
                    HOME NODE
                  (source of truth)
                 ┌───────────────┐
                 │  SQLite Vault │
                 │  (complete)   │
                 └───┬───┬───┬──┘
                     │   │   │
           ┌─────────┘   │   └──────────┐
           ▼             ▼              ▼
      ┌─────────┐  ┌──────────┐  ┌───────────┐
      │ Phone   │  │ Laptop   │  │ Glasses   │
      │ (cache: │  │ (cache:  │  │ (no cache,│
      │ 6 months│  │ all)     │  │ live only)│
      └─────────┘  └──────────┘  └───────────┘
```

### Sync Protocol

**Rich client (phone, laptop) connecting to Home Node:**

```
CLIENT STARTUP:
  1. Authenticate to Home Node with CLIENT_TOKEN (TLS + auth frame)
  2. Send: "My last sync checkpoint was timestamp X"
  3. Home Node responds with all vault_items changed since X
  4. Client applies changes to local SQLite cache
  5. Client sends any locally-created items (e.g. offline drafts) to Home Node
  6. Home Node applies and acknowledges
  7. Both are now in sync
```

```
ONGOING (while connected):
  - Home Node pushes new items to connected clients in real-time (WebSocket)
  - Client pushes locally-created items immediately
  - If connection drops, client queues changes and syncs on reconnect
```

```
THIN CLIENT (glasses, watch, browser):
  - No local cache
  - All queries go directly to Home Node
  - Authenticated WebSocket connection
  - Home Node streams responses
```

**Why this is simple:**
- No event log, no vector clocks, no CRDTs
- Home Node is authoritative — no conflict resolution for 95% of operations
- Client caches are SQLite replicas — if corrupted, re-sync from Home Node
- Adding a new device = authenticate + full sync

**The one conflict case:**
- Phone captures a message while offline
- Laptop creates a manual note while offline
- Both reconnect to Home Node
- **These are different items. No conflict.** Both get inserted.

If both devices somehow modify the SAME item while offline (rare — most data is append-only ingestion), the Home Node accepts the later-timestamped write and logs the earlier one as a recoverable version. The user can review conflicts in a simple "sync conflicts" view — but in practice, this almost never happens because ingested data is immutable and user-editable data (notes, preferences) is small and infrequently modified.

### What About Home Node Failure?

- **Planned backup:** Home Node takes encrypted snapshots of the full Vault to a blob store (S3, Backblaze, NAS). Configurable frequency (daily default).
- **Recovery:** Spin up a new Home Node instance, restore from latest snapshot, re-authenticate devices. Same as restoring a mail server from backup.
- **Rich clients have local caches.** If Home Node is down, you can still read your cached data, do local searches, and use on-device LLM. You just can't ingest new data from API connectors or receive Dina-to-Dina messages until the node is back.
- **Offline-capable rich clients** queue changes locally and push when Home Node is reachable again.

---

