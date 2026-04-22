/**
 * DID resolver — fetch and cache DID Documents from PLC directory.
 *
 * Resolution flow:
 *   1. Check in-memory TTL cache (10-min default)
 *   2. Cache miss → fetch from PLC directory (https://plc.directory/{did})
 *   3. Parse and validate the DID Document
 *   4. Extract #dina-messaging service endpoint + type
 *
 * The resolver supports both did:plc (PLC directory lookup) and
 * did:key (local derivation, no network needed).
 *
 * Injectable fetch for testability — tests use mock, production uses real.
 *
 * Source: ARCHITECTURE.md Task 6.1
 */

import type { DIDDocument, ServiceEndpoint } from '../identity/did_document';
import { validateDIDDocument, getMessagingService } from '../identity/did_document';
import { buildDIDDocument } from '../identity/did_document';
import { extractPublicKey, publicKeyToMultibase } from '../identity/did';

import { DEFAULT_PLC_DIRECTORY, DID_CACHE_TTL_MS } from '../constants';

const DEFAULT_TTL_MS = DID_CACHE_TTL_MS;

export interface ResolvedDID {
  did: string;
  document: DIDDocument;
  messagingService: { type: string; endpoint: string } | null;
  resolvedAt: number;
  source: 'cache' | 'network' | 'local';
}

export interface ResolverConfig {
  plcDirectory?: string;
  ttlMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface CacheEntry {
  resolved: ResolvedDID;
  expiresAt: number;
}

export class DIDResolver {
  private readonly plcDirectory: string;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly cache: Map<string, CacheEntry>;

  constructor(config?: ResolverConfig) {
    this.plcDirectory = (config?.plcDirectory ?? DEFAULT_PLC_DIRECTORY).replace(/\/$/, '');
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.fetchFn = config?.fetch ?? globalThis.fetch;
    this.cache = new Map();
  }

  /**
   * Resolve a DID to its DID Document.
   *
   * did:key — local derivation (no network)
   * did:plc — PLC directory lookup (with cache)
   */
  async resolve(did: string): Promise<ResolvedDID> {
    if (!did) throw new Error('resolver: DID is required');

    // Check cache first
    const cached = this.getFromCache(did);
    if (cached) return cached;

    // Resolve based on DID method
    let resolved: ResolvedDID;
    if (did.startsWith('did:key:')) {
      resolved = this.resolveDidKey(did);
    } else if (did.startsWith('did:plc:')) {
      resolved = await this.resolveDidPlc(did);
    } else {
      throw new Error(`resolver: unsupported DID method in "${did}"`);
    }

    // Cache the result
    this.putInCache(did, resolved);
    return resolved;
  }

  /**
   * Resolve and extract the messaging service endpoint.
   * Returns null if the DID has no #dina-messaging service.
   */
  async resolveMessagingEndpoint(did: string): Promise<{ type: string; endpoint: string } | null> {
    const resolved = await this.resolve(did);
    return resolved.messagingService;
  }

  /** Invalidate a cached entry. */
  invalidate(did: string): void {
    this.cache.delete(did);
  }

  /** Clear the entire cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Get cache stats. */
  cacheStats(): { size: number; ttlMs: number } {
    return { size: this.cache.size, ttlMs: this.ttlMs };
  }

  // ---------------------------------------------------------------
  // did:key — local derivation
  // ---------------------------------------------------------------

  private resolveDidKey(did: string): ResolvedDID {
    const pubKey = extractPublicKey(did);
    const multibase = publicKeyToMultibase(pubKey);
    const document = buildDIDDocument(did, multibase);

    return {
      did,
      document,
      messagingService: getMessagingService(document),
      resolvedAt: Date.now(),
      source: 'local',
    };
  }

  // ---------------------------------------------------------------
  // did:plc — PLC directory lookup
  // ---------------------------------------------------------------

  private async resolveDidPlc(did: string): Promise<ResolvedDID> {
    const url = `${this.plcDirectory}/${did}`;

    const response = await this.fetchFn(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`resolver: DID "${did}" not found on PLC directory`);
      }
      throw new Error(`resolver: PLC directory returned HTTP ${response.status}`);
    }

    const document = (await response.json()) as DIDDocument;

    // Validate the document structure
    const errors = validateDIDDocument(document);
    if (errors.length > 0) {
      throw new Error(`resolver: invalid DID document — ${errors.join('; ')}`);
    }

    // Verify the document ID matches the requested DID
    if (document.id !== did) {
      throw new Error(
        `resolver: DID document ID "${document.id}" does not match requested DID "${did}"`,
      );
    }

    return {
      did,
      document,
      messagingService: getMessagingService(document),
      resolvedAt: Date.now(),
      source: 'network',
    };
  }

  // ---------------------------------------------------------------
  // Cache
  // ---------------------------------------------------------------

  private getFromCache(did: string): ResolvedDID | null {
    const entry = this.cache.get(did);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(did);
      return null;
    }

    return { ...entry.resolved, source: 'cache' };
  }

  private putInCache(did: string, resolved: ResolvedDID): void {
    this.cache.set(did, {
      resolved,
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}
