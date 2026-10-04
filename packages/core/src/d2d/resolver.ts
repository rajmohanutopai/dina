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

import { DEFAULT_PLC_DIRECTORY, DID_CACHE_TTL_MS } from '../constants';
import { extractPublicKey, publicKeyToMultibase } from '../identity/did';
import { validateDIDDocument, getMessagingService , buildDIDDocument } from '../identity/did_document';
import { defaultFetch } from '../runtime/fetch';

import type { DIDDocument } from '../identity/did_document';

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
  /** How long `lookup` waits for the directory's whole answer. Default 10 s. */
  lookupTimeoutMs?: number;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * What a plain lookup of a DID found (`DIDResolver.lookup`): its document,
 * whatever it holds; `deactivated`, the directory's tombstone (HTTP 410);
 * `not_found` (HTTP 404); or `unavailable`, anything else (an outage, an
 * answer that is not a document for this DID, an unsupported method).
 */
export type DIDLookup =
  | { kind: 'document'; document: Record<string, unknown> }
  | { kind: 'deactivated' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

interface CacheEntry {
  resolved: ResolvedDID;
  expiresAt: number;
}

export class DIDResolver {
  private readonly plcDirectory: string;
  private readonly ttlMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly cache: Map<string, CacheEntry>;
  private readonly lookupTimeoutMs: number;

  constructor(config?: ResolverConfig) {
    this.plcDirectory = (config?.plcDirectory ?? DEFAULT_PLC_DIRECTORY).replace(/\/$/, '');
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.lookupTimeoutMs = config?.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.fetchFn = config?.fetch ?? defaultFetch();
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

  /**
   * Look a DID up as it stands now: no cache, and none of `resolve`'s
   * messaging checks, so a document that has dropped every key still
   * comes back as a document. Never throws, and never waits past
   * `lookupTimeoutMs` (a stalled directory is `unavailable`). For a caller
   * that must tell a DID's own end (a tombstone) from a directory fault,
   * and see a removed key as soon as the directory does (A2A's bound
   * clients).
   */
  async lookup(did: string): Promise<DIDLookup> {
    if (did.startsWith('did:key:')) {
      try {
        return { kind: 'document', document: this.resolveDidKey(did).document as unknown as Record<string, unknown> };
      } catch {
        return { kind: 'unavailable' };
      }
    }
    if (!did.startsWith('did:plc:')) return { kind: 'unavailable' };
    // One deadline over the request and the body: the abort ends either.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.lookupTimeoutMs);
    try {
      const response = await this.fetchFn(`${this.plcDirectory}/${did}`, {
        headers: { Accept: 'application/json' },
        signal: abort.signal,
      });
      if (response.status === 410) return { kind: 'deactivated' };
      if (response.status === 404) return { kind: 'not_found' };
      if (!response.ok) return { kind: 'unavailable' };
      const document: unknown = await response.json();
      if (document === null || typeof document !== 'object' || Array.isArray(document)) return { kind: 'unavailable' };
      if ((document as { id?: unknown }).id !== did) return { kind: 'unavailable' };
      return { kind: 'document', document: document as Record<string, unknown> };
    } catch {
      // A failed or aborted fetch, or a body that is not JSON.
      return { kind: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
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
