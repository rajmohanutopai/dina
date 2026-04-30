/**
 * Unit tests for the namespace-signature gate (TN-ING-003 / Plan §3.5.1).
 *
 * The gate is the AppView-side enforcement that namespace-bearing
 * records (Attestation + Endorsement with `record.namespace` set) only
 * land if the author's DID document declares that namespace as a
 * `verificationMethod` AND lists it as an `assertionMethod`. Tests
 * pin the contract end-to-end with an injected DID resolver + DID doc
 * cache, never hitting a real PLC directory.
 *
 * Coverage strategy:
 *   1. **Skip paths** — null / undefined / empty namespace short-circuits
 *      to pass without resolver call (V1 root-identity majority path).
 *   2. **Pass paths** — namespace declared in BOTH `verificationMethod[]`
 *      AND `assertionMethod[]`; both forms of `assertionMethod` entry
 *      (string id reference + embedded VM object).
 *   3. **`namespace_disabled` paths** — namespace not in VM[]; in VM[]
 *      but not in assertionMethod[]; missing top-level fields.
 *   4. **`signature_invalid` paths** — resolver throws / fetch fails.
 *   5. **Caching** — subsequent calls hit cache, resolver called once.
 *   6. **Observability** — outcome metrics fire with correct labels.
 *   7. **Defensive shape handling** — malformed VM entries don't crash.
 */

import { describe, expect, it } from 'vitest'

import {
  createDidDocCache,
  type DIDDocument,
} from '@/shared/utils/did-doc-cache'
import {
  verifyNamespaceSignature,
  type NamespaceGateContext,
} from '@/ingester/namespace-signature-gate'

// Common test inputs — keep DID and namespace fragment realistic so
// debug output is meaningful when a test fails. The `vmId` is the
// canonical W3C DID URL form.
const AUTHOR_DID = 'did:plc:abcdefghijklmnopqrstuvwx'
const NAMESPACE = 'namespace_3'
const VM_ID = `${AUTHOR_DID}#${NAMESPACE}`

/**
 * Build a minimal valid DID doc that DECLARES the namespace as both
 * a verificationMethod AND an assertionMethod (string-ref form).
 * This is the "happy-path" fixture; tests mutate it to exercise
 * negative paths.
 */
function happyPathDoc(): DIDDocument {
  return {
    id: AUTHOR_DID,
    verificationMethod: [
      {
        id: VM_ID,
        type: 'Multikey',
        controller: AUTHOR_DID,
        publicKeyMultibase: 'z6MkpTHR8VNsBxYAAWHut2Geadd9jSshuHcrzMSDuxMv5e2T',
      },
    ],
    assertionMethod: [VM_ID],
  }
}

/**
 * Build a metrics stub. Returned shape matches the subset the gate
 * uses (`incr(name, labels?)`). Every call is captured so tests can
 * assert outcome labels without relying on the real metrics backend.
 */
interface CapturedMetric {
  name: string
  labels?: Record<string, string>
}
function createMetricsStub(): {
  metrics: { incr: (name: string, labels?: Record<string, string>) => void }
  captured: CapturedMetric[]
} {
  const captured: CapturedMetric[] = []
  return {
    metrics: {
      incr: (name, labels) => {
        captured.push({ name, ...(labels ? { labels } : {}) })
      },
    },
    captured,
  }
}

/**
 * Build a logger stub. The gate calls `info` / `warn`. We keep these
 * silent in tests but still capture for assertions.
 */
interface CapturedLog {
  level: 'info' | 'warn'
  fields: Record<string, unknown>
  msg: string
}
function createLoggerStub(): {
  logger: {
    info: (fields: Record<string, unknown>, msg: string) => void
    warn: (fields: Record<string, unknown>, msg: string) => void
    debug: (fields: Record<string, unknown>, msg: string) => void
    error: (fields: Record<string, unknown>, msg: string) => void
  }
  captured: CapturedLog[]
} {
  const captured: CapturedLog[] = []
  return {
    logger: {
      info: (fields, msg) => captured.push({ level: 'info', fields, msg }),
      warn: (fields, msg) => captured.push({ level: 'warn', fields, msg }),
      // Gate doesn't currently emit at debug/error; stubbed to satisfy
      // the BaseLogger shape if ever called.
      debug: () => {},
      error: () => {},
    },
    captured,
  }
}

