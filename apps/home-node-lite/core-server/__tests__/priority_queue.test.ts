/**
 * priority_queue tests.
 */

import { PriorityQueue } from '../src/brain/priority_queue';

describe('PriorityQueue — basic operations', () => {
  it('empty queue', () => {
    const pq = new PriorityQueue<string>();
    expect(pq.size()).toBe(0);
    expect(pq.isEmpty()).toBe(true);
    expect(pq.peek()).toBeNull();
    expect(pq.pop()).toBeNull();
  });

  it('push single item', () => {
    const pq = new PriorityQueue<string>();
    pq.push(1, 'a');
    expect(pq.size()).toBe(1);
    expect(pq.peek()).toEqual({ priority: 1, value: 'a' });
  });

  it('pop returns min priority first', () => {
    const pq = new PriorityQueue<string>();
    pq.push(3, 'c');
    pq.push(1, 'a');
    pq.push(2, 'b');
    expect(pq.pop()).toEqual({ priority: 1, value: 'a' });
    expect(pq.pop()).toEqual({ priority: 2, value: 'b' });
    expect(pq.pop()).toEqual({ priority: 3, value: 'c' });
    expect(pq.isEmpty()).toBe(true);
  });

  it('peek does not remove', () => {
    const pq = new PriorityQueue<string>();
    pq.push(1, 'a');
    pq.peek();
    pq.peek();
    expect(pq.size()).toBe(1);
  });
});

describe('PriorityQueue — stable tiebreak', () => {
  it('FIFO among equal priorities', () => {
    const pq = new PriorityQueue<string>();
    pq.push(5, 'first');
    pq.push(5, 'second');
    pq.push(5, 'third');
    expect(pq.pop()!.value).toBe('first');
    expect(pq.pop()!.value).toBe('second');
    expect(pq.pop()!.value).toBe('third');
  });

  it('stability preserved after mixed priorities', () => {
    const pq = new PriorityQueue<string>();
    pq.push(3, 'c-first');
    pq.push(1, 'a');
    pq.push(3, 'c-second');
    pq.push(2, 'b');
    pq.push(3, 'c-third');
    expect(pq.pop()!.value).toBe('a');
    expect(pq.pop()!.value).toBe('b');
    expect(pq.pop()!.value).toBe('c-first');
    expect(pq.pop()!.value).toBe('c-second');
    expect(pq.pop()!.value).toBe('c-third');
  });
});

describe('PriorityQueue — heap invariant under many inserts', () => {
  it('500 random pushes pop in ascending order', () => {
    const pq = new PriorityQueue<number>();
    const values: number[] = [];
    // Deterministic pseudo-random sequence.
    let seed = 17;
    for (let i = 0; i < 500; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const p = seed % 10000;
      pq.push(p, i);
      values.push(p);
    }
    values.sort((a, b) => a - b);
    let last = -Infinity;
    for (let i = 0; i < 500; i++) {
      const out = pq.pop()!;
      expect(out.priority).toBe(values[i]);
      expect(out.priority).toBeGreaterThanOrEqual(last);
      last = out.priority;
    }
    expect(pq.isEmpty()).toBe(true);
  });
});

describe('PriorityQueue — custom comparator', () => {
  it('max-heap via negated compare', () => {
    const pq = new PriorityQueue<string, number>({ compare: (a, b) => b - a });
    pq.push(1, 'a');
    pq.push(3, 'c');
    pq.push(2, 'b');
    expect(pq.pop()!.value).toBe('c');
    expect(pq.pop()!.value).toBe('b');
    expect(pq.pop()!.value).toBe('a');
  });

  it('string priorities via localeCompare', () => {
    const pq = new PriorityQueue<number, string>({
      compare: (a, b) => a.localeCompare(b),
    });
    pq.push('banana', 1);
    pq.push('apple', 2);
    pq.push('cherry', 3);
    expect(pq.pop()!.value).toBe(2);
    expect(pq.pop()!.value).toBe(1);
    expect(pq.pop()!.value).toBe(3);
  });
});

describe('PriorityQueue — remove', () => {
  it('removes entries matching predicate + rebuilds heap', () => {
    const pq = new PriorityQueue<string>();
    pq.push(1, 'a');
    pq.push(2, 'b');
    pq.push(3, 'c');
    pq.push(4, 'd');
    const removed = pq.remove((v) => v === 'b' || v === 'c');
    expect(removed).toBe(2);
    expect(pq.size()).toBe(2);
    expect(pq.pop()!.value).toBe('a');
    expect(pq.pop()!.value).toBe('d');
  });

  it('remove with no match returns 0', () => {
    const pq = new PriorityQueue<string>();
    pq.push(1, 'a');
    expect(pq.remove(() => false)).toBe(0);
    expect(pq.size()).toBe(1);
  });

  it('remove predicate sees priority', () => {
    const pq = new PriorityQueue<string>();
    pq.push(1, 'a');
    pq.push(2, 'b');
    pq.push(3, 'c');
    pq.remove((_v, p) => p > 1);
    expect(pq.size()).toBe(1);
    expect(pq.pop()!.value).toBe('a');
  });
});

describe('PriorityQueue — snapshot', () => {
  it('snapshot returns pop-order without mutating', () => {
    const pq = new PriorityQueue<string>();
    pq.push(3, 'c');
    pq.push(1, 'a');
    pq.push(2, 'b');
    const snap = pq.snapshot();
    expect(snap.map((e) => e.value)).toEqual(['a', 'b', 'c']);
    // Queue unchanged.
    expect(pq.size()).toBe(3);
    expect(pq.peek()!.value).toBe('a');
  });

  it('snapshot on empty → []', () => {
    const pq = new PriorityQueue<string>();
    expect(pq.snapshot()).toEqual([]);
  });

  it('snapshot preserves stable tiebreak', () => {
    const pq = new PriorityQueue<string>();
    pq.push(1, 'x');
    pq.push(1, 'y');
    pq.push(1, 'z');
    const snap = pq.snapshot();
    expect(snap.map((e) => e.value)).toEqual(['x', 'y', 'z']);
  });
});

describe('PriorityQueue — clear', () => {
  it('clear empties heap + resets counter (new FIFO)', () => {
    const pq = new PriorityQueue<string>();
    pq.push(1, 'old');
    pq.clear();
    expect(pq.isEmpty()).toBe(true);
    pq.push(1, 'new-a');
    pq.push(1, 'new-b');
    expect(pq.pop()!.value).toBe('new-a');
  });
});

describe('PriorityQueue — generic typing', () => {
  it('object values preserved', () => {
    const pq = new PriorityQueue<{ id: string; bytes: number }>();
    pq.push(100, { id: 'a', bytes: 50 });
    pq.push(50, { id: 'b', bytes: 200 });
    expect(pq.pop()!.value.id).toBe('b');
  });
});
