/**
 * Unit tests for `appview/src/ingester/pds-suspension-gate.ts`
 * (TN-OPS-003 ingester hookup).
 *
 * The gate is a pure function over (db, didDocCache, didResolver,
 * authorDid). Tests pin:
 *   - `pds_suspended` when host is on the list
 *   - `pass` when host is not on the list
 *   - `signature_invalid` (fail-closed) on resolver error
 *   - `signature_invalid` when the DID doc has no AT-protocol PDS
 *     endpoint
 *   - `extractPdsHost` correctness across the DID-doc shapes
 *     AT-protocol emits (fragment id, absolute id, port-bearing
 *     endpoint, malformed URL)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const isPdsSuspendedMock = vi.fn()
vi.mock('@/db/queries/suspended-pds-hosts.js', () => ({
  isPdsSuspended: (...args: unknown[]) => isPdsSuspendedMock(...args),
}))

import {
  checkPdsSuspension,
  extractPdsHost,
  type PdsSuspensionGateContext,
} from '@/ingester/pds-suspension-gate'
import type { DidDocCache, DIDDocument } from '@/shared/utils/did-doc-cache.js'
import type { DrizzleDB } from '@/db/connection.js'

const DUMMY_DB = {} as unknown as DrizzleDB
const AUTHOR = 'did:plc:author-pds-test'

function makeDoc(serviceEndpoint: string | null, opts: { idForm?: 'fragment' | 'absolute' } = {}): DIDDocument {
  if (serviceEndpoint === null) {
    return { id: AUTHOR }
  }
  const id = opts.idForm === 'absolute' ? `${AUTHOR}#atproto_pds` : '#atproto_pds'
  return {
    id: AUTHOR,
    service: [{ id, type: 'AtprotoPersonalDataServer', serviceEndpoint }],
  }
}

function makeCache(doc: DIDDocument): DidDocCache {
  return {
    cache: {} as never,
    getOrFetch: async () => doc,
    invalidate: () => false,
  }
}

function makeFailingCache(err: Error): DidDocCache {
  return {
    cache: {} as never,
    getOrFetch: async () => {
      throw err
    },
    invalidate: () => false,
  }
}

const NOOP_RESOLVER = async () => ({ id: AUTHOR })

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}
const SILENT_METRICS = { incr: () => {} }

function makeCtx(cache: DidDocCache) {
  // The full Logger / Metrics types are pino's BaseLogger + this
  // codebase's Metrics interface; the production gate only calls
  // `info` / `warn` / `incr`. A minimal duck-typed stub keeps
  // tests readable; cast through unknown to satisfy the strict
  // type position while documenting the narrowing intent.
  return {
    db: DUMMY_DB,
    didDocCache: cache,
    didResolver: NOOP_RESOLVER,
    logger: SILENT_LOGGER as unknown as PdsSuspensionGateContext['logger'],
    metrics: SILENT_METRICS as unknown as PdsSuspensionGateContext['metrics'],
  }
}

describe('extractPdsHost — DID-doc shape coverage', () => {
  it('extracts host from fragment-id form (canonical AT-protocol)', () => {
    const doc = makeDoc('https://bsky.social')
    expect(extractPdsHost(doc)).toBe('bsky.social')
  })

  it('extracts host from absolute-id form (legacy PLC docs)', () => {
    const doc = makeDoc('https://bsky.social', { idForm: 'absolute' })
    expect(extractPdsHost(doc)).toBe('bsky.social')
  })

  it('preserves non-default ports (operator may suspend `bsky.social:4443`)', () => {
    const doc = makeDoc('https://example.test:8443')
    expect(extractPdsHost(doc)).toBe('example.test:8443')
  })

  it('returns null when the doc has no service array', () => {
    expect(extractPdsHost({ id: AUTHOR })).toBeNull()
  })

  it('returns null when no entry matches the AT-protocol PDS service id', () => {
    const doc: DIDDocument = {
      id: AUTHOR,
      service: [{ id: '#some_other_service', type: 'X', serviceEndpoint: 'https://x.test' }],
    }
    expect(extractPdsHost(doc)).toBeNull()
  })

  it('returns null on malformed serviceEndpoint URL', () => {
    const doc = makeDoc('not-a-url')
    expect(extractPdsHost(doc)).toBeNull()
  })

  it('returns null when service entries lack required fields (defensive against malformed docs)', () => {
    const doc: DIDDocument = {
      id: AUTHOR,
      service: [
        { id: '#atproto_pds' }, // missing type + serviceEndpoint
      ],
    }
    expect(extractPdsHost(doc)).toBeNull()
  })

  it('handles `services` (plural) variant — some legacy docs use plural', () => {
    const doc: DIDDocument = {
      id: AUTHOR,
      services: [
        { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://legacy.test' },
      ],
    }
    expect(extractPdsHost(doc)).toBe('legacy.test')
  })

  it('returns null when service is not an array (string / object / null)', () => {
    expect(extractPdsHost({ id: AUTHOR, service: 'not-an-array' as never })).toBeNull()
    expect(extractPdsHost({ id: AUTHOR, service: { id: '#atproto_pds' } as never })).toBeNull()
  })
})

describe('checkPdsSuspension — gate decisions', () => {
  beforeEach(() => {
    isPdsSuspendedMock.mockReset()
  })

  it('passes when the resolved host is NOT on the suspension list', async () => {
    isPdsSuspendedMock.mockResolvedValueOnce(false)
    const ctx = makeCtx(makeCache(makeDoc('https://safe-host.test')))

    const result = await checkPdsSuspension(ctx, AUTHOR)

    expect(result.ok).toBe(true)
    expect(isPdsSuspendedMock).toHaveBeenCalledWith(DUMMY_DB, 'safe-host.test')
  })

  it('rejects with reason=pds_suspended when host is on the list', async () => {
    isPdsSuspendedMock.mockResolvedValueOnce(true)
    const ctx = makeCtx(makeCache(makeDoc('https://abusive-host.test')))

    const result = await checkPdsSuspension(ctx, AUTHOR)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('pds_suspended')
    expect(result.detail).toMatchObject({
      phase: 'host_suspended',
      did: AUTHOR,
      host: 'abusive-host.test',
    })
  })

  it('rejects with reason=signature_invalid (fail-closed) when DID doc resolution fails', async () => {
    const ctx = makeCtx(makeFailingCache(new Error('PLC timeout')))

    const result = await checkPdsSuspension(ctx, AUTHOR)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('signature_invalid')
    expect(result.detail).toMatchObject({
      phase: 'did_resolution',
      did: AUTHOR,
      error: 'PLC timeout',
    })
    // Resolver failure short-circuits BEFORE the DB lookup — the
    // suspension list never runs.
    expect(isPdsSuspendedMock).not.toHaveBeenCalled()
  })

  it('rejects with reason=signature_invalid when DID doc has no PDS endpoint', async () => {
    const ctx = makeCtx(makeCache(makeDoc(null)))

    const result = await checkPdsSuspension(ctx, AUTHOR)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('signature_invalid')
    expect(result.detail).toMatchObject({
      phase: 'pds_endpoint_missing',
      did: AUTHOR,
    })
    // No host extracted → no DB lookup attempted.
    expect(isPdsSuspendedMock).not.toHaveBeenCalled()
  })

  it('non-Error thrown by resolver still surfaces as signature_invalid', async () => {
    const ctx = makeCtx(makeFailingCache('string-error' as unknown as Error))

    const result = await checkPdsSuspension(ctx, AUTHOR)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('signature_invalid')
  })
})