/**
 * Build a fresh gate context per test. The cache is independent so
 * cross-test cache hits can't corrupt outcomes.
 */
function createGateContext(
  resolver: (did: string) => Promise<DIDDocument>,
): {
  ctx: NamespaceGateContext
  capturedMetrics: CapturedMetric[]
  capturedLogs: CapturedLog[]
} {
  const cache = createDidDocCache({ ttlMs: 60_000, max: 100 })
  const { metrics, captured: capturedMetrics } = createMetricsStub()
  const { logger, captured: capturedLogs } = createLoggerStub()
  return {
    ctx: {
      didDocCache: cache,
      didResolver: resolver,
      // Cast through unknown — the type signature uses pino's full
      // BaseLogger shape, but the gate only calls info/warn. Test
      // stub satisfies the call sites without re-implementing pino.
      logger: logger as unknown as NamespaceGateContext['logger'],
      metrics: metrics as unknown as NamespaceGateContext['metrics'],
    },
    capturedMetrics,
    capturedLogs,
  }
}

describe('namespace-signature gate — TN-ING-003 skip paths (no namespace)', () => {
  it('returns ok=true when namespace is undefined (V1 root-identity path)', async () => {
    let resolverCalls = 0
    const { ctx } = createGateContext(async () => {
      resolverCalls++
      return happyPathDoc()
    })
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, undefined)
    expect(result).toEqual({ ok: true })
    expect(resolverCalls).toBe(0)
  })

  it('returns ok=true when namespace is null', async () => {
    let resolverCalls = 0
    const { ctx } = createGateContext(async () => {
      resolverCalls++
      return happyPathDoc()
    })
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, null)
    expect(result).toEqual({ ok: true })
    expect(resolverCalls).toBe(0)
  })

  it('returns ok=true when namespace is empty string', async () => {
    // Empty string is the falsy path the lexicon-validator's `min(1)`
    // bound treats as "no namespace". Gate symmetry: same as null.
    let resolverCalls = 0
    const { ctx } = createGateContext(async () => {
      resolverCalls++
      return happyPathDoc()
    })
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, '')
    expect(result).toEqual({ ok: true })
    expect(resolverCalls).toBe(0)
  })

  it('skipped path emits the no-namespace observability label', async () => {
    const { ctx, capturedMetrics } = createGateContext(async () => happyPathDoc())
    await verifyNamespaceSignature(ctx, AUTHOR_DID, undefined)
    const skipped = capturedMetrics.filter(
      (m) => m.name === 'ingester.namespace_gate.skipped',
    )
    expect(skipped).toHaveLength(1)
    expect(skipped[0].labels).toEqual({ reason: 'no_namespace' })
  })
})

describe('namespace-signature gate — TN-ING-003 pass paths (declared)', () => {
  it('passes when namespace is declared in VM[] AND assertionMethod[] (string-ref form)', async () => {
    const { ctx, capturedMetrics } = createGateContext(async () => happyPathDoc())
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result).toEqual({ ok: true })
    const outcomes = capturedMetrics.filter(
      (m) => m.name === 'ingester.namespace_gate.outcome',
    )
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0].labels).toEqual({ outcome: 'pass' })
  })

  it('passes when assertionMethod entry is an EMBEDDED VM (not a string ref)', async () => {
    // W3C DID Core §5.3.2: assertionMethod entries can be string ids
    // OR embedded full verificationMethod objects. The gate must
    // accept both forms — pinned here.
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      verificationMethod: [
        { id: VM_ID, type: 'Multikey', controller: AUTHOR_DID },
      ],
      assertionMethod: [
        // Embedded form — VM object inline rather than string ref.
        { id: VM_ID, type: 'Multikey', controller: AUTHOR_DID },
      ],
    }
    const { ctx } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result).toEqual({ ok: true })
  })

  it('passes when DID has multiple namespaces declared (matches by id)', async () => {
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      verificationMethod: [
        { id: `${AUTHOR_DID}#namespace_0`, type: 'Multikey', controller: AUTHOR_DID },
        { id: `${AUTHOR_DID}#namespace_1`, type: 'Multikey', controller: AUTHOR_DID },
        { id: VM_ID, type: 'Multikey', controller: AUTHOR_DID },
      ],
      assertionMethod: [
        `${AUTHOR_DID}#namespace_0`,
        `${AUTHOR_DID}#namespace_1`,
        VM_ID,
      ],
    }
    const { ctx } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result).toEqual({ ok: true })
  })
})

