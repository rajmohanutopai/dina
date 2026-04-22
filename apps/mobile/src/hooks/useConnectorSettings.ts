/**
 * Connector settings data hook — manage data source connections.
 *
 * Connectors sync external data into Dina's vault:
 *   - Gmail (OAuth2, IMAP sync)
 *   - Calendar (CalDAV or Google Calendar API)
 *   - Contacts (CardDAV or native phone contacts)
 *
 * Each connector has: status, last sync time, sync mode, error state.
 *
 * Source: ARCHITECTURE.md Task 7.7
 */

export type ConnectorType = 'gmail' | 'calendar' | 'contacts' | 'custom';
export type ConnectorStatus = 'connected' | 'disconnected' | 'syncing' | 'error';
export type SyncMode = 'auto' | 'manual' | 'disabled';

export interface ConnectorState {
  id: string;
  type: ConnectorType;
  label: string;
  description: string;
  status: ConnectorStatus;
  syncMode: SyncMode;
  lastSyncAt: number | null;
  lastSyncLabel: string;
  itemsSynced: number;
  error: string | null;
  accountLabel: string;
}

/** In-memory connector registry. */
const connectors = new Map<string, ConnectorState>();

/**
 * Register a connector.
 */
export function registerConnector(
  id: string,
  type: ConnectorType,
  label: string,
  opts?: { description?: string; accountLabel?: string },
): ConnectorState {
  const state: ConnectorState = {
    id,
    type,
    label,
    description: opts?.description ?? '',
    status: 'disconnected',
    syncMode: 'manual',
    lastSyncAt: null,
    lastSyncLabel: 'Never synced',
    itemsSynced: 0,
    error: null,
    accountLabel: opts?.accountLabel ?? '',
  };
  connectors.set(id, state);
  return state;
}

/**
 * Connect a connector (simulate OAuth completion).
 */
export function connectConnector(id: string, accountLabel: string): string | null {
  const c = connectors.get(id);
  if (!c) return 'Connector not found';

  c.status = 'connected';
  c.accountLabel = accountLabel;
  c.error = null;
  return null;
}

/**
 * Disconnect a connector.
 */
export function disconnectConnector(id: string): string | null {
  const c = connectors.get(id);
  if (!c) return 'Connector not found';

  c.status = 'disconnected';
  c.accountLabel = '';
  c.syncMode = 'manual';
  return null;
}

/**
 * Trigger a manual sync for a connector.
 */
export function triggerSync(id: string): string | null {
  const c = connectors.get(id);
  if (!c) return 'Connector not found';
  if (c.status !== 'connected') return 'Connector is not connected';

  c.status = 'syncing';
  // Simulate sync completion
  c.lastSyncAt = Date.now();
  c.lastSyncLabel = 'Just now';
  c.itemsSynced += Math.floor(Math.random() * 50) + 1;
  c.status = 'connected';
  return null;
}

/**
 * Set the sync mode for a connector.
 */
export function setSyncMode(id: string, mode: SyncMode): string | null {
  const c = connectors.get(id);
  if (!c) return 'Connector not found';

  c.syncMode = mode;
  return null;
}

/**
 * Report a sync error.
 */
export function reportError(id: string, error: string): void {
  const c = connectors.get(id);
  if (c) {
    c.status = 'error';
    c.error = error;
  }
}

/**
 * Get all connectors for the settings screen.
 */
export function getConnectorList(): ConnectorState[] {
  return [...connectors.values()];
}

/**
 * Get a single connector by ID.
 */
export function getConnector(id: string): ConnectorState | null {
  return connectors.get(id) ?? null;
}

/**
 * Get counts for the summary header.
 */
export function getConnectorCounts(): {
  total: number;
  connected: number;
  syncing: number;
  errors: number;
} {
  const all = [...connectors.values()];
  return {
    total: all.length,
    connected: all.filter((c) => c.status === 'connected').length,
    syncing: all.filter((c) => c.status === 'syncing').length,
    errors: all.filter((c) => c.status === 'error').length,
  };
}

/**
 * Get available connector types for the "Add" screen.
 */
export function getAvailableTypes(): Array<{
  type: ConnectorType;
  label: string;
  description: string;
}> {
  return [
    { type: 'gmail', label: 'Gmail', description: 'Sync emails via Google OAuth' },
    {
      type: 'calendar',
      label: 'Calendar',
      description: 'Sync events via CalDAV or Google Calendar',
    },
    { type: 'contacts', label: 'Phone Contacts', description: 'Import contacts from device' },
  ];
}

/**
 * Reset (for testing).
 */
export function resetConnectors(): void {
  connectors.clear();
}
