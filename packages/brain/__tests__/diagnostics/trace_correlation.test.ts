/**
 * Task 5.58 — trace correlation tests.
 */

import {
  currentTrace,
  headersFor,
  inboundRequestId,
  logBindings,
  mergeTraceHeaders,
  newChildTrace,
  newRequestId,
  newRootTrace,
  withChildTrace,
  withTrace,
  type TraceContext,
} from '../../src/diagnostics/trace_correlation';

describe('newRequestId (task 5.58)', () => {
  it('returns a 32-char lowercase hex string', () => {
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('each call returns a unique id', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newRequestId());
    expect(ids.size).toBe(1000);
  });
});

describe('newRootTrace / newChildTrace', () => {
  it('root trace has null parentId', () => {
    const t = newRootTrace(() => 42);
    expect(t.parentId).toBeNull();
    expect(t.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(t.startedAtMs).toBe(42);
  });

  it('root trace is frozen', () => {
    const t = newRootTrace();
    expect(Object.isFrozen(t)).toBe(true);
    expect(() => {
      (t as { requestId: string }).requestId = 'MUTATED';
    }).toThrow();
  });

  it('child trace parentId = parent.requestId, fresh id', () => {
    const parent = newRootTrace(() => 100);
    const child = newChildTrace(parent, () => 200);
    expect(child.parentId).toBe(parent.requestId);
    expect(child.requestId).not.toBe(parent.requestId);
    expect(child.startedAtMs).toBe(200);
  });
});

describe('withTrace + currentTrace', () => {
  it('currentTrace() returns the active trace', async () => {
    const trace = newRootTrace();
    await withTrace(trace, async () => {
      expect(currentTrace()).toEqual(trace);
    });
  });

  it('currentTrace() returns null outside any scope', () => {
    expect(currentTrace()).toBeNull();
  });

  it('trace propagates across await boundaries', async () => {
    const trace = newRootTrace();
    await withTrace(trace, async () => {
      await new Promise((r) => setImmediate(r));
      const t1 = currentTrace();
      await Promise.resolve();
      const t2 = currentTrace();
      expect(t1!.requestId).toBe(trace.requestId);
      expect(t2!.requestId).toBe(trace.requestId);
    });
  });

  it('nested withTrace swaps to the inner trace + restores on exit', async () => {
    const outer = newRootTrace();
    const inner = newRootTrace();
    await withTrace(outer, async () => {
      expect(currentTrace()!.requestId).toBe(outer.requestId);
      await withTrace(inner, async () => {
        expect(currentTrace()!.requestId).toBe(inner.requestId);
      });
      expect(currentTrace()!.requestId).toBe(outer.requestId);
    });
    expect(currentTrace()).toBeNull();
  });

  it('parallel withTrace scopes are isolated', async () => {
    const a = newRootTrace();
    const b = newRootTrace();
    let aSeen = '';
    let bSeen = '';
    await Promise.all([
      withTrace(a, async () => {
        await new Promise((r) => setImmediate(r));
        aSeen = currentTrace()!.requestId;
      }),
      withTrace(b, async () => {
        await new Promise((r) => setImmediate(r));
        bSeen = currentTrace()!.requestId;
      }),
    ]);
    expect(aSeen).toBe(a.requestId);
    expect(bSeen).toBe(b.requestId);
    expect(aSeen).not.toBe(bSeen);
  });

  it('rejects invalid trace contexts', async () => {
    await expect(withTrace(null as unknown as TraceContext, async () => undefined)).rejects.toThrow(
      /invalid trace/,
    );
    await expect(withTrace({} as unknown as TraceContext, async () => undefined)).rejects.toThrow(
      /invalid trace/,
    );
  });

  it('fn value is returned to the caller', async () => {
    const trace = newRootTrace();
    const out = await withTrace(trace, async () => 42);
    expect(out).toBe(42);
  });

  it('fn throw propagates + scope unwinds', async () => {
    const trace = newRootTrace();
    await expect(
      withTrace(trace, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(currentTrace()).toBeNull();
  });
});

describe('withChildTrace', () => {
  it('outside any scope → creates a root', async () => {
    let seen: TraceContext | null = null;
    await withChildTrace(async () => {
      seen = currentTrace();
    });
    expect(seen).not.toBeNull();
    expect(seen!.parentId).toBeNull();
  });

  it('inside a scope → creates a child with parentId set', async () => {
    const parent = newRootTrace();
    let seenChild: TraceContext | null = null;
    await withTrace(parent, async () => {
      await withChildTrace(async () => {
        seenChild = currentTrace();
      });
    });
    expect(seenChild!.parentId).toBe(parent.requestId);
    expect(seenChild!.requestId).not.toBe(parent.requestId);
  });

  it('grandchild traces keep chaining', async () => {
    const traces: TraceContext[] = [];
    await withChildTrace(async () => {
      traces.push(currentTrace()!);
      await withChildTrace(async () => {
        traces.push(currentTrace()!);
        await withChildTrace(async () => {
          traces.push(currentTrace()!);
        });
      });
    });
    expect(traces[0]!.parentId).toBeNull();
    expect(traces[1]!.parentId).toBe(traces[0]!.requestId);
    expect(traces[2]!.parentId).toBe(traces[1]!.requestId);
  });
});

describe('inboundRequestId', () => {
  it('accepts a well-formed id', () => {
    expect(inboundRequestId('abc123def456abcd')).toBe('abc123def456abcd');
    expect(inboundRequestId('a'.repeat(32))).toBe('a'.repeat(32));
    expect(inboundRequestId('id-with_underscores-1234567890')).toBe(
      'id-with_underscores-1234567890',
    );
  });

  it('lowercases + trims', () => {
    expect(inboundRequestId('  ABCDEF1234567890  ')).toBe('abcdef1234567890');
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc123'],
    ['too long', 'a'.repeat(65)],
    ['contains spaces', 'abc123 def456 ghijkl'],
    ['contains special chars', 'abc123!def456.,'],
    ['non-string', 42],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, raw) => {
    expect(inboundRequestId(raw as unknown)).toBeNull();
  });
});

describe('headersFor', () => {
  it('root trace → only x-request-id', () => {
    const t = newRootTrace();
    const h = headersFor(t);
    expect(h).toEqual({ 'x-request-id': t.requestId });
  });

  it('child trace → x-request-id + x-parent-id', () => {
    const parent = newRootTrace();
    const child = newChildTrace(parent);
    const h = headersFor(child);
    expect(h).toEqual({
      'x-request-id': child.requestId,
      'x-parent-id': parent.requestId,
    });
  });
});

describe('mergeTraceHeaders', () => {
  it('merges trace headers with caller headers', () => {
    const t = newRootTrace();
    const merged = mergeTraceHeaders(t, { 'x-custom': 'value' });
    expect(merged['x-request-id']).toBe(t.requestId);
    expect(merged['x-custom']).toBe('value');
  });

  it('caller headers win on conflict', () => {
    const t = newRootTrace();
    const merged = mergeTraceHeaders(t, { 'x-request-id': 'OVERRIDE' });
    expect(merged['x-request-id']).toBe('OVERRIDE');
  });

  it('empty caller headers → trace headers only', () => {
    const t = newRootTrace();
    const merged = mergeTraceHeaders(t);
    expect(Object.keys(merged).sort()).toEqual(['x-request-id']);
  });
});

describe('logBindings', () => {
  it('outside scope → empty object', () => {
    expect(logBindings()).toEqual({});
  });

  it('root trace → request_id only', async () => {
    const t = newRootTrace();
    await withTrace(t, async () => {
      expect(logBindings()).toEqual({ request_id: t.requestId });
    });
  });

  it('child trace → request_id + parent_id', async () => {
    const parent = newRootTrace();
    await withTrace(parent, async () => {
      await withChildTrace(async () => {
        const bindings = logBindings();
        expect(bindings.request_id).toBeDefined();
        expect(bindings.parent_id).toBe(parent.requestId);
      });
    });
  });
});

describe('realistic request flow', () => {
  it('inbound → currentTrace → outbound headers → child trace on downstream', async () => {
    // Simulate an inbound header being parsed, then building a root
    // trace, then fanning out into a child call.
    const raw = 'inbound1234567890abcdefghij'; // 27 chars, valid
    const incoming = inboundRequestId(raw)!;
    expect(incoming).toBeTruthy();

    const root: TraceContext = Object.freeze({
      requestId: incoming,
      parentId: null,
      startedAtMs: 123,
    });

    const observed: Record<string, unknown> = {};
    await withTrace(root, async () => {
      observed.rootHeaders = headersFor(currentTrace()!);
      await withChildTrace(async () => {
        observed.childHeaders = headersFor(currentTrace()!);
      });
    });

    expect((observed.rootHeaders as Record<string, string>)['x-request-id']).toBe(incoming);
    expect((observed.childHeaders as Record<string, string>)['x-parent-id']).toBe(incoming);
  });
});