describe('namespace-signature gate — TN-ING-003 namespace_disabled paths', () => {
  it("rejects when namespace VM is not in verificationMethod[]", async () => {
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      // namespace_3 isn't declared — only namespace_0
      verificationMethod: [
        { id: `${AUTHOR_DID}#namespace_0`, type: 'Multikey', controller: AUTHOR_DID },
      ],
      assertionMethod: [`${AUTHOR_DID}#namespace_0`],
    }
    const { ctx, capturedMetrics } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('namespace_disabled')
    expect(result.detail).toMatchObject({
      phase: 'verification_method_missing',
      did: AUTHOR_DID,
      namespace: NAMESPACE,
      expected_vm_id: VM_ID,
    })
    const outcomes = capturedMetrics.filter(
      (m) => m.name === 'ingester.namespace_gate.outcome',
    )
    expect(outcomes[0].labels).toEqual({ outcome: 'namespace_disabled' })
  })

  it('rejects when namespace VM is in VM[] but NOT in assertionMethod[]', async () => {
    // Defends against keys declared for OTHER purposes (authentication,
    // capability delegation) that must not be trusted as record-signing
    // keys per W3C DID Core §5.3.2. Critical security invariant.
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      verificationMethod: [
        { id: VM_ID, type: 'Multikey', controller: AUTHOR_DID },
      ],
      // No assertionMethod entries at all.
      assertionMethod: [],
    }
    const { ctx } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('namespace_disabled')
    expect(result.detail).toMatchObject({
      phase: 'assertion_method_missing',
      did: AUTHOR_DID,
      namespace: NAMESPACE,
    })
  })

  it('rejects when assertionMethod field is missing entirely', async () => {
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      verificationMethod: [
        { id: VM_ID, type: 'Multikey', controller: AUTHOR_DID },
      ],
      // assertionMethod intentionally omitted.
    }
    const { ctx } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('namespace_disabled')
    expect(result.detail).toMatchObject({ phase: 'assertion_method_missing' })
  })

  it('rejects when verificationMethod field is missing entirely', async () => {
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      // verificationMethod intentionally omitted.
      assertionMethod: [VM_ID],
    }
    const { ctx } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('namespace_disabled')
    expect(result.detail).toMatchObject({ phase: 'verification_method_missing' })
  })

  it('rejects when assertionMethod has the SAME fragment but DIFFERENT DID prefix', async () => {
    // Defence against a hostile doc that lists `did:plc:OTHER#namespace_3`
    // — the namespace fragment matches but the controlling DID does
    // not. The expected_vm_id includes the author DID prefix so this
    // mismatch is caught.
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      verificationMethod: [
        {
          id: 'did:plc:somewhereelse#namespace_3',
          type: 'Multikey',
          controller: 'did:plc:somewhereelse',
        },
      ],
      assertionMethod: ['did:plc:somewhereelse#namespace_3'],
    }
    const { ctx } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('namespace_disabled')
  })

  it('rejects when malformed VM entries (no id) silently skip', async () => {
    // Malformed entries shouldn't crash the gate — they just don't
    // match. Hostile or buggy doc producers can put garbage in the
    // array; the gate is a tolerator at the type-narrowing layer.
    const doc: DIDDocument = {
      id: AUTHOR_DID,
      verificationMethod: [
        // Missing `id` — must NOT match.
        { type: 'Multikey', controller: AUTHOR_DID },
        // Wrong type — must NOT match (id field is a number).
        { id: 42, type: 'Multikey' },
        // null — must NOT match.
        null,
        // string — must NOT match (gate guards expect objects).
        'not-an-object',
      ] as unknown as ReadonlyArray<unknown>,
      assertionMethod: [VM_ID],
    }
    const { ctx } = createGateContext(async () => doc)
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('namespace_disabled')
    expect(result.detail).toMatchObject({ phase: 'verification_method_missing' })
  })
})

