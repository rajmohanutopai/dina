/**
 * circular_buffer tests.
 */

import { CircularBuffer } from '../src/brain/circular_buffer';

describe('CircularBuffer — construction', () => {
  it.each([
    ['null opts', null],
    ['zero capacity', { capacity: 0 }],
    ['negative capacity', { capacity: -1 }],
    ['fraction capacity', { capacity: 1.5 }],
    ['NaN capacity', { capacity: Number.NaN }],
  ] as const)('rejects %s', (_l, bad) => {
    expect(() =>
      new CircularBuffer(bad as unknown as ConstructorParameters<typeof CircularBuffer>[0]),
    ).toThrow();
  });

  it('new buffer is empty', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    expect(b.size()).toBe(0);
    expect(b.isEmpty()).toBe(true);
    expect(b.isFull()).toBe(false);
    expect(b.capacity).toBe(3);
  });
});

describe('CircularBuffer.push — no overflow', () => {
  it('push under capacity grows size', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    expect(b.push(1)).toBeUndefined();
    expect(b.push(2)).toBeUndefined();
    expect(b.size()).toBe(2);
    expect(b.isFull()).toBe(false);
  });

  it('push to capacity → isFull true', () => {
    const b = new CircularBuffer<number>({ capacity: 2 });
    b.push(1);
    b.push(2);
    expect(b.isFull()).toBe(true);
    expect(b.size()).toBe(2);
  });
});

describe('CircularBuffer.push — overflow', () => {
  it('push past capacity evicts oldest + returns it', () => {
    const b = new CircularBuffer<number>({ capacity: 2 });
    b.push(1);
    b.push(2);
    const evicted = b.push(3);
    expect(evicted).toBe(1);
    expect(b.size()).toBe(2);
  });

  it('insertion order preserved via snapshot', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.snapshot()).toEqual([3, 4, 5]);
  });

  it('wrap-around index correct after many pushes', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    for (let i = 0; i < 100; i++) b.push(i);
    expect(b.snapshot()).toEqual([97, 98, 99]);
  });
});

describe('CircularBuffer — peek', () => {
  it('peek on empty returns undefined', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    expect(b.peekOldest()).toBeUndefined();
    expect(b.peekNewest()).toBeUndefined();
  });

  it('peekOldest / peekNewest', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    b.push(3);
    expect(b.peekOldest()).toBe(1);
    expect(b.peekNewest()).toBe(3);
  });

  it('peek after overflow', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.peekOldest()).toBe(3);
    expect(b.peekNewest()).toBe(5);
  });
});

describe('CircularBuffer — pop / shift', () => {
  it('popNewest returns newest + removes', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    b.push(3);
    expect(b.popNewest()).toBe(3);
    expect(b.size()).toBe(2);
    expect(b.snapshot()).toEqual([1, 2]);
  });

  it('popNewest empty → undefined', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    expect(b.popNewest()).toBeUndefined();
  });

  it('shiftOldest returns oldest + removes', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    b.push(3);
    expect(b.shiftOldest()).toBe(1);
    expect(b.size()).toBe(2);
    expect(b.snapshot()).toEqual([2, 3]);
  });

  it('shiftOldest empty → undefined', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    expect(b.shiftOldest()).toBeUndefined();
  });

  it('pop all then push still works', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    b.popNewest();
    b.popNewest();
    expect(b.size()).toBe(0);
    b.push(99);
    expect(b.snapshot()).toEqual([99]);
  });
});

describe('CircularBuffer — tail', () => {
  it('tail(n) returns last n newest-first', () => {
    const b = new CircularBuffer<number>({ capacity: 5 });
    for (let i = 1; i <= 5; i++) b.push(i);
    expect(b.tail(3)).toEqual([5, 4, 3]);
  });

  it('tail larger than size returns everything', () => {
    const b = new CircularBuffer<number>({ capacity: 5 });
    b.push(1);
    b.push(2);
    expect(b.tail(10)).toEqual([2, 1]);
  });

  it('tail(0) → empty', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    expect(b.tail(0)).toEqual([]);
  });

  it('tail rejects negative n', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    expect(() => b.tail(-1)).toThrow(/n/);
  });

  it('tail after overflow', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    for (let i = 1; i <= 10; i++) b.push(i);
    expect(b.tail(2)).toEqual([10, 9]);
  });
});

describe('CircularBuffer — iteration', () => {
  it('forEach visits oldest → newest', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    b.push(3);
    const seen: Array<[number, number]> = [];
    b.forEach((v, i) => seen.push([v, i]));
    expect(seen).toEqual([[1, 0], [2, 1], [3, 2]]);
  });

  it('for...of works', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    const out: number[] = [];
    for (const v of b) out.push(v);
    expect(out).toEqual([1, 2]);
  });

  it('iteration after overflow still oldest → newest', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    for (let i = 1; i <= 5; i++) b.push(i);
    expect([...b]).toEqual([3, 4, 5]);
  });
});

describe('CircularBuffer — snapshot + clear', () => {
  it('snapshot is a defensive copy', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    const snap = b.snapshot();
    snap[0] = 999;
    expect(b.snapshot()).toEqual([1, 2]);
  });

  it('snapshot empty → []', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    expect(b.snapshot()).toEqual([]);
  });

  it('clear resets to empty', () => {
    const b = new CircularBuffer<number>({ capacity: 3 });
    b.push(1);
    b.push(2);
    b.clear();
    expect(b.size()).toBe(0);
    expect(b.snapshot()).toEqual([]);
    // Indices re-start cleanly.
    b.push(99);
    expect(b.snapshot()).toEqual([99]);
  });
});

describe('CircularBuffer — generic typing', () => {
  it('works with object types', () => {
    const b = new CircularBuffer<{ id: string }>({ capacity: 2 });
    b.push({ id: 'a' });
    b.push({ id: 'b' });
    expect(b.snapshot().map((o) => o.id)).toEqual(['a', 'b']);
  });
});
