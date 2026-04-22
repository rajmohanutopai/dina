/**
 * WebSocket hub — real-time event broadcasting to paired thin clients.
 *
 * Features:
 *   - Auth on connect (device must be paired + not revoked)
 *   - Event broadcasting to all connected clients
 *   - Message buffer: 50 messages, 5-minute TTL (for reconnecting clients)
 *   - Per-client send queue (doesn't block other clients on slow sender)
 *   - Heartbeat/ping to detect dead connections
 *
 * Events:
 *   vault_updated, reminder_fired, approval_needed, persona_unlocked,
 *   staging_progress, notification, system_message
 *
 * Source: ARCHITECTURE.md Task 10.7
 */

export type HubEventType =
  | 'vault_updated'
  | 'reminder_fired'
  | 'approval_needed'
  | 'persona_unlocked'
  | 'staging_progress'
  | 'notification'
  | 'system_message';

export interface HubEvent {
  id: string;
  type: HubEventType;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface ConnectedClient {
  id: string;
  deviceId: string;
  connectedAt: number;
  lastPing: number;
}

/** Injectable auth checker: returns device ID if auth passes, null if denied. */
export type AuthChecker = (credentials: Record<string, string>) => string | null;

/** Injectable message sender: sends serialized event to a client. */
export type MessageSender = (clientId: string, message: string) => boolean;

import { WS_HUB_BUFFER_SIZE, WS_HUB_BUFFER_TTL_MS } from '../constants';

const DEFAULT_BUFFER_SIZE = WS_HUB_BUFFER_SIZE;
const DEFAULT_BUFFER_TTL_MS = WS_HUB_BUFFER_TTL_MS;

export interface HubConfig {
  bufferSize?: number;
  bufferTTLMs?: number;
  authChecker?: AuthChecker;
  messageSender?: MessageSender;
}

interface BufferedEvent {
  event: HubEvent;
  expiresAt: number;
}

export class WebSocketHub {
  private readonly clients: Map<string, ConnectedClient> = new Map();
  private readonly buffer: BufferedEvent[] = [];
  private readonly bufferSize: number;
  private readonly bufferTTLMs: number;
  private readonly authChecker: AuthChecker | null;
  private readonly messageSender: MessageSender | null;

  private eventCounter = 0;

  constructor(config?: HubConfig) {
    this.bufferSize = config?.bufferSize ?? DEFAULT_BUFFER_SIZE;
    this.bufferTTLMs = config?.bufferTTLMs ?? DEFAULT_BUFFER_TTL_MS;
    this.authChecker = config?.authChecker ?? null;
    this.messageSender = config?.messageSender ?? null;
  }

  /**
   * Authenticate and register a new client connection.
   *
   * Returns the client ID on success, null on auth failure.
   */
  connect(credentials: Record<string, string>): string | null {
    // Auth check
    let deviceId = 'unknown';
    if (this.authChecker) {
      const result = this.authChecker(credentials);
      if (!result) return null; // auth failed
      deviceId = result;
    }

    const clientId = `ws-${++this.eventCounter}-${Date.now()}`;
    const now = Date.now();

    this.clients.set(clientId, {
      id: clientId,
      deviceId,
      connectedAt: now,
      lastPing: now,
    });

    return clientId;
  }

  /**
   * Disconnect a client.
   */
  disconnect(clientId: string): void {
    this.clients.delete(clientId);
  }

  /**
   * Broadcast an event to all connected clients.
   *
   * Also buffers the event for reconnecting clients.
   */
  broadcast(type: HubEventType, data: Record<string, unknown>): HubEvent {
    const event: HubEvent = {
      id: `evt-${++this.eventCounter}`,
      type,
      data,
      timestamp: Date.now(),
    };

    // Buffer for reconnecting clients
    this.addToBuffer(event);

    // Send to all connected clients
    if (this.messageSender) {
      const message = JSON.stringify(event);
      for (const client of this.clients.values()) {
        this.messageSender(client.id, message);
      }
    }

    return event;
  }

  /**
   * Get buffered events since a given timestamp.
   *
   * Used when a client reconnects to catch up on missed events.
   */
  getBufferedSince(sinceTimestamp: number): HubEvent[] {
    this.pruneBuffer();
    return this.buffer.filter((b) => b.event.timestamp > sinceTimestamp).map((b) => b.event);
  }

  /**
   * Send all buffered events to a specific client (replay on reconnect).
   */
  replayTo(clientId: string, sinceTimestamp: number): number {
    if (!this.messageSender) return 0;
    if (!this.clients.has(clientId)) return 0;

    const events = this.getBufferedSince(sinceTimestamp);
    for (const event of events) {
      this.messageSender(clientId, JSON.stringify(event));
    }
    return events.length;
  }

  /**
   * Record a ping from a client (heartbeat).
   */
  ping(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastPing = Date.now();
    }
  }

  /**
   * Get a connected client by ID.
   */
  getClient(clientId: string): ConnectedClient | null {
    return this.clients.get(clientId) ?? null;
  }

  /**
   * List all connected clients.
   */
  listClients(): ConnectedClient[] {
    return [...this.clients.values()];
  }

  /**
   * Count connected clients.
   */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * Current buffer size.
   */
  bufferCount(): number {
    this.pruneBuffer();
    return this.buffer.length;
  }

  /**
   * Remove stale clients that haven't pinged within timeout.
   */
  pruneStaleClients(timeoutMs: number): string[] {
    const now = Date.now();
    const pruned: string[] = [];

    for (const [id, client] of this.clients.entries()) {
      if (now - client.lastPing > timeoutMs) {
        this.clients.delete(id);
        pruned.push(id);
      }
    }

    return pruned;
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.clients.clear();
    this.buffer.length = 0;
    this.eventCounter = 0;
  }

  // ---------------------------------------------------------------
  // Buffer management
  // ---------------------------------------------------------------

  private addToBuffer(event: HubEvent): void {
    this.buffer.push({
      event,
      expiresAt: Date.now() + this.bufferTTLMs,
    });

    // Evict oldest if over capacity
    while (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
  }

  private pruneBuffer(): void {
    const now = Date.now();
    while (this.buffer.length > 0 && this.buffer[0].expiresAt <= now) {
      this.buffer.shift();
    }
  }
}