describe('namespace-signature gate — TN-ING-003 signature_invalid (resolver errors)', () => {
  it('returns signature_invalid when the resolver throws', async () => {
    // Fail-CLOSED posture: resolver failure is signature_invalid, NOT
    // pass. The author's namespace MIGHT be valid; we fail because
    // we can't prove it. Critical security invariant.
    const { ctx, capturedMetrics, capturedLogs } = createGateContext(
      async () => {
        throw new Error('PLC directory unreachable')
      },
    )
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('signature_invalid')
    expect(result.detail).toMatchObject({
      phase: 'did_resolution',
      did: AUTHOR_DID,
      error: 'PLC directory unreachable',
    })
    const outcomes = capturedMetrics.filter(
      (m) => m.name === 'ingester.namespace_gate.outcome',
    )
    expect(outcomes[0].labels).toEqual({ outcome: 'signature_invalid' })
    // The warn log fires so operators see PLC outages.
    const warns = capturedLogs.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0].fields).toMatchObject({ did: AUTHOR_DID, namespace: NAMESPACE })
  })

  it('returns signature_invalid when the resolver throws a non-Error value', async () => {
    // Defensive — a fetcher throwing a string / number / object should
    // still produce a structured detail field. Pinned because the
    // gate uses `err instanceof Error` for the message extraction.
    const { ctx } = createGateContext(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string error'
    })
    const result = await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('signature_invalid')
    expect(result.detail).toMatchObject({ error: 'string error' })
  })
})

describe('namespace-signature gate — TN-ING-003 caching', () => {
  it('subsequent calls hit the cache (resolver called once per DID)', async () => {
    let resolverCalls = 0
    const { ctx } = createGateContext(async () => {
      resolverCalls++
      return happyPathDoc()
    })

    // First call → resolver fires.
    await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(resolverCalls).toBe(1)

    // Second call → cache hit, resolver not fired.
    await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    expect(resolverCalls).toBe(1)

    // Different namespace, same DID → still cache hit (cache is
    // keyed on DID, not (DID, namespace)).
    await verifyNamespaceSignature(ctx, AUTHOR_DID, 'namespace_0')
    expect(resolverCalls).toBe(1)
  })

  it('different DIDs cache independently', async () => {
    const calls: string[] = []
    const { ctx } = createGateContext(async (did) => {
      calls.push(did)
      return { ...happyPathDoc(), id: did }
    })
    await verifyNamespaceSignature(ctx, AUTHOR_DID, NAMESPACE)
    await verifyNamespaceSignature(ctx, 'did:plc:somewhereelseyzzzzzzzzzzz', NAMESPACE)
    expect(calls).toEqual([AUTHOR_DID, 'did:plc:somewhereelseyzzzzzzzzzzz'])
  })
})

describe('namespace-signature gate — TN-ING-003 default observability fallback', () => {
  it('runs cleanly when logger + metrics omitted from context', async () => {
    // Pin the contract that the gate has working defaults — production
    // call sites can omit logger/metrics and rely on the module-level
    // singletons. Without this guard, an accidental ctx-shape refactor
    // that drops the `?` from logger/metrics would silently break
    // every caller using the singleton path.
    const cache = createDidDocCache({ ttlMs: 60_000, max: 100 })
    const result = await verifyNamespaceSignature(
      {
        didDocCache: cache,
        didResolver: async () => happyPathDoc(),
        // logger + metrics intentionally omitted — gate uses defaults.
      },
      AUTHOR_DID,
      NAMESPACE,
    )
    expect(result).toEqual({ ok: true })
  })
})
